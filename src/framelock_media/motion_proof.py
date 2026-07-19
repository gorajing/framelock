from __future__ import annotations

from dataclasses import asdict, dataclass, replace
import hashlib
import json
from pathlib import Path
import shutil
from typing import Sequence

import numpy as np
from PIL import Image

from .artifacts import (
    load_rgb_png,
    save_core_mask_png,
    save_rgb_png,
    sha256_file,
)
from .composite import compose_frame
from .contract import CANONICAL_CONTRACT, DecodeProvenance
from .masks import (
    CORE_EROSION_RADIUS,
    FOREGROUND_THRESHOLD,
    derive_masks,
    load_core_mask,
)
from .verify import (
    VERIFIED_CORE_CLAIM,
    ArtifactIntegrityError,
    IngestManifest,
    ProofManifest,
    SequenceAudit,
    SequenceBindingError,
    finalize_proof_manifest,
    freeze_ingest_manifest,
    verify_persisted_sequence,
    write_proof_manifest_json,
)


class MotionProofError(RuntimeError):
    """Raised when a temporal mask sequence cannot earn a FrameLock claim."""


@dataclass(frozen=True)
class MotionInputFrame:
    index: int
    foreground_mask_path: str
    foreground_mask_file_sha256: str
    core_mask_path: str
    core_mask_file_sha256: str
    generated_path: str
    generated_file_sha256: str
    generated_rgb_sha256: str


@dataclass(frozen=True)
class MotionInputManifest:
    frames: tuple[MotionInputFrame, ...]
    expected_width: int
    expected_height: int
    expected_frame_count: int
    foreground_threshold: int
    erosion_radius: int
    source_ingest_digest_sha256: str
    source_sequence_digest_sha256: str
    digest_sha256: str
    schema_version: int = 1


@dataclass(frozen=True)
class MotionProofResult:
    source_paths: tuple[Path, ...]
    generated_paths: tuple[Path, ...]
    foreground_mask_paths: tuple[Path, ...]
    core_mask_paths: tuple[Path, ...]
    composite_paths: tuple[Path, ...]
    motion_input_manifest_path: Path
    proof_manifest_path: Path
    audit_path: Path
    motion_input_manifest: MotionInputManifest
    manifest: ProofManifest
    audit: SequenceAudit


def _canonical_json_bytes(payload: object) -> bytes:
    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")


def _motion_input_payload(manifest: MotionInputManifest) -> dict[str, object]:
    return {
        "contract": {
            "expected_frame_count": manifest.expected_frame_count,
            "expected_height": manifest.expected_height,
            "expected_width": manifest.expected_width,
        },
        "frames": [asdict(frame) for frame in manifest.frames],
        "mask_parameters": {
            "erosion_radius": manifest.erosion_radius,
            "foreground_threshold": manifest.foreground_threshold,
        },
        "source_sequence_digest_sha256": (
            manifest.source_sequence_digest_sha256
        ),
        "source_ingest_digest_sha256": manifest.source_ingest_digest_sha256,
        "schema_version": manifest.schema_version,
    }


def _calculate_motion_input_digest(manifest: MotionInputManifest) -> str:
    return hashlib.sha256(
        _canonical_json_bytes(_motion_input_payload(manifest))
    ).hexdigest()


def _calculate_source_sequence_digest(
    manifest: IngestManifest | ProofManifest,
) -> str:
    ordered_sources = [
        {
            "index": frame.index,
            "source_file_sha256": frame.source_file_sha256,
            "source_path": frame.source_path,
            "source_rgb_sha256": frame.source_rgb_sha256,
        }
        for frame in manifest.frames
    ]
    return hashlib.sha256(_canonical_json_bytes(ordered_sources)).hexdigest()


def _resolved_paths(paths: Sequence[Path]) -> tuple[str, ...]:
    return tuple(str(path.resolve()) for path in paths)


def _require_output_under_motion_root(
    output_directory: Path,
    motion_root: Path,
) -> None:
    resolved_output = output_directory.resolve()
    resolved_root = motion_root.resolve()
    if resolved_output == resolved_root or not resolved_output.is_relative_to(
        resolved_root
    ):
        raise SequenceBindingError(
            "motion proof output must be a child of the dedicated motion root"
        )


