from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

import cv2
import numpy as np
from PIL import Image

from .artifacts import load_rgb_png, save_rgb_png, sha256_file
from .composite import compose_frame
from .contract import CANONICAL_CONTRACT, DecodeProvenance
from .corruption_fixture import (
    CorruptionFixtureResult,
    create_deliberate_corruption_fixture,
)
from .exports import CanonicalFrameArchive, export_canonical_frame_archive
from .finalization_transaction import (
    FinalizationOutput,
    FinalizationTransaction,
    FinalizationTransactionError,
    finalization_lock,
)
from .ffmpeg_pipeline import (
    SourceAudioProvenance,
    decode_comparable_rgb24_frames_with_provenance,
    encode_preview,
    load_source_audio_manifest,
)
from .generation_gate import calculate_generation_digest
from .masks import DerivedMasks, derive_masks, load_core_mask
from .verify import (
    VERIFIED_CORE_CLAIM,
    IngestManifest,
    ProofManifest,
    SequenceAudit,
    finalize_proof_manifest,
    freeze_ingest_manifest,
    verify_persisted_sequence,
    write_audit_json,
    write_proof_manifest_json,
)


REVIEW_SOURCE_INDICES = (0, 60, 120)
REVIEW_MANIFEST_NAME = "review_manifest.json"


class RealProofError(ValueError):
    """Raised when live generation evidence cannot enter the proof pipeline."""


@dataclass(frozen=True)
class VisualGeometryApproval:
    passed: bool
    reviewer: str
    reviewed_source_indices: tuple[int, ...]
    reviewed_overlay_sha256s: tuple[str, ...]
    review_manifest_sha256: str
    note: str


@dataclass(frozen=True)
class PreparedGenerationReview:
    generated_paths: tuple[Path, ...]
    geometry_overlay_paths: tuple[Path, ...]
    generated_decode_provenance: DecodeProvenance
    review_manifest_path: Path
    review_manifest_sha256: str
    review_manifest_digest_sha256: str
    source_audio: SourceAudioProvenance | None


@dataclass(frozen=True)
class RealProofResult:
    source_paths: tuple[Path, ...]
    core_mask_paths: tuple[Path, ...]
    generated_paths: tuple[Path, ...]
    composite_paths: tuple[Path, ...]
    geometry_overlay_paths: tuple[Path, ...]
    generated_decode_provenance: DecodeProvenance
    source_audio: SourceAudioProvenance | None
    preview_path: Path
    proof_manifest_path: Path
    audit_path: Path
    run_manifest_path: Path
    difference_heatmap_path: Path
    frame_archive: CanonicalFrameArchive
    corruption_fixture: CorruptionFixtureResult
    manifest: ProofManifest
    audit: SequenceAudit


@dataclass(frozen=True)
class _LoadedReview:
    payload: dict[str, object]
    ingest: IngestManifest
    source_paths: tuple[Path, ...]
    core_mask_paths: tuple[Path, ...]
    generated_paths: tuple[Path, ...]
    geometry_overlay_paths: tuple[Path, ...]
    generated_decode_provenance: DecodeProvenance
    source_audio_binding: _SourceAudioBinding | None
    prepared_foreground_mask: Path
    source_proof_directory: Path
    review_manifest_path: Path
    review_manifest_sha256: str


@dataclass(frozen=True)
class _SourceAudioBinding:
    provenance: SourceAudioProvenance
    manifest_path: Path
    manifest_sha256: str


def _json_object(path: Path, *, role: str) -> dict[str, object]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RealProofError(f"{role} must be a JSON object")
    return payload


def _decode_provenance(raw: object) -> DecodeProvenance:
    if not isinstance(raw, dict):
        raise RealProofError("proof evidence has no media provenance")
    values = dict(raw)
    for field in ("probe_argv", "decode_argv"):
        value = values.get(field)
        if not isinstance(value, list) or not all(
            isinstance(item, str) for item in value
        ):
            raise RealProofError(f"proof evidence has invalid {field}")
        values[field] = tuple(value)
    try:
        return DecodeProvenance(**values)
    except TypeError as error:
        raise RealProofError("proof media provenance is malformed") from error


