from __future__ import annotations

from dataclasses import asdict, dataclass, replace
import hashlib
import json
from pathlib import Path
from typing import Sequence

import numpy as np
from PIL import Image

from .artifacts import load_rgb_png, sha256_file
from .composite import compose_frame
from .contract import CANONICAL_CONTRACT, DecodeProvenance
from .masks import derive_masks, load_core_mask


VERIFIED_CORE_CLAIM = (
    "Protected core verified — canonical pre-encode frame sequence."
)


class ArtifactIntegrityError(ValueError):
    """Raised when a frozen artifact or manifest trust anchor changes."""


class EmptyProtectedCoreError(ValueError):
    """Raised when an audit frame contains no protected pixels."""


class SequenceBindingError(ValueError):
    """Raised when artifact identity or order differs from the manifest."""


@dataclass(frozen=True)
class MaskParameters:
    foreground_threshold: int = 128
    erosion_radius: int = 4


@dataclass(frozen=True)
class IngestFrame:
    index: int
    source_path: str
    core_mask_path: str
    source_file_sha256: str
    source_rgb_sha256: str
    core_mask_file_sha256: str


@dataclass(frozen=True)
class IngestManifest:
    frames: tuple[IngestFrame, ...]
    mask_parameters: MaskParameters
    expected_width: int
    expected_height: int
    expected_frame_count: int
    media_provenance: DecodeProvenance | None
    digest_sha256: str
    schema_version: int = 1


@dataclass(frozen=True)
class ProofFrame:
    index: int
    source_path: str
    core_mask_path: str
    composite_path: str
    source_file_sha256: str
    source_rgb_sha256: str
    core_mask_file_sha256: str
    composite_file_sha256: str
    generated_path: str | None = None
    generated_file_sha256: str | None = None
    generated_rgb_sha256: str | None = None


@dataclass(frozen=True)
class GenerationBinding:
    prepared_foreground_mask_path: str
    prepared_foreground_mask_file_sha256: str
    generated_media_provenance: DecodeProvenance


@dataclass(frozen=True)
class ProofManifest:
    frames: tuple[ProofFrame, ...]
    mask_parameters: MaskParameters
    expected_width: int
    expected_height: int
    expected_frame_count: int
    media_provenance: DecodeProvenance | None
    ingest_digest_sha256: str
    digest_sha256: str
    generation_binding: GenerationBinding | None = None
    ingest_schema_version: int = 1
    schema_version: int = 1


@dataclass(frozen=True)
class FrameAudit:
    index: int
    passed: bool
    core_passed: bool
    artifact_integrity_passed: bool
    protected_core_pixels: int
    changed_core_pixels: int
    changed_core_channel_samples: int
    maximum_absolute_channel_delta: int
    mean_absolute_channel_delta: float
    source_core_sha256: str
    output_core_sha256: str
    generated_artifact_integrity_passed: bool | None = None
    deterministic_composition_passed: bool | None = None
    stage: str = "canonical_pre_encode"


@dataclass(frozen=True)
class SequenceAudit:
    passed: bool
    canonical_contract_passed: bool
    core_passed: bool
    artifact_integrity_passed: bool
    frames_audited: int
    frames_with_nonempty_core: int
    total_core_pixels: int
    total_changed_core_pixels: int
    total_changed_core_channel_samples: int
    worst_maximum_absolute_channel_delta: int
    core_hash_match_count: int
    manifest_digest_sha256: str
    frame_audits: tuple[FrameAudit, ...]
    deterministic_composition_checked: bool = False
    deterministic_composition_passed: bool = False
    stage: str = "canonical_pre_encode"


def _rgb_sha256(rgb: np.ndarray) -> str:
    return hashlib.sha256(np.ascontiguousarray(rgb).tobytes(order="C")).hexdigest()


def _canonical_json_bytes(payload: object) -> bytes:
    return json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("utf-8")


def _contract_payload(
    *, expected_width: int, expected_height: int, expected_frame_count: int
) -> dict[str, int]:
    return {
        "expected_frame_count": expected_frame_count,
        "expected_height": expected_height,
        "expected_width": expected_width,
    }


