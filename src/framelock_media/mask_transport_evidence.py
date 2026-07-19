from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
from typing import Any, Sequence

from .artifacts import sha256_file
from .contract import ContractViolation, MediaFacts, validate_media_facts
from .ffmpeg_pipeline import (
    FfmpegPipelineError,
    MaskTransportViolation,
    decode_mask_transport,
    encode_mask_transport,
    probe_media_evidence,
    validate_mask_transport_round_trip,
)
from .masks import MaskDomainError, load_edit_mask
from .temporal_matte import (
    MatteIntegrityError,
    TemporalMatteError,
    TemporalMatteResult,
    verify_temporal_matte,
)


TRANSPORT_NAME = "mask-transport.mp4"
RECEIPT_NAME = "mask-transport-receipt.json"
_RECEIPT_KEYS = frozenset(
    {
        "digest_sha256",
        "kind",
        "roundtrip",
        "schema_version",
        "temporal_matte",
        "transport",
    }
)
_TEMPORAL_MATTE_KEYS = frozenset(
    {
        "authoritative_ordered_pixels_sha256",
        "edit_mask_ordered_digest_sha256",
        "manifest_digest_sha256",
        "manifest_file_sha256",
        "manifest_path",
    }
)
_TRANSPORT_KEYS = frozenset(
    {"bytes", "media_facts", "path", "sha256"}
)
_ROUNDTRIP_KEYS = frozenset(
    {
        "authoritative_ordered_pixels_sha256",
        "decoded_ordered_pixels_sha256",
        "decoder",
        "exact_equality",
        "frame_count",
        "validator",
    }
)


class MaskTransportEvidenceError(ValueError):
    """Raised when a VACE mask transport cannot retain sealed evidence."""


@dataclass(frozen=True)
class MaskTransportEvidence:
    receipt_path: Path
    transport_path: Path
    receipt_digest_sha256: str
    temporal_matte_digest_sha256: str
    transport_sha256: str
    authoritative_ordered_pixels_sha256: str
    decoded_ordered_pixels_sha256: str
    exact_roundtrip: bool