def _source_ingest(
    source_proof_directory: Path,
) -> tuple[
    IngestManifest,
    tuple[Path, ...],
    tuple[Path, ...],
    str,
    _SourceAudioBinding | None,
]:
    manifest_path = source_proof_directory / "proof_manifest.json"
    payload = _json_object(manifest_path, role="source proof manifest")
    raw_frames = payload.get("frames")
    if not isinstance(raw_frames, list) or len(raw_frames) != 121:
        raise RealProofError("source proof must contain exactly 121 frames")
    try:
        source_paths = tuple(Path(str(item["source_path"])) for item in raw_frames)
        core_paths = tuple(Path(str(item["core_mask_path"])) for item in raw_frames)
    except (KeyError, TypeError) as error:
        raise RealProofError("source proof frame paths are malformed") from error
    provenance = _decode_provenance(payload.get("media_provenance"))
    ingest = freeze_ingest_manifest(
        source_paths,
        core_paths,
        media_provenance=provenance,
    )
    expected_ingest_digest = payload.get("ingest_digest_sha256")
    if ingest.digest_sha256 != expected_ingest_digest:
        raise RealProofError("source ingest digest differs from the frozen proof")
    source_audio_manifest_path = source_proof_directory / "source_audio.json"
    source_audio_binding = None
    if source_audio_manifest_path.is_file():
        source_audio = load_source_audio_manifest(source_audio_manifest_path)
        if source_audio.source_file_sha256 != provenance.source_file_sha256:
            raise RealProofError(
                "source audio manifest belongs to different source media"
            )
        source_audio_binding = _SourceAudioBinding(
            provenance=source_audio,
            manifest_path=source_audio_manifest_path,
            manifest_sha256=sha256_file(source_audio_manifest_path),
        )
    return (
        ingest,
        source_paths,
        core_paths,
        sha256_file(manifest_path),
        source_audio_binding,
    )


def _load_prepared_masks(path: Path) -> DerivedMasks:
    with Image.open(path) as image:
        if image.format != "PNG" or image.mode != "L":
            raise RealProofError("prepared foreground must be an L-mode PNG")
        grayscale = np.array(image, dtype=np.uint8, copy=True)
    if grayscale.shape != (
        CANONICAL_CONTRACT.height,
        CANONICAL_CONTRACT.width,
    ):
        raise RealProofError("prepared foreground geometry is noncanonical")
    return derive_masks(grayscale)


def _validate_mask_binding(
    masks: DerivedMasks,
    core_mask_paths: tuple[Path, ...],
) -> None:
    for index, path in enumerate(core_mask_paths):
        if not np.array_equal(load_core_mask(path), masks.core):
            raise RealProofError(
                f"prepared foreground differs from frozen core mask {index}"
            )


def _validated_static_visualization_masks(
    source_proof_directory: Path,
    masks: DerivedMasks,
) -> tuple[Path, Path]:
    protected_core_path = source_proof_directory / "masks" / "protected_core.png"
    boundary_ring_path = source_proof_directory / "masks" / "feather_boundary.png"
    for role, path, expected in (
        ("protected core", protected_core_path, masks.core),
        ("feather boundary", boundary_ring_path, masks.edge),
    ):
        try:
            observed = load_core_mask(path)
        except (OSError, ValueError) as error:
            raise RealProofError(
                f"frozen {role} visualization is malformed"
            ) from error
        if not np.array_equal(observed, expected):
            raise RealProofError(
                f"frozen {role} visualization differs from proof-bound masks"
            )
    return protected_core_path, boundary_ring_path


def _write_changed_pixel_heatmap(
    source_path: Path,
    composite_path: Path,
    output_path: Path,
) -> None:
    source = load_rgb_png(source_path)
    composite = load_rgb_png(composite_path)
    if source.shape != composite.shape:
        raise RealProofError("frame-60 heatmap inputs have different geometry")
    delta = np.max(
        np.abs(source.astype(np.int16) - composite.astype(np.int16)),
        axis=2,
    ).astype(np.uint8)
    heatmap = np.zeros((*delta.shape, 3), dtype=np.uint8)
    heatmap[:, :, 0] = delta
    heatmap[:, :, 1] = delta // 4
    save_rgb_png(output_path, heatmap)


