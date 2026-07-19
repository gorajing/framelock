from __future__ import annotations

import argparse
from dataclasses import dataclass
from fractions import Fraction
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
from typing import Mapping, Sequence

from .artifacts import ArtifactExistsError, sha256_file
from .contract import CANONICAL_CONTRACT, MediaFacts, validate_media_facts
from .ffmpeg_pipeline import (
    FFMPEG_TIMEOUT_SECONDS,
    FfmpegPipelineError,
    MediaProbeEvidence,
    probe_media_evidence,
)


RAW_WIDTH = 1284
RAW_HEIGHT = 716
SELECTED_START_FRAME = 0
SELECTED_END_FRAME_INCLUSIVE = 120
SELECTED_FRAME_COUNT = 121
CROP_WIDTH = 1280
CROP_HEIGHT = 716
CROP_X = 2
CROP_Y = 0
PAD_TOP = 2
PAD_BOTTOM = 2
PAD_LEFT = 0
PAD_RIGHT = 0
OUTPUT_FILENAME = "source-canonical.mp4"
MANIFEST_FILENAME = "source-construction.json"
MANIFEST_KIND = "framelock_motion_source_construction"
PAD_CROP_MODE = "crop_pad"
SCALE_CENTER_CROP_MODE = "scale_center_crop"
PAD_SCHEMA_VERSION = 1
SCALE_SCHEMA_VERSION = 2
SELECTABLE_WINDOW_SCHEMA_VERSION = 3
SCALE_WIDTH_EXPRESSION = "-2"
SCALE_EXPECTED_WIDTH = 1292
SCALE_EXPECTED_HEIGHT = 720
SCALE_CROP_X = 6
SCALE_FLAGS = (
    "lanczos",
    "accurate_rnd",
    "full_chroma_int",
    "bitexact",
)
SCALE_LANCZOS_LOBES = 3


class MotionSourceConstructionError(RuntimeError):
    """Raised when an MP4 cannot become the immutable Motion v1 source."""


@dataclass(frozen=True)
class MotionSourceConstruction:
    directory: Path
    source_path: Path
    output_path: Path
    manifest_path: Path
    source_sha256: str
    output_sha256: str
    manifest_digest_sha256: str
    facts: MediaFacts
    geometry_mode: str
    start_frame: int


