from __future__ import annotations

from dataclasses import asdict, dataclass
from fractions import Fraction
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from typing import Sequence
import wave

import numpy as np

from .artifacts import load_rgb_png, sha256_file
from .contract import (
    CANONICAL_CONTRACT,
    DecodeProvenance,
    MediaFacts,
    validate_media_facts,
)
from .masks import MaskDomainError, load_edit_mask


FFMPEG_TIMEOUT_SECONDS = 180
SOURCE_AUDIO_SAMPLE_RATE_HZ = 48_000
SOURCE_AUDIO_CHANNELS = 2
SOURCE_AUDIO_SAMPLE_COUNT = 242_000
SOURCE_AUDIO_CLAIM_SCOPE = "outside_pixel_verification_claim"
SOURCE_AUDIO_NORMALIZATION_OPERATION = (
    "resample_stereo_then_pad_and_trim_to_242000_samples"
)
BT709_LIMITED_FALLBACK_ASSUMPTION = (
    "Source color metadata was absent or incomplete; FrameLock explicitly "
    "assumed BT.709 matrix and limited-range YUV for canonical decoding."
)


class FfmpegPipelineError(RuntimeError):
    """Raised when FFmpeg cannot produce a canonical local artifact."""


class MaskTransportViolation(ValueError):
    """Raised when encoded mask transport changes authoritative mask bytes."""


@dataclass(frozen=True)
class MediaProbeEvidence:
    facts: MediaFacts
    argv: tuple[str, ...]
    raw_json: str
    timestamp_tokens: tuple[str, ...]
    ffprobe_executable: str
    ffprobe_version: str


@dataclass(frozen=True)
class DecodedRgbSequence:
    paths: tuple[Path, ...]
    provenance: DecodeProvenance


@dataclass(frozen=True)
class SourceAudioProvenance:
    source_media_path: str
    source_file_sha256: str
    source_audio_present: bool
    source_audio_stream_count: int
    selected_source_audio_stream_index: int | None
    source_codec: str | None
    source_sample_rate_hz: int | None
    source_channels: int | None
    source_channel_layout: str | None
    source_duration_seconds: float | None
    normalized_audio_path: str | None
    normalized_audio_file_sha256: str | None
    normalized_codec: str | None
    normalized_sample_format: str | None
    normalized_sample_rate_hz: int | None
    normalized_channels: int | None
    normalized_sample_count: int | None
    normalization_operation: str
    target_sample_count: int
    target_duration_numerator: int
    target_duration_denominator: int
    ffmpeg_executable: str | None
    ffmpeg_version: str | None
    ffprobe_executable: str
    ffprobe_version: str
    probe_argv: tuple[str, ...]
    probe_json_sha256: str
    normalize_argv: tuple[str, ...]
    claim_scope: str = SOURCE_AUDIO_CLAIM_SCOPE
    schema_version: int = 1


@dataclass(frozen=True)
class _AudioProbe:
    streams: tuple[dict[str, object], ...]
    argv: tuple[str, ...]
    raw_json: str
    ffprobe_executable: str
    ffprobe_version: str


def _executable(name: str) -> str:
    path = shutil.which(name)
    if path is None:
        raise FfmpegPipelineError(f"required executable is unavailable: {name}")
    return str(Path(path).resolve())