def _validate_generation_evidence(
    *,
    job: dict[str, object],
    assessment: dict[str, object],
    generated_media: Path,
    foreground_path: Path,
    source_ingest: IngestManifest,
) -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
    if (
        assessment.get("verdict") != "comparable_pending_visual_approval"
        or assessment.get("automatic_checks_passed") is not True
        or assessment.get("failed_checks") != []
    ):
        raise RealProofError("generation assessment did not pass automatic checks")
    generation = job.get("generation")
    fal = job.get("fal")
    model_output = fal.get("modelOutput") if isinstance(fal, dict) else None
    assessment_output = assessment.get("model_output")
    assessment_job = assessment.get("job_provenance")
    if not all(
        isinstance(value, dict)
        for value in (
            generation,
            fal,
            model_output,
            assessment_output,
            assessment_job,
        )
    ):
        raise RealProofError("job or assessment provenance is incomplete")
    assert isinstance(generation, dict)
    assert isinstance(fal, dict)
    assert isinstance(model_output, dict)
    assert isinstance(assessment_output, dict)
    assert isinstance(assessment_job, dict)
    recomputed_generation_digest = calculate_generation_digest(generation)
    if generation.get("digest") != recomputed_generation_digest:
        raise RealProofError("job differs from the recomputed generation digest")
    media_sha256 = sha256_file(generated_media)
    if (
        model_output.get("sha256") != media_sha256
        or assessment_output.get("sha256") != media_sha256
        or Path(str(assessment_output.get("path"))).resolve()
        != generated_media.resolve()
    ):
        raise RealProofError("generated media differs from persisted provenance")
    if source_ingest.media_provenance is None:
        raise RealProofError("source ingest has no canonical media provenance")
    if (
        generation.get("sourceSha256")
        != source_ingest.media_provenance.source_file_sha256
        or generation.get("editMaskSha256") != sha256_file(foreground_path)
    ):
        raise RealProofError("source or restoration mask differs from the job")
    if (
        fal.get("generationDigest") != recomputed_generation_digest
        or generation.get("endpoint") != fal.get("endpoint")
    ):
        raise RealProofError("job generation provenance is internally inconsistent")
    if assessment_job.get("id") != job.get("id"):
        raise RealProofError("assessment is bound to a different job")
    assessment_generation = assessment_job.get("generation")
    if (
        not isinstance(assessment_generation, dict)
        or calculate_generation_digest(assessment_generation)
        != recomputed_generation_digest
        or assessment_generation.get("digest") != recomputed_generation_digest
    ):
        raise RealProofError("assessment generation identity differs from the job")
    assessment_fal = assessment_job.get("fal")
    if not isinstance(assessment_fal, dict) or (
        assessment_fal.get("requestId") != fal.get("requestId")
        or assessment_fal.get("generationDigest") != recomputed_generation_digest
    ):
        raise RealProofError("assessment fal provenance differs from the job")
    return generation, fal, model_output


def _compose_sequence(
    source_paths: tuple[Path, ...],
    generated_paths: tuple[Path, ...],
    masks: DerivedMasks,
    output_directory: Path,
) -> tuple[Path, ...]:
    output_directory.mkdir(parents=True, exist_ok=False)
    paths: list[Path] = []
    for index, (source_path, generated_path) in enumerate(
        zip(source_paths, generated_paths, strict=True)
    ):
        composite = compose_frame(
            load_rgb_png(source_path),
            load_rgb_png(generated_path),
            masks.core,
            masks.protect_alpha,
        )
        path = output_directory / f"composite_{index:06d}.png"
        save_rgb_png(path, composite)
        paths.append(path)
    return tuple(paths)


def _outline(mask: np.ndarray, *, width: int = 5) -> np.ndarray:
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (width, width))
    expanded = cv2.dilate(mask.astype(np.uint8), kernel, iterations=1)
    contracted = cv2.erode(mask.astype(np.uint8), kernel, iterations=1)
    return expanded != contracted


def _geometry_overlays(
    generated_paths: tuple[Path, ...],
    masks: DerivedMasks,
    output_directory: Path,
) -> tuple[Path, ...]:
    output_directory.mkdir(parents=True, exist_ok=False)
    foreground_outline = _outline(masks.foreground)
    core_outline = _outline(masks.core)
    paths: list[Path] = []
    for index in REVIEW_SOURCE_INDICES:
        frame = load_rgb_png(generated_paths[index])
        frame[foreground_outline] = np.array([0, 255, 255], dtype=np.uint8)
        frame[core_outline] = np.array([255, 0, 128], dtype=np.uint8)
        path = output_directory / f"overlay_{index:06d}.png"
        save_rgb_png(path, frame)
        paths.append(path)
    return tuple(paths)


