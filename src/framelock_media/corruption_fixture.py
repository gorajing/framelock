from __future__ import annotations

from dataclasses import dataclass, replace
import hashlib
import json
from pathlib import Path
import shutil

import numpy as np

from .artifacts import load_rgb_png, save_rgb_png, sha256_file
from .contract import DecodeProvenance
from .masks import load_core_mask
from .verify import (
    GenerationBinding,
    MaskParameters,
    ProofFrame,
    ProofManifest,
    SequenceAudit,
    calculate_proof_manifest_digest,
    verify_persisted_sequence,
    write_audit_json,
    write_proof_manifest_json,
)


@dataclass(frozen=True)
class CorruptionFixtureResult:
    corrupted_frame_path: Path
    manifest_path: Path
    audit_path: Path
    summary_path: Path
    manifest: ProofManifest
    audit: SequenceAudit


def _rgb_sha256(rgb: np.ndarray) -> str:
    return hashlib.sha256(
        np.ascontiguousarray(rgb).tobytes(order="C")
    ).hexdigest()


def _decode_provenance(raw: object) -> DecodeProvenance | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("proof media provenance must be an object or null")
    values = dict(raw)
    for field in ("probe_argv", "decode_argv"):
        value = values.get(field)
        if not isinstance(value, list) or not all(
            isinstance(item, str) for item in value
        ):
            raise ValueError(f"proof media provenance has invalid {field}")
        values[field] = tuple(value)
    try:
        return DecodeProvenance(**values)
    except TypeError as error:
        raise ValueError("proof media provenance is malformed") from error


def load_proof_manifest(path: Path) -> ProofManifest:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("proof manifest must be a JSON object")
    frames_raw = payload.get("frames")
    mask_raw = payload.get("mask_parameters")
    if not isinstance(frames_raw, list) or not isinstance(mask_raw, dict):
        raise ValueError("proof manifest has invalid frame or mask evidence")
    try:
        frames = tuple(ProofFrame(**item) for item in frames_raw)
        mask_parameters = MaskParameters(**mask_raw)
    except (TypeError, AttributeError) as error:
        raise ValueError("proof manifest frame evidence is malformed") from error
    binding_raw = payload.get("generation_binding")
    generation_binding = None
    if binding_raw is not None:
        if not isinstance(binding_raw, dict):
            raise ValueError("proof generation binding must be an object or null")
        binding_values = dict(binding_raw)
        binding_values["generated_media_provenance"] = _decode_provenance(
            binding_values.get("generated_media_provenance")
        )
        if binding_values["generated_media_provenance"] is None:
            raise ValueError("proof generation binding has no media provenance")
        try:
            generation_binding = GenerationBinding(**binding_values)
        except TypeError as error:
            raise ValueError("proof generation binding is malformed") from error
    values = dict(payload)
    values["frames"] = frames
    values["mask_parameters"] = mask_parameters
    values["media_provenance"] = _decode_provenance(
        values.get("media_provenance")
    )
    values["generation_binding"] = generation_binding
    try:
        return ProofManifest(**values)
    except TypeError as error:
        raise ValueError("proof manifest is malformed") from error


def create_deliberate_corruption_fixture_from_manifest(
    *,
    proof_manifest_path: Path,
    output_directory: Path,
    frame_index: int = 60,
) -> CorruptionFixtureResult:
    manifest = load_proof_manifest(proof_manifest_path)
    return create_deliberate_corruption_fixture(
        manifest=manifest,
        source_paths=tuple(Path(frame.source_path) for frame in manifest.frames),
        core_mask_paths=tuple(
            Path(frame.core_mask_path) for frame in manifest.frames
        ),
        composite_paths=tuple(
            Path(frame.composite_path) for frame in manifest.frames
        ),
        output_directory=output_directory,
        frame_index=frame_index,
    )