def _require_sequence(
    paths: Sequence[Path],
    *,
    role: str,
    expected_frame_count: int,
) -> tuple[Path, ...]:
    declared = tuple(Path(path) for path in paths)
    if len(declared) != expected_frame_count:
        raise SequenceBindingError(
            f"{role} sequence must contain exactly {expected_frame_count} frames"
        )
    resolved = _resolved_paths(declared)
    if len(set(resolved)) != len(resolved):
        raise SequenceBindingError(f"{role} artifact paths must be unique")
    for path in declared:
        if not path.is_file():
            raise ArtifactIntegrityError(f"{role} artifact is missing: {path}")
    return declared


def _require_disjoint_input_domains(
    source_paths: Sequence[Path],
    generated_paths: Sequence[Path],
    foreground_mask_paths: Sequence[Path],
) -> None:
    domains = (
        set(_resolved_paths(source_paths)),
        set(_resolved_paths(generated_paths)),
        set(_resolved_paths(foreground_mask_paths)),
    )
    if any(
        first & second
        for index, first in enumerate(domains)
        for second in domains[index + 1 :]
    ):
        raise SequenceBindingError(
            "source, generated and foreground-mask artifacts must be distinct"
        )


def _load_foreground_mask(
    path: Path,
    *,
    expected_width: int,
    expected_height: int,
) -> np.ndarray:
    with Image.open(path) as image:
        if image.format != "PNG" or image.mode != "L":
            raise MotionProofError(
                "temporal foreground mask must be a single-channel grayscale PNG"
            )
        if bool(getattr(image, "is_animated", False)) or image.n_frames != 1:
            raise MotionProofError(
                "temporal foreground mask must be a single-frame PNG"
            )
        grayscale = np.array(image, dtype=np.uint8, copy=True)
    if grayscale.shape != (expected_height, expected_width):
        raise SequenceBindingError(
            "temporal foreground mask geometry differs from the proof contract"
        )
    return np.ascontiguousarray(grayscale)


def _materialize_core_masks(
    foreground_mask_paths: Sequence[Path],
    output_directory: Path,
    *,
    expected_width: int,
    expected_height: int,
) -> tuple[Path, ...]:
    output_directory.mkdir(parents=True, exist_ok=False)
    paths: list[Path] = []
    for index, foreground_path in enumerate(foreground_mask_paths):
        masks = derive_masks(
            _load_foreground_mask(
                foreground_path,
                expected_width=expected_width,
                expected_height=expected_height,
            )
        )
        path = output_directory / f"core_{index:06d}.png"
        save_core_mask_png(path, masks.core)
        paths.append(path)
    return tuple(paths)


def _freeze_motion_input_manifest(
    foreground_mask_paths: Sequence[Path],
    core_mask_paths: Sequence[Path],
    generated_paths: Sequence[Path],
    *,
    source_ingest: IngestManifest,
    expected_width: int,
    expected_height: int,
    expected_frame_count: int,
) -> MotionInputManifest:
    frames: list[MotionInputFrame] = []
    expected_rgb_shape = (expected_height, expected_width, 3)
    for index, (foreground_path, core_path, generated_path) in enumerate(
        zip(
            foreground_mask_paths,
            core_mask_paths,
            generated_paths,
            strict=True,
        )
    ):
        grayscale = _load_foreground_mask(
            foreground_path,
            expected_width=expected_width,
            expected_height=expected_height,
        )
        derived = derive_masks(grayscale)
        persisted_core = load_core_mask(core_path)
        if not np.array_equal(persisted_core, derived.core):
            raise SequenceBindingError(
                f"foreground mask differs from derived core mask {index}"
            )
        generated = load_rgb_png(generated_path)
        if generated.shape != expected_rgb_shape:
            raise SequenceBindingError(
                "generated frame geometry differs from the proof contract"
            )
        frames.append(
            MotionInputFrame(
                index=index,
                foreground_mask_path=str(foreground_path.resolve()),
                foreground_mask_file_sha256=sha256_file(foreground_path),
                core_mask_path=str(core_path.resolve()),
                core_mask_file_sha256=sha256_file(core_path),
                generated_path=str(generated_path.resolve()),
                generated_file_sha256=sha256_file(generated_path),
                generated_rgb_sha256=hashlib.sha256(
                    np.ascontiguousarray(generated).tobytes(order="C")
                ).hexdigest(),
            )
        )
    provisional = MotionInputManifest(
        frames=tuple(frames),
        expected_width=expected_width,
        expected_height=expected_height,
        expected_frame_count=expected_frame_count,
        foreground_threshold=FOREGROUND_THRESHOLD,
        erosion_radius=CORE_EROSION_RADIUS,
        source_ingest_digest_sha256=source_ingest.digest_sha256,
        source_sequence_digest_sha256=_calculate_source_sequence_digest(
            source_ingest
        ),
        digest_sha256="",
    )
    return replace(
        provisional,
        digest_sha256=_calculate_motion_input_digest(provisional),
    )


