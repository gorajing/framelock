from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import wave

import numpy as np
from PIL import Image
import pytest

from framelock_media.artifacts import sha256_file
from framelock_media.ffmpeg_pipeline import (
    FfmpegPipelineError,
    encode_preview,
    load_source_audio_manifest,
    prepare_source_audio,
)


TARGET_SAMPLE_COUNT = 242_000


def _run_ffmpeg(*arguments: str) -> None:
    executable = shutil.which("ffmpeg")
    assert executable is not None
    subprocess.run(
        [executable, "-hide_banner", "-loglevel", "error", *arguments],
        check=True,
        capture_output=True,
        text=True,
    )


def _audio_streams(path: Path) -> list[dict[str, object]]:
    executable = shutil.which("ffprobe")
    assert executable is not None
    completed = subprocess.run(
        [
            executable,
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_streams",
            "-show_entries",
            "stream=index,codec_name,sample_fmt,sample_rate,channels,"
            "channel_layout,time_base,duration_ts",
            "-of",
            "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(completed.stdout)
    streams = payload["streams"]
    assert isinstance(streams, list)
    return streams


def _audio_only_mp4(
    path: Path,
    *,
    duration_seconds: float,
    frequencies: tuple[int, ...] = (700,),
) -> None:
    arguments: list[str] = []
    for frequency in frequencies:
        arguments.extend(
            [
                "-f",
                "lavfi",
                "-i",
                (
                    f"sine=frequency={frequency}:sample_rate=44100:"
                    f"duration={duration_seconds}"
                ),
            ]
        )
    for index in range(len(frequencies)):
        arguments.extend(["-map", f"{index}:a:0"])
    arguments.extend(
        [
            "-vn",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            "-map_metadata",
            "-1",
            str(path),
        ]
    )
    _run_ffmpeg(*arguments)


def _silent_mp4(path: Path) -> None:
    _run_ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "color=c=black:size=16x16:rate=1",
        "-frames:v",
        "1",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        str(path),
    )


def _composite_frames(directory: Path) -> tuple[Path, ...]:
    directory.mkdir()
    frame = np.zeros((720, 1280, 3), dtype=np.uint8)
    paths: list[Path] = []
    for index in range(121):
        path = directory / f"composite_{index:06d}.png"
        Image.fromarray(frame, mode="RGB").save(path, format="PNG")
        paths.append(path)
    return tuple(paths)


def _dominant_preview_frequency(path: Path) -> float:
    executable = shutil.which("ffmpeg")
    assert executable is not None
    completed = subprocess.run(
        [
            executable,
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            "48000",
            "-f",
            "f32le",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    )
    samples = np.frombuffer(completed.stdout, dtype=np.float32)
    analysis = samples[4_800:38_400] * np.hanning(33_600)
    magnitudes = np.abs(np.fft.rfft(analysis))
    frequencies = np.fft.rfftfreq(len(analysis), 1 / 48_000)
    return float(frequencies[int(np.argmax(magnitudes))])


def test_absent_source_audio_is_recorded_and_preserves_silent_preview_bytes(
    tmp_path: Path,
) -> None:
    source = tmp_path / "silent-source.mp4"
    _silent_mp4(source)
    normalized = tmp_path / "source_audio.wav"
    manifest = tmp_path / "source_audio.json"

    evidence = prepare_source_audio(source, normalized, manifest)

    assert evidence.source_audio_present is False
    assert evidence.source_audio_stream_count == 0
    assert evidence.normalized_audio_path is None
    assert evidence.normalized_audio_file_sha256 is None
    assert evidence.normalization_operation == "absent_source_no_track"
    assert evidence.claim_scope == "outside_pixel_verification_claim"
    assert manifest.is_file()
    assert not normalized.exists()
    assert load_source_audio_manifest(manifest) == evidence

    composites = _composite_frames(tmp_path / "composites")
    legacy_preview = tmp_path / "legacy-preview.mp4"
    policy_preview = tmp_path / "policy-preview.mp4"
    encode_preview(composites, legacy_preview)
    encode_preview(
        composites,
        policy_preview,
        source_audio=evidence,
        expected_source_file_sha256=sha256_file(source),
    )

    assert _audio_streams(legacy_preview) == []
    assert _audio_streams(policy_preview) == []
    assert sha256_file(policy_preview) == sha256_file(legacy_preview)


@pytest.mark.parametrize("duration_seconds", (0.2, 6.2))
def test_source_audio_is_padded_or_trimmed_to_exact_working_pcm(
    tmp_path: Path,
    duration_seconds: float,
) -> None:
    source = tmp_path / f"source-{duration_seconds}.mp4"
    _audio_only_mp4(source, duration_seconds=duration_seconds)
    normalized = tmp_path / "source_audio.wav"
    manifest = tmp_path / "source_audio.json"

    evidence = prepare_source_audio(source, normalized, manifest)

    assert evidence.source_audio_present is True
    assert evidence.source_audio_stream_count == 1
    assert evidence.source_sample_rate_hz == 44_100
    assert evidence.source_channels == 1
    assert evidence.normalized_sample_rate_hz == 48_000
    assert evidence.normalized_channels == 2
    assert evidence.normalized_sample_format == "s16"
    assert evidence.normalized_sample_count == TARGET_SAMPLE_COUNT
    assert evidence.normalization_operation == (
        "resample_stereo_then_pad_and_trim_to_242000_samples"
    )
    assert evidence.normalized_audio_file_sha256 == sha256_file(normalized)
    with wave.open(str(normalized), "rb") as audio:
        assert audio.getframerate() == 48_000
        assert audio.getnchannels() == 2
        assert audio.getsampwidth() == 2
        assert audio.getnframes() == TARGET_SAMPLE_COUNT
    assert load_source_audio_manifest(manifest) == evidence


def test_preview_uses_bound_first_source_audio_and_rejects_other_source(
    tmp_path: Path,
) -> None:
    source = tmp_path / "two-source-audio-streams.mp4"
    _audio_only_mp4(
        source,
        duration_seconds=1.0,
        frequencies=(700, 1_400),
    )
    evidence = prepare_source_audio(
        source,
        tmp_path / "source_audio.wav",
        tmp_path / "source_audio.json",
    )
    composites = _composite_frames(tmp_path / "composites")
    preview = tmp_path / "preview.mp4"

    assert evidence.source_audio_stream_count == 2
    assert evidence.selected_source_audio_stream_index == 0
    encode_preview(
        composites,
        preview,
        source_audio=evidence,
        expected_source_file_sha256=sha256_file(source),
    )

    streams = _audio_streams(preview)
    assert len(streams) == 1
    assert streams[0]["codec_name"] == "aac"
    assert streams[0]["sample_rate"] == "48000"
    assert streams[0]["channels"] == 2
    assert streams[0]["time_base"] == "1/48000"
    assert abs(int(streams[0]["duration_ts"]) - TARGET_SAMPLE_COUNT) < 1_024
    assert _dominant_preview_frequency(preview) == pytest.approx(700, abs=3)

    rejected = tmp_path / "rejected-other-source.mp4"
    with pytest.raises(FfmpegPipelineError, match="different source media"):
        encode_preview(
            composites,
            rejected,
            source_audio=evidence,
            expected_source_file_sha256="00" * 32,
        )
    assert not rejected.exists()


def test_tampered_working_pcm_is_rejected_by_immutable_audio_manifest(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.mp4"
    _audio_only_mp4(source, duration_seconds=1.0)
    normalized = tmp_path / "source_audio.wav"
    manifest = tmp_path / "source_audio.json"
    prepare_source_audio(source, normalized, manifest)
    normalized.write_bytes(normalized.read_bytes() + b"tampered")

    with pytest.raises(FfmpegPipelineError, match="audio hash"):
        load_source_audio_manifest(manifest)