def create_deliberate_corruption_fixture(
    *,
    manifest: ProofManifest,
    source_paths: tuple[Path, ...],
    core_mask_paths: tuple[Path, ...],
    composite_paths: tuple[Path, ...],
    output_directory: Path,
    frame_index: int = 60,
) -> CorruptionFixtureResult:
    """Run the real verifier on a copied one-sample corruption fixture."""
    if output_directory.exists():
        raise FileExistsError(
            f"corruption fixture directory exists: {output_directory}"
        )
    if not 0 <= frame_index < len(manifest.frames):
        raise ValueError("corruption frame index is outside the proof sequence")
    original_audit = verify_persisted_sequence(
        manifest,
        source_paths=source_paths,
        core_mask_paths=core_mask_paths,
        composite_paths=composite_paths,
    )
    if not original_audit.core_passed or not original_audit.artifact_integrity_passed:
        raise ValueError("canonical evidence must pass before negative testing")
    if (
        original_audit.deterministic_composition_checked
        and not original_audit.deterministic_composition_passed
    ):
        raise ValueError("canonical composition must pass before negative testing")
    original_composite_sha256s = tuple(
        sha256_file(path) for path in composite_paths
    )

    output_directory.mkdir(parents=True)
    try:
        corrupted_frame_path = (
            output_directory / f"corrupted_composite_{frame_index:06d}.png"
        )
        corrupted = load_rgb_png(composite_paths[frame_index])
        core = load_core_mask(core_mask_paths[frame_index])
        protected = np.argwhere(core)
        if protected.size == 0:
            raise ValueError("corruption fixture requires a non-empty protected core")
        y, x = protected[0]
        corrupted[int(y), int(x), 1] ^= np.uint8(1)
        save_rgb_png(corrupted_frame_path, corrupted)
        persisted_corrupted = load_rgb_png(corrupted_frame_path)
        corrupted_frame_file_sha256 = sha256_file(corrupted_frame_path)
        corrupted_frame_rgb_sha256 = _rgb_sha256(persisted_corrupted)

        frames = list(manifest.frames)
        frames[frame_index] = replace(
            frames[frame_index],
            composite_path=str(corrupted_frame_path.resolve()),
        )
        provisional = replace(
            manifest,
            frames=tuple(frames),
            digest_sha256="",
        )
        fixture_manifest = replace(
            provisional,
            digest_sha256=calculate_proof_manifest_digest(provisional),
        )
        fixture_composites = list(composite_paths)
        fixture_composites[frame_index] = corrupted_frame_path
        audit = verify_persisted_sequence(
            fixture_manifest,
            source_paths=source_paths,
            core_mask_paths=core_mask_paths,
            composite_paths=tuple(fixture_composites),
        )
        if (
            audit.passed
            or audit.total_changed_core_pixels != 1
            or audit.total_changed_core_channel_samples != 1
            or audit.worst_maximum_absolute_channel_delta != 1
        ):
            raise ValueError("deliberate corruption did not produce the exact failure")
        corrupted_frame_audit = next(
            (
                frame
                for frame in audit.frame_audits
                if frame.index == frame_index
            ),
            None,
        )
        if corrupted_frame_audit is None:
            raise ValueError("deliberate corruption audit omitted its frame")

        manifest_path = output_directory / "corruption_manifest.json"
        audit_path = output_directory / "corruption_audit.json"
        write_proof_manifest_json(manifest_path, fixture_manifest)
        write_audit_json(audit_path, audit, fixture_manifest)
        if tuple(sha256_file(path) for path in composite_paths) != (
            original_composite_sha256s
        ):
            raise ValueError("canonical composite evidence changed during negative test")

        summary_path = output_directory / "corruption_summary.json"
        summary = {
            "schema_version": 2,
            "fixture": "one_channel_one_pixel_protected_core_corruption",
            "corrupted_frame_index": frame_index,
            "corrupted_channel": 1,
            "corrupted_frame_path": str(corrupted_frame_path.resolve()),
            "corrupted_frame_file_sha256": corrupted_frame_file_sha256,
            "corrupted_frame_rgb_sha256": corrupted_frame_rgb_sha256,
            "corrupted_frame_output_core_sha256": (
                corrupted_frame_audit.output_core_sha256
            ),
            "passed": audit.passed,
            "changed_core_pixels": audit.total_changed_core_pixels,
            "changed_core_channel_samples": (
                audit.total_changed_core_channel_samples
            ),
            "worst_maximum_absolute_channel_delta": (
                audit.worst_maximum_absolute_channel_delta
            ),
            "canonical_artifacts_mutated": False,
            "manifest_path": str(manifest_path.resolve()),
            "manifest_sha256": sha256_file(manifest_path),
            "audit_path": str(audit_path.resolve()),
            "audit_sha256": sha256_file(audit_path),
        }
        with summary_path.open("x", encoding="utf-8") as handle:
            json.dump(summary, handle, indent=2, sort_keys=True)
            handle.write("\n")
    except Exception:
        shutil.rmtree(output_directory, ignore_errors=True)
        raise
    return CorruptionFixtureResult(
        corrupted_frame_path=corrupted_frame_path,
        manifest_path=manifest_path,
        audit_path=audit_path,
        summary_path=summary_path,
        manifest=fixture_manifest,
        audit=audit,
    )