def _validate_motion_input_manifest(manifest: MotionInputManifest) -> None:
    if (
        manifest.schema_version != 1
        or manifest.expected_width <= 0
        or manifest.expected_height <= 0
        or manifest.expected_frame_count <= 0
    ):
        raise SequenceBindingError("motion input manifest contract is unsupported")
    if len(manifest.frames) != manifest.expected_frame_count:
        raise SequenceBindingError(
            "motion input frame count differs from its contract"
        )
    if tuple(frame.index for frame in manifest.frames) != tuple(
        range(manifest.expected_frame_count)
    ):
        raise SequenceBindingError(
            "motion input frame indices must be consecutive from zero"
        )
    if (
        manifest.foreground_threshold != FOREGROUND_THRESHOLD
        or manifest.erosion_radius != CORE_EROSION_RADIUS
    ):
        raise SequenceBindingError("motion mask parameters are unsupported")
    for role, digest in (
        ("source ingest", manifest.source_ingest_digest_sha256),
        ("source sequence", manifest.source_sequence_digest_sha256),
    ):
        if not isinstance(digest, str) or len(digest) != 64 or any(
            character not in "0123456789abcdef" for character in digest
        ):
            raise SequenceBindingError(f"motion {role} digest is malformed")
    if _calculate_motion_input_digest(manifest) != manifest.digest_sha256:
        raise ArtifactIntegrityError("motion input manifest digest does not match")

    foreground_paths = [frame.foreground_mask_path for frame in manifest.frames]
    core_paths = [frame.core_mask_path for frame in manifest.frames]
    generated_paths = [frame.generated_path for frame in manifest.frames]
    for role, paths in (
        ("foreground mask", foreground_paths),
        ("core mask", core_paths),
        ("generated", generated_paths),
    ):
        if len(set(paths)) != len(paths):
            raise SequenceBindingError(
                f"motion input {role} artifact paths must be unique"
            )
    domains = (set(foreground_paths), set(core_paths), set(generated_paths))
    if any(
        first & second
        for index, first in enumerate(domains)
        for second in domains[index + 1 :]
    ):
        raise SequenceBindingError(
            "motion input artifact path domains must be distinct"
        )

    expected_rgb_shape = (
        manifest.expected_height,
        manifest.expected_width,
        3,
    )
    for frame in manifest.frames:
        foreground_path = Path(frame.foreground_mask_path)
        core_path = Path(frame.core_mask_path)
        generated_path = Path(frame.generated_path)
        if sha256_file(foreground_path) != frame.foreground_mask_file_sha256:
            raise ArtifactIntegrityError(
                "foreground mask hash no longer matches motion input manifest"
            )
        if sha256_file(core_path) != frame.core_mask_file_sha256:
            raise ArtifactIntegrityError(
                "core mask hash no longer matches motion input manifest"
            )
        if sha256_file(generated_path) != frame.generated_file_sha256:
            raise ArtifactIntegrityError(
                "generated frame hash no longer matches motion input manifest"
            )
        grayscale = _load_foreground_mask(
            foreground_path,
            expected_width=manifest.expected_width,
            expected_height=manifest.expected_height,
        )
        if not np.array_equal(
            derive_masks(grayscale).core,
            load_core_mask(core_path),
        ):
            raise SequenceBindingError(
                f"foreground mask differs from frozen core mask {frame.index}"
            )
        generated = load_rgb_png(generated_path)
        if generated.shape != expected_rgb_shape:
            raise SequenceBindingError(
                "generated frame geometry differs from motion input manifest"
            )
        decoded_sha256 = hashlib.sha256(
            np.ascontiguousarray(generated).tobytes(order="C")
        ).hexdigest()
        if decoded_sha256 != frame.generated_rgb_sha256:
            raise ArtifactIntegrityError(
                "generated RGB hash no longer matches motion input manifest"
            )