def _ingest_manifest_payload(
    frames: Sequence[IngestFrame],
    parameters: MaskParameters,
    *,
    expected_width: int,
    expected_height: int,
    expected_frame_count: int,
    media_provenance: DecodeProvenance | None,
    schema_version: int,
) -> bytes:
    payload = {
        "contract": _contract_payload(
            expected_width=expected_width,
            expected_height=expected_height,
            expected_frame_count=expected_frame_count,
        ),
        "frames": [asdict(frame) for frame in frames],
        "mask_parameters": asdict(parameters),
        "media_provenance": (
            asdict(media_provenance) if media_provenance is not None else None
        ),
        "schema_version": schema_version,
    }
    return _canonical_json_bytes(payload)


def _proof_manifest_payload(manifest: ProofManifest) -> bytes:
    payload = {
        "contract": _contract_payload(
            expected_width=manifest.expected_width,
            expected_height=manifest.expected_height,
            expected_frame_count=manifest.expected_frame_count,
        ),
        "frames": [asdict(frame) for frame in manifest.frames],
        "ingest_digest_sha256": manifest.ingest_digest_sha256,
        "ingest_schema_version": manifest.ingest_schema_version,
        "generation_binding": (
            asdict(manifest.generation_binding)
            if manifest.generation_binding is not None
            else None
        ),
        "mask_parameters": asdict(manifest.mask_parameters),
        "media_provenance": (
            asdict(manifest.media_provenance)
            if manifest.media_provenance is not None
            else None
        ),
        "schema_version": manifest.schema_version,
    }
    return _canonical_json_bytes(payload)


def calculate_proof_manifest_digest(manifest: ProofManifest) -> str:
    """Return the canonical digest so exported manifests are independently checkable."""
    return hashlib.sha256(_proof_manifest_payload(manifest)).hexdigest()


def _require_contract_values(
    *, expected_width: int, expected_height: int, expected_frame_count: int
) -> None:
    if expected_width <= 0 or expected_height <= 0 or expected_frame_count <= 0:
        raise SequenceBindingError("manifest contract values must be positive")


def _require_consecutive_indices(frames: Sequence[IngestFrame | ProofFrame]) -> None:
    if tuple(frame.index for frame in frames) != tuple(range(len(frames))):
        raise SequenceBindingError("manifest frame indices must be consecutive from zero")


def _resolved_unique(paths: Sequence[str], *, role: str) -> set[str]:
    resolved = [str(Path(path).resolve()) for path in paths]
    if len(set(resolved)) != len(resolved):
        raise SequenceBindingError(f"{role} artifact paths must be unique")
    return set(resolved)


def _validate_path_domains(
    frames: Sequence[IngestFrame | ProofFrame], *, include_composites: bool
) -> None:
    sources = _resolved_unique([frame.source_path for frame in frames], role="source")
    masks = _resolved_unique([frame.core_mask_path for frame in frames], role="core mask")
    if sources & masks:
        raise SequenceBindingError("source and core-mask artifacts must be distinct")
    if include_composites:
        proof_frames = [frame for frame in frames if isinstance(frame, ProofFrame)]
        composites = _resolved_unique(
            [frame.composite_path for frame in proof_frames], role="composite"
        )
        if composites & (sources | masks):
            raise SequenceBindingError(
                "source, core-mask and composite artifacts must be distinct"
            )
        generated = _resolved_unique(
            [
                frame.generated_path
                for frame in proof_frames
                if frame.generated_path is not None
            ],
            role="generated",
        )
        if generated & (sources | masks | composites):
            raise SequenceBindingError(
                "source, generated, core-mask and composite artifacts must be distinct"
            )


def _calculate_ingest_digest(manifest: IngestManifest) -> str:
    return hashlib.sha256(
        _ingest_manifest_payload(
            manifest.frames,
            manifest.mask_parameters,
            expected_width=manifest.expected_width,
            expected_height=manifest.expected_height,
            expected_frame_count=manifest.expected_frame_count,
            media_provenance=manifest.media_provenance,
            schema_version=manifest.schema_version,
        )
    ).hexdigest()