def _run(argv: Sequence[str], *, timeout: int = FFMPEG_TIMEOUT_SECONDS) -> str:
    try:
        completed = subprocess.run(
            list(argv),
            check=True,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        raise FfmpegPipelineError(
            f"media command exceeded {timeout} seconds: {argv[0]}"
        ) from error
    except subprocess.CalledProcessError as error:
        stderr = (error.stderr or "").strip()
        detail = stderr[-2_000:] if stderr else "no diagnostic output"
        raise FfmpegPipelineError(
            f"media command failed ({Path(argv[0]).name}): {detail}"
        ) from error
    return completed.stdout


def _version_line(executable: str) -> str:
    output = _run([executable, "-version"])
    line = output.splitlines()[0] if output.splitlines() else ""
    if not line:
        raise FfmpegPipelineError(f"{Path(executable).name} did not report a version")
    return line


def _parse_fraction(value: object, *, field: str) -> Fraction:
    if not isinstance(value, str) or value in {"", "N/A", "0/0"}:
        raise FfmpegPipelineError(f"ffprobe did not report a valid {field}")
    try:
        return Fraction(value.replace(":", "/"))
    except (ValueError, ZeroDivisionError) as error:
        raise FfmpegPipelineError(f"ffprobe reported invalid {field}: {value}") from error


def _parse_optional_fraction(value: object, *, field: str) -> Fraction | None:
    if value in {None, "", "N/A", "0/0"}:
        return None
    return _parse_fraction(value, field=field)


def _rotation_degrees(stream: dict[str, object]) -> int:
    tags = stream.get("tags", {})
    if isinstance(tags, dict) and "rotate" in tags:
        try:
            return int(tags["rotate"])
        except (TypeError, ValueError) as error:
            raise FfmpegPipelineError("invalid rotate stream tag") from error
    side_data = stream.get("side_data_list", [])
    if isinstance(side_data, list):
        for entry in side_data:
            if isinstance(entry, dict) and "rotation" in entry:
                try:
                    return int(entry["rotation"])
                except (TypeError, ValueError) as error:
                    raise FfmpegPipelineError("invalid display-matrix rotation") from error
    return 0


def _container_name(path: Path, format_record: dict[str, object]) -> str:
    format_name = format_record.get("format_name")
    tokens = (
        {token.strip().lower() for token in format_name.split(",")}
        if isinstance(format_name, str)
        else set()
    )
    tags = format_record.get("tags", {})
    major_brand = tags.get("major_brand") if isinstance(tags, dict) else None
    if path.suffix.lower() == ".mp4" and "mp4" in tokens and major_brand != "qt  ":
        return "mp4"
    return next(iter(sorted(tokens)), "unknown")


def _probe_media(path: Path) -> MediaProbeEvidence:
    """Decode-probe the first real video stream without trusting nb_frames."""
    if not path.is_file():
        raise FfmpegPipelineError(f"media file does not exist: {path}")
    ffprobe = _executable("ffprobe")
    entries = (
        "format=format_name,size,duration:format_tags=major_brand:"
        "stream=index,codec_type,codec_name,width,height,pix_fmt,"
        "sample_aspect_ratio,display_aspect_ratio,r_frame_rate,avg_frame_rate,"
        "time_base,start_time,duration,color_range,color_space,color_transfer,"
        "color_primaries,chroma_location:stream_tags=rotate:"
        "stream_side_data=rotation,displaymatrix:"
        "frame=pts,best_effort_timestamp_time,width,height,pix_fmt"
    )
    argv = (
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "V:0",
        "-show_streams",
        "-show_format",
        "-show_frames",
        "-show_entries",
        entries,
        "-of",
        "json",
        str(path),
    )
    raw = _run(argv)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise FfmpegPipelineError("ffprobe returned malformed JSON") from error
    streams = payload.get("streams")
    frames = payload.get("frames")
    format_record = payload.get("format")
    if not isinstance(streams, list) or len(streams) != 1:
        raise FfmpegPipelineError("media must expose exactly one selected video stream")
    if not isinstance(frames, list) or not frames:
        raise FfmpegPipelineError("media exposes no decoded video frames")
    if not isinstance(format_record, dict) or not isinstance(streams[0], dict):
        raise FfmpegPipelineError("ffprobe omitted stream or format metadata")
    stream = streams[0]
    width = stream.get("width")
    height = stream.get("height")
    if not isinstance(width, int) or not isinstance(height, int):
        raise FfmpegPipelineError("ffprobe omitted video dimensions")
    for index, frame in enumerate(frames):
        if not isinstance(frame, dict):
            raise FfmpegPipelineError(f"ffprobe frame {index} is malformed")
        if frame.get("width") != width or frame.get("height") != height:
            raise FfmpegPipelineError(f"decoded frame {index} changes geometry")

    time_base = _parse_fraction(stream.get("time_base"), field="time base")
    timestamps: list[float] = []
    timestamp_tokens: list[str] = []
    for index, frame in enumerate(frames):
        pts = frame.get("pts")
        if pts is None:
            raise FfmpegPipelineError(f"decoded frame {index} has no integer PTS")
        try:
            exact_timestamp = int(pts) * time_base
        except (TypeError, ValueError) as error:
            raise FfmpegPipelineError(
                f"decoded frame {index} has invalid integer PTS"
            ) from error
        timestamps.append(float(exact_timestamp))
        timestamp_tokens.append(
            f"{exact_timestamp.numerator}/{exact_timestamp.denominator}"
        )

    frame_rate = _parse_fraction(stream.get("r_frame_rate"), field="frame rate")
    declared_duration: float | None = None
    # Container duration can be extended by source audio that Stage A will
    # deterministically trim. The video contract is scoped to the video stream.
    duration_value = stream.get("duration")
    if isinstance(duration_value, str) and duration_value not in {"", "N/A"}:
        try:
            declared_duration = float(duration_value)
        except ValueError as error:
            raise FfmpegPipelineError("ffprobe reported invalid duration") from error
    if declared_duration is None:
        declared_duration = (
            timestamps[-1] - timestamps[0] + 1.0 / float(frame_rate)
        )

    facts = MediaFacts(
        container=_container_name(path, format_record),
        width=width,
        height=height,
        frame_count=len(frames),
        frame_rate=frame_rate,
        presentation_timestamps=tuple(timestamps),
        file_size_bytes=path.stat().st_size,
        rotation_degrees=_rotation_degrees(stream),
        sample_aspect_ratio=_parse_optional_fraction(
            stream.get("sample_aspect_ratio"), field="sample aspect ratio"
        ),
        declared_duration_seconds=declared_duration,
        codec_name=str(stream.get("codec_name", "unknown")),
        pixel_format=str(stream.get("pix_fmt", "unknown")),
        time_base=time_base,
        color_range=(
            str(stream["color_range"]) if "color_range" in stream else None
        ),
        color_space=(
            str(stream["color_space"]) if "color_space" in stream else None
        ),
        color_transfer=(
            str(stream["color_transfer"]) if "color_transfer" in stream else None
        ),
        color_primaries=(
            str(stream["color_primaries"])
            if "color_primaries" in stream
            else None
        ),
        chroma_location=(
            str(stream["chroma_location"])
            if "chroma_location" in stream
            else None
        ),
    )
    return MediaProbeEvidence(
        facts=facts,
        argv=argv,
        raw_json=raw,
        timestamp_tokens=tuple(timestamp_tokens),
        ffprobe_executable=ffprobe,
        ffprobe_version=_version_line(ffprobe),
    )


def probe_media_facts(path: Path) -> MediaFacts:
    """Decode-probe the first real video stream without trusting nb_frames."""
    return _probe_media(path).facts


def probe_media_evidence(path: Path) -> MediaProbeEvidence:
    """Return facts plus the exact ffprobe evidence used to derive them."""
    return _probe_media(path)


def _probe_audio_streams(path: Path) -> _AudioProbe:
    if not path.is_file():
        raise FfmpegPipelineError(f"media file does not exist: {path}")
    ffprobe = _executable("ffprobe")
    argv = (
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "a",
        "-show_streams",
        "-show_entries",
        (
            "stream=index,codec_name,sample_fmt,sample_rate,channels,"
            "channel_layout,time_base,start_time,duration,duration_ts"
        ),
        "-of",
        "json",
        str(path),
    )
    raw = _run(argv)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise FfmpegPipelineError("audio ffprobe returned malformed JSON") from error
    streams = payload.get("streams")
    if not isinstance(streams, list) or not all(
        isinstance(stream, dict) for stream in streams
    ):
        raise FfmpegPipelineError("audio ffprobe omitted stream metadata")
    return _AudioProbe(
        streams=tuple(streams),
        argv=argv,
        raw_json=raw,
        ffprobe_executable=ffprobe,
        ffprobe_version=_version_line(ffprobe),
    )


def _optional_int(value: object, *, field: str) -> int | None:
    if value in {None, "", "N/A"}:
        return None
    try:
        return int(value)
    except (TypeError, ValueError) as error:
        raise FfmpegPipelineError(f"audio ffprobe reported invalid {field}") from error


def _optional_float(value: object, *, field: str) -> float | None:
    if value in {None, "", "N/A"}:
        return None
    try:
        return float(value)
    except (TypeError, ValueError) as error:
        raise FfmpegPipelineError(f"audio ffprobe reported invalid {field}") from error


def _validate_working_pcm(path: Path) -> None:
    try:
        with wave.open(str(path), "rb") as audio:
            facts = (
                audio.getcomptype(),
                audio.getframerate(),
                audio.getnchannels(),
                audio.getsampwidth(),
                audio.getnframes(),
            )
    except (OSError, EOFError, wave.Error) as error:
        raise FfmpegPipelineError("normalized source audio is not valid PCM") from error
    if facts != (
        "NONE",
        SOURCE_AUDIO_SAMPLE_RATE_HZ,
        SOURCE_AUDIO_CHANNELS,
        2,
        SOURCE_AUDIO_SAMPLE_COUNT,
    ):
        raise FfmpegPipelineError(
            "normalized source audio must be 48 kHz stereo s16 PCM with "
            "exactly 242000 samples"
        )


def _validate_source_audio_provenance(
    evidence: SourceAudioProvenance,
) -> None:
    if (
        evidence.schema_version != 1
        or evidence.claim_scope != SOURCE_AUDIO_CLAIM_SCOPE
        or evidence.target_sample_count != SOURCE_AUDIO_SAMPLE_COUNT
        or evidence.target_duration_numerator != CANONICAL_CONTRACT.frame_count
        or evidence.target_duration_denominator
        != CANONICAL_CONTRACT.frame_rate.numerator
    ):
        raise FfmpegPipelineError("source audio provenance contract is invalid")
    source_path = Path(evidence.source_media_path)
    if (
        not source_path.is_file()
        or sha256_file(source_path) != evidence.source_file_sha256
    ):
        raise FfmpegPipelineError("source audio provenance source hash differs")
    if (
        len(evidence.source_file_sha256) != 64
        or len(evidence.probe_json_sha256) != 64
        or not evidence.probe_argv
        or not evidence.ffprobe_version
    ):
        raise FfmpegPipelineError("source audio provenance is incomplete")
    if evidence.source_audio_present:
        if (
            evidence.source_audio_stream_count < 1
            or evidence.selected_source_audio_stream_index != 0
            or not evidence.source_codec
            or not evidence.source_sample_rate_hz
            or not evidence.source_channels
            or evidence.normalized_codec != "pcm_s16le"
            or evidence.normalized_sample_format != "s16"
            or evidence.normalized_sample_rate_hz != SOURCE_AUDIO_SAMPLE_RATE_HZ
            or evidence.normalized_channels != SOURCE_AUDIO_CHANNELS
            or evidence.normalized_sample_count != SOURCE_AUDIO_SAMPLE_COUNT
            or evidence.normalization_operation
            != SOURCE_AUDIO_NORMALIZATION_OPERATION
            or not evidence.ffmpeg_executable
            or not evidence.ffmpeg_version
            or not evidence.normalize_argv
            or not evidence.normalized_audio_path
            or not evidence.normalized_audio_file_sha256
        ):
            raise FfmpegPipelineError("source audio provenance is incomplete")
        normalized_path = Path(evidence.normalized_audio_path)
        if (
            not normalized_path.is_file()
            or sha256_file(normalized_path)
            != evidence.normalized_audio_file_sha256
        ):
            raise FfmpegPipelineError("normalized source audio hash differs")
        _validate_working_pcm(normalized_path)
    elif (
        evidence.source_audio_stream_count != 0
        or evidence.selected_source_audio_stream_index is not None
        or evidence.source_codec is not None
        or evidence.source_sample_rate_hz is not None
        or evidence.source_channels is not None
        or evidence.source_channel_layout is not None
        or evidence.source_duration_seconds is not None
        or evidence.normalized_audio_path is not None
        or evidence.normalized_audio_file_sha256 is not None
        or evidence.normalized_codec is not None
        or evidence.normalized_sample_format is not None
        or evidence.normalized_sample_rate_hz is not None
        or evidence.normalized_channels is not None
        or evidence.normalized_sample_count is not None
        or evidence.normalization_operation != "absent_source_no_track"
        or evidence.ffmpeg_executable is not None
        or evidence.ffmpeg_version is not None
        or evidence.normalize_argv
    ):
        raise FfmpegPipelineError("absent source audio provenance is invalid")


def _canonical_json_bytes(payload: object) -> bytes:
    return json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("utf-8")


def _write_source_audio_manifest(
    path: Path, evidence: SourceAudioProvenance
) -> None:
    if path.exists():
        raise FileExistsError(f"source audio manifest already exists: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    payload: dict[str, object] = {
        "schema_version": 1,
        "source_audio": asdict(evidence),
    }
    payload["digest_sha256"] = hashlib.sha256(
        _canonical_json_bytes(payload)
    ).hexdigest()
    temporary_directory = Path(
        tempfile.mkdtemp(prefix=f".{path.name}.tmp-", dir=str(path.parent))
    )
    temporary_path = temporary_directory / path.name
    try:
        temporary_path.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary_path, path)
    finally:
        shutil.rmtree(temporary_directory, ignore_errors=True)


