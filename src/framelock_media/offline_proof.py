from __future__ import annotations

from dataclasses import asdict, dataclass
import json
from pathlib import Path
import shutil

import numpy as np
from PIL import Image

from .artifacts import (
    load_rgb_png,
    save_core_mask_png,
    save_edit_mask_png,
    save_rgb_png,
    sha256_file,
)
from .composite import compose_frame
from .contract import CANONICAL_CONTRACT
from .ffmpeg_pipeline import (
    SourceAudioProvenance,
    decode_mask_transport,
    decode_rgb24_frames_with_provenance,
    encode_mask_transport,
    encode_preview,
    materialize_static_mask_sequence,
    prepare_source_audio,
    validate_mask_transport_round_trip,
)
from .masks import DerivedMasks, derive_masks
from .verify import (
    ProofManifest,
    SequenceAudit,
    VERIFIED_CORE_CLAIM,
    finalize_proof_manifest,
    freeze_ingest_manifest,
    verify_persisted_sequence,
    write_audit_json,
    write_proof_manifest_json,
)


class OfflineProofError(RuntimeError):
    """Raised when the deterministic proof fixture cannot earn its claim."""


@dataclass(frozen=True)
class OfflineProofResult:
    source_paths: tuple[Path, ...]
    core_mask_paths: tuple[Path, ...]
    edit_mask_paths: tuple[Path, ...]
    generated_paths: tuple[Path, ...]
    composite_paths: tuple[Path, ...]
    mask_transport_path: Path
    source_audio: SourceAudioProvenance
    source_audio_manifest_path: Path
    normalized_source_audio_path: Path | None
    preview_path: Path
    preview_label: str
    proof_manifest_path: Path
    audit_path: Path
    manifest: ProofManifest
    audit: SequenceAudit


@dataclass(frozen=True)
class PreparedCanonicalSource:
    source_mp4: Path
    prepared_foreground_mask: Path
    source_paths: tuple[Path, ...]
    core_mask_paths: tuple[Path, ...]
    edit_mask_paths: tuple[Path, ...]
    mask_transport_path: Path
    source_audio: SourceAudioProvenance
    source_audio_manifest_path: Path
    normalized_source_audio_path: Path | None
    proof_manifest_path: Path
    summary_path: Path
    manifest: ProofManifest