def _canonical_json_bytes(value: object) -> bytes:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise MaskTransportEvidenceError(
            "mask transport evidence contains noncanonical JSON"
        ) from error


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _require_sha256(value: object, *, role: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise MaskTransportEvidenceError(f"{role} SHA-256 is malformed")
    return value


def _load_json_object(path: Path, *, role: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise MaskTransportEvidenceError(f"{role} is unreadable") from error
    if not isinstance(payload, dict):
        raise MaskTransportEvidenceError(f"{role} must be a JSON object")
    return payload


def _verified_matte(path: Path) -> TemporalMatteResult:
    try:
        return verify_temporal_matte(path)
    except (TemporalMatteError, MatteIntegrityError, OSError) as error:
        raise MaskTransportEvidenceError(
            "temporal matte verification failed"
        ) from error


def _ordered_pixel_digest(paths: Sequence[Path]) -> str:
    records: list[dict[str, object]] = []
    for index, path in enumerate(paths):
        expected_name = f"mask_{index:06d}.png"
        if path.name != expected_name:
            raise MaskTransportEvidenceError(
                "edit mask sequence order or names are noncanonical"
            )
        try:
            pixels = load_edit_mask(path)
        except (MaskDomainError, OSError) as error:
            raise MaskTransportEvidenceError(
                f"edit mask frame {index} is unreadable"
            ) from error
        records.append(
            {
                "index": index,
                "pixels_sha256": _sha256_bytes(
                    pixels.tobytes(order="C")
                ),
            }
        )
    return _sha256_bytes(_canonical_json_bytes(records))


def _fraction_payload(value: Fraction | None) -> dict[str, int] | None:
    if value is None:
        return None
    return {
        "denominator": value.denominator,
        "numerator": value.numerator,
    }


def _facts_payload(path: Path) -> dict[str, object]:
    try:
        evidence = probe_media_evidence(path)
        validated = validate_media_facts(evidence.facts)
    except (FfmpegPipelineError, ContractViolation, OSError) as error:
        raise MaskTransportEvidenceError(
            "mask transport media verification failed"
        ) from error
    facts: MediaFacts = evidence.facts
    return {
        "chroma_location": facts.chroma_location,
        "codec_name": facts.codec_name,
        "color_primaries": facts.color_primaries,
        "color_range": facts.color_range,
        "color_space": facts.color_space,
        "color_transfer": facts.color_transfer,
        "container": facts.container,
        "declared_duration_seconds": facts.declared_duration_seconds,
        "ffprobe_executable": evidence.ffprobe_executable,
        "ffprobe_json_sha256": _sha256_bytes(
            evidence.raw_json.encode("utf-8")
        ),
        "ffprobe_version": evidence.ffprobe_version,
        "file_size_bytes": facts.file_size_bytes,
        "frame_count": facts.frame_count,
        "frame_rate": _fraction_payload(facts.frame_rate),
        "height": facts.height,
        "max_pts_residual_microseconds": round(
            validated.max_pts_residual_seconds * 1_000_000
        ),
        "pixel_format": facts.pixel_format,
        "presentation_timestamp_tokens_sha256": _sha256_bytes(
            _canonical_json_bytes(list(evidence.timestamp_tokens))
        ),
        "rotation_degrees": facts.rotation_degrees,
        "sample_aspect_ratio": _fraction_payload(
            facts.sample_aspect_ratio
        ),
        "time_base": _fraction_payload(facts.time_base),
        "width": facts.width,
    }


def _manifest_bindings(
    result: TemporalMatteResult,
) -> tuple[dict[str, Any], str]:
    manifest = _load_json_object(
        result.manifest_path,
        role="temporal matte manifest",
    )
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, dict):
        raise MaskTransportEvidenceError(
            "temporal matte artifact evidence is malformed"
        )
    ordered_digest = _require_sha256(
        artifacts.get("edit_mask_ordered_digest_sha256"),
        role="ordered edit-mask manifest",
    )
    if artifacts.get("vace_transport_compatible") is not True:
        raise MaskTransportEvidenceError(
            "temporal matte is not admitted for VACE transport"
        )
    return manifest, ordered_digest


def _decode_and_digest(
    transport_path: Path,
    authoritative_paths: Sequence[Path],
) -> str:
    temporary_root = Path(tempfile.mkdtemp(prefix="framelock-mask-decode-"))
    try:
        try:
            decoded = decode_mask_transport(
                transport_path,
                temporary_root / "decoded",
            )
            validate_mask_transport_round_trip(
                authoritative_paths,
                decoded,
            )
        except (
            FfmpegPipelineError,
            MaskTransportViolation,
            ContractViolation,
            OSError,
        ) as error:
            raise MaskTransportEvidenceError(
                "mask transport exact roundtrip failed"
            ) from error
        return _ordered_pixel_digest(decoded)
    finally:
        shutil.rmtree(temporary_root, ignore_errors=True)


def _result(
    receipt_path: Path,
    payload: dict[str, Any],
) -> MaskTransportEvidence:
    temporal = payload["temporal_matte"]
    transport = payload["transport"]
    roundtrip = payload["roundtrip"]
    return MaskTransportEvidence(
        receipt_path=receipt_path,
        transport_path=Path(transport["path"]),
        receipt_digest_sha256=payload["digest_sha256"],
        temporal_matte_digest_sha256=temporal[
            "manifest_digest_sha256"
        ],
        transport_sha256=transport["sha256"],
        authoritative_ordered_pixels_sha256=roundtrip[
            "authoritative_ordered_pixels_sha256"
        ],
        decoded_ordered_pixels_sha256=roundtrip[
            "decoded_ordered_pixels_sha256"
        ],
        exact_roundtrip=roundtrip["exact_equality"],
    )


def seal_mask_transport_evidence(
    temporal_matte_manifest_path: Path,
    output_directory: Path,
) -> MaskTransportEvidence:
    """Encode and atomically seal one admitted temporal matte for VACE."""
    target = Path(output_directory).resolve()
    if target.exists():
        raise MaskTransportEvidenceError(
            "mask transport evidence directory already exists"
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    initial = _verified_matte(Path(temporal_matte_manifest_path))
    matte_root = initial.manifest_path.parent.resolve()
    if target.is_relative_to(matte_root):
        raise MaskTransportEvidenceError(
            "mask transport evidence cannot be written inside the temporal matte"
        )
    manifest, edit_mask_ordered_digest = _manifest_bindings(initial)
    del manifest
    initial_pixels_digest = _ordered_pixel_digest(initial.edit_mask_paths)

    temporary = Path(
        tempfile.mkdtemp(prefix=f".{target.name}.tmp-", dir=target.parent)
    )
    finalized = False
    try:
        temporary_transport = temporary / TRANSPORT_NAME
        try:
            encode_mask_transport(
                initial.edit_mask_paths,
                temporary_transport,
            )
        except (
            FfmpegPipelineError,
            MaskTransportViolation,
            ContractViolation,
            OSError,
        ) as error:
            raise MaskTransportEvidenceError(
                "mask transport encoding failed"
            ) from error
        decoded_digest = _decode_and_digest(
            temporary_transport,
            initial.edit_mask_paths,
        )
        final_matte = _verified_matte(initial.manifest_path)
        _, final_edit_digest = _manifest_bindings(final_matte)
        final_pixels_digest = _ordered_pixel_digest(
            final_matte.edit_mask_paths
        )
        if (
            final_matte.manifest_digest_sha256
            != initial.manifest_digest_sha256
            or final_edit_digest != edit_mask_ordered_digest
            or final_pixels_digest != initial_pixels_digest
        ):
            raise MaskTransportEvidenceError(
                "temporal matte changed during mask transport sealing"
            )
        try:
            validate_mask_transport_round_trip(
                final_matte.edit_mask_paths,
                decode_mask_transport(
                    temporary_transport,
                    temporary / "final-roundtrip",
                ),
            )
        except (
            FfmpegPipelineError,
            MaskTransportViolation,
            ContractViolation,
            OSError,
        ) as error:
            raise MaskTransportEvidenceError(
                "mask transport final roundtrip failed"
            ) from error
        final_decoded_digest = _ordered_pixel_digest(
            tuple(
                temporary
                / "final-roundtrip"
                / f"mask_{index:06d}.png"
                for index in range(121)
            )
        )
        if (
            decoded_digest != final_decoded_digest
            or final_decoded_digest != final_pixels_digest
        ):
            raise MaskTransportEvidenceError(
                "mask transport decoded ordered digest differs"
            )
        shutil.rmtree(temporary / "final-roundtrip")

        final_transport_path = target / TRANSPORT_NAME
        payload: dict[str, Any] = {
            "kind": "framelock_vace_mask_transport_evidence",
            "roundtrip": {
                "authoritative_ordered_pixels_sha256": (
                    final_pixels_digest
                ),
                "decoded_ordered_pixels_sha256": final_decoded_digest,
                "decoder": (
                    "framelock_media.ffmpeg_pipeline.decode_mask_transport"
                ),
                "exact_equality": True,
                "frame_count": len(final_matte.edit_mask_paths),
                "validator": (
                    "framelock_media.ffmpeg_pipeline."
                    "validate_mask_transport_round_trip"
                ),
            },
            "schema_version": 1,
            "temporal_matte": {
                "authoritative_ordered_pixels_sha256": (
                    final_pixels_digest
                ),
                "edit_mask_ordered_digest_sha256": final_edit_digest,
                "manifest_digest_sha256": (
                    final_matte.manifest_digest_sha256
                ),
                "manifest_file_sha256": sha256_file(
                    final_matte.manifest_path
                ),
                "manifest_path": str(final_matte.manifest_path),
            },
            "transport": {
                "bytes": temporary_transport.stat().st_size,
                "media_facts": _facts_payload(temporary_transport),
                "path": str(final_transport_path),
                "sha256": sha256_file(temporary_transport),
            },
        }
        payload["digest_sha256"] = _sha256_bytes(
            _canonical_json_bytes(payload)
        )
        receipt = temporary / RECEIPT_NAME
        with receipt.open("x", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, indent=2, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        if target.exists():
            raise MaskTransportEvidenceError(
                "mask transport evidence directory already exists"
            )
        os.rename(temporary, target)
        finalized = True
    finally:
        if not finalized:
            shutil.rmtree(temporary, ignore_errors=True)
    return verify_mask_transport_evidence(target / RECEIPT_NAME)


def verify_mask_transport_evidence(
    receipt_path: Path,
) -> MaskTransportEvidence:
    """Freshly re-verify a sealed temporal-matte mask transport."""
    try:
        path = Path(receipt_path).resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise MaskTransportEvidenceError(
            "mask transport receipt is missing"
        ) from error
    if not path.is_file() or path.name != RECEIPT_NAME or path.is_symlink():
        raise MaskTransportEvidenceError(
            "mask transport receipt path is noncanonical"
        )
    root = path.parent
    try:
        children = tuple(root.iterdir())
    except OSError as error:
        raise MaskTransportEvidenceError(
            "mask transport evidence directory is unreadable"
        ) from error
    if (
        {child.name for child in children} != {TRANSPORT_NAME, RECEIPT_NAME}
        or any(not child.is_file() or child.is_symlink() for child in children)
    ):
        raise MaskTransportEvidenceError(
            "mask transport evidence contains missing or unbound files"
        )
    payload = _load_json_object(path, role="mask transport receipt")
    if (
        set(payload) != _RECEIPT_KEYS
        or payload.get("schema_version") != 1
        or payload.get("kind")
        != "framelock_vace_mask_transport_evidence"
    ):
        raise MaskTransportEvidenceError(
            "mask transport receipt schema is invalid"
        )
    declared_digest = _require_sha256(
        payload.get("digest_sha256"),
        role="mask transport receipt",
    )
    unsigned = dict(payload)
    unsigned.pop("digest_sha256")
    if declared_digest != _sha256_bytes(_canonical_json_bytes(unsigned)):
        raise MaskTransportEvidenceError(
            "mask transport receipt digest differs"
        )
    temporal = payload.get("temporal_matte")
    transport = payload.get("transport")
    roundtrip = payload.get("roundtrip")
    if (
        not isinstance(temporal, dict)
        or set(temporal) != _TEMPORAL_MATTE_KEYS
        or not isinstance(transport, dict)
        or set(transport) != _TRANSPORT_KEYS
        or not isinstance(roundtrip, dict)
        or set(roundtrip) != _ROUNDTRIP_KEYS
    ):
        raise MaskTransportEvidenceError(
            "mask transport receipt records are malformed"
        )
    manifest_path_value = temporal.get("manifest_path")
    if not isinstance(manifest_path_value, str):
        raise MaskTransportEvidenceError(
            "temporal matte manifest path is malformed"
        )
    matte = _verified_matte(Path(manifest_path_value))
    if matte.manifest_path != Path(manifest_path_value):
        raise MaskTransportEvidenceError(
            "temporal matte manifest path is noncanonical"
        )
    _, edit_mask_ordered_digest = _manifest_bindings(matte)
    if (
        sha256_file(matte.manifest_path)
        != _require_sha256(
            temporal.get("manifest_file_sha256"),
            role="temporal matte manifest file",
        )
        or matte.manifest_digest_sha256
        != _require_sha256(
            temporal.get("manifest_digest_sha256"),
            role="temporal matte manifest",
        )
        or edit_mask_ordered_digest
        != _require_sha256(
            temporal.get("edit_mask_ordered_digest_sha256"),
            role="ordered edit-mask manifest",
        )
    ):
        raise MaskTransportEvidenceError(
            "temporal matte receipt binding differs"
        )
    authoritative_digest = _ordered_pixel_digest(matte.edit_mask_paths)
    if authoritative_digest != _require_sha256(
        temporal.get("authoritative_ordered_pixels_sha256"),
        role="authoritative edit-mask pixels",
    ):
        raise MaskTransportEvidenceError(
            "authoritative ordered edit-mask digest differs"
        )

    transport_path = root / TRANSPORT_NAME
    if transport.get("path") != str(transport_path):
        raise MaskTransportEvidenceError(
            "mask transport path binding differs"
        )
    if transport_path.stat().st_size != transport.get("bytes"):
        raise MaskTransportEvidenceError("mask transport byte count differs")
    if sha256_file(transport_path) != _require_sha256(
        transport.get("sha256"),
        role="mask transport",
    ):
        raise MaskTransportEvidenceError("mask transport SHA-256 differs")
    if _facts_payload(transport_path) != transport.get("media_facts"):
        raise MaskTransportEvidenceError("mask transport media facts differ")

    fresh_decoded_digest = _decode_and_digest(
        transport_path,
        matte.edit_mask_paths,
    )
    declared_decoded_digest = _require_sha256(
        roundtrip.get("decoded_ordered_pixels_sha256"),
        role="decoded ordered mask pixels",
    )
    if fresh_decoded_digest != declared_decoded_digest:
        raise MaskTransportEvidenceError(
            "fresh decoded ordered digest differs"
        )
    if (
        roundtrip.get("exact_equality") is not True
        or roundtrip.get("frame_count") != len(matte.edit_mask_paths)
        or roundtrip.get("authoritative_ordered_pixels_sha256")
        != authoritative_digest
        or declared_decoded_digest != authoritative_digest
        or roundtrip.get("decoder")
        != "framelock_media.ffmpeg_pipeline.decode_mask_transport"
        or roundtrip.get("validator")
        != (
            "framelock_media.ffmpeg_pipeline."
            "validate_mask_transport_round_trip"
        )
    ):
        raise MaskTransportEvidenceError(
            "mask transport roundtrip receipt differs"
        )
    return _result(path, payload)