def load_source_audio_manifest(path: Path) -> SourceAudioProvenance:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise FfmpegPipelineError("source audio manifest is unreadable") from error
    if not isinstance(payload, dict) or payload.get("schema_version") != 1:
        raise FfmpegPipelineError("source audio manifest schema is invalid")
    declared_digest = payload.get("digest_sha256")
    unsigned_payload = dict(payload)
    unsigned_payload.pop("digest_sha256", None)
    if declared_digest != hashlib.sha256(
        _canonical_json_bytes(unsigned_payload)
    ).hexdigest():
        raise FfmpegPipelineError("source audio manifest digest differs")
    raw_evidence = payload.get("source_audio")
    if not isinstance(raw_evidence, dict):
        raise FfmpegPipelineError("source audio manifest evidence is invalid")
    values = dict(raw_evidence)
    for field in ("probe_argv", "normalize_argv"):
        raw_argv = values.get(field)
        if not isinstance(raw_argv, list) or not all(
            isinstance(value, str) for value in raw_argv
        ):
            raise FfmpegPipelineError(
                f"source audio manifest {field} is invalid"
            )
        values[field] = tuple(raw_argv)
    try:
        evidence = SourceAudioProvenance(**values)
    except TypeError as error:
        raise FfmpegPipelineError("source audio manifest evidence is malformed") from error
    _validate_source_audio_provenance(evidence)
    return evidence