def _project_ingest_digest(manifest: ProofManifest) -> str:
    ingest_frames = tuple(
        IngestFrame(
            index=frame.index,
            source_path=frame.source_path,
            core_mask_path=frame.core_mask_path,
            source_file_sha256=frame.source_file_sha256,
            source_rgb_sha256=frame.source_rgb_sha256,
            core_mask_file_sha256=frame.core_mask_file_sha256,
        )
        for frame in manifest.frames
    )
    return hashlib.sha256(
        _ingest_manifest_payload(
            ingest_frames,
            manifest.mask_parameters,
            expected_width=manifest.expected_width,
            expected_height=manifest.expected_height,
            expected_frame_count=manifest.expected_frame_count,
            media_provenance=manifest.media_provenance,
            schema_version=manifest.ingest_schema_version,
        )
    ).hexdigest()


def calculate_projected_ingest_digest(manifest: ProofManifest) -> str:
    """Recompute the ingest root represented by a proof manifest."""
    return _project_ingest_digest(manifest)


def _validate_media_provenance(
    provenance: DecodeProvenance,
    *,
    expected_width: int,
    expected_height: int,
    expected_frame_count: int,
) -> None:
    if (
        provenance.width != expected_width
        or provenance.height != expected_height
        or provenance.decoded_frame_count != expected_frame_count
    ):
        raise SequenceBindingError("decode provenance differs from manifest contract")
    if (
        provenance.source_container != "mp4"
        or provenance.frame_rate_numerator != 24
        or provenance.frame_rate_denominator != 1
        or not 0 <= provenance.max_pts_residual_microseconds <= 1_000
    ):
        raise SequenceBindingError("decode provenance is not canonical 24/1 media")
    if provenance.canonical_color_conversion != (
        "BT.709 limited-range YUV to full-range RGB24"
    ):
        raise SequenceBindingError("decode provenance color conversion is unknown")
    color_metadata_complete = all(
        value is not None
        for value in (
            provenance.source_color_range,
            provenance.source_color_space,
            provenance.source_color_transfer,
            provenance.source_color_primaries,
        )
    )
    if color_metadata_complete:
        if (
            provenance.color_conversion_basis != "declared_source_metadata"
            or provenance.color_conversion_assumption is not None
        ):
            raise SequenceBindingError(
                "decode provenance misstates declared color metadata"
            )
    elif (
        provenance.color_conversion_basis != "explicit_bt709_limited_fallback"
        or not provenance.color_conversion_assumption
    ):
        raise SequenceBindingError(
            "decode provenance omits the missing-color-metadata fallback"
        )
    if not provenance.ffmpeg_version or not provenance.ffprobe_version:
        raise SequenceBindingError("decode provenance tool versions are missing")
    if not provenance.decode_argv or not provenance.probe_argv:
        raise SequenceBindingError("decode provenance command arguments are missing")
    if (
        len(provenance.source_file_sha256) != 64
        or len(provenance.probe_json_sha256) != 64
        or len(provenance.presentation_timestamps_sha256) != 64
    ):
        raise SequenceBindingError("decode provenance hashes are malformed")
    source_media = Path(provenance.source_media_path)
    if not source_media.is_file():
        raise ArtifactIntegrityError("source media artifact is missing")
    if sha256_file(source_media) != provenance.source_file_sha256:
        raise ArtifactIntegrityError("source media hash no longer matches provenance")


def _validate_ingest_manifest(manifest: IngestManifest) -> None:
    _require_contract_values(
        expected_width=manifest.expected_width,
        expected_height=manifest.expected_height,
        expected_frame_count=manifest.expected_frame_count,
    )
    if len(manifest.frames) != manifest.expected_frame_count:
        raise SequenceBindingError("ingest frame count differs from its contract")
    _require_consecutive_indices(manifest.frames)
    _validate_path_domains(manifest.frames, include_composites=False)
    if manifest.media_provenance is not None:
        _validate_media_provenance(
            manifest.media_provenance,
            expected_width=manifest.expected_width,
            expected_height=manifest.expected_height,
            expected_frame_count=manifest.expected_frame_count,
        )
    if _calculate_ingest_digest(manifest) != manifest.digest_sha256:
        raise ArtifactIntegrityError("ingest manifest digest does not match")