def _canonical_digest(payload: object) -> str:
    encoded = json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _source_audio_binding_payload(
    binding: _SourceAudioBinding,
) -> dict[str, object]:
    provenance = binding.provenance
    return {
        "manifest_path": str(binding.manifest_path.resolve()),
        "manifest_sha256": binding.manifest_sha256,
        "source_audio_present": provenance.source_audio_present,
        "normalized_audio_path": provenance.normalized_audio_path,
        "normalized_audio_sha256": provenance.normalized_audio_file_sha256,
        "normalization_operation": provenance.normalization_operation,
        "target_sample_count": provenance.target_sample_count,
        "preview_audio_policy": (
            "normalized_source_pcm_delivery_encode"
            if provenance.source_audio_present
            else "silent_no_source_audio"
        ),
        "claim_scope": provenance.claim_scope,
    }


def _write_immutable_json(path: Path, payload: dict[str, object]) -> None:
    if path.exists():
        raise FileExistsError(f"immutable JSON artifact exists: {path}")
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _hashed_frames(
    paths: tuple[Path, ...],
    *,
    recorded_paths: tuple[Path, ...] | None = None,
) -> list[dict[str, object]]:
    evidence_paths = recorded_paths if recorded_paths is not None else paths
    if len(evidence_paths) != len(paths):
        raise RealProofError("recorded frame paths differ from decoded frames")
    return [
        {
            "source_index": index,
            "path": str(evidence_path.resolve()),
            "file_sha256": sha256_file(path),
            "rgb_sha256": hashlib.sha256(
                np.ascontiguousarray(load_rgb_png(path)).tobytes(order="C")
            ).hexdigest(),
        }
        for index, (path, evidence_path) in enumerate(
            zip(paths, evidence_paths, strict=True)
        )
    ]


def _fsync_prepared_review_tree(root: Path) -> None:
    directories = [root]
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise RealProofError("prepared review cannot contain symbolic links")
        if path.is_dir():
            directories.append(path)
            continue
        if not path.is_file():
            raise RealProofError("prepared review contains a non-file artifact")
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    for directory in reversed(directories):
        descriptor = os.open(
            directory,
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
        )
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def _fsync_parent_directory(path: Path) -> None:
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def prepare_real_generation_review(
    *,
    source_proof_directory: Path,
    prepared_foreground_mask: Path,
    generated_media: Path,
    generation_assessment_path: Path,
    job_record_path: Path,
    output_directory: Path,
) -> PreparedGenerationReview:
    """Persist exact overlay and generated-frame evidence before human approval."""
    if os.path.lexists(output_directory):
        raise FileExistsError(f"review directory exists: {output_directory}")
    (
        ingest,
        source_paths,
        core_mask_paths,
        source_manifest_sha256,
        source_audio_binding,
    ) = _source_ingest(source_proof_directory)
    job = _json_object(job_record_path, role="job record")
    assessment = _json_object(
        generation_assessment_path, role="generation assessment"
    )
    masks = _load_prepared_masks(prepared_foreground_mask)
    _validate_mask_binding(masks, core_mask_paths)
    generation, fal, model_output = _validate_generation_evidence(
        job=job,
        assessment=assessment,
        generated_media=generated_media,
        foreground_path=prepared_foreground_mask,
        source_ingest=ingest,
    )

    output_directory = output_directory.resolve()
    output_directory.parent.mkdir(parents=True, exist_ok=True)
    if os.path.lexists(output_directory):
        raise FileExistsError(f"review directory exists: {output_directory}")
    staging_directory = Path(
        tempfile.mkdtemp(
            prefix=f".{output_directory.name}.preparing-",
            dir=output_directory.parent,
        )
    )
    published = False
    try:
        decoded_generated = decode_comparable_rgb24_frames_with_provenance(
            generated_media, staging_directory / "generated_frames"
        )
        staged_generated_paths = decoded_generated.paths
        published_generated_paths = tuple(
            output_directory / path.relative_to(staging_directory)
            for path in staged_generated_paths
        )
        staged_geometry_overlay_paths = _geometry_overlays(
            staged_generated_paths,
            masks,
            staging_directory / "geometry_overlays",
        )
        published_geometry_overlay_paths = tuple(
            output_directory / path.relative_to(staging_directory)
            for path in staged_geometry_overlay_paths
        )
        review_payload: dict[str, object] = {
            "schema_version": 2 if source_audio_binding is not None else 1,
            "prepared_at": datetime.now(timezone.utc).isoformat(),
            "review_state": "awaiting_visual_geometry_approval",
            "reviewed_source_indices": list(REVIEW_SOURCE_INDICES),
            "job": {
                "id": job.get("id"),
                "endpoint": generation.get("endpoint"),
                "request_id": fal.get("requestId"),
                "generation_digest": generation.get("digest"),
                "source_sha256": generation.get("sourceSha256"),
                "restoration_mask_sha256": generation.get("editMaskSha256"),
                "model_output_sha256": model_output.get("sha256"),
            },
            "generation_assessment": {
                "path": str(generation_assessment_path.resolve()),
                "sha256": sha256_file(generation_assessment_path),
                "rule_version": assessment.get("rule_version"),
                "automatic_checks_passed": True,
            },
            "source_proof": {
                "directory": str(source_proof_directory.resolve()),
                "proof_manifest_sha256": source_manifest_sha256,
                "ingest_digest_sha256": ingest.digest_sha256,
            },
            "prepared_foreground_mask": {
                "path": str(prepared_foreground_mask.resolve()),
                "sha256": sha256_file(prepared_foreground_mask),
            },
            "generated_decode_provenance": asdict(
                decoded_generated.provenance
            ),
            "generated_frames": _hashed_frames(
                staged_generated_paths,
                recorded_paths=published_generated_paths,
            ),
            "geometry_overlays": [
                {
                    "source_index": index,
                    "path": str(published_path.resolve()),
                    "sha256": sha256_file(staged_path),
                }
                for index, staged_path, published_path in zip(
                    REVIEW_SOURCE_INDICES,
                    staged_geometry_overlay_paths,
                    published_geometry_overlay_paths,
                    strict=True,
                )
            ],
        }
        if source_audio_binding is not None:
            review_payload["source_audio"] = _source_audio_binding_payload(
                source_audio_binding
            )
        review_payload["digest_sha256"] = _canonical_digest(review_payload)
        staged_review_manifest_path = (
            staging_directory / REVIEW_MANIFEST_NAME
        )
        _write_immutable_json(staged_review_manifest_path, review_payload)
        _fsync_prepared_review_tree(staging_directory)
        if os.path.lexists(output_directory):
            raise FileExistsError(
                f"review directory exists: {output_directory}"
            )
        os.rename(staging_directory, output_directory)
        published = True
        _fsync_parent_directory(output_directory.parent)
    except Exception:
        if not published:
            shutil.rmtree(staging_directory, ignore_errors=True)
        raise
    review_manifest_path = output_directory / REVIEW_MANIFEST_NAME
    return PreparedGenerationReview(
        generated_paths=published_generated_paths,
        geometry_overlay_paths=published_geometry_overlay_paths,
        generated_decode_provenance=decoded_generated.provenance,
        review_manifest_path=review_manifest_path,
        review_manifest_sha256=sha256_file(review_manifest_path),
        review_manifest_digest_sha256=str(review_payload["digest_sha256"]),
        source_audio=(
            source_audio_binding.provenance
            if source_audio_binding is not None
            else None
        ),
    )