def prepare_source_audio(
    source_media_path: Path,
    normalized_audio_path: Path,
    manifest_path: Path,
) -> SourceAudioProvenance:
    """Persist canonical working PCM or an explicit no-source-audio record."""
    if normalized_audio_path.exists() or manifest_path.exists():
        raise FileExistsError("source audio artifact already exists")
    if normalized_audio_path.suffix.lower() != ".wav":
        raise FfmpegPipelineError("normalized source audio must be a WAV artifact")
    probe = _probe_audio_streams(source_media_path)
    common: dict[str, object] = {
        "source_media_path": str(source_media_path.resolve()),
        "source_file_sha256": sha256_file(source_media_path),
        "source_audio_stream_count": len(probe.streams),
        "target_sample_count": SOURCE_AUDIO_SAMPLE_COUNT,
        "target_duration_numerator": CANONICAL_CONTRACT.frame_count,
        "target_duration_denominator": CANONICAL_CONTRACT.frame_rate.numerator,
        "ffprobe_executable": probe.ffprobe_executable,
        "ffprobe_version": probe.ffprobe_version,
        "probe_argv": probe.argv,
        "probe_json_sha256": hashlib.sha256(
            probe.raw_json.encode("utf-8")
        ).hexdigest(),
    }
    if not probe.streams:
        evidence = SourceAudioProvenance(
            **common,
            source_audio_present=False,
            selected_source_audio_stream_index=None,
            source_codec=None,
            source_sample_rate_hz=None,
            source_channels=None,
            source_channel_layout=None,
            source_duration_seconds=None,
            normalized_audio_path=None,
            normalized_audio_file_sha256=None,
            normalized_codec=None,
            normalized_sample_format=None,
            normalized_sample_rate_hz=None,
            normalized_channels=None,
            normalized_sample_count=None,
            normalization_operation="absent_source_no_track",
            ffmpeg_executable=None,
            ffmpeg_version=None,
            normalize_argv=(),
        )
        _validate_source_audio_provenance(evidence)
        _write_source_audio_manifest(manifest_path, evidence)
        return evidence

    selected = probe.streams[0]
    source_sample_rate = _optional_int(
        selected.get("sample_rate"), field="sample rate"
    )
    source_channels = _optional_int(selected.get("channels"), field="channels")
    if source_sample_rate is None or source_channels is None:
        raise FfmpegPipelineError("selected source audio stream is incomplete")
    ffmpeg = _executable("ffmpeg")
    ffmpeg_version = _version_line(ffmpeg)
    normalized_audio_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_directory = Path(
        tempfile.mkdtemp(
            prefix=f".{normalized_audio_path.name}.tmp-",
            dir=str(normalized_audio_path.parent),
        )
    )
    temporary_path = temporary_directory / normalized_audio_path.name
    normalize_argv = (
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-xerror",
        "-i",
        str(source_media_path),
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-af",
        (
            "aresample=48000,apad=whole_len=242000,"
            "atrim=end_sample=242000,asetpts=N/SR/TB"
        ),
        "-ar",
        str(SOURCE_AUDIO_SAMPLE_RATE_HZ),
        "-ac",
        str(SOURCE_AUDIO_CHANNELS),
        "-c:a",
        "pcm_s16le",
        "-map_metadata",
        "-1",
        "-fflags",
        "+bitexact",
        "-flags:a",
        "+bitexact",
        "-n",
        str(temporary_path),
    )
    try:
        _run(normalize_argv)
        _validate_working_pcm(temporary_path)
        os.replace(temporary_path, normalized_audio_path)
    except Exception:
        normalized_audio_path.unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(temporary_directory, ignore_errors=True)

    try:
        evidence = SourceAudioProvenance(
            **common,
            source_audio_present=True,
            selected_source_audio_stream_index=0,
            source_codec=str(selected.get("codec_name", "unknown")),
            source_sample_rate_hz=source_sample_rate,
            source_channels=source_channels,
            source_channel_layout=(
                str(selected["channel_layout"])
                if selected.get("channel_layout") not in {None, ""}
                else None
            ),
            source_duration_seconds=_optional_float(
                selected.get("duration"), field="duration"
            ),
            normalized_audio_path=str(normalized_audio_path.resolve()),
            normalized_audio_file_sha256=sha256_file(normalized_audio_path),
            normalized_codec="pcm_s16le",
            normalized_sample_format="s16",
            normalized_sample_rate_hz=SOURCE_AUDIO_SAMPLE_RATE_HZ,
            normalized_channels=SOURCE_AUDIO_CHANNELS,
            normalized_sample_count=SOURCE_AUDIO_SAMPLE_COUNT,
            normalization_operation=SOURCE_AUDIO_NORMALIZATION_OPERATION,
            ffmpeg_executable=ffmpeg,
            ffmpeg_version=ffmpeg_version,
            normalize_argv=normalize_argv,
        )
        _validate_source_audio_provenance(evidence)
        _write_source_audio_manifest(manifest_path, evidence)
    except Exception:
        normalized_audio_path.unlink(missing_ok=True)
        raise
    return evidence