def _write_json(path: Path, payload: dict[str, object]) -> None:
    if path.exists():
        raise FileExistsError(f"immutable JSON artifact exists: {path}")
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _write_motion_input_manifest(
    path: Path,
    manifest: MotionInputManifest,
) -> None:
    _validate_motion_input_manifest(manifest)
    _write_json(path, asdict(manifest))


def _load_motion_input_manifest(path: Path) -> MotionInputManifest:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise MotionProofError(
            "persisted motion input manifest is unreadable"
        ) from error
    if not isinstance(payload, dict):
        raise MotionProofError(
            "persisted motion input manifest must be a JSON object"
        )
    raw_frames = payload.get("frames")
    if not isinstance(raw_frames, list) or not all(
        isinstance(frame, dict) for frame in raw_frames
    ):
        raise MotionProofError(
            "persisted motion input manifest frames are malformed"
        )
    try:
        values = dict(payload)
        values["frames"] = tuple(
            MotionInputFrame(**frame) for frame in raw_frames
        )
        manifest = MotionInputManifest(**values)
    except TypeError as error:
        raise MotionProofError(
            "persisted motion input manifest fields are malformed"
        ) from error
    _validate_motion_input_manifest(manifest)
    return manifest


def _compose_motion_sequence(
    *,
    source_paths: Sequence[Path],
    generated_paths: Sequence[Path],
    foreground_mask_paths: Sequence[Path],
    output_directory: Path,
    expected_width: int,
    expected_height: int,
) -> tuple[Path, ...]:
    output_directory.mkdir(parents=True, exist_ok=False)
    expected_rgb_shape = (expected_height, expected_width, 3)
    paths: list[Path] = []
    for index, (source_path, generated_path, foreground_path) in enumerate(
        zip(
            source_paths,
            generated_paths,
            foreground_mask_paths,
            strict=True,
        )
    ):
        source = load_rgb_png(source_path)
        generated = load_rgb_png(generated_path)
        if source.shape != expected_rgb_shape or generated.shape != expected_rgb_shape:
            raise SequenceBindingError(
                "motion proof frame geometry differs from the proof contract"
            )
        masks = derive_masks(
            _load_foreground_mask(
                foreground_path,
                expected_width=expected_width,
                expected_height=expected_height,
            )
        )
        path = output_directory / f"composite_{index:06d}.png"
        save_rgb_png(
            path,
            compose_frame(
                source,
                generated,
                masks.core,
                masks.protect_alpha,
            ),
        )
        paths.append(path)
    return tuple(paths)


def _verify_motion_artifacts(
    *,
    motion_input_manifest: MotionInputManifest,
    proof_manifest: ProofManifest,
    source_paths: Sequence[Path],
    generated_paths: Sequence[Path],
    foreground_mask_paths: Sequence[Path],
    core_mask_paths: Sequence[Path],
    composite_paths: Sequence[Path],
) -> SequenceAudit:
    expected_foregrounds = tuple(
        frame.foreground_mask_path for frame in motion_input_manifest.frames
    )
    expected_generated = tuple(
        frame.generated_path for frame in motion_input_manifest.frames
    )
    expected_cores = tuple(
        frame.core_mask_path for frame in motion_input_manifest.frames
    )
    if _resolved_paths(foreground_mask_paths) != expected_foregrounds:
        raise SequenceBindingError(
            "provided foreground mask sequence does not match the motion proof"
        )
    if _resolved_paths(generated_paths) != expected_generated:
        raise SequenceBindingError(
            "provided generated sequence does not match the motion proof"
        )
    if _resolved_paths(core_mask_paths) != expected_cores:
        raise SequenceBindingError(
            "provided core mask sequence does not match the motion proof"
        )
    _validate_motion_input_manifest(motion_input_manifest)
    if (
        _calculate_source_sequence_digest(proof_manifest)
        != motion_input_manifest.source_sequence_digest_sha256
    ):
        raise SequenceBindingError(
            "ordered source sequence does not match the motion proof"
        )
    if (
        proof_manifest.ingest_digest_sha256
        != motion_input_manifest.source_ingest_digest_sha256
    ):
        raise SequenceBindingError(
            "source decode provenance does not match the motion proof"
        )

    audit = verify_persisted_sequence(
        proof_manifest,
        source_paths=source_paths,
        core_mask_paths=core_mask_paths,
        composite_paths=composite_paths,
    )
    deterministic_composition_passed = True
    for frame, source_path, composite_path in zip(
        motion_input_manifest.frames,
        source_paths,
        composite_paths,
        strict=True,
    ):
        masks = derive_masks(
            _load_foreground_mask(
                Path(frame.foreground_mask_path),
                expected_width=motion_input_manifest.expected_width,
                expected_height=motion_input_manifest.expected_height,
            )
        )
        expected = compose_frame(
            load_rgb_png(source_path),
            load_rgb_png(Path(frame.generated_path)),
            masks.core,
            masks.protect_alpha,
        )
        if not np.array_equal(expected, load_rgb_png(composite_path)):
            deterministic_composition_passed = False
    return replace(
        audit,
        passed=audit.passed and deterministic_composition_passed,
        deterministic_composition_checked=True,
        deterministic_composition_passed=deterministic_composition_passed,
    )