def _expect_object(payload: dict[str, object], field: str) -> dict[str, object]:
    value = payload.get(field)
    if not isinstance(value, dict):
        raise RealProofError(f"review manifest has invalid {field}")
    return value


def _expect_hashed_paths(
    raw: object,
    *,
    role: str,
    hash_field: str,
    expected_count: int,
) -> tuple[Path, ...]:
    if not isinstance(raw, list) or len(raw) != expected_count:
        raise RealProofError(f"review manifest has invalid {role} sequence")
    paths: list[Path] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict) or item.get("source_index") != (
            REVIEW_SOURCE_INDICES[index]
            if expected_count == len(REVIEW_SOURCE_INDICES)
            else index
        ):
            raise RealProofError(f"review manifest has invalid {role} index")
        path = Path(str(item.get("path")))
        if not path.is_file() or sha256_file(path) != item.get(hash_field):
            raise RealProofError(f"persisted {role} hash differs from review evidence")
        if "rgb_sha256" in item:
            rgb_sha256 = hashlib.sha256(
                np.ascontiguousarray(load_rgb_png(path)).tobytes(order="C")
            ).hexdigest()
            if rgb_sha256 != item.get("rgb_sha256"):
                raise RealProofError(
                    f"persisted {role} RGB hash differs from review evidence"
                )
        paths.append(path)
    return tuple(paths)