def _temporary_output_directory(target: Path) -> Path:
    if target.exists():
        if not target.is_dir() or any(target.iterdir()):
            raise FileExistsError(f"artifact directory already exists: {target}")
        # pytest and upload staging commonly hand us an already-created empty
        # directory. Remove only that empty shell so finalization stays atomic.
        target.rmdir()
    target.parent.mkdir(parents=True, exist_ok=True)
    return Path(
        tempfile.mkdtemp(prefix=f".{target.name}.tmp-", dir=str(target.parent))
    )


def _finalize_directory(temporary: Path, target: Path) -> None:
    if target.exists():
        raise FileExistsError(f"artifact directory already exists: {target}")
    os.replace(temporary, target)


def _exact_sequence(directory: Path, stem: str) -> tuple[Path, ...]:
    expected = tuple(
        directory / f"{stem}_{index:06d}.png"
        for index in range(CANONICAL_CONTRACT.frame_count)
    )
    actual = tuple(sorted(directory.glob("*.png")))
    if actual != expected:
        raise FfmpegPipelineError(
            f"artifact sequence must be exactly {stem}_000000.png through "
            f"{stem}_000120.png"
        )
    return expected


def _decode_probed_rgb24_sequence(
    media_path: Path,
    output_directory: Path,
    probe: MediaProbeEvidence,
    *,
    max_pts_residual_seconds: float,
    scale_to_canonical: bool,
) -> DecodedRgbSequence:
    facts = probe.facts
    temporary = _temporary_output_directory(output_directory)
    ffmpeg = _executable("ffmpeg")
    scale_dimensions = (
        f"{CANONICAL_CONTRACT.width}:{CANONICAL_CONTRACT.height}:"
        if scale_to_canonical
        else ""
    )
    decode_argv = (
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-xerror",
        "-noautorotate",
        "-err_detect",
        "explode",
        "-i",
        str(media_path),
        "-map",
        "0:V:0",
        "-an",
        "-sn",
        "-dn",
        "-vf",
        (
            f"scale={scale_dimensions}in_color_matrix=bt709:out_color_matrix=bt709:"
            "in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int,"
            "format=rgb24"
        ),
        "-fps_mode",
        "passthrough",
        "-c:v",
        "png",
        "-pix_fmt",
        "rgb24",
        "-compression_level",
        "4",
        "-pred",
        "mixed",
        "-threads:v",
        "1",
        "-start_number",
        "0",
        "-f",
        "image2",
        "-n",
        str(temporary / "frame_%06d.png"),
    )
    try:
        _run(decode_argv)
        temporary_paths = _exact_sequence(temporary, "frame")
        for path in temporary_paths:
            rgb = load_rgb_png(path)
            if rgb.shape != (
                CANONICAL_CONTRACT.height,
                CANONICAL_CONTRACT.width,
                3,
            ):
                raise FfmpegPipelineError("decoded RGB frame geometry is noncanonical")
        _finalize_directory(temporary, output_directory)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    output_paths = tuple(output_directory / path.name for path in temporary_paths)
    timestamps_payload = "\n".join(probe.timestamp_tokens).encode("ascii")
    color_metadata_complete = all(
        value is not None
        for value in (
            facts.color_range,
            facts.color_space,
            facts.color_transfer,
            facts.color_primaries,
        )
    )
    provenance = DecodeProvenance(
        source_media_path=str(media_path.resolve()),
        source_file_sha256=sha256_file(media_path),
        source_container=facts.container,
        source_codec=facts.codec_name,
        source_pixel_format=facts.pixel_format,
        source_color_range=facts.color_range,
        source_color_space=facts.color_space,
        source_color_transfer=facts.color_transfer,
        source_color_primaries=facts.color_primaries,
        source_chroma_location=facts.chroma_location,
        ffmpeg_executable=ffmpeg,
        ffmpeg_version=_version_line(ffmpeg),
        ffprobe_executable=probe.ffprobe_executable,
        ffprobe_version=probe.ffprobe_version,
        probe_argv=probe.argv,
        probe_json_sha256=hashlib.sha256(
            probe.raw_json.encode("utf-8")
        ).hexdigest(),
        decode_argv=decode_argv,
        canonical_color_conversion=(
            "BT.709 limited-range YUV to full-range RGB24"
        ),
        width=CANONICAL_CONTRACT.width,
        height=CANONICAL_CONTRACT.height,
        decoded_frame_count=facts.frame_count,
        frame_rate_numerator=facts.frame_rate.numerator,
        frame_rate_denominator=facts.frame_rate.denominator,
        time_base_numerator=facts.time_base.numerator,
        time_base_denominator=facts.time_base.denominator,
        max_pts_residual_microseconds=round(
            max_pts_residual_seconds * 1_000_000
        ),
        presentation_timestamps_sha256=hashlib.sha256(
            timestamps_payload
        ).hexdigest(),
        color_conversion_basis=(
            "declared_source_metadata"
            if color_metadata_complete
            else "explicit_bt709_limited_fallback"
        ),
        color_conversion_assumption=(
            None if color_metadata_complete else BT709_LIMITED_FALLBACK_ASSUMPTION
        ),
    )
    return DecodedRgbSequence(paths=output_paths, provenance=provenance)