def _load_grayscale_mask(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        if image.format != "PNG" or image.mode != "L":
            raise OfflineProofError("prepared foreground mask must be an L-mode PNG")
        if bool(getattr(image, "is_animated", False)) or image.n_frames != 1:
            raise OfflineProofError(
                "prepared foreground mask must be a single-frame static PNG"
            )
        grayscale = np.array(image, dtype=np.uint8, copy=True)
    expected_shape = (CANONICAL_CONTRACT.height, CANONICAL_CONTRACT.width)
    if grayscale.shape != expected_shape:
        raise OfflineProofError("prepared foreground mask geometry is noncanonical")
    return grayscale


def _persist_static_mask_artifacts(
    root: Path, source_path: Path, masks: DerivedMasks
) -> tuple[Path, Path, Path, Path]:
    root.mkdir(parents=True, exist_ok=False)
    foreground_path = root / "prepared_foreground.png"
    shutil.copyfile(source_path, foreground_path)
    core_path = root / "protected_core.png"
    boundary_path = root / "feather_boundary.png"
    edit_path = root / "ltx_edit_mask.png"
    save_core_mask_png(core_path, masks.core)
    save_core_mask_png(boundary_path, masks.edge)
    save_edit_mask_png(edit_path, masks.edit_mask)
    return foreground_path, core_path, boundary_path, edit_path


def _materialize_core_sequence(
    core: np.ndarray, output_directory: Path
) -> tuple[Path, ...]:
    output_directory.mkdir(parents=True, exist_ok=False)
    paths: list[Path] = []
    for index in range(CANONICAL_CONTRACT.frame_count):
        path = output_directory / f"core_{index:06d}.png"
        save_core_mask_png(path, core)
        paths.append(path)
    return tuple(paths)


def _synthetic_generated_frame(source: np.ndarray) -> np.ndarray:
    # Every channel changes while the source's temporal variation remains visible.
    xor_key = np.array([0xD3, 0x7A, 0x35], dtype=np.uint8)
    return np.ascontiguousarray(np.bitwise_xor(source, xor_key))


def _materialize_generated_sequence(
    source_paths: tuple[Path, ...], output_directory: Path
) -> tuple[Path, ...]:
    output_directory.mkdir(parents=True, exist_ok=False)
    paths: list[Path] = []
    for index, source_path in enumerate(source_paths):
        generated = _synthetic_generated_frame(load_rgb_png(source_path))
        path = output_directory / f"generated_{index:06d}.png"
        save_rgb_png(path, generated)
        paths.append(path)
    return tuple(paths)


def _compose_sequence(
    source_paths: tuple[Path, ...],
    generated_paths: tuple[Path, ...],
    masks: DerivedMasks,
    output_directory: Path,
) -> tuple[Path, ...]:
    output_directory.mkdir(parents=True, exist_ok=False)
    paths: list[Path] = []
    for index, (source_path, generated_path) in enumerate(
        zip(source_paths, generated_paths)
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


def _materialize_source_baseline(
    source_paths: tuple[Path, ...], output_directory: Path
) -> tuple[Path, ...]:
    """Copy accepted source frames into a distinct pre-generation proof domain."""
    output_directory.mkdir(parents=True, exist_ok=False)
    paths: list[Path] = []
    for index, source_path in enumerate(source_paths):
        path = output_directory / f"baseline_{index:06d}.png"
        shutil.copyfile(source_path, path)
        paths.append(path)
    return tuple(paths)


def prepare_canonical_source(
    source_mp4: Path,
    prepared_foreground_mask: Path,
    output_directory: Path,
) -> PreparedCanonicalSource:
    """Freeze a user-owned source and static mask before any paid generation."""
    if output_directory.exists():
        raise FileExistsError(
            f"source preparation directory exists: {output_directory}"
        )
    output_directory.mkdir(parents=True)
    try:
        inputs = output_directory / "inputs"
        inputs.mkdir()
        accepted_source = inputs / "source.mp4"
        accepted_foreground = inputs / "foreground.png"
        shutil.copyfile(source_mp4, accepted_source)
        shutil.copyfile(prepared_foreground_mask, accepted_foreground)

        proof_directory = output_directory / "proof"
        proof_directory.mkdir()
        source_audio_manifest_path = proof_directory / "source_audio.json"
        source_audio = prepare_source_audio(
            accepted_source,
            proof_directory / "source_audio.wav",
            source_audio_manifest_path,
        )
        normalized_source_audio_path = (
            Path(source_audio.normalized_audio_path)
            if source_audio.normalized_audio_path is not None
            else None
        )
        decoded_source = decode_rgb24_frames_with_provenance(
            accepted_source,
            proof_directory / "source_frames",
        )
        source_paths = decoded_source.paths
        masks = derive_masks(_load_grayscale_mask(accepted_foreground))
        _, _, _, static_edit_path = _persist_static_mask_artifacts(
            proof_directory / "masks",
            accepted_foreground,
            masks,
        )
        core_paths = _materialize_core_sequence(
            masks.core,
            proof_directory / "core_masks",
        )
        edit_paths = materialize_static_mask_sequence(
            static_edit_path,
            proof_directory / "edit_masks",
        )
        mask_transport_path = proof_directory / "mask_transport.mp4"
        encode_mask_transport(edit_paths, mask_transport_path)
        decoded_edit_paths = decode_mask_transport(
            mask_transport_path,
            proof_directory / "mask_transport_roundtrip",
        )
        validate_mask_transport_round_trip(edit_paths, decoded_edit_paths)

        ingest_manifest = freeze_ingest_manifest(
            source_paths,
            core_paths,
            media_provenance=decoded_source.provenance,
        )
        baseline_paths = _materialize_source_baseline(
            source_paths,
            proof_directory / "source_baseline",
        )
        manifest = finalize_proof_manifest(ingest_manifest, baseline_paths)
        proof_manifest_path = proof_directory / "proof_manifest.json"
        write_proof_manifest_json(proof_manifest_path, manifest)

        summary_path = output_directory / "source_preparation.json"
        summary = {
            "schema_version": 2,
            "state": "validated",
            "claim": None,
            "next_step": "generation",
            "source": {
                "path": str(accepted_source.resolve()),
                "sha256": sha256_file(accepted_source),
            },
            "foreground_mask": {
                "path": str(accepted_foreground.resolve()),
                "sha256": sha256_file(accepted_foreground),
                "protected_core_pixels_per_frame": int(
                    np.count_nonzero(masks.core)
                ),
            },
            "proof_manifest": {
                "path": str(proof_manifest_path.resolve()),
                "sha256": sha256_file(proof_manifest_path),
                "ingest_digest_sha256": ingest_manifest.digest_sha256,
            },
            "source_audio": {
                "present": source_audio.source_audio_present,
                "manifest_path": str(source_audio_manifest_path.resolve()),
                "manifest_sha256": sha256_file(source_audio_manifest_path),
                "normalized_audio_path": (
                    str(normalized_source_audio_path.resolve())
                    if normalized_source_audio_path is not None
                    else None
                ),
                "normalized_audio_sha256": (
                    source_audio.normalized_audio_file_sha256
                ),
                "normalization_operation": (
                    source_audio.normalization_operation
                ),
                "target_sample_count": source_audio.target_sample_count,
                "claim_scope": source_audio.claim_scope,
            },
            "media_provenance": asdict(decoded_source.provenance),
        }
        summary_path.write_text(
            json.dumps(summary, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    except Exception:
        shutil.rmtree(output_directory, ignore_errors=True)
        raise

    return PreparedCanonicalSource(
        source_mp4=accepted_source,
        prepared_foreground_mask=accepted_foreground,
        source_paths=source_paths,
        core_mask_paths=core_paths,
        edit_mask_paths=edit_paths,
        mask_transport_path=mask_transport_path,
        source_audio=source_audio,
        source_audio_manifest_path=source_audio_manifest_path,
        normalized_source_audio_path=normalized_source_audio_path,
        proof_manifest_path=proof_manifest_path,
        summary_path=summary_path,
        manifest=manifest,
    )


def run_synthetic_canonical_proof(
    source_mp4: Path, prepared_foreground_mask: Path, output_directory: Path
) -> OfflineProofResult:
    """Run the complete deterministic artifact graph without model inference."""
    if output_directory.exists():
        raise FileExistsError(f"offline proof directory exists: {output_directory}")
    output_directory.mkdir(parents=True)

    source_audio_manifest_path = output_directory / "source_audio.json"
    source_audio = prepare_source_audio(
        source_mp4,
        output_directory / "source_audio.wav",
        source_audio_manifest_path,
    )
    normalized_source_audio_path = (
        Path(source_audio.normalized_audio_path)
        if source_audio.normalized_audio_path is not None
        else None
    )

    decoded_source = decode_rgb24_frames_with_provenance(
        source_mp4, output_directory / "source_frames"
    )
    source_paths = decoded_source.paths
    grayscale = _load_grayscale_mask(prepared_foreground_mask)
    masks = derive_masks(grayscale)
    _, _, _, static_edit_path = _persist_static_mask_artifacts(
        output_directory / "masks", prepared_foreground_mask, masks
    )
    core_paths = _materialize_core_sequence(
        masks.core, output_directory / "core_masks"
    )
    edit_paths = materialize_static_mask_sequence(
        static_edit_path, output_directory / "edit_masks"
    )

    # The source/core trust root is frozen before generation or composition.
    ingest_manifest = freeze_ingest_manifest(
        source_paths,
        core_paths,
        media_provenance=decoded_source.provenance,
    )

    mask_transport_path = output_directory / "mask_transport.mp4"
    encode_mask_transport(edit_paths, mask_transport_path)
    decoded_edit_paths = decode_mask_transport(
        mask_transport_path, output_directory / "mask_transport_roundtrip"
    )
    validate_mask_transport_round_trip(edit_paths, decoded_edit_paths)

    generated_paths = _materialize_generated_sequence(
        source_paths, output_directory / "generated_frames"
    )
    composite_paths = _compose_sequence(
        source_paths,
        generated_paths,
        masks,
        output_directory / "composite_frames",
    )
    manifest = finalize_proof_manifest(ingest_manifest, composite_paths)
    audit = verify_persisted_sequence(
        manifest,
        source_paths=source_paths,
        core_mask_paths=core_paths,
        composite_paths=composite_paths,
    )
    if not audit.passed:
        raise OfflineProofError("canonical synthetic sequence did not pass verification")

    proof_manifest_path = output_directory / "proof_manifest.json"
    audit_path = output_directory / "audit.json"
    write_proof_manifest_json(proof_manifest_path, manifest)
    write_audit_json(audit_path, audit, manifest)
    preview_path = output_directory / "preview.mp4"
    encode_preview(
        composite_paths,
        preview_path,
        source_audio=source_audio,
        expected_source_file_sha256=(
            decoded_source.provenance.source_file_sha256
        ),
    )
    return OfflineProofResult(
        source_paths=source_paths,
        core_mask_paths=core_paths,
        edit_mask_paths=edit_paths,
        generated_paths=generated_paths,
        composite_paths=composite_paths,
        mask_transport_path=mask_transport_path,
        source_audio=source_audio,
        source_audio_manifest_path=source_audio_manifest_path,
        normalized_source_audio_path=normalized_source_audio_path,
        preview_path=preview_path,
        preview_label="Preview derived from verified canonical frames",
        proof_manifest_path=proof_manifest_path,
        audit_path=audit_path,
        manifest=manifest,
        audit=audit,
    )