def _validate_proof_manifest(manifest: ProofManifest) -> None:
    _require_contract_values(
        expected_width=manifest.expected_width,
        expected_height=manifest.expected_height,
        expected_frame_count=manifest.expected_frame_count,
    )
    if len(manifest.frames) != manifest.expected_frame_count:
        raise SequenceBindingError("proof frame count differs from its contract")
    _require_consecutive_indices(manifest.frames)
    _validate_path_domains(manifest.frames, include_composites=True)
    generated_fields = tuple(
        (
            frame.generated_path,
            frame.generated_file_sha256,
            frame.generated_rgb_sha256,
        )
        for frame in manifest.frames
    )
    generation_fields_complete = all(
        all(value is not None for value in values) for values in generated_fields
    )
    generation_fields_absent = all(
        all(value is None for value in values) for values in generated_fields
    )
    if not (generation_fields_complete or generation_fields_absent):
        raise SequenceBindingError("generated frame bindings must be all-or-none")
    if (manifest.generation_binding is None) != generation_fields_absent:
        raise SequenceBindingError(
            "generated frames and generation binding must be declared together"
        )
    if manifest.media_provenance is not None:
        _validate_media_provenance(
            manifest.media_provenance,
            expected_width=manifest.expected_width,
            expected_height=manifest.expected_height,
            expected_frame_count=manifest.expected_frame_count,
        )
    if manifest.generation_binding is not None:
        _validate_media_provenance(
            manifest.generation_binding.generated_media_provenance,
            expected_width=manifest.expected_width,
            expected_height=manifest.expected_height,
            expected_frame_count=manifest.expected_frame_count,
        )
        foreground_path = Path(
            manifest.generation_binding.prepared_foreground_mask_path
        )
        if not foreground_path.is_file():
            raise ArtifactIntegrityError("prepared foreground mask is missing")
        if (
            sha256_file(foreground_path)
            != manifest.generation_binding.prepared_foreground_mask_file_sha256
        ):
            raise ArtifactIntegrityError(
                "prepared foreground mask hash no longer matches"
            )
    if calculate_proof_manifest_digest(manifest) != manifest.digest_sha256:
        raise ArtifactIntegrityError("proof manifest digest does not match")
    if _project_ingest_digest(manifest) != manifest.ingest_digest_sha256:
        raise ArtifactIntegrityError("ingest manifest digest does not match proof frames")


def freeze_ingest_manifest(
    source_paths: Sequence[Path],
    core_mask_paths: Sequence[Path],
    *,
    expected_width: int = CANONICAL_CONTRACT.width,
    expected_height: int = CANONICAL_CONTRACT.height,
    expected_frame_count: int = CANONICAL_CONTRACT.frame_count,
    media_provenance: DecodeProvenance | None = None,
) -> IngestManifest:
    _require_contract_values(
        expected_width=expected_width,
        expected_height=expected_height,
        expected_frame_count=expected_frame_count,
    )
    if len(source_paths) != expected_frame_count or len(core_mask_paths) != expected_frame_count:
        raise SequenceBindingError(
            f"ingest sequences must contain exactly {expected_frame_count} frames"
        )
    source_strings = [str(path.resolve()) for path in source_paths]
    mask_strings = [str(path.resolve()) for path in core_mask_paths]
    _resolved_unique(source_strings, role="source")
    _resolved_unique(mask_strings, role="core mask")
    if set(source_strings) & set(mask_strings):
        raise SequenceBindingError("source and core-mask artifacts must be distinct")

    frames: list[IngestFrame] = []
    for index, (source_path, mask_path) in enumerate(
        zip(source_paths, core_mask_paths)
    ):
        source = load_rgb_png(source_path)
        mask = load_core_mask(mask_path)
        expected_shape = (expected_height, expected_width)
        if source.shape[:2] != expected_shape or mask.shape != expected_shape:
            raise SequenceBindingError("ingest artifact geometry is noncanonical")
        frames.append(
            IngestFrame(
                index=index,
                source_path=str(source_path.resolve()),
                core_mask_path=str(mask_path.resolve()),
                source_file_sha256=sha256_file(source_path),
                source_rgb_sha256=_rgb_sha256(source),
                core_mask_file_sha256=sha256_file(mask_path),
            )
        )
    parameters = MaskParameters()
    manifest = IngestManifest(
        frames=tuple(frames),
        mask_parameters=parameters,
        expected_width=expected_width,
        expected_height=expected_height,
        expected_frame_count=expected_frame_count,
        media_provenance=media_provenance,
        digest_sha256="",
    )
    return replace(manifest, digest_sha256=_calculate_ingest_digest(manifest))