def decode_rgb24_frames_with_provenance(
    media_path: Path, output_directory: Path
) -> DecodedRgbSequence:
    probe = _probe_media(media_path)
    validated = validate_media_facts(probe.facts)
    return _decode_probed_rgb24_sequence(
        media_path,
        output_directory,
        probe,
        max_pts_residual_seconds=validated.max_pts_residual_seconds,
        scale_to_canonical=False,
    )


def decode_comparable_rgb24_frames_with_provenance(
    media_path: Path, output_directory: Path
) -> DecodedRgbSequence:
    """Decode a generator result only after the frozen comparability gate passes."""
    # Imported lazily because generation_gate persists the raw probe evidence and
    # therefore imports this module's probe function.
    from .generation_gate import evaluate_comparability

    probe = _probe_media(media_path)
    comparison = evaluate_comparability(probe.facts)
    if not comparison.passed:
        failures = ", ".join(comparison.failed_checks)
        raise FfmpegPipelineError(
            f"generated media is not comparable: {failures}"
        )
    scale_to_canonical = (
        probe.facts.width,
        probe.facts.height,
    ) != (CANONICAL_CONTRACT.width, CANONICAL_CONTRACT.height)
    return _decode_probed_rgb24_sequence(
        media_path,
        output_directory,
        probe,
        max_pts_residual_seconds=comparison.max_timestamp_residual_seconds,
        scale_to_canonical=scale_to_canonical,
    )


def decode_rgb24_frames(media_path: Path, output_directory: Path) -> tuple[Path, ...]:
    return decode_rgb24_frames_with_provenance(media_path, output_directory).paths


def materialize_static_mask_sequence(
    static_edit_mask_path: Path, output_directory: Path
) -> tuple[Path, ...]:
    mask = load_edit_mask(static_edit_mask_path)
    if mask.shape != (CANONICAL_CONTRACT.height, CANONICAL_CONTRACT.width):
        raise MaskTransportViolation("static edit mask geometry is noncanonical")
    if set(np.unique(mask).tolist()) != {0, 255}:
        raise MaskTransportViolation(
            "static edit mask must contain both values from {0,255}"
        )
    temporary = _temporary_output_directory(output_directory)
    try:
        for index in range(CANONICAL_CONTRACT.frame_count):
            shutil.copyfile(
                static_edit_mask_path, temporary / f"mask_{index:06d}.png"
            )
        temporary_paths = _exact_sequence(temporary, "mask")
        _finalize_directory(temporary, output_directory)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return tuple(output_directory / path.name for path in temporary_paths)


def _validate_authoritative_masks(paths: Sequence[Path]) -> Path:
    if len(paths) != CANONICAL_CONTRACT.frame_count:
        raise MaskTransportViolation("mask sequence must contain exactly 121 frames")
    expected_names = tuple(
        f"mask_{index:06d}.png"
        for index in range(CANONICAL_CONTRACT.frame_count)
    )
    if tuple(path.name for path in paths) != expected_names:
        raise MaskTransportViolation("mask sequence order or names are noncanonical")
    directories = {path.resolve().parent for path in paths}
    if len(directories) != 1:
        raise MaskTransportViolation("mask sequence must share one artifact directory")
    for index, path in enumerate(paths):
        try:
            mask = load_edit_mask(path)
        except (MaskDomainError, OSError) as error:
            raise MaskTransportViolation(f"mask frame {index}: {error}") from error
        if mask.shape != (CANONICAL_CONTRACT.height, CANONICAL_CONTRACT.width):
            raise MaskTransportViolation(f"mask frame {index} geometry is noncanonical")
        if set(np.unique(mask).tolist()) != {0, 255}:
            raise MaskTransportViolation(
                f"mask frame {index} must contain both values from {{0,255}}"
            )
    return next(iter(directories))


