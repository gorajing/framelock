from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from typing import Any, Mapping, Sequence

import numpy as np
from PIL import Image, UnidentifiedImageError

from .artifacts import sha256_file
from .contract import CANONICAL_CONTRACT, MediaFacts, validate_media_facts
from .ffmpeg_pipeline import MediaProbeEvidence, probe_media_evidence
from .temporal_matte import TemporalMatteError, verify_temporal_matte


MANIFEST_NAME = "mask-preview-manifest.json"
OUTPUT_NAME = "mask-preview.mp4"
ARTIFACT_KIND = "framelock_temporal_mask_preview"
FFMPEG_TIMEOUT_SECONDS = 180
FILTERGRAPH = (
    "scale=w=1280:h=720:in_range=pc:out_range=tv:"
    "out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,"
    "format=yuv420p,setsar=1"
)
X264_PARAMETERS = (
    "keyint=48:min-keyint=48:scenecut=0:colorprim=bt709:"
    "transfer=bt709:colormatrix=bt709:fullrange=off:"
    "threads=1:lookahead-threads=1"
)
ENCODER_SETTINGS: dict[str, object] = {
    "audio": "absent",
    "codec": "libx264",
    "container": "mp4",
    "crf": 18,
    "filtergraph": FILTERGRAPH,
    "frame_count": CANONICAL_CONTRACT.frame_count,
    "frame_rate": "24/1",
    "level": "3.1",
    "pixel_format": "yuv420p",
    "preset": "slow",
    "profile": "high",
    "thread_count": 1,
    "video_track_timescale": 24_000,
    "x264_parameters": X264_PARAMETERS,
}


class MaskPreviewError(RuntimeError):
    """Raised when temporal-mask preview provenance cannot be established."""


@dataclass(frozen=True)
class MaskPreviewArtifact:
    directory: Path
    output_path: Path
    manifest_path: Path
    output_sha256: str
    manifest_digest_sha256: str
    temporal_matte_manifest_path: Path
    temporal_matte_manifest_digest_sha256: str