def _canonical_json_bytes(payload: object) -> bytes:
    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _require_sha256(value: object, *, role: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise MotionSourceConstructionError(f"{role} SHA-256 is invalid")
    return value


def _require_mapping(value: object, *, role: str) -> Mapping[str, object]:
    if not isinstance(value, dict):
        raise MotionSourceConstructionError(f"{role} is invalid")
    return value


def _require_exact_keys(
    value: Mapping[str, object],
    expected: set[str],
    *,
    role: str,
) -> None:
    if set(value) != expected:
        raise MotionSourceConstructionError(f"{role} schema is invalid")


def _require_string_tuple(value: object, *, role: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not value or not all(
        isinstance(item, str) and item for item in value
    ):
        raise MotionSourceConstructionError(f"{role} is invalid")
    return tuple(value)


def _validate_start_frame(
    value: object,
    *,
    available_frame_count: int | None = None,
) -> int:
    if type(value) is not int or value < 0:
        raise MotionSourceConstructionError(
            "start frame must be an explicitly supplied nonnegative integer"
        )
    start_frame = int(value)
    if (
        available_frame_count is not None
        and start_frame + SELECTED_FRAME_COUNT > available_frame_count
    ):
        raise MotionSourceConstructionError(
            "start frame does not leave 121 decoded source frames"
        )
    return start_frame


def _ffmpeg_executable() -> str:
    executable = shutil.which("ffmpeg")
    if executable is None:
        raise MotionSourceConstructionError("required executable is unavailable: ffmpeg")
    return str(Path(executable).resolve())


def _run(
    argv: Sequence[str],
    *,
    binary_stdout: bool = False,
) -> str | bytes:
    try:
        completed = subprocess.run(
            list(argv),
            check=True,
            capture_output=True,
            text=not binary_stdout,
            timeout=FFMPEG_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        raise MotionSourceConstructionError(
            f"media command exceeded {FFMPEG_TIMEOUT_SECONDS} seconds"
        ) from error
    except subprocess.CalledProcessError as error:
        stderr_value = error.stderr or (b"" if binary_stdout else "")
        if isinstance(stderr_value, bytes):
            stderr = stderr_value.decode("utf-8", errors="replace")
        else:
            stderr = stderr_value
        detail = stderr.strip()[-2_000:] or "no diagnostic output"
        raise MotionSourceConstructionError(
            f"media command failed ({Path(argv[0]).name}): {detail}"
        ) from error
    except OSError as error:
        raise MotionSourceConstructionError(
            f"media command could not start: {Path(argv[0]).name}"
        ) from error
    return completed.stdout


def _version_line(executable: str) -> str:
    output = _run((executable, "-version"))
    assert isinstance(output, str)
    lines = output.splitlines()
    if not lines:
        raise MotionSourceConstructionError(
            f"{Path(executable).name} did not report a version"
        )
    return lines[0]


def _stream_types(path: Path, ffprobe: str) -> tuple[str, ...]:
    raw = _run(
        (
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "json",
            str(path),
        )
    )
    assert isinstance(raw, str)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise MotionSourceConstructionError(
            "ffprobe returned malformed stream JSON"
        ) from error
    streams = payload.get("streams")
    if not isinstance(streams, list) or not all(
        isinstance(stream, dict)
        and isinstance(stream.get("codec_type"), str)
        for stream in streams
    ):
        raise MotionSourceConstructionError("ffprobe omitted stream types")
    return tuple(str(stream["codec_type"]) for stream in streams)


def _framehash_argv(
    *,
    ffmpeg: str,
    media_path: Path,
    filtergraph: str | None,
    geometry_mode: str | None,
) -> tuple[str, ...]:
    arguments: list[str] = [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
    ]
    if geometry_mode == SCALE_CENTER_CROP_MODE:
        arguments.extend(("-filter_threads", "1"))
    if filtergraph is not None:
        arguments.append("-noautorotate")
    arguments.extend(("-i", str(media_path), "-map", "0:v:0", "-an", "-sn", "-dn"))
    if filtergraph is not None:
        arguments.extend(("-vf", filtergraph))
    arguments.extend(
        (
            "-frames:v",
            str(SELECTED_FRAME_COUNT),
            "-pix_fmt",
            "yuv420p",
            "-f",
            "framehash",
            "-hash",
            "sha256",
            "-",
        )
    )
    return tuple(arguments)


def _parse_framehash(raw: str) -> tuple[str, ...]:
    rows = [line for line in raw.splitlines() if line and not line.startswith("#")]
    if len(rows) != SELECTED_FRAME_COUNT:
        raise MotionSourceConstructionError(
            "decoded frame identity must contain exactly 121 hashes"
        )
    hashes: list[str] = []
    expected_size = CANONICAL_CONTRACT.width * CANONICAL_CONTRACT.height * 3 // 2
    for index, row in enumerate(rows):
        fields = tuple(value.strip() for value in row.split(","))
        if len(fields) != 6:
            raise MotionSourceConstructionError("decoded frame identity row is invalid")
        stream, dts, pts, duration, size, digest = fields
        if (
            stream != "0"
            or dts != str(index)
            or pts != str(index)
            or duration != "1"
            or size != str(expected_size)
        ):
            raise MotionSourceConstructionError(
                "decoded frame identity timing or geometry differs"
            )
        hashes.append(_require_sha256(digest, role="decoded frame"))
    return tuple(hashes)


def _decoded_frame_identity(
    *,
    ffmpeg: str,
    source_path: Path,
    output_path: Path,
    filtergraph: str,
    geometry_mode: str,
) -> dict[str, object]:
    expected_argv = _framehash_argv(
        ffmpeg=ffmpeg,
        media_path=source_path,
        filtergraph=filtergraph,
        geometry_mode=geometry_mode,
    )
    output_argv = _framehash_argv(
        ffmpeg=ffmpeg,
        media_path=output_path,
        filtergraph=None,
        geometry_mode=None,
    )
    expected_raw = _run(expected_argv)
    output_raw = _run(output_argv)
    assert isinstance(expected_raw, str) and isinstance(output_raw, str)
    expected_hashes = _parse_framehash(expected_raw)
    output_hashes = _parse_framehash(output_raw)
    if expected_raw != output_raw or expected_hashes != output_hashes:
        raise MotionSourceConstructionError(
            "decoded output frames differ from the explicit source transform"
        )
    return {
        "algorithm": "ffmpeg_framehash_sha256_v2",
        "exact_match": True,
        "expected_framehash_sha256": _sha256_bytes(expected_raw.encode("utf-8")),
        "expected_transform_argv": list(expected_argv),
        "frame_count": SELECTED_FRAME_COUNT,
        "ordered_frame_sha256": list(expected_hashes),
        "output_decode_argv": list(output_argv),
        "output_framehash_sha256": _sha256_bytes(output_raw.encode("utf-8")),
        "pixel_format": "yuv420p",
    }


def _facts_payload(evidence: MediaProbeEvidence) -> dict[str, object]:
    facts = evidence.facts
    timestamp_digest = _sha256_bytes(
        _canonical_json_bytes(list(evidence.timestamp_tokens))
    )
    return {
        "chroma_location": facts.chroma_location,
        "codec_name": facts.codec_name,
        "color_primaries": facts.color_primaries,
        "color_range": facts.color_range,
        "color_space": facts.color_space,
        "color_transfer": facts.color_transfer,
        "container": facts.container,
        "declared_duration_seconds": facts.declared_duration_seconds,
        "file_size_bytes": facts.file_size_bytes,
        "frame_count": facts.frame_count,
        "frame_rate": {
            "denominator": facts.frame_rate.denominator,
            "numerator": facts.frame_rate.numerator,
        },
        "height": facts.height,
        "pixel_format": facts.pixel_format,
        "presentation_timestamp_tokens": list(evidence.timestamp_tokens),
        "presentation_timestamps_sha256": timestamp_digest,
        "rotation_degrees": facts.rotation_degrees,
        "sample_aspect_ratio": (
            None
            if facts.sample_aspect_ratio is None
            else {
                "denominator": facts.sample_aspect_ratio.denominator,
                "numerator": facts.sample_aspect_ratio.numerator,
            }
        ),
        "time_base": {
            "denominator": facts.time_base.denominator,
            "numerator": facts.time_base.numerator,
        },
        "width": facts.width,
    }


def _probe_payload(
    evidence: MediaProbeEvidence,
    *,
    stream_types: Sequence[str],
) -> dict[str, object]:
    return {
        "facts": _facts_payload(evidence),
        "ffprobe_argv": list(evidence.argv),
        "ffprobe_executable": evidence.ffprobe_executable,
        "ffprobe_json_sha256": _sha256_bytes(evidence.raw_json.encode("utf-8")),
        "ffprobe_version": evidence.ffprobe_version,
        "stream_types": list(stream_types),
    }


def _max_selected_pts_residual(
    facts: MediaFacts,
    *,
    start_frame: int,
) -> float:
    selected = facts.presentation_timestamps[
        start_frame : start_frame + SELECTED_FRAME_COUNT
    ]
    origin = selected[0]
    interval = Fraction(1, 24)
    return max(
        abs((timestamp - origin) - index * float(interval))
        for index, timestamp in enumerate(selected)
    )


def _validate_raw_source(
    evidence: MediaProbeEvidence,
    *,
    start_frame: int = SELECTED_START_FRAME,
) -> None:
    facts = evidence.facts
    selected_start = _validate_start_frame(
        start_frame,
        available_frame_count=facts.frame_count,
    )
    if facts.container != "mp4":
        raise MotionSourceConstructionError("raw source container must be MP4")
    if (facts.width, facts.height) != (RAW_WIDTH, RAW_HEIGHT):
        raise MotionSourceConstructionError(
            f"raw source dimensions must be {RAW_WIDTH}x{RAW_HEIGHT}"
        )
    if facts.frame_rate != Fraction(24, 1):
        raise MotionSourceConstructionError("raw source frame rate must be 24/1")
    if facts.rotation_degrees != 0:
        raise MotionSourceConstructionError("raw source rotation must be zero")
    if facts.sample_aspect_ratio not in {None, Fraction(1, 1)}:
        raise MotionSourceConstructionError(
            "raw source sample aspect ratio must be 1:1 or absent"
        )
    selected_timestamps = facts.presentation_timestamps[
        selected_start : selected_start + SELECTED_FRAME_COUNT
    ]
    if len(selected_timestamps) != SELECTED_FRAME_COUNT or any(
        current <= previous
        for previous, current in zip(
            selected_timestamps,
            selected_timestamps[1:],
        )
    ):
        raise MotionSourceConstructionError(
            "raw source selected timestamps must be strictly increasing"
        )
    residual = _max_selected_pts_residual(
        facts,
        start_frame=selected_start,
    )
    if not math.isfinite(residual) or residual > 0.001 + 1e-12:
        raise MotionSourceConstructionError(
            "raw source selected timestamps differ from 24/1 CFR by more than 1 ms"
        )


def _validate_canonical_output(
    evidence: MediaProbeEvidence,
    *,
    stream_types: Sequence[str],
) -> None:
    try:
        validate_media_facts(evidence.facts)
    except ValueError as error:
        raise MotionSourceConstructionError(
            "canonical output media contract failed"
        ) from error
    facts = evidence.facts
    if facts.codec_name != "h264" or facts.pixel_format != "yuv420p":
        raise MotionSourceConstructionError(
            "canonical output must be H.264 yuv420p"
        )
    if facts.time_base != Fraction(1, 24_000):
        raise MotionSourceConstructionError(
            "canonical output time base must be 1/24000"
        )
    if not facts.presentation_timestamps or abs(
        facts.presentation_timestamps[0]
    ) > 1e-12:
        raise MotionSourceConstructionError(
            "canonical output presentation timestamps must start at zero"
        )
    if tuple(stream_types) != ("video",):
        raise MotionSourceConstructionError(
            "canonical output must contain exactly one video stream and no audio"
        )


def _pad_hex(pad_gray: int) -> str:
    if type(pad_gray) is not int or not 0 <= pad_gray <= 255:
        raise MotionSourceConstructionError(
            "pad gray must be an explicitly supplied integer byte"
        )
    return f"#{pad_gray:02X}{pad_gray:02X}{pad_gray:02X}"


def _validate_geometry_arguments(
    geometry_mode: str,
    pad_gray: int | None,
) -> None:
    if geometry_mode == PAD_CROP_MODE:
        if pad_gray is None:
            raise MotionSourceConstructionError(
                "crop-pad geometry requires pad gray"
            )
        _pad_hex(pad_gray)
        return
    if geometry_mode == SCALE_CENTER_CROP_MODE:
        if pad_gray is not None:
            raise MotionSourceConstructionError(
                "scale-center-crop geometry does not accept pad gray"
            )
        return
    raise MotionSourceConstructionError(f"unsupported geometry mode: {geometry_mode}")


def _filter(
    geometry_mode: str,
    pad_gray: int | None,
    *,
    start_frame: int = SELECTED_START_FRAME,
) -> str:
    _validate_geometry_arguments(geometry_mode, pad_gray)
    selected_start = _validate_start_frame(start_frame)
    selected_end = selected_start + SELECTED_FRAME_COUNT
    if geometry_mode == PAD_CROP_MODE:
        assert pad_gray is not None
        color = _pad_hex(pad_gray).removeprefix("#")
        return (
            f"trim=start_frame={selected_start}:end_frame={selected_end},"
            "crop=w=1280:h=716:x=2:y=0,"
            f"pad=w=1280:h=720:x=0:y=2:color=0x{color},"
            "setsar=1,setpts=PTS-STARTPTS"
        )
    flags = "+".join(SCALE_FLAGS)
    return (
        f"trim=start_frame={selected_start}:end_frame={selected_end},"
        f"scale=w={SCALE_WIDTH_EXPRESSION}:h={SCALE_EXPECTED_HEIGHT}:"
        f"flags={flags}:param0={SCALE_LANCZOS_LOBES}:eval=init,"
        f"crop=w=1280:h=720:x={SCALE_CROP_X}:y=0,"
        "setsar=1,setpts=PTS-STARTPTS"
    )


def _source_sar_interpretation(value: Fraction | None) -> str:
    return "absent_assumed_1_1" if value is None else "declared_1_1"


def _geometry_payload(
    *,
    geometry_mode: str,
    pad_gray: int | None,
    source_sample_aspect_ratio: Fraction | None,
) -> dict[str, object]:
    _validate_geometry_arguments(geometry_mode, pad_gray)
    if geometry_mode == PAD_CROP_MODE:
        assert pad_gray is not None
        return {
            "crop": {
                "height": CROP_HEIGHT,
                "width": CROP_WIDTH,
                "x": CROP_X,
                "y": CROP_Y,
            },
            "pad": {
                "bottom": PAD_BOTTOM,
                "color_rgb_hex": _pad_hex(pad_gray),
                "left": PAD_LEFT,
                "right": PAD_RIGHT,
                "top": PAD_TOP,
            },
            "source_sample_aspect_ratio_interpretation": (
                _source_sar_interpretation(source_sample_aspect_ratio)
            ),
        }
    return {
        "crop": {
            "height": CANONICAL_CONTRACT.height,
            "width": CANONICAL_CONTRACT.width,
            "x": SCALE_CROP_X,
            "y": 0,
        },
        "mode": SCALE_CENTER_CROP_MODE,
        "scale": {
            "algorithm": "lanczos",
            "eval": "init",
            "expected_height": SCALE_EXPECTED_HEIGHT,
            "expected_width": SCALE_EXPECTED_WIDTH,
            "flags": list(SCALE_FLAGS),
            "input_height": RAW_HEIGHT,
            "input_width": RAW_WIDTH,
            "lanczos_lobes": SCALE_LANCZOS_LOBES,
            "width_expression": SCALE_WIDTH_EXPRESSION,
        },
        "source_sample_aspect_ratio_interpretation": (
            _source_sar_interpretation(source_sample_aspect_ratio)
        ),
    }


def _schema_version(
    geometry_mode: str,
    *,
    start_frame: int = SELECTED_START_FRAME,
) -> int:
    selected_start = _validate_start_frame(start_frame)
    if selected_start != SELECTED_START_FRAME:
        return SELECTABLE_WINDOW_SCHEMA_VERSION
    if geometry_mode == PAD_CROP_MODE:
        return PAD_SCHEMA_VERSION
    if geometry_mode == SCALE_CENTER_CROP_MODE:
        return SCALE_SCHEMA_VERSION
    raise MotionSourceConstructionError(f"unsupported geometry mode: {geometry_mode}")


def _construction_payload(
    *,
    ffmpeg: str,
    ffmpeg_version: str,
    ffmpeg_argv: Sequence[str],
    geometry_mode: str,
    pad_gray: int | None,
    source_sample_aspect_ratio: Fraction | None,
    decoded_frame_identity: Mapping[str, object],
    start_frame: int = SELECTED_START_FRAME,
) -> dict[str, object]:
    selected_start = _validate_start_frame(start_frame)
    return {
        "audio": "discarded",
        "decoded_frame_identity": dict(decoded_frame_identity),
        "encoding": {
            "b_frames": 0,
            "codec": "libx264",
            "crf": 0,
            "movflags": "+faststart",
            "pixel_format": "yuv420p",
            "preset": "medium",
            "video_track_timescale": 24000,
        },
        "ffmpeg_argv": list(ffmpeg_argv),
        "ffmpeg_executable": ffmpeg,
        "ffmpeg_version": ffmpeg_version,
        "filtergraph": _filter(
            geometry_mode,
            pad_gray,
            start_frame=selected_start,
        ),
        "geometry": _geometry_payload(
            geometry_mode=geometry_mode,
            pad_gray=pad_gray,
            source_sample_aspect_ratio=source_sample_aspect_ratio,
        ),
        "selection": {
            "count": SELECTED_FRAME_COUNT,
            "end_frame_inclusive": (
                selected_start + SELECTED_FRAME_COUNT - 1
            ),
            "interpolation": "none",
            "order": "decoded_presentation_order_unchanged",
            "start_frame": selected_start,
        },
        "timing": {
            "cfr": "inherited_from_validated_24_1_source_pts",
            "fps_filter": "none",
            "output_frame_rate": "24/1",
            "timestamp_operation": "subtract_first_selected_pts_only",
        },
    }


def _artifact_payload(
    path: Path,
    evidence: MediaProbeEvidence,
    stream_types: Sequence[str],
) -> dict[str, object]:
    return {
        "path": str(path.resolve()),
        "probe": _probe_payload(evidence, stream_types=stream_types),
        "sha256": sha256_file(path),
    }


def _write_manifest(path: Path, payload: Mapping[str, object]) -> None:
    encoded = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode(
        "utf-8"
    )
    try:
        with path.open("xb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError as error:
        raise ArtifactExistsError(f"artifact already exists: {path}") from error


def _read_manifest(path: Path) -> dict[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise MotionSourceConstructionError(
            "motion source construction manifest is unreadable"
        ) from error
    if not isinstance(payload, dict):
        raise MotionSourceConstructionError(
            "motion source construction manifest is invalid"
        )
    return payload


def _geometry_arguments_from_record(
    geometry: Mapping[str, object],
) -> tuple[str, int | None]:
    if "pad" in geometry and "scale" not in geometry and "mode" not in geometry:
        pad = _require_mapping(geometry.get("pad"), role="construction pad")
        color = pad.get("color_rgb_hex")
        if (
            not isinstance(color, str)
            or len(color) != 7
            or not color.startswith("#")
        ):
            raise MotionSourceConstructionError("construction pad color is invalid")
        try:
            red, green, blue = (
                int(color[1:3], 16),
                int(color[3:5], 16),
                int(color[5:7], 16),
            )
        except ValueError as error:
            raise MotionSourceConstructionError(
                "construction pad color is invalid"
            ) from error
        if red != green or green != blue:
            raise MotionSourceConstructionError(
                "construction pad color must be solid gray"
            )
        return PAD_CROP_MODE, red
    if (
        geometry.get("mode") == SCALE_CENTER_CROP_MODE
        and "scale" in geometry
        and "pad" not in geometry
    ):
        return SCALE_CENTER_CROP_MODE, None
    raise MotionSourceConstructionError("construction geometry mode is invalid")


def _start_frame_from_construction_record(
    record: Mapping[str, object],
) -> int:
    selection = _require_mapping(
        record.get("selection"),
        role="construction selection",
    )
    return _validate_start_frame(selection.get("start_frame"))


def _encode_argv(
    *,
    ffmpeg: str,
    source_path: Path,
    output_path: Path,
    filtergraph: str,
    geometry_mode: str,
) -> tuple[str, ...]:
    arguments: list[str] = [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
    ]
    if geometry_mode == SCALE_CENTER_CROP_MODE:
        arguments.extend(("-filter_threads", "1"))
    arguments.extend(
        (
            "-noautorotate",
            "-i",
            str(source_path),
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-vf",
            filtergraph,
            "-frames:v",
            str(SELECTED_FRAME_COUNT),
            "-fps_mode:v",
            "passthrough",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "0",
            "-bf",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-video_track_timescale",
            "24000",
            "-movflags",
            "+faststart",
            str(output_path),
        )
    )
    return tuple(arguments)


def _validate_construction_record(
    record: Mapping[str, object],
    *,
    source_path: Path,
    output_path: Path,
    source_sample_aspect_ratio: Fraction | None,
) -> tuple[str, int]:
    expected_keys = {
        "audio",
        "decoded_frame_identity",
        "encoding",
        "ffmpeg_argv",
        "ffmpeg_executable",
        "ffmpeg_version",
        "filtergraph",
        "geometry",
        "selection",
        "timing",
    }
    _require_exact_keys(record, expected_keys, role="construction record")
    geometry = _require_mapping(record.get("geometry"), role="construction geometry")
    geometry_mode, pad_gray = _geometry_arguments_from_record(geometry)
    start_frame = _start_frame_from_construction_record(record)

    executable = record.get("ffmpeg_executable")
    version = record.get("ffmpeg_version")
    argv = _require_string_tuple(record.get("ffmpeg_argv"), role="ffmpeg argv")
    expected_filter = _filter(
        geometry_mode,
        pad_gray,
        start_frame=start_frame,
    )
    expected_record = _construction_payload(
        ffmpeg=str(executable),
        ffmpeg_version=str(version),
        ffmpeg_argv=argv,
        geometry_mode=geometry_mode,
        pad_gray=pad_gray,
        source_sample_aspect_ratio=source_sample_aspect_ratio,
        decoded_frame_identity=_require_mapping(
            record.get("decoded_frame_identity"),
            role="decoded frame identity",
        ),
        start_frame=start_frame,
    )
    if dict(record) != expected_record:
        raise MotionSourceConstructionError("construction semantics are invalid")
    expected_argv = _encode_argv(
        ffmpeg=str(executable),
        source_path=source_path,
        output_path=output_path,
        filtergraph=expected_filter,
        geometry_mode=geometry_mode,
    )
    if argv != expected_argv:
        raise MotionSourceConstructionError("ffmpeg argv differs from construction semantics")
    if not isinstance(version, str) or not version.startswith("ffmpeg version"):
        raise MotionSourceConstructionError("ffmpeg version evidence is invalid")
    return geometry_mode, start_frame


def _validate_probe_record(
    record: Mapping[str, object],
    *,
    current: MediaProbeEvidence,
    stream_types: Sequence[str],
    role: str,
) -> None:
    expected = _probe_payload(current, stream_types=stream_types)
    if dict(record) != expected:
        raise MotionSourceConstructionError(f"{role} probe evidence differs")


def construct_motion_source(
    raw_mp4: Path,
    output_directory: Path,
    *,
    pad_gray: int | None = None,
    geometry_mode: str = PAD_CROP_MODE,
    start_frame: int = SELECTED_START_FRAME,
) -> MotionSourceConstruction:
    """Select 121 ordered raw frames and publish one immutable canonical source.

    Both geometry modes preserve selected-frame order and only reset the
    sequence's timestamp origin. ``crop_pad`` retains the original pixels and
    adds explicit rows. ``scale_center_crop`` proportionally scales to 720
    lines before a deterministic center crop, without inserting a seam.
    """
    _validate_geometry_arguments(geometry_mode, pad_gray)
    selected_start = _validate_start_frame(start_frame)
    source_path = Path(raw_mp4).resolve()
    target = Path(output_directory).resolve()
    if target.exists():
        raise ArtifactExistsError(f"artifact already exists: {target}")
    if not source_path.is_file():
        raise MotionSourceConstructionError(f"raw source does not exist: {source_path}")
    if source_path.suffix.lower() != ".mp4":
        raise MotionSourceConstructionError("raw source path must end in .mp4")

    try:
        source_evidence = probe_media_evidence(source_path)
    except FfmpegPipelineError as error:
        raise MotionSourceConstructionError("raw source probe failed") from error
    _validate_raw_source(
        source_evidence,
        start_frame=selected_start,
    )
    source_stream_types = _stream_types(
        source_path,
        source_evidence.ffprobe_executable,
    )

    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        target.mkdir()
    except FileExistsError as error:
        raise ArtifactExistsError(f"artifact already exists: {target}") from error

    output_path = target / OUTPUT_FILENAME
    manifest_path = target / MANIFEST_FILENAME
    ffmpeg = _ffmpeg_executable()
    ffmpeg_version = _version_line(ffmpeg)
    filtergraph = _filter(
        geometry_mode,
        pad_gray,
        start_frame=selected_start,
    )
    argv = _encode_argv(
        ffmpeg=ffmpeg,
        source_path=source_path,
        output_path=output_path,
        filtergraph=filtergraph,
        geometry_mode=geometry_mode,
    )
    completed = False
    try:
        _run(argv)
        try:
            output_evidence = probe_media_evidence(output_path)
        except FfmpegPipelineError as error:
            raise MotionSourceConstructionError(
                "canonical output probe failed"
            ) from error
        output_stream_types = _stream_types(
            output_path,
            output_evidence.ffprobe_executable,
        )
        _validate_canonical_output(
            output_evidence,
            stream_types=output_stream_types,
        )
        decoded_frame_identity = _decoded_frame_identity(
            ffmpeg=ffmpeg,
            source_path=source_path,
            output_path=output_path,
            filtergraph=filtergraph,
            geometry_mode=geometry_mode,
        )

        unsigned_payload: dict[str, object] = {
            "construction": _construction_payload(
                ffmpeg=ffmpeg,
                ffmpeg_version=ffmpeg_version,
                ffmpeg_argv=argv,
                geometry_mode=geometry_mode,
                pad_gray=pad_gray,
                source_sample_aspect_ratio=(
                    source_evidence.facts.sample_aspect_ratio
                ),
                decoded_frame_identity=decoded_frame_identity,
                start_frame=selected_start,
            ),
            "kind": MANIFEST_KIND,
            "output": _artifact_payload(
                output_path,
                output_evidence,
                output_stream_types,
            ),
            "schema_version": _schema_version(
                geometry_mode,
                start_frame=selected_start,
            ),
            "source": _artifact_payload(
                source_path,
                source_evidence,
                source_stream_types,
            ),
        }
        payload = dict(unsigned_payload)
        payload["digest_sha256"] = _sha256_bytes(
            _canonical_json_bytes(unsigned_payload)
        )
        _write_manifest(manifest_path, payload)
        result = load_motion_source_construction(manifest_path)
        completed = True
        return result
    finally:
        if not completed:
            shutil.rmtree(target, ignore_errors=True)


def load_motion_source_construction(
    manifest_path: Path,
) -> MotionSourceConstruction:
    """Reopen and validate every hash, semantic record and media fact."""
    declared_manifest = Path(manifest_path)
    if declared_manifest.name != MANIFEST_FILENAME:
        raise MotionSourceConstructionError(
            f"manifest must be named {MANIFEST_FILENAME}"
        )
    manifest = declared_manifest.resolve()
    payload = _read_manifest(manifest)
    _require_exact_keys(
        payload,
        {
            "construction",
            "digest_sha256",
            "kind",
            "output",
            "schema_version",
            "source",
        },
        role="manifest",
    )
    schema_version = payload.get("schema_version")
    if schema_version not in {
        PAD_SCHEMA_VERSION,
        SCALE_SCHEMA_VERSION,
        SELECTABLE_WINDOW_SCHEMA_VERSION,
    } or payload.get("kind") != MANIFEST_KIND:
        raise MotionSourceConstructionError("motion source manifest contract is invalid")
    declared_digest = _require_sha256(
        payload.get("digest_sha256"),
        role="manifest digest",
    )
    unsigned_payload = dict(payload)
    unsigned_payload.pop("digest_sha256")
    calculated_digest = _sha256_bytes(_canonical_json_bytes(unsigned_payload))
    if declared_digest != calculated_digest:
        raise MotionSourceConstructionError("manifest digest differs")

    source_record = _require_mapping(payload.get("source"), role="source record")
    output_record = _require_mapping(payload.get("output"), role="output record")
    artifact_keys = {"path", "probe", "sha256"}
    _require_exact_keys(source_record, artifact_keys, role="source record")
    _require_exact_keys(output_record, artifact_keys, role="output record")
    source_value = source_record.get("path")
    output_value = output_record.get("path")
    if not isinstance(source_value, str) or not isinstance(output_value, str):
        raise MotionSourceConstructionError("artifact paths are invalid")
    source_path = Path(source_value).resolve()
    output_path = Path(output_value).resolve()
    expected_output_path = (manifest.parent / OUTPUT_FILENAME).resolve()
    if output_path != expected_output_path:
        raise MotionSourceConstructionError("output path differs from manifest location")
    if source_path == output_path:
        raise MotionSourceConstructionError("source and output paths must differ")

    source_hash = _require_sha256(source_record.get("sha256"), role="source")
    output_hash = _require_sha256(output_record.get("sha256"), role="output")
    if not source_path.is_file() or sha256_file(source_path) != source_hash:
        raise MotionSourceConstructionError("source hash differs")
    if not output_path.is_file() or sha256_file(output_path) != output_hash:
        raise MotionSourceConstructionError("output hash differs")

    try:
        source_evidence = probe_media_evidence(source_path)
        output_evidence = probe_media_evidence(output_path)
    except FfmpegPipelineError as error:
        raise MotionSourceConstructionError("artifact reopen probe failed") from error
    construction = _require_mapping(
        payload.get("construction"),
        role="construction record",
    )
    start_frame = _start_frame_from_construction_record(construction)
    _validate_raw_source(
        source_evidence,
        start_frame=start_frame,
    )
    geometry = _require_mapping(
        construction.get("geometry"),
        role="construction geometry",
    )
    geometry_mode, _ = _geometry_arguments_from_record(geometry)
    if schema_version != _schema_version(
        geometry_mode,
        start_frame=start_frame,
    ):
        raise MotionSourceConstructionError(
            "manifest schema version differs from geometry mode"
        )
    executable = construction.get("ffmpeg_executable")
    filtergraph = construction.get("filtergraph")
    if not isinstance(executable, str) or not isinstance(filtergraph, str):
        raise MotionSourceConstructionError("construction executable evidence is invalid")
    decoded_frame_identity = _decoded_frame_identity(
        ffmpeg=executable,
        source_path=source_path,
        output_path=output_path,
        filtergraph=filtergraph,
        geometry_mode=geometry_mode,
    )
    if construction.get("decoded_frame_identity") != decoded_frame_identity:
        raise MotionSourceConstructionError("decoded frame identity evidence differs")
    validated_geometry_mode, validated_start_frame = _validate_construction_record(
        construction,
        source_path=source_path,
        output_path=output_path,
        source_sample_aspect_ratio=source_evidence.facts.sample_aspect_ratio,
    )
    if (
        validated_geometry_mode != geometry_mode
        or validated_start_frame != start_frame
    ):
        raise MotionSourceConstructionError(
            "construction geometry or selected start frame differs"
        )
    source_stream_types = _stream_types(
        source_path,
        source_evidence.ffprobe_executable,
    )
    output_stream_types = _stream_types(
        output_path,
        output_evidence.ffprobe_executable,
    )
    _validate_canonical_output(
        output_evidence,
        stream_types=output_stream_types,
    )
    source_probe = _require_mapping(source_record.get("probe"), role="source probe")
    output_probe = _require_mapping(output_record.get("probe"), role="output probe")
    _validate_probe_record(
        source_probe,
        current=source_evidence,
        stream_types=source_stream_types,
        role="source",
    )
    _validate_probe_record(
        output_probe,
        current=output_evidence,
        stream_types=output_stream_types,
        role="output",
    )
    return MotionSourceConstruction(
        directory=manifest.parent,
        source_path=source_path,
        output_path=output_path,
        manifest_path=manifest,
        source_sha256=source_hash,
        output_sha256=output_hash,
        manifest_digest_sha256=declared_digest,
        facts=output_evidence.facts,
        geometry_mode=geometry_mode,
        start_frame=start_frame,
    )


def _byte_argument(value: str) -> int:
    try:
        parsed = int(value, 0)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer byte") from error
    if not 0 <= parsed <= 255:
        raise argparse.ArgumentTypeError("must be between 0 and 255")
    return parsed


def _start_frame_argument(value: str) -> int:
    try:
        parsed = int(value, 10)
    except ValueError as error:
        raise argparse.ArgumentTypeError(
            "start frame must be a nonnegative integer"
        ) from error
    if parsed < 0:
        raise argparse.ArgumentTypeError(
            "start frame must be a nonnegative integer"
        )
    return parsed


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Construct FrameLock's immutable 1280x720, 121-frame, 24 FPS "
            "Motion v1 source without interpolation."
        )
    )
    parser.add_argument("raw_mp4", type=Path)
    parser.add_argument("output_directory", type=Path)
    parser.add_argument(
        "--geometry-mode",
        choices=(PAD_CROP_MODE, SCALE_CENTER_CROP_MODE),
        default=PAD_CROP_MODE,
        help=(
            "Use crop_pad with --pad-gray or seamless scale_center_crop "
            "without --pad-gray."
        ),
    )
    parser.add_argument(
        "--pad-gray",
        type=_byte_argument,
        help="Explicit RGB gray byte required only by crop_pad geometry.",
    )
    parser.add_argument(
        "--start-frame",
        type=_start_frame_argument,
        default=SELECTED_START_FRAME,
        help=(
            "Zero-based first decoded source frame. Exactly 121 ordered frames "
            "are selected without interpolation."
        ),
    )
    arguments = parser.parse_args(argv)
    result = construct_motion_source(
        arguments.raw_mp4,
        arguments.output_directory,
        pad_gray=arguments.pad_gray,
        geometry_mode=arguments.geometry_mode,
        start_frame=arguments.start_frame,
    )
    print(
        json.dumps(
            {
                "frame_count": result.facts.frame_count,
                "frame_rate": "24/1",
                "geometry_mode": result.geometry_mode,
                "height": result.facts.height,
                "manifest_digest_sha256": result.manifest_digest_sha256,
                "manifest_path": str(result.manifest_path),
                "output_path": str(result.output_path),
                "output_sha256": result.output_sha256,
                "source_path": str(result.source_path),
                "source_sha256": result.source_sha256,
                "start_frame": result.start_frame,
                "width": result.facts.width,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