def encode_mask_transport(mask_paths: Sequence[Path], output_path: Path) -> None:
    mask_directory = _validate_authoritative_masks(mask_paths)
    if output_path.exists():
        raise FileExistsError(f"artifact already exists: {output_path}")
    if output_path.suffix.lower() != ".mp4":
        raise MaskTransportViolation("mask transport must use an MP4 container")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = _executable("ffmpeg")
    _run(
        [
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
            str(mask_directory / "mask_%06d.png"),
            "-map",
            "0:v:0",
            "-frames:v",
            str(CANONICAL_CONTRACT.frame_count),
            "-vf",
            (
                "scale=w=1280:h=720:in_range=pc:out_range=pc:"
                "flags=accurate_rnd,format=yuv420p,setsar=1"
            ),
            "-fps_mode",
            "passthrough",
            "-c:v",
            "libx264",
            "-preset",
            "veryslow",
            "-crf",
            "0",
            "-g",
            "1",
            "-bf",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-threads:v",
            "1",
            "-color_range",
            "pc",
            "-x264-params",
            (
                "keyint=1:min-keyint=1:scenecut=0:colorprim=bt709:"
                "transfer=bt709:colormatrix=bt709:fullrange=on"
            ),
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
            "-movflags",
            "+faststart",
            "-n",
            str(output_path),
        ]
    )
    validate_media_facts(probe_media_facts(output_path))


def decode_mask_transport(
    media_path: Path, output_directory: Path
) -> tuple[Path, ...]:
    validate_media_facts(probe_media_facts(media_path))
    temporary = _temporary_output_directory(output_directory)
    ffmpeg = _executable("ffmpeg")
    try:
        _run(
            [
                ffmpeg,
                "-hide_banner",
                "-nostdin",
                "-loglevel",
                "error",
                "-xerror",
                "-noautorotate",
                "-err_detect",
                "explode",
                "-i",
                str(media_path),
                "-map",
                "0:V:0",
                "-an",
                "-sn",
                "-dn",
                "-vf",
                "format=gray",
                "-fps_mode",
                "passthrough",
                "-c:v",
                "png",
                "-pix_fmt",
                "gray",
                "-compression_level",
                "4",
                "-pred",
                "mixed",
                "-threads:v",
                "1",
                "-start_number",
                "0",
                "-f",
                "image2",
                "-n",
                str(temporary / "mask_%06d.png"),
            ]
        )
        temporary_paths = _exact_sequence(temporary, "mask")
        for index, path in enumerate(temporary_paths):
            try:
                mask = load_edit_mask(path)
            except (MaskDomainError, OSError) as error:
                raise MaskTransportViolation(
                    f"decoded mask frame {index}: {error}"
                ) from error
            if mask.shape != (
                CANONICAL_CONTRACT.height,
                CANONICAL_CONTRACT.width,
            ):
                raise MaskTransportViolation(
                    f"decoded mask frame {index} geometry is noncanonical"
                )
        _finalize_directory(temporary, output_directory)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return tuple(output_directory / path.name for path in temporary_paths)


def validate_mask_transport_round_trip(
    authoritative_paths: Sequence[Path], decoded_paths: Sequence[Path]
) -> None:
    if len(authoritative_paths) != CANONICAL_CONTRACT.frame_count:
        raise MaskTransportViolation(
            "authoritative mask sequence must contain exactly 121 frames"
        )
    if len(decoded_paths) != CANONICAL_CONTRACT.frame_count:
        raise MaskTransportViolation(
            "decoded mask sequence must contain exactly 121 frames"
        )
    for index, (authoritative_path, decoded_path) in enumerate(
        zip(authoritative_paths, decoded_paths)
    ):
        try:
            authoritative = load_edit_mask(authoritative_path)
            decoded = load_edit_mask(decoded_path)
        except (MaskDomainError, OSError) as error:
            raise MaskTransportViolation(
                f"mask transport frame {index} must remain inside {{0,255}}: {error}"
            ) from error
        if authoritative.shape != decoded.shape or not np.array_equal(
            authoritative, decoded
        ):
            raise MaskTransportViolation(
                f"mask transport frame {index} changed domain or polarity"
            )