def _load_prepared_review(prepared_review_directory: Path) -> _LoadedReview:
    manifest_path = prepared_review_directory / REVIEW_MANIFEST_NAME
    payload = _json_object(manifest_path, role="review manifest")
    declared_digest = payload.get("digest_sha256")
    unsigned_payload = dict(payload)
    unsigned_payload.pop("digest_sha256", None)
    if declared_digest != _canonical_digest(unsigned_payload):
        raise RealProofError("review manifest canonical digest differs")
    if (
        payload.get("review_state") != "awaiting_visual_geometry_approval"
        or payload.get("reviewed_source_indices") != list(REVIEW_SOURCE_INDICES)
    ):
        raise RealProofError("review manifest state or indices are invalid")
    source_proof = _expect_object(payload, "source_proof")
    source_directory = Path(str(source_proof.get("directory")))
    (
        ingest,
        source_paths,
        core_mask_paths,
        source_manifest_sha256,
        source_audio_binding,
    ) = _source_ingest(source_directory)
    if (
        source_proof.get("proof_manifest_sha256") != source_manifest_sha256
        or source_proof.get("ingest_digest_sha256") != ingest.digest_sha256
    ):
        raise RealProofError("source proof differs from review evidence")
    expected_source_audio = (
        _source_audio_binding_payload(source_audio_binding)
        if source_audio_binding is not None
        else None
    )
    if payload.get("source_audio") != expected_source_audio:
        raise RealProofError("source audio differs from review evidence")
    foreground = _expect_object(payload, "prepared_foreground_mask")
    foreground_path = Path(str(foreground.get("path")))
    if (
        not foreground_path.is_file()
        or sha256_file(foreground_path) != foreground.get("sha256")
    ):
        raise RealProofError("prepared foreground differs from review evidence")
    masks = _load_prepared_masks(foreground_path)
    _validate_mask_binding(masks, core_mask_paths)
    provenance = _decode_provenance(payload.get("generated_decode_provenance"))
    generated_paths = _expect_hashed_paths(
        payload.get("generated_frames"),
        role="generated frame",
        hash_field="file_sha256",
        expected_count=CANONICAL_CONTRACT.frame_count,
    )
    if provenance.source_file_sha256 != sha256_file(
        Path(provenance.source_media_path)
    ):
        raise RealProofError("generated media differs from review decode provenance")
    overlay_paths = _expect_hashed_paths(
        payload.get("geometry_overlays"),
        role="geometry overlay",
        hash_field="sha256",
        expected_count=len(REVIEW_SOURCE_INDICES),
    )
    return _LoadedReview(
        payload=payload,
        ingest=ingest,
        source_paths=source_paths,
        core_mask_paths=core_mask_paths,
        generated_paths=generated_paths,
        geometry_overlay_paths=overlay_paths,
        generated_decode_provenance=provenance,
        source_audio_binding=source_audio_binding,
        prepared_foreground_mask=foreground_path,
        source_proof_directory=source_directory,
        review_manifest_path=manifest_path,
        review_manifest_sha256=sha256_file(manifest_path),
    )


def _validate_visual_approval(
    approval: VisualGeometryApproval,
    review: _LoadedReview,
) -> None:
    if (
        not approval.passed
        or approval.reviewed_source_indices != REVIEW_SOURCE_INDICES
        or not approval.reviewer.strip()
        or not approval.note.strip()
    ):
        raise RealProofError(
            "visual geometry approval must cover source indices 0, 60 and 120"
        )
    if approval.review_manifest_sha256 != review.review_manifest_sha256:
        raise RealProofError("approval is bound to a different review manifest")
    persisted_overlay_hashes = tuple(
        sha256_file(path) for path in review.geometry_overlay_paths
    )
    if approval.reviewed_overlay_sha256s != persisted_overlay_hashes:
        raise RealProofError("approval overlay hashes differ from persisted evidence")