def verify_motion_proof(
    result: MotionProofResult,
    *,
    source_paths: Sequence[Path] | None = None,
    generated_paths: Sequence[Path] | None = None,
    foreground_mask_paths: Sequence[Path] | None = None,
    core_mask_paths: Sequence[Path] | None = None,
    composite_paths: Sequence[Path] | None = None,
) -> SequenceAudit:
    """Reopen every persisted motion artifact and recompute its proof."""
    persisted_motion_inputs = _load_motion_input_manifest(
        result.motion_input_manifest_path
    )
    if persisted_motion_inputs != result.motion_input_manifest:
        raise ArtifactIntegrityError(
            "persisted motion input manifest differs from the proof result"
        )
    return _verify_motion_artifacts(
        motion_input_manifest=persisted_motion_inputs,
        proof_manifest=result.manifest,
        source_paths=(result.source_paths if source_paths is None else source_paths),
        generated_paths=(
            result.generated_paths if generated_paths is None else generated_paths
        ),
        foreground_mask_paths=(
            result.foreground_mask_paths
            if foreground_mask_paths is None
            else foreground_mask_paths
        ),
        core_mask_paths=(
            result.core_mask_paths if core_mask_paths is None else core_mask_paths
        ),
        composite_paths=(
            result.composite_paths
            if composite_paths is None
            else composite_paths
        ),
    )