def _verify_ingest_frame_integrity(frame: IngestFrame | ProofFrame) -> None:
    source_path = Path(frame.source_path)
    mask_path = Path(frame.core_mask_path)
    if sha256_file(source_path) != frame.source_file_sha256:
        raise ArtifactIntegrityError("source hash no longer matches ingest manifest")
    source = load_rgb_png(source_path)
    if _rgb_sha256(source) != frame.source_rgb_sha256:
        raise ArtifactIntegrityError("source decoded RGB hash no longer matches")
    if sha256_file(mask_path) != frame.core_mask_file_sha256:
        raise ArtifactIntegrityError("core mask hash no longer matches ingest manifest")
    core = load_core_mask(mask_path)
    if source.shape[:2] != core.shape:
        raise SequenceBindingError("ingest artifact geometry does not match")


def finalize_proof_manifest(
    ingest_manifest: IngestManifest,
    composite_paths: Sequence[Path],
    *,
    generated_paths: Sequence[Path] | None = None,
    prepared_foreground_mask: Path | None = None,
    generated_media_provenance: DecodeProvenance | None = None,
) -> ProofManifest:
    _validate_ingest_manifest(ingest_manifest)
    if len(composite_paths) != ingest_manifest.expected_frame_count:
        raise SequenceBindingError("composite sequence must match ingest manifest")
    composite_strings = [str(path.resolve()) for path in composite_paths]
    composites = _resolved_unique(composite_strings, role="composite")
    sources = {frame.source_path for frame in ingest_manifest.frames}
    masks = {frame.core_mask_path for frame in ingest_manifest.frames}
    if composites & (sources | masks):
        raise SequenceBindingError(
            "source, core-mask and composite artifacts must be distinct"
        )
    generation_values = (
        generated_paths,
        prepared_foreground_mask,
        generated_media_provenance,
    )
    if not (all(value is None for value in generation_values) or all(
        value is not None for value in generation_values
    )):
        raise SequenceBindingError(
            "generated paths, foreground mask and decode provenance are all-or-none"
        )
    if generated_paths is not None:
        if len(generated_paths) != ingest_manifest.expected_frame_count:
            raise SequenceBindingError(
                "generated sequence must match ingest manifest"
            )
        generated_strings = [str(path.resolve()) for path in generated_paths]
        generated_set = _resolved_unique(generated_strings, role="generated")
        if generated_set & (sources | masks | composites):
            raise SequenceBindingError(
                "source, generated, core-mask and composite artifacts must be distinct"
            )

    frames: list[ProofFrame] = []
    for index, (ingest_frame, composite_path) in enumerate(
        zip(ingest_manifest.frames, composite_paths, strict=True)
    ):
        _verify_ingest_frame_integrity(ingest_frame)
        source = load_rgb_png(Path(ingest_frame.source_path))
        composite = load_rgb_png(composite_path)
        expected_shape = (
            ingest_manifest.expected_height,
            ingest_manifest.expected_width,
            3,
        )
        if source.shape != expected_shape or composite.shape != expected_shape:
            raise SequenceBindingError("proof artifact geometry is noncanonical")
        generated_path = generated_paths[index] if generated_paths is not None else None
        generated_file_sha256: str | None = None
        generated_rgb_sha256: str | None = None
        if generated_path is not None:
            generated = load_rgb_png(generated_path)
            if generated.shape != expected_shape:
                raise SequenceBindingError(
                    "generated proof artifact geometry is noncanonical"
                )
            generated_file_sha256 = sha256_file(generated_path)
            generated_rgb_sha256 = _rgb_sha256(generated)
        frames.append(
            ProofFrame(
                **asdict(ingest_frame),
                composite_path=str(composite_path.resolve()),
                composite_file_sha256=sha256_file(composite_path),
                generated_path=(
                    str(generated_path.resolve())
                    if generated_path is not None
                    else None
                ),
                generated_file_sha256=generated_file_sha256,
                generated_rgb_sha256=generated_rgb_sha256,
            )
        )
    generation_binding = None
    if (
        prepared_foreground_mask is not None
        and generated_media_provenance is not None
    ):
        generation_binding = GenerationBinding(
            prepared_foreground_mask_path=str(
                prepared_foreground_mask.resolve()
            ),
            prepared_foreground_mask_file_sha256=sha256_file(
                prepared_foreground_mask
            ),
            generated_media_provenance=generated_media_provenance,
        )
    provisional = ProofManifest(
        frames=tuple(frames),
        mask_parameters=ingest_manifest.mask_parameters,
        expected_width=ingest_manifest.expected_width,
        expected_height=ingest_manifest.expected_height,
        expected_frame_count=ingest_manifest.expected_frame_count,
        media_provenance=ingest_manifest.media_provenance,
        ingest_digest_sha256=ingest_manifest.digest_sha256,
        digest_sha256="",
        generation_binding=generation_binding,
        ingest_schema_version=ingest_manifest.schema_version,
        schema_version=(2 if generation_binding is not None else 1),
    )
    return replace(
        provisional,
        digest_sha256=calculate_proof_manifest_digest(provisional),
    )