def _canonical_json_bytes(value: object) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise MaskPreviewError(
            "mask preview evidence contains noncanonical JSON"
        ) from error


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _require_sha256(value: object, *, role: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise MaskPreviewError(f"{role} SHA-256 is malformed")
    return value


def _resolved_file(path: Path, *, role: str) -> Path:
    try:
        resolved = Path(path).resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise MaskPreviewError(f"{role} is missing: {path}") from error
    if not resolved.is_file():
        raise MaskPreviewError(f"{role} is not a file: {path}")
    return resolved


def _load_json(path: Path, *, role: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise MaskPreviewError(f"{role} is unreadable") from error
    if not isinstance(value, dict):
        raise MaskPreviewError(f"{role} must be a JSON object")
    return value


def _file_record(path: Path) -> dict[str, object]:
    resolved = _resolved_file(path, role="artifact")
    return {
        "bytes": resolved.stat().st_size,
        "path": str(resolved),
        "sha256": sha256_file(resolved),
    }


def _verify_file_record(value: object, *, role: str) -> Path:
    if not isinstance(value, dict) or set(value) != {"bytes", "path", "sha256"}:
        raise MaskPreviewError(f"{role} file record is malformed")
    path_value = value.get("path")
    byte_count = value.get("bytes")
    if (
        not isinstance(path_value, str)
        or not isinstance(byte_count, int)
        or byte_count < 0
    ):
        raise MaskPreviewError(f"{role} file record is malformed")
    path = _resolved_file(Path(path_value), role=role)
    if path_value != str(path) or path.stat().st_size != byte_count:
        raise MaskPreviewError(f"{role} file identity differs")
    if sha256_file(path) != _require_sha256(value.get("sha256"), role=role):
        raise MaskPreviewError(f"{role} file hash differs")
    return path


def _write_exclusive_json(path: Path, payload: Mapping[str, object]) -> None:
    encoded = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode(
        "utf-8"
    )
    try:
        with path.open("xb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError as error:
        raise MaskPreviewError(f"immutable artifact exists: {path}") from error


def _executable(name: str) -> str:
    value = shutil.which(name)
    if value is None:
        raise MaskPreviewError(f"required executable is unavailable: {name}")
    return str(Path(value).resolve())


def _version_line(executable: str) -> str:
    try:
        completed = subprocess.run(
            [executable, "-version"],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise MaskPreviewError(
            f"{Path(executable).name} version probe failed"
        ) from error
    lines = completed.stdout.splitlines()
    if not lines:
        raise MaskPreviewError(
            f"{Path(executable).name} did not report a version"
        )
    return lines[0]


def _encode_argv(
    *,
    ffmpeg: str,
    soft_mask_directory: Path,
    output_path: Path,
) -> tuple[str, ...]:
    return (
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-framerate",
        "24",
        "-start_number",
        "0",
        "-pattern_type",
        "sequence",
        "-i",
        str(soft_mask_directory / "foreground_%06d.png"),
        "-map",
        "0:v:0",
        "-frames:v",
        str(CANONICAL_CONTRACT.frame_count),
        "-vf",
        FILTERGRAPH,
        "-fps_mode",
        "passthrough",
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "18",
        "-profile:v",
        "high",
        "-level:v",
        "3.1",
        "-pix_fmt",
        "yuv420p",
        "-threads:v",
        "1",
        "-x264-params",
        X264_PARAMETERS,
        "-video_track_timescale",
        "24000",
        "-tag:v",
        "avc1",
        "-an",
        "-sn",
        "-dn",
        "-map_metadata",
        "-1",
        "-fflags",
        "+bitexact",
        "-flags:v",
        "+bitexact",
        "-movflags",
        "+faststart",
        "-n",
        str(output_path),
    )


def _encode_mask_preview(
    *,
    ffmpeg: str,
    soft_mask_directory: Path,
    output_path: Path,
) -> tuple[str, ...]:
    if output_path.exists():
        raise MaskPreviewError(f"mask preview output exists: {output_path}")
    argv = _encode_argv(
        ffmpeg=ffmpeg,
        soft_mask_directory=soft_mask_directory,
        output_path=output_path,
    )
    try:
        subprocess.run(
            argv,
            check=True,
            capture_output=True,
            text=True,
            timeout=FFMPEG_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        output_path.unlink(missing_ok=True)
        raise MaskPreviewError("mask preview encode exceeded 180 seconds") from error
    except subprocess.CalledProcessError as error:
        output_path.unlink(missing_ok=True)
        detail = (error.stderr or "").strip()[-2_000:] or "no diagnostic output"
        raise MaskPreviewError(f"mask preview encode failed: {detail}") from error
    except OSError as error:
        output_path.unlink(missing_ok=True)
        raise MaskPreviewError("mask preview encoder could not start") from error
    if not output_path.is_file():
        raise MaskPreviewError("mask preview encoder produced no output")
    return argv


def _load_soft_mask(path: Path) -> np.ndarray:
    try:
        with Image.open(path) as image:
            if (
                image.format != "PNG"
                or image.mode != "L"
                or bool(getattr(image, "is_animated", False))
                or image.n_frames != 1
            ):
                raise MaskPreviewError(
                    "mask preview source must be a single-frame L-mode PNG"
                )
            pixels = np.array(image, dtype=np.uint8, copy=True)
    except (OSError, UnidentifiedImageError) as error:
        raise MaskPreviewError("mask preview source PNG is unreadable") from error
    if pixels.shape != (
        CANONICAL_CONTRACT.height,
        CANONICAL_CONTRACT.width,
    ):
        raise MaskPreviewError("mask preview source geometry is noncanonical")
    return np.ascontiguousarray(pixels)


def _soft_mask_records(paths: Sequence[Path]) -> list[dict[str, object]]:
    if len(paths) != CANONICAL_CONTRACT.frame_count:
        raise MaskPreviewError("mask preview requires exactly 121 soft masks")
    directories = {Path(path).resolve().parent for path in paths}
    if len(directories) != 1:
        raise MaskPreviewError("soft masks must share one artifact directory")
    records: list[dict[str, object]] = []
    for index, source_path in enumerate(paths):
        path = _resolved_file(source_path, role="soft mask")
        if path.name != f"foreground_{index:06d}.png":
            raise MaskPreviewError("soft mask names or order are noncanonical")
        pixels = _load_soft_mask(path)
        records.append(
            {
                "file_sha256": sha256_file(path),
                "index": index,
                "path": str(path),
                "pixels_sha256": _sha256_bytes(pixels.tobytes(order="C")),
            }
        )
    return records


def _ordered_soft_mask_digest(records: Sequence[Mapping[str, object]]) -> str:
    ordered = [
        {
            "file_sha256": record["file_sha256"],
            "index": record["index"],
            "path": record["path"],
            "pixels_sha256": record["pixels_sha256"],
        }
        for record in records
    ]
    return _sha256_bytes(_canonical_json_bytes(ordered))


def _fraction_text(value: Fraction | None) -> str | None:
    if value is None:
        return None
    return f"{value.numerator}/{value.denominator}"


def _facts_payload(
    facts: MediaFacts,
    evidence: MediaProbeEvidence,
) -> dict[str, object]:
    timestamp_bytes = "\n".join(evidence.timestamp_tokens).encode("ascii")
    start = facts.presentation_timestamps[0]
    interval = 1 / float(CANONICAL_CONTRACT.frame_rate)
    maximum_residual = max(
        abs((timestamp - start) - index * interval)
        for index, timestamp in enumerate(facts.presentation_timestamps)
    )
    return {
        "chroma_location": facts.chroma_location,
        "codec": facts.codec_name,
        "color_primaries": facts.color_primaries,
        "color_range": facts.color_range,
        "color_space": facts.color_space,
        "color_transfer": facts.color_transfer,
        "container": facts.container,
        "declared_duration_seconds": facts.declared_duration_seconds,
        "file_size_bytes": facts.file_size_bytes,
        "frame_count": facts.frame_count,
        "frame_rate": _fraction_text(facts.frame_rate),
        "height": facts.height,
        "maximum_pts_residual_microseconds": round(
            maximum_residual * 1_000_000
        ),
        "pixel_format": facts.pixel_format,
        "presentation_timestamp_count": len(facts.presentation_timestamps),
        "presentation_timestamps_sha256": _sha256_bytes(timestamp_bytes),
        "rotation_degrees": facts.rotation_degrees,
        "sample_aspect_ratio": _fraction_text(facts.sample_aspect_ratio),
        "time_base": _fraction_text(facts.time_base),
        "width": facts.width,
    }


def _validate_output_probe(evidence: MediaProbeEvidence) -> None:
    facts = evidence.facts
    try:
        validate_media_facts(facts)
    except ValueError as error:
        raise MaskPreviewError("mask preview media contract failed") from error
    if (
        facts.codec_name != "h264"
        or facts.pixel_format != "yuv420p"
        or facts.time_base != Fraction(1, 24_000)
        or facts.frame_rate != Fraction(24, 1)
        or facts.frame_count != 121
    ):
        raise MaskPreviewError("mask preview codec or timing facts differ")
    if not facts.presentation_timestamps or not math.isclose(
        facts.presentation_timestamps[0],
        0.0,
        abs_tol=1e-12,
    ):
        raise MaskPreviewError("mask preview timestamps must start at zero")


def _probe_payload(evidence: MediaProbeEvidence) -> dict[str, object]:
    return {
        "argv": list(evidence.argv),
        "facts": _facts_payload(evidence.facts, evidence),
        "ffprobe_executable": evidence.ffprobe_executable,
        "ffprobe_version": evidence.ffprobe_version,
        "raw_json_sha256": _sha256_bytes(evidence.raw_json.encode("utf-8")),
    }


def _verify_soft_mask_records(
    value: object,
    expected_paths: Sequence[Path],
) -> list[dict[str, object]]:
    if not isinstance(value, list) or len(value) != 121:
        raise MaskPreviewError("soft mask provenance records are malformed")
    expected = _soft_mask_records(expected_paths)
    if value != expected:
        raise MaskPreviewError("soft mask provenance differs")
    return expected


def build_mask_preview(
    temporal_matte_manifest_path: Path,
    output_directory: Path,
) -> MaskPreviewArtifact:
    """Build one immutable deterministic preview from a verified temporal matte."""
    try:
        matte = verify_temporal_matte(temporal_matte_manifest_path)
    except TemporalMatteError as error:
        raise MaskPreviewError("temporal matte did not verify") from error
    target = Path(output_directory).resolve()
    if target.exists():
        raise MaskPreviewError("mask preview output directory already exists")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.mkdir()
    try:
        initial_records = _soft_mask_records(matte.soft_mask_paths)
        ffmpeg = _executable("ffmpeg")
        ffmpeg_version = _version_line(ffmpeg)
        output_path = target / OUTPUT_NAME
        argv = _encode_mask_preview(
            ffmpeg=ffmpeg,
            soft_mask_directory=matte.directory,
            output_path=output_path,
        )
        if _soft_mask_records(matte.soft_mask_paths) != initial_records:
            raise MaskPreviewError("soft masks changed during preview encoding")
        probe = probe_media_evidence(output_path)
        _validate_output_probe(probe)
        payload: dict[str, object] = {
            "artifact_root": str(target),
            "contract": {
                "codec": "h264",
                "container": "mp4",
                "frame_count": CANONICAL_CONTRACT.frame_count,
                "frame_rate": "24/1",
                "height": CANONICAL_CONTRACT.height,
                "pixel_format": "yuv420p",
                "width": CANONICAL_CONTRACT.width,
            },
            "encoder": {
                "argv": list(argv),
                "ffmpeg_executable": ffmpeg,
                "ffmpeg_version": ffmpeg_version,
                "settings": ENCODER_SETTINGS,
            },
            "kind": ARTIFACT_KIND,
            "output": {
                **_file_record(output_path),
                "probe": _probe_payload(probe),
            },
            "schema_version": 1,
            "source": {
                "ordered_soft_mask_digest_sha256": (
                    _ordered_soft_mask_digest(initial_records)
                ),
                "soft_masks": initial_records,
                "temporal_matte_manifest": _file_record(matte.manifest_path),
                "temporal_matte_manifest_digest_sha256": (
                    matte.manifest_digest_sha256
                ),
            },
        }
        payload["digest_sha256"] = _sha256_bytes(_canonical_json_bytes(payload))
        manifest_path = target / MANIFEST_NAME
        _write_exclusive_json(manifest_path, payload)
        return verify_mask_preview(manifest_path)
    except Exception:
        shutil.rmtree(target, ignore_errors=True)
        raise


def verify_mask_preview(manifest_path: Path) -> MaskPreviewArtifact:
    """Reopen every binding and reproduce the persisted MP4 byte-for-byte."""
    manifest = _resolved_file(manifest_path, role="mask preview manifest")
    if manifest.name != MANIFEST_NAME:
        raise MaskPreviewError("mask preview manifest name is noncanonical")
    payload = _load_json(manifest, role="mask preview manifest")
    if set(payload) != {
        "artifact_root",
        "contract",
        "digest_sha256",
        "encoder",
        "kind",
        "output",
        "schema_version",
        "source",
    } or payload.get("schema_version") != 1 or payload.get("kind") != (
        ARTIFACT_KIND
    ):
        raise MaskPreviewError("mask preview manifest schema is invalid")
    declared_digest = _require_sha256(
        payload.get("digest_sha256"),
        role="mask preview manifest",
    )
    unsigned = dict(payload)
    unsigned.pop("digest_sha256")
    if _sha256_bytes(_canonical_json_bytes(unsigned)) != declared_digest:
        raise MaskPreviewError("mask preview manifest digest differs")
    root = manifest.parent.resolve()
    if payload.get("artifact_root") != str(root):
        raise MaskPreviewError("mask preview artifact root differs")
    expected_names = {MANIFEST_NAME, OUTPUT_NAME}
    try:
        children = tuple(root.iterdir())
    except OSError as error:
        raise MaskPreviewError("mask preview artifact root is unreadable") from error
    if (
        {child.name for child in children} != expected_names
        or any(not child.is_file() for child in children)
    ):
        raise MaskPreviewError("mask preview artifact tree differs")
    if payload.get("contract") != {
        "codec": "h264",
        "container": "mp4",
        "frame_count": CANONICAL_CONTRACT.frame_count,
        "frame_rate": "24/1",
        "height": CANONICAL_CONTRACT.height,
        "pixel_format": "yuv420p",
        "width": CANONICAL_CONTRACT.width,
    }:
        raise MaskPreviewError("mask preview contract differs")

    source = payload.get("source")
    if not isinstance(source, dict) or set(source) != {
        "ordered_soft_mask_digest_sha256",
        "soft_masks",
        "temporal_matte_manifest",
        "temporal_matte_manifest_digest_sha256",
    }:
        raise MaskPreviewError("mask preview source record is malformed")
    matte_manifest = _verify_file_record(
        source["temporal_matte_manifest"],
        role="temporal matte manifest",
    )
    try:
        matte = verify_temporal_matte(matte_manifest)
    except TemporalMatteError as error:
        raise MaskPreviewError("temporal matte no longer verifies") from error
    if matte.manifest_digest_sha256 != _require_sha256(
        source.get("temporal_matte_manifest_digest_sha256"),
        role="temporal matte manifest",
    ):
        raise MaskPreviewError("temporal matte manifest digest differs")
    records = _verify_soft_mask_records(
        source.get("soft_masks"),
        matte.soft_mask_paths,
    )
    if _ordered_soft_mask_digest(records) != _require_sha256(
        source.get("ordered_soft_mask_digest_sha256"),
        role="ordered soft masks",
    ):
        raise MaskPreviewError("ordered soft mask digest differs")

    encoder = payload.get("encoder")
    if not isinstance(encoder, dict) or set(encoder) != {
        "argv",
        "ffmpeg_executable",
        "ffmpeg_version",
        "settings",
    }:
        raise MaskPreviewError("mask preview encoder record is malformed")
    ffmpeg = _executable("ffmpeg")
    ffmpeg_version = _version_line(ffmpeg)
    if (
        encoder.get("ffmpeg_executable") != ffmpeg
        or encoder.get("ffmpeg_version") != ffmpeg_version
        or encoder.get("settings") != ENCODER_SETTINGS
    ):
        raise MaskPreviewError("mask preview encoder provenance differs")

    output = payload.get("output")
    if not isinstance(output, dict) or set(output) != {
        "bytes",
        "path",
        "probe",
        "sha256",
    }:
        raise MaskPreviewError("mask preview output record is malformed")
    output_file_record = dict(output)
    persisted_probe = output_file_record.pop("probe")
    output_path = _verify_file_record(
        output_file_record,
        role="mask preview output",
    )
    if output_path != root / OUTPUT_NAME:
        raise MaskPreviewError("mask preview output path differs")
    expected_argv = _encode_argv(
        ffmpeg=ffmpeg,
        soft_mask_directory=matte.directory,
        output_path=output_path,
    )
    if encoder.get("argv") != list(expected_argv):
        raise MaskPreviewError("mask preview encoder argv differs")
    fresh_probe = probe_media_evidence(output_path)
    _validate_output_probe(fresh_probe)
    if persisted_probe != _probe_payload(fresh_probe):
        raise MaskPreviewError("mask preview probe evidence differs")

    with tempfile.TemporaryDirectory(prefix="framelock-mask-preview-verify-") as raw:
        reproduced = Path(raw) / OUTPUT_NAME
        _encode_mask_preview(
            ffmpeg=ffmpeg,
            soft_mask_directory=matte.directory,
            output_path=reproduced,
        )
        if (
            reproduced.stat().st_size != output_path.stat().st_size
            or sha256_file(reproduced) != sha256_file(output_path)
            or reproduced.read_bytes() != output_path.read_bytes()
        ):
            raise MaskPreviewError(
                "mask preview deterministic re-encode differs from output file"
            )
    return MaskPreviewArtifact(
        directory=root,
        output_path=output_path,
        manifest_path=manifest,
        output_sha256=sha256_file(output_path),
        manifest_digest_sha256=declared_digest,
        temporal_matte_manifest_path=matte.manifest_path,
        temporal_matte_manifest_digest_sha256=(
            matte.manifest_digest_sha256
        ),
    )