def _run_motion_proof(
    *,
    source_paths: Sequence[Path],
    generated_paths: Sequence[Path],
    foreground_mask_paths: Sequence[Path],
    motion_root: Path,
    output_directory: Path,
    expected_width: int,
    expected_height: int,
    expected_frame_count: int,
    source_media_provenance: DecodeProvenance | None,
    require_canonical_claim: bool,
) -> MotionProofResult:
    """Internal small-contract seam used by the deterministic regression fixture."""
    if expected_width <= 0 or expected_height <= 0 or expected_frame_count <= 0:
        raise SequenceBindingError("motion proof contract values must be positive")
    _require_output_under_motion_root(output_directory, motion_root)
    sources = _require_sequence(
        source_paths,
        role="source",
        expected_frame_count=expected_frame_count,
    )
    generated = _require_sequence(
        generated_paths,
        role="generated",
        expected_frame_count=expected_frame_count,
    )
    foregrounds = _require_sequence(
        foreground_mask_paths,
        role="foreground mask",
        expected_frame_count=expected_frame_count,
    )
    _require_disjoint_input_domains(sources, generated, foregrounds)
    if output_directory.exists():
        raise FileExistsError(
            f"motion proof output directory exists: {output_directory}"
        )
    output_directory.mkdir(parents=True)
    try:
        core_paths = _materialize_core_masks(
            foregrounds,
            output_directory / "core_masks",
            expected_width=expected_width,
            expected_height=expected_height,
        )
        ingest: IngestManifest = freeze_ingest_manifest(
            sources,
            core_paths,
            expected_width=expected_width,
            expected_height=expected_height,
            expected_frame_count=expected_frame_count,
            media_provenance=source_media_provenance,
        )
        motion_inputs = _freeze_motion_input_manifest(
            foregrounds,
            core_paths,
            generated,
            source_ingest=ingest,
            expected_width=expected_width,
            expected_height=expected_height,
            expected_frame_count=expected_frame_count,
        )
        motion_input_manifest_path = output_directory / "motion_inputs.json"
        _write_motion_input_manifest(
            motion_input_manifest_path,
            motion_inputs,
        )
        persisted_motion_inputs = _load_motion_input_manifest(
            motion_input_manifest_path
        )
        if persisted_motion_inputs != motion_inputs:
            raise ArtifactIntegrityError(
                "persisted motion input manifest differs after write"
            )
        composites = _compose_motion_sequence(
            source_paths=sources,
            generated_paths=generated,
            foreground_mask_paths=foregrounds,
            output_directory=output_directory / "composite_frames",
            expected_width=expected_width,
            expected_height=expected_height,
        )
        proof_manifest = finalize_proof_manifest(ingest, composites)
        proof_manifest_path = output_directory / "proof_manifest.json"
        write_proof_manifest_json(proof_manifest_path, proof_manifest)
        audit = _verify_motion_artifacts(
            motion_input_manifest=persisted_motion_inputs,
            proof_manifest=proof_manifest,
            source_paths=sources,
            generated_paths=generated,
            foreground_mask_paths=foregrounds,
            core_mask_paths=core_paths,
            composite_paths=composites,
        )
        if not (
            audit.core_passed
            and audit.artifact_integrity_passed
            and audit.deterministic_composition_passed
        ):
            raise MotionProofError(
                "motion artifacts failed exact-core or deterministic verification"
            )
        if require_canonical_claim and not audit.passed:
            raise MotionProofError(
                "motion artifacts did not satisfy the canonical proof contract"
            )
        audit_path = output_directory / "motion_audit.json"
        _write_json(
            audit_path,
            {
                "audit": asdict(audit),
                "claim": VERIFIED_CORE_CLAIM if audit.passed else None,
                "motion_input_digest_sha256": motion_inputs.digest_sha256,
                "proof_manifest_digest_sha256": proof_manifest.digest_sha256,
                "source_sequence_digest_sha256": (
                    motion_inputs.source_sequence_digest_sha256
                ),
                "source_ingest_digest_sha256": (
                    motion_inputs.source_ingest_digest_sha256
                ),
                "schema_version": 1,
            },
        )
        return MotionProofResult(
            source_paths=sources,
            generated_paths=generated,
            foreground_mask_paths=foregrounds,
            core_mask_paths=core_paths,
            composite_paths=composites,
            motion_input_manifest_path=motion_input_manifest_path,
            proof_manifest_path=proof_manifest_path,
            audit_path=audit_path,
            motion_input_manifest=persisted_motion_inputs,
            manifest=proof_manifest,
            audit=audit,
        )
    except Exception:
        shutil.rmtree(output_directory, ignore_errors=True)
        raise


def run_canonical_motion_proof(
    *,
    source_paths: Sequence[Path],
    generated_paths: Sequence[Path],
    foreground_mask_paths: Sequence[Path],
    source_media_provenance: DecodeProvenance,
    motion_root: Path,
    output_directory: Path,
) -> MotionProofResult:
    """Build a no-spend proof from canonical decoded frames and temporal masks.

    This public artifact boundary admits exactly 1280x720 RGB frames, 121 ordered
    masks and source provenance establishing a 24/1 FPS MP4 decode. Its output
    must be a child of the caller's dedicated motion artifact root.
    """
    if source_media_provenance is None:
        raise MotionProofError("canonical motion proof requires source provenance")
    return _run_motion_proof(
        source_paths=source_paths,
        generated_paths=generated_paths,
        foreground_mask_paths=foreground_mask_paths,
        motion_root=motion_root,
        output_directory=output_directory,
        expected_width=CANONICAL_CONTRACT.width,
        expected_height=CANONICAL_CONTRACT.height,
        expected_frame_count=CANONICAL_CONTRACT.frame_count,
        source_media_provenance=source_media_provenance,
        require_canonical_claim=True,
    )