def hash_core_rgb_bytes(rgb: np.ndarray, core: np.ndarray) -> str:
    if rgb.dtype != np.uint8 or rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError("RGB frame must be HxWx3 uint8")
    if core.dtype != np.bool_ or core.shape != rgb.shape[:2]:
        raise ValueError("core must be a matching 2D boolean array")
    selected = np.ascontiguousarray(rgb[core])
    return hashlib.sha256(selected.tobytes(order="C")).hexdigest()


def _verify_persisted_frame(
    frame: ProofFrame,
    *,
    expected_width: int | None = None,
    expected_height: int | None = None,
) -> FrameAudit:
    source_path = Path(frame.source_path)
    mask_path = Path(frame.core_mask_path)
    composite_path = Path(frame.composite_path)
    _verify_ingest_frame_integrity(frame)
    source = load_rgb_png(source_path)
    core = load_core_mask(mask_path)
    composite = load_rgb_png(composite_path)
    if source.shape != composite.shape or source.shape[:2] != core.shape:
        raise SequenceBindingError("persisted artifact geometry does not match")
    if expected_width is not None and expected_height is not None:
        expected_rgb_shape = (expected_height, expected_width, 3)
        expected_mask_shape = (expected_height, expected_width)
        if source.shape != expected_rgb_shape or core.shape != expected_mask_shape:
            raise SequenceBindingError(
                "reopened artifact geometry differs from manifest contract"
            )
    protected_pixels = int(np.count_nonzero(core))
    if protected_pixels == 0:
        raise EmptyProtectedCoreError("protected core is empty")

    delta = np.abs(source.astype(np.int16) - composite.astype(np.int16))
    core_delta = delta[core]
    changed_samples = int(np.count_nonzero(core_delta))
    changed_pixels = int(np.count_nonzero(np.any(core_delta != 0, axis=1)))
    maximum_delta = int(np.max(core_delta))
    mean_delta = float(np.mean(core_delta, dtype=np.float64))
    source_hash = hash_core_rgb_bytes(source, core)
    output_hash = hash_core_rgb_bytes(composite, core)
    core_passed = (
        changed_pixels == 0
        and changed_samples == 0
        and maximum_delta == 0
        and source_hash == output_hash
    )
    composite_integrity_passed = (
        sha256_file(composite_path) == frame.composite_file_sha256
    )
    generated_integrity_passed: bool | None = None
    if frame.generated_path is not None:
        if frame.generated_file_sha256 is None or frame.generated_rgb_sha256 is None:
            raise SequenceBindingError("generated frame binding is incomplete")
        generated_path = Path(frame.generated_path)
        generated = load_rgb_png(generated_path)
        if generated.shape != source.shape:
            raise SequenceBindingError("generated artifact geometry does not match")
        generated_integrity_passed = (
            sha256_file(generated_path) == frame.generated_file_sha256
            and _rgb_sha256(generated) == frame.generated_rgb_sha256
        )
    artifact_integrity_passed = (
        composite_integrity_passed and generated_integrity_passed is not False
    )
    return FrameAudit(
        index=frame.index,
        passed=(
            core_passed
            and artifact_integrity_passed
            and generated_integrity_passed is not False
        ),
        core_passed=core_passed,
        artifact_integrity_passed=artifact_integrity_passed,
        protected_core_pixels=protected_pixels,
        changed_core_pixels=changed_pixels,
        changed_core_channel_samples=changed_samples,
        maximum_absolute_channel_delta=maximum_delta,
        mean_absolute_channel_delta=mean_delta,
        source_core_sha256=source_hash,
        output_core_sha256=output_hash,
        generated_artifact_integrity_passed=generated_integrity_passed,
    )