def encode_source_fixture(source_paths: Sequence[Path], output_path: Path) -> None:
    if len(source_paths) != CANONICAL_CONTRACT.frame_count:
        raise FfmpegPipelineError("source fixture requires exactly 121 frames")
    expected_names = tuple(
        f"source_{index:06d}.png"
        for index in range(CANONICAL_CONTRACT.frame_count)
    )
    if tuple(path.name for path in source_paths) != expected_names:
        raise FfmpegPipelineError("source fixture order or names are noncanonical")
    directories = {path.resolve().parent for path in source_paths}
    if len(directories) != 1:
        raise FfmpegPipelineError("source fixture frames must share one directory")
    for index, path in enumerate(source_paths):
        rgb = load_rgb_png(path)
        if rgb.shape != (
            CANONICAL_CONTRACT.height,
            CANONICAL_CONTRACT.width,
            3,
        ):
            raise FfmpegPipelineError(
                f"source fixture frame {index} geometry is noncanonical"
            )
    if output_path.exists():
        raise FileExistsError(f"artifact already exists: {output_path}")
    if output_path.suffix.lower() != ".mp4":
        raise FfmpegPipelineError("source fixture must use an MP4 container")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    source_directory = next(iter(directories))
    ffmpeg = _executable("ffmpeg")
    _run(
        [
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
            str(source_directory / "source_%06d.png"),
            "-map",
            "0:v:0",
            "-frames:v",
            str(CANONICAL_CONTRACT.frame_count),
            "-vf",
            (
                "scale=w=1280:h=720:in_range=pc:out_range=tv:"
                "out_color_matrix=bt709:flags=lanczos+accurate_rnd+"
                "full_chroma_int,format=yuv420p,setsar=1"
            ),
            "-fps_mode",
            "passthrough",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-threads:v",
            "1",
            "-x264-params",
            (
                "keyint=24:min-keyint=24:scenecut=0:colorprim=bt709:"
                "transfer=bt709:colormatrix=bt709:fullrange=off"
            ),
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
            "-movflags",
            "+faststart",
            "-n",
            str(output_path),
        ]
    )
    validate_media_facts(probe_media_facts(output_path))


def encode_preview(
    composite_paths: Sequence[Path],
    output_path: Path,
    *,
    source_audio: SourceAudioProvenance | None = None,
    expected_source_file_sha256: str | None = None,
) -> None:
    if len(composite_paths) != CANONICAL_CONTRACT.frame_count:
        raise FfmpegPipelineError("preview requires exactly 121 composite frames")
    expected_names = tuple(
        f"composite_{index:06d}.png"
        for index in range(CANONICAL_CONTRACT.frame_count)
    )
    if tuple(path.name for path in composite_paths) != expected_names:
        raise FfmpegPipelineError("composite sequence order or names are noncanonical")
    directories = {path.resolve().parent for path in composite_paths}
    if len(directories) != 1:
        raise FfmpegPipelineError("composite sequence must share one artifact directory")
    for index, path in enumerate(composite_paths):
        rgb = load_rgb_png(path)
        if rgb.shape != (
            CANONICAL_CONTRACT.height,
            CANONICAL_CONTRACT.width,
            3,
        ):
            raise FfmpegPipelineError(
                f"composite frame {index} geometry is noncanonical"
            )
    if output_path.exists():
        raise FileExistsError(f"artifact already exists: {output_path}")
    if output_path.suffix.lower() != ".mp4":
        raise FfmpegPipelineError("preview must use an MP4 container")
    normalized_audio_path: Path | None = None
    if source_audio is not None:
        _validate_source_audio_provenance(source_audio)
        if (
            expected_source_file_sha256 is None
            or source_audio.source_file_sha256
            != expected_source_file_sha256
        ):
            raise FfmpegPipelineError(
                "preview source audio belongs to different source media"
            )
        if source_audio.source_audio_present:
            assert source_audio.normalized_audio_path is not None
            normalized_audio_path = Path(source_audio.normalized_audio_path)
    elif expected_source_file_sha256 is not None:
        raise FfmpegPipelineError(
            "preview source hash requires source audio provenance"
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    composite_directory = next(iter(directories))
    ffmpeg = _executable("ffmpeg")
    argv = [
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
        str(composite_directory / "composite_%06d.png"),
    ]
    if normalized_audio_path is not None:
        argv.extend(["-i", str(normalized_audio_path)])
    argv.extend(
        [
            "-map",
            "0:v:0",
            "-frames:v",
            str(CANONICAL_CONTRACT.frame_count),
            "-vf",
            (
                "scale=w=1280:h=720:in_range=pc:out_range=tv:"
                "out_color_matrix=bt709:flags=lanczos+accurate_rnd+"
                "full_chroma_int,format=yuv420p,setsar=1"
            ),
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
            (
                "keyint=48:min-keyint=48:scenecut=0:colorprim=bt709:"
                "transfer=bt709:colormatrix=bt709:fullrange=off"
            ),
            "-video_track_timescale",
            "24000",
            "-tag:v",
            "avc1",
        ]
    )
    if normalized_audio_path is None:
        argv.append("-an")
    else:
        argv.extend(
            [
                "-map",
                "1:a:0",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-ar",
                str(SOURCE_AUDIO_SAMPLE_RATE_HZ),
                "-ac",
                str(SOURCE_AUDIO_CHANNELS),
            ]
        )
    argv.extend(
        [
            "-sn",
            "-dn",
            "-map_metadata",
            "-1",
            "-movflags",
            "+faststart",
            "-n",
            str(output_path),
        ]
    )
    _run(argv)
    validate_media_facts(probe_media_facts(output_path))
    preview_audio = _probe_audio_streams(output_path)
    if normalized_audio_path is None:
        if preview_audio.streams:
            raise FfmpegPipelineError("silent preview unexpectedly contains audio")
    else:
        if len(preview_audio.streams) != 1:
            raise FfmpegPipelineError(
                "source-audio preview must contain exactly one audio stream"
            )
        stream = preview_audio.streams[0]
        if (
            stream.get("codec_name") != "aac"
            or _optional_int(stream.get("sample_rate"), field="sample rate")
            != SOURCE_AUDIO_SAMPLE_RATE_HZ
            or _optional_int(stream.get("channels"), field="channels")
            != SOURCE_AUDIO_CHANNELS
        ):
            raise FfmpegPipelineError(
                "preview audio is not canonical source-derived AAC"
            )