def finalize_real_generation_proof(
    *,
    prepared_review_directory: Path,
    visual_approval: VisualGeometryApproval,
) -> RealProofResult:
    """Finalize only after approval names the already-persisted review hashes."""
    review = _load_prepared_review(prepared_review_directory)
    _validate_visual_approval(visual_approval, review)
    proof_manifest_path = prepared_review_directory / "proof_manifest.json"
    audit_path = prepared_review_directory / "audit.json"
    preview_path = prepared_review_directory / "preview.mp4"
    run_manifest_path = prepared_review_directory / "run_manifest.json"
    difference_heatmap_path = (
        prepared_review_directory / "difference_heatmap_000060.png"
    )
    frame_archive_path = prepared_review_directory / "canonical_frames.zip"
    frame_archive_manifest_path = (
        prepared_review_directory / "canonical_frames_manifest.json"
    )
    proof_paths = (
        proof_manifest_path,
        audit_path,
        preview_path,
        run_manifest_path,
        frame_archive_path,
        frame_archive_manifest_path,
        difference_heatmap_path,
    )
    composite_directory = prepared_review_directory / "composite_frames"
    corruption_directory = prepared_review_directory / "corruption_fixture"
    masks = _load_prepared_masks(review.prepared_foreground_mask)
    protected_core_path, boundary_ring_path = (
        _validated_static_visualization_masks(
            review.source_proof_directory,
            masks,
        )
    )
    finalization_outputs = (
        FinalizationOutput(composite_directory, "directory"),
        *(FinalizationOutput(path, "file") for path in proof_paths),
        FinalizationOutput(corruption_directory, "directory"),
    )
    try:
        with finalization_lock(prepared_review_directory):
            transaction = FinalizationTransaction.begin(
                root=prepared_review_directory,
                review_manifest_sha256=review.review_manifest_sha256,
                outputs=finalization_outputs,
            )
            try:
                composite_paths = _compose_sequence(
                    review.source_paths,
                    review.generated_paths,
                    masks,
                    composite_directory,
                )
                manifest = finalize_proof_manifest(
                    review.ingest,
                    composite_paths,
                    generated_paths=review.generated_paths,
                    prepared_foreground_mask=review.prepared_foreground_mask,
                    generated_media_provenance=(
                        review.generated_decode_provenance
                    ),
                )
                audit = verify_persisted_sequence(
                    manifest,
                    source_paths=review.source_paths,
                    core_mask_paths=review.core_mask_paths,
                    composite_paths=composite_paths,
                )
                if not audit.passed or not audit.deterministic_composition_passed:
                    raise RealProofError(
                        "live canonical composite did not pass verification"
                    )
                write_proof_manifest_json(proof_manifest_path, manifest)
                write_audit_json(audit_path, audit, manifest)
                source_audio = (
                    review.source_audio_binding.provenance
                    if review.source_audio_binding is not None
                    else None
                )
                source_media_sha256 = (
                    review.ingest.media_provenance.source_file_sha256
                    if review.ingest.media_provenance is not None
                    else None
                )
                encode_preview(
                    composite_paths,
                    preview_path,
                    source_audio=source_audio,
                    expected_source_file_sha256=(
                        source_media_sha256 if source_audio is not None else None
                    ),
                )
                frame_archive = export_canonical_frame_archive(
                    manifest,
                    composite_paths,
                    frame_archive_path,
                    frame_archive_manifest_path,
                )
                corruption_fixture = create_deliberate_corruption_fixture(
                    manifest=manifest,
                    source_paths=review.source_paths,
                    core_mask_paths=review.core_mask_paths,
                    composite_paths=composite_paths,
                    output_directory=corruption_directory,
                    frame_index=60,
                )
                _write_changed_pixel_heatmap(
                    review.source_paths[60],
                    composite_paths[60],
                    difference_heatmap_path,
                )

                job = _expect_object(review.payload, "job")
                source_proof = _expect_object(review.payload, "source_proof")
                generation_assessment = _expect_object(
                    review.payload, "generation_assessment"
                )
                run_payload: dict[str, object] = {
                    "schema_version": 6 if source_audio is not None else 5,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "claim": VERIFIED_CORE_CLAIM,
                    "job": job,
                    "generation_assessment": generation_assessment,
                    "visual_geometry_approval": asdict(visual_approval),
                    "review_evidence": {
                        "manifest_path": str(
                            review.review_manifest_path.resolve()
                        ),
                        "manifest_sha256": review.review_manifest_sha256,
                        "manifest_digest_sha256": review.payload.get(
                            "digest_sha256"
                        ),
                        "prepared_before_approval": True,
                        "geometry_overlays": [
                            {
                                "source_index": index,
                                "path": str(path.resolve()),
                                "sha256": sha256_file(path),
                            }
                            for index, path in zip(
                                REVIEW_SOURCE_INDICES,
                                review.geometry_overlay_paths,
                                strict=True,
                            )
                        ],
                    },
                    "source_proof": source_proof,
                    "generated_decode_provenance": asdict(
                        review.generated_decode_provenance
                    ),
                    "proof": {
                        "manifest_path": str(proof_manifest_path.resolve()),
                        "manifest_sha256": sha256_file(proof_manifest_path),
                        "manifest_digest_sha256": manifest.digest_sha256,
                        "audit_path": str(audit_path.resolve()),
                        "audit_sha256": sha256_file(audit_path),
                        "frames_audited": audit.frames_audited,
                        "changed_core_channel_samples": (
                            audit.total_changed_core_channel_samples
                        ),
                        "deterministic_composition_checked": (
                            audit.deterministic_composition_checked
                        ),
                        "deterministic_composition_passed": (
                            audit.deterministic_composition_passed
                        ),
                    },
                    "preview": {
                        "path": str(preview_path.resolve()),
                        "sha256": sha256_file(preview_path),
                        "label": (
                            "Preview derived from verified canonical frames"
                        ),
                    },
                    "exports": {
                        "canonical_frames": {
                            "archive_path": str(
                                frame_archive.archive_path.resolve()
                            ),
                            "archive_sha256": frame_archive.archive_sha256,
                            "manifest_path": str(
                                frame_archive.manifest_path.resolve()
                            ),
                            "manifest_sha256": frame_archive.manifest_sha256,
                            "frame_count": frame_archive.frame_count,
                            "total_uncompressed_bytes": (
                                frame_archive.total_uncompressed_bytes
                            ),
                            "label": (
                                "Proof-bound canonical pre-encode RGB24 PNG sequence"
                            ),
                        },
                    },
                    "visualizations": {
                        "protected_core_frame_60": {
                            "path": str(protected_core_path.resolve()),
                            "sha256": sha256_file(protected_core_path),
                            "claim_scope": "exactness_contract_mask",
                        },
                        "boundary_ring_frame_60": {
                            "path": str(boundary_ring_path.resolve()),
                            "sha256": sha256_file(boundary_ring_path),
                            "claim_scope": (
                                "visual_only_not_exactness_contract"
                            ),
                        },
                        "difference_heatmap_frame_60": {
                            "path": str(difference_heatmap_path.resolve()),
                            "sha256": sha256_file(difference_heatmap_path),
                            "source_file_sha256": sha256_file(
                                review.source_paths[60]
                            ),
                            "composite_file_sha256": sha256_file(
                                composite_paths[60]
                            ),
                            "claim_scope": (
                                "visual_only_not_verifier_output"
                            ),
                        },
                    },
                    "negative_test": {
                        "fixture": (
                            "one_channel_one_pixel_protected_core_corruption"
                        ),
                        "verifier": "verify_persisted_sequence",
                        "frame_index": 60,
                        "channel": 1,
                        "passed": corruption_fixture.audit.passed,
                        "claim": None,
                        "canonical_artifacts_mutated": False,
                        "changed_core_pixels": (
                            corruption_fixture.audit.total_changed_core_pixels
                        ),
                        "changed_core_channel_samples": (
                            corruption_fixture.audit
                            .total_changed_core_channel_samples
                        ),
                        "worst_maximum_absolute_channel_delta": (
                            corruption_fixture.audit
                            .worst_maximum_absolute_channel_delta
                        ),
                        "manifest_path": str(
                            corruption_fixture.manifest_path.resolve()
                        ),
                        "manifest_sha256": sha256_file(
                            corruption_fixture.manifest_path
                        ),
                        "audit_path": str(
                            corruption_fixture.audit_path.resolve()
                        ),
                        "audit_sha256": sha256_file(
                            corruption_fixture.audit_path
                        ),
                        "summary_path": str(
                            corruption_fixture.summary_path.resolve()
                        ),
                        "summary_sha256": sha256_file(
                            corruption_fixture.summary_path
                        ),
                    },
                }
                if review.source_audio_binding is not None:
                    run_payload["audio"] = _source_audio_binding_payload(
                        review.source_audio_binding
                    )
                run_payload["digest_sha256"] = _canonical_digest(run_payload)
                _write_immutable_json(run_manifest_path, run_payload)
                transaction.commit()
            except Exception:
                # The durable journal is the authority for cleanup. It names
                # only targets proven absent before this attempt began.
                transaction.abort()
                raise
    except FinalizationTransactionError as error:
        raise RealProofError(str(error)) from error
    return RealProofResult(
        source_paths=review.source_paths,
        core_mask_paths=review.core_mask_paths,
        generated_paths=review.generated_paths,
        composite_paths=composite_paths,
        geometry_overlay_paths=review.geometry_overlay_paths,
        generated_decode_provenance=review.generated_decode_provenance,
        source_audio=source_audio,
        preview_path=preview_path,
        proof_manifest_path=proof_manifest_path,
        audit_path=audit_path,
        run_manifest_path=run_manifest_path,
        difference_heatmap_path=difference_heatmap_path,
        frame_archive=frame_archive,
        corruption_fixture=corruption_fixture,
        manifest=manifest,
        audit=audit,
    )