def verify_persisted_frame(frame: ProofFrame) -> FrameAudit:
    return _verify_persisted_frame(frame)


def _resolved_strings(paths: Sequence[Path]) -> tuple[str, ...]:
    return tuple(str(path.resolve()) for path in paths)


def _generation_masks(manifest: ProofManifest):
    binding = manifest.generation_binding
    if binding is None:
        return None
    foreground_path = Path(binding.prepared_foreground_mask_path)
    with Image.open(foreground_path) as image:
        if image.format != "PNG" or image.mode != "L":
            raise SequenceBindingError(
                "prepared foreground mask must be an L-mode PNG"
            )
        grayscale = np.array(image, dtype=np.uint8, copy=True)
    expected_shape = (manifest.expected_height, manifest.expected_width)
    if grayscale.shape != expected_shape:
        raise SequenceBindingError(
            "prepared foreground mask geometry differs from manifest contract"
        )
    return derive_masks(grayscale)


def verify_persisted_sequence(
    manifest: ProofManifest,
    *,
    source_paths: Sequence[Path],
    core_mask_paths: Sequence[Path],
    composite_paths: Sequence[Path],
) -> SequenceAudit:
    _validate_proof_manifest(manifest)
    expected_sources = tuple(frame.source_path for frame in manifest.frames)
    expected_masks = tuple(frame.core_mask_path for frame in manifest.frames)
    expected_composites = tuple(frame.composite_path for frame in manifest.frames)
    if (
        _resolved_strings(source_paths) != expected_sources
        or _resolved_strings(core_mask_paths) != expected_masks
        or _resolved_strings(composite_paths) != expected_composites
    ):
        raise SequenceBindingError("provided sequence does not match the manifest")
    generation_masks = _generation_masks(manifest)
    frame_audits: list[FrameAudit] = []
    for frame in manifest.frames:
        audit = _verify_persisted_frame(
            frame,
            expected_width=manifest.expected_width,
            expected_height=manifest.expected_height,
        )
        if generation_masks is not None:
            core = load_core_mask(Path(frame.core_mask_path))
            if not np.array_equal(core, generation_masks.core):
                raise SequenceBindingError(
                    "persisted core mask differs from foreground-derived core"
                )
            assert frame.generated_path is not None
            expected_composite = compose_frame(
                load_rgb_png(Path(frame.source_path)),
                load_rgb_png(Path(frame.generated_path)),
                generation_masks.core,
                generation_masks.protect_alpha,
            )
            deterministic_composition_passed = np.array_equal(
                expected_composite, load_rgb_png(Path(frame.composite_path))
            )
            audit = replace(
                audit,
                passed=audit.passed and deterministic_composition_passed,
                deterministic_composition_passed=(
                    deterministic_composition_passed
                ),
            )
        frame_audits.append(audit)
    audits = tuple(frame_audits)
    frames_nonempty = sum(audit.protected_core_pixels > 0 for audit in audits)
    core_hash_matches = sum(
        audit.source_core_sha256 == audit.output_core_sha256 for audit in audits
    )
    core_passed = all(audit.core_passed for audit in audits)
    integrity_passed = all(audit.artifact_integrity_passed for audit in audits)
    deterministic_composition_checked = generation_masks is not None
    deterministic_composition_passed = (
        deterministic_composition_checked
        and all(
            audit.deterministic_composition_passed is True for audit in audits
        )
    )
    canonical_contract_passed = (
        manifest.expected_width == CANONICAL_CONTRACT.width
        and manifest.expected_height == CANONICAL_CONTRACT.height
        and manifest.expected_frame_count == CANONICAL_CONTRACT.frame_count
        and len(audits) == CANONICAL_CONTRACT.frame_count
        and manifest.media_provenance is not None
        and manifest.media_provenance.frame_rate_numerator == 24
        and manifest.media_provenance.frame_rate_denominator == 1
        and manifest.media_provenance.max_pts_residual_microseconds <= 1_000
    )
    return SequenceAudit(
        passed=(
            canonical_contract_passed
            and core_passed
            and integrity_passed
            and (
                not deterministic_composition_checked
                or deterministic_composition_passed
            )
        ),
        canonical_contract_passed=canonical_contract_passed,
        core_passed=core_passed,
        artifact_integrity_passed=integrity_passed,
        frames_audited=len(audits),
        frames_with_nonempty_core=frames_nonempty,
        total_core_pixels=sum(audit.protected_core_pixels for audit in audits),
        total_changed_core_pixels=sum(
            audit.changed_core_pixels for audit in audits
        ),
        total_changed_core_channel_samples=sum(
            audit.changed_core_channel_samples for audit in audits
        ),
        worst_maximum_absolute_channel_delta=max(
            (audit.maximum_absolute_channel_delta for audit in audits), default=0
        ),
        core_hash_match_count=core_hash_matches,
        manifest_digest_sha256=manifest.digest_sha256,
        frame_audits=audits,
        deterministic_composition_checked=deterministic_composition_checked,
        deterministic_composition_passed=deterministic_composition_passed,
    )


def write_proof_manifest_json(path: Path, manifest: ProofManifest) -> None:
    _validate_proof_manifest(manifest)
    if path.exists():
        raise FileExistsError(f"proof manifest already exists: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(asdict(manifest), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def write_audit_json(
    path: Path, summary: SequenceAudit, manifest: ProofManifest
) -> None:
    _validate_proof_manifest(manifest)
    if summary.manifest_digest_sha256 != manifest.digest_sha256:
        raise ArtifactIntegrityError("audit is not bound to the supplied manifest")
    recomputed = verify_persisted_sequence(
        manifest,
        source_paths=[Path(frame.source_path) for frame in manifest.frames],
        core_mask_paths=[Path(frame.core_mask_path) for frame in manifest.frames],
        composite_paths=[Path(frame.composite_path) for frame in manifest.frames],
    )
    if recomputed != summary:
        raise ArtifactIntegrityError("audit summary differs from recomputed evidence")
    if path.exists():
        raise FileExistsError(f"audit artifact already exists: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "audit": asdict(summary),
        "claim": VERIFIED_CORE_CLAIM if recomputed.passed else None,
        "manifest": asdict(manifest),
        "schema_version": 1,
    }
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
