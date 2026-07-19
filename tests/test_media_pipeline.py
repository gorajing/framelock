from __future__ import annotations

import json
from fractions import Fraction
from pathlib import Path
import shutil
import subprocess

import numpy as np
from PIL import Image
import pytest

from framelock_media.contract import ContractViolation, validate_media_facts
from framelock_media.ffmpeg_pipeline import (
    MaskTransportViolation,
    FfmpegPipelineError,
    decode_comparable_rgb24_frames_with_provenance,
    decode_mask_transport,
    decode_rgb24_frames,
    decode_rgb24_frames_with_provenance,
    encode_mask_transport,
    materialize_static_mask_sequence,
    probe_media_facts,
    validate_mask_transport_round_trip,
)
from framelock_media.fixtures import create_framelock_hero_fixture
from framelock_media.masks import (
    load_core_mask,
    load_edit_mask,
    validate_ltx_edit_mask_round_trip,
)
from framelock_media.offline_proof import run_synthetic_canonical_proof
from framelock_media.artifacts import load_rgb_png
from framelock_media.verify import verify_persisted_sequence


CANONICAL_WIDTH = 1280
CANONICAL_HEIGHT = 720
CANONICAL_FRAME_COUNT = 121
CANONICAL_FRAME_RATE = Fraction(24, 1)


def _run_ffmpeg(*arguments: str) -> None:
    executable = shutil.which("ffmpeg")
    assert executable is not None, "FrameLock's media tests require FFmpeg"
    subprocess.run(
        [executable, "-hide_banner", "-loglevel", "error", *arguments],
        check=True,
        capture_output=True,
        text=True,
    )


def _ffprobe(path: Path, *, frames: bool = False) -> dict[str, object]:
    executable = shutil.which("ffprobe")
    assert executable is not None, "FrameLock's media tests require ffprobe"
    command = [
        executable,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_streams",
        "-show_format",
    ]
    if frames:
        command.extend(
            [
                "-show_frames",
                "-show_entries",
                (
                    "frame=best_effort_timestamp_time:"
                    "stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,"
                    "time_base,pix_fmt,color_range:"
                    "format=format_name,duration,size"
                ),
            ]
        )
    command.extend(["-of", "json", str(path)])
    completed = subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def _audio_streams(path: Path) -> list[dict[str, object]]:
    executable = shutil.which("ffprobe")
    assert executable is not None, "FrameLock's media tests require ffprobe"
    completed = subprocess.run(
        [
            executable,
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_streams",
            "-of",
            "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    streams = json.loads(completed.stdout)["streams"]
    assert isinstance(streams, list)
    return streams


def _frame_timestamps(probe: dict[str, object]) -> tuple[float, ...]:
    raw_frames = probe["frames"]
    assert isinstance(raw_frames, list)
    return tuple(float(frame["best_effort_timestamp_time"]) for frame in raw_frames)


def _read_l_png(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        assert image.mode == "L"
        assert image.size == (CANONICAL_WIDTH, CANONICAL_HEIGHT)
        return np.asarray(image, dtype=np.uint8).copy()


@pytest.fixture(scope="session")
def canonical_source_mp4(tmp_path_factory: pytest.TempPathFactory) -> Path:
    directory = tmp_path_factory.mktemp("canonical-source")
    output_path = directory / "synthetic-source.mp4"
    _run_ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1280x720:rate=24",
        "-frames:v",
        str(CANONICAL_FRAME_COUNT),
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-video_track_timescale",
        "24000",
        "-movflags",
        "+faststart",
        str(output_path),
    )
    return output_path


@pytest.fixture(scope="session")
def static_edit_mask(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, np.ndarray]:
    directory = tmp_path_factory.mktemp("static-edit-mask")
    path = directory / "static-ltx-edit-mask.png"
    protected_core = np.zeros(
        (CANONICAL_HEIGHT, CANONICAL_WIDTH), dtype=np.bool_
    )
    protected_core[180:540, 448:832] = True
    edit_mask = np.where(protected_core, 0, 255).astype(np.uint8)
    Image.fromarray(edit_mask).save(path, format="PNG")
    return path, protected_core


@pytest.fixture(scope="session")
def authoritative_mask_sequence(
    tmp_path_factory: pytest.TempPathFactory,
    static_edit_mask: tuple[Path, np.ndarray],
) -> tuple[Path, ...]:
    static_path, _ = static_edit_mask
    output_directory = tmp_path_factory.mktemp("authoritative-mask-sequence")
    return materialize_static_mask_sequence(static_path, output_directory)


@pytest.fixture(scope="session")
def decoded_mask_transport(
    tmp_path_factory: pytest.TempPathFactory,
    authoritative_mask_sequence: tuple[Path, ...],
) -> tuple[Path, tuple[Path, ...]]:
    directory = tmp_path_factory.mktemp("mask-transport")
    video_path = directory / "ltx-edit-mask.mp4"
    encode_mask_transport(authoritative_mask_sequence, video_path)
    decoded = decode_mask_transport(video_path, directory / "decoded")
    return video_path, decoded


def test_actual_synthetic_mp4_passes_ffprobe_and_decoded_pts_contract(
    canonical_source_mp4: Path,
) -> None:
    facts = probe_media_facts(canonical_source_mp4)
    result = validate_media_facts(facts)

    assert facts.container == "mp4"
    assert (facts.width, facts.height) == (CANONICAL_WIDTH, CANONICAL_HEIGHT)
    assert facts.frame_count == CANONICAL_FRAME_COUNT
    assert facts.frame_rate == CANONICAL_FRAME_RATE
    assert result.max_pts_residual_seconds <= 0.000_001

    # This direct probe is deliberately independent from FrameLock's parser.
    probe = _ffprobe(canonical_source_mp4, frames=True)
    streams = probe["streams"]
    assert isinstance(streams, list) and len(streams) == 1
    stream = streams[0]
    assert stream["width"] == CANONICAL_WIDTH
    assert stream["height"] == CANONICAL_HEIGHT
    assert stream["r_frame_rate"] == "24/1"
    assert stream["avg_frame_rate"] == "24/1"
    assert int(stream["nb_frames"]) == CANONICAL_FRAME_COUNT

    timestamps = _frame_timestamps(probe)
    assert len(timestamps) == CANONICAL_FRAME_COUNT
    assert all(current > previous for previous, current in zip(timestamps, timestamps[1:]))
    residuals = [
        abs((timestamp - timestamps[0]) - index / 24)
        for index, timestamp in enumerate(timestamps)
    ]
    assert max(residuals) <= 0.000_001


def test_video_contract_uses_video_duration_when_source_audio_is_longer(
    canonical_source_mp4: Path,
    tmp_path: Path,
) -> None:
    source_with_long_audio = tmp_path / "source-with-long-audio.mp4"
    _run_ffmpeg(
        "-i",
        str(canonical_source_mp4),
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=700:sample_rate=44100:duration=6.2",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-map_metadata",
        "-1",
        str(source_with_long_audio),
    )

    facts = probe_media_facts(source_with_long_audio)

    assert facts.declared_duration_seconds == pytest.approx(121 / 24, abs=1e-6)
    validate_media_facts(facts)


def test_decode_creates_zero_indexed_authoritative_rgb24_png_sequence(
    canonical_source_mp4: Path, tmp_path: Path
) -> None:
    decoded = decode_rgb24_frames_with_provenance(
        canonical_source_mp4, tmp_path / "frames"
    )
    frame_paths = decoded.paths

    assert len(frame_paths) == CANONICAL_FRAME_COUNT
    assert frame_paths[0].name == "frame_000000.png"
    assert frame_paths[-1].name == "frame_000120.png"

    samples: list[np.ndarray] = []
    for index in (0, 60, 120):
        with Image.open(frame_paths[index]) as image:
            assert image.mode == "RGB"
            assert image.size == (CANONICAL_WIDTH, CANONICAL_HEIGHT)
            sample = np.asarray(image, dtype=np.uint8).copy()
            assert sample.shape == (CANONICAL_HEIGHT, CANONICAL_WIDTH, 3)
            samples.append(sample)
    assert not np.array_equal(samples[0], samples[1])
    assert not np.array_equal(samples[1], samples[2])
    assert len(decoded.provenance.source_file_sha256) == 64
    assert decoded.provenance.ffmpeg_version.startswith("ffmpeg version 8.1")
    assert decoded.provenance.ffprobe_version.startswith("ffprobe version 8.1")
    assert len(decoded.provenance.probe_json_sha256) == 64
    assert len(decoded.provenance.presentation_timestamps_sha256) == 64
    assert decoded.provenance.frame_rate_numerator == 24
    assert decoded.provenance.frame_rate_denominator == 1
    assert decoded.provenance.decoded_frame_count == CANONICAL_FRAME_COUNT
    assert decoded.provenance.max_pts_residual_microseconds <= 1
    assert "-noautorotate" in decoded.provenance.decode_argv
    assert "passthrough" in decoded.provenance.decode_argv
    assert decoded.provenance.canonical_color_conversion == (
        "BT.709 limited-range YUV to full-range RGB24"
    )
    assert decoded.provenance.color_conversion_basis == (
        "explicit_bt709_limited_fallback"
    )
    assert decoded.provenance.color_conversion_assumption == (
        "Source color metadata was absent or incomplete; FrameLock explicitly "
        "assumed BT.709 matrix and limited-range YUV for canonical decoding."
    )


def test_comparable_generator_decoder_scales_16_by_9_without_frame_resampling(
    tmp_path: Path,
) -> None:
    generated = tmp_path / "generated-640x360.mp4"
    _run_ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "color=c=0x12607a:size=640x360:rate=24",
        "-frames:v",
        str(CANONICAL_FRAME_COUNT),
        "-vf",
        "setsar=1",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-video_track_timescale",
        "24000",
        str(generated),
    )

    decoded = decode_comparable_rgb24_frames_with_provenance(
        generated, tmp_path / "generated-frames"
    )

    assert len(decoded.paths) == CANONICAL_FRAME_COUNT
    assert decoded.provenance.width == CANONICAL_WIDTH
    assert decoded.provenance.height == CANONICAL_HEIGHT
    assert decoded.provenance.source_file_sha256
    assert "1280" in " ".join(decoded.provenance.decode_argv)
    with Image.open(decoded.paths[60]) as image:
        assert image.size == (CANONICAL_WIDTH, CANONICAL_HEIGHT)


def test_missing_color_metadata_is_recorded_as_fallback_not_declared_metadata(
    tmp_path: Path,
) -> None:
    generated = tmp_path / "unlabeled-color.mp4"
    _run_ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "color=c=0x12607a:size=1280x720:rate=24",
        "-frames:v",
        str(CANONICAL_FRAME_COUNT),
        "-vf",
        "setsar=1",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-video_track_timescale",
        "24000",
        str(generated),
    )

    decoded = decode_comparable_rgb24_frames_with_provenance(
        generated, tmp_path / "decoded-unlabeled-color"
    )

    assert decoded.provenance.source_color_range is None
    assert decoded.provenance.source_color_space is None
    assert decoded.provenance.color_conversion_basis == (
        "explicit_bt709_limited_fallback"
    )
    assert decoded.provenance.color_conversion_assumption is not None


def test_generator_decoder_rejects_non_16_by_9_geometry_before_writing(
    tmp_path: Path,
) -> None:
    generated = tmp_path / "generated-5x3.mp4"
    _run_ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "color=c=black:size=1280x768:rate=24",
        "-frames:v",
        str(CANONICAL_FRAME_COUNT),
        "-vf",
        "setsar=1",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-video_track_timescale",
        "24000",
        str(generated),
    )

    with pytest.raises(FfmpegPipelineError, match="display_aspect_ratio"):
        decode_comparable_rgb24_frames_with_provenance(
            generated, tmp_path / "should-not-exist"
        )
    assert not (tmp_path / "should-not-exist").exists()


def test_static_mask_materializes_exact_authoritative_png_sequence(
    authoritative_mask_sequence: tuple[Path, ...],
    static_edit_mask: tuple[Path, np.ndarray],
) -> None:
    static_path, protected_core = static_edit_mask
    expected = _read_l_png(static_path)

    assert len(authoritative_mask_sequence) == CANONICAL_FRAME_COUNT
    assert authoritative_mask_sequence[0].name == "mask_000000.png"
    assert authoritative_mask_sequence[-1].name == "mask_000120.png"
    assert set(np.unique(expected).tolist()) == {0, 255}

    for index in (0, 60, 120):
        decoded = _read_l_png(authoritative_mask_sequence[index])
        np.testing.assert_array_equal(decoded, expected)
        validate_ltx_edit_mask_round_trip(decoded, protected_core)


def test_lossless_mask_transport_round_trip_preserves_domain_and_ltx_polarity(
    authoritative_mask_sequence: tuple[Path, ...],
    decoded_mask_transport: tuple[Path, tuple[Path, ...]],
    static_edit_mask: tuple[Path, np.ndarray],
) -> None:
    video_path, decoded_paths = decoded_mask_transport
    _, protected_core = static_edit_mask

    validate_mask_transport_round_trip(authoritative_mask_sequence, decoded_paths)
    assert len(decoded_paths) == CANONICAL_FRAME_COUNT

    facts = probe_media_facts(video_path)
    assert facts.frame_count == CANONICAL_FRAME_COUNT
    assert facts.frame_rate == CANONICAL_FRAME_RATE
    assert facts.presentation_timestamps[0] == pytest.approx(0.0, abs=0.000_001)

    for index in (0, 60, 120):
        decoded = load_edit_mask(decoded_paths[index])
        assert set(np.unique(decoded).tolist()) == {0, 255}
        validate_ltx_edit_mask_round_trip(decoded, protected_core)


def test_mask_transport_validator_rejects_one_nonbinary_decoded_sample(
    authoritative_mask_sequence: tuple[Path, ...],
    decoded_mask_transport: tuple[Path, tuple[Path, ...]],
    tmp_path: Path,
) -> None:
    _, decoded_paths = decoded_mask_transport
    corrupted_path = tmp_path / "corrupted-mask.png"
    corrupted = _read_l_png(decoded_paths[60])
    corrupted[0, 0] = 254
    Image.fromarray(corrupted).save(corrupted_path, format="PNG")
    corrupted_paths = list(decoded_paths)
    corrupted_paths[60] = corrupted_path

    with pytest.raises(MaskTransportViolation, match=r"\{0,255\}"):
        validate_mask_transport_round_trip(
            authoritative_mask_sequence, tuple(corrupted_paths)
        )


def test_actual_mp4_with_one_1_001_ms_pts_drift_is_rejected(
    tmp_path: Path,
) -> None:
    drifted_path = tmp_path / "one-frame-pts-drift.mp4"
    # A 1 MHz track time base represents 1.001 ms exactly without relying on
    # floating-point metadata. Only frame 60 moves; ordering remains monotonic.
    _run_ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1280x720:rate=24",
        "-frames:v",
        str(CANONICAL_FRAME_COUNT),
        "-vf",
        "settb=1/1000000,setpts=N*1000000/24+if(eq(N\\,60)\\,1001\\,0)",
        "-fps_mode",
        "passthrough",
        "-enc_time_base",
        "1/1000000",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "28",
        "-pix_fmt",
        "yuv420p",
        "-video_track_timescale",
        "1000000",
        str(drifted_path),
    )

    probe = _ffprobe(drifted_path, frames=True)
    timestamps = _frame_timestamps(probe)
    observed_residual = abs((timestamps[60] - timestamps[0]) - 60 / 24)
    assert observed_residual == pytest.approx(0.001_001, abs=0.000_001)
    assert all(current > previous for previous, current in zip(timestamps, timestamps[1:]))

    facts = probe_media_facts(drifted_path)
    with pytest.raises(ContractViolation, match="residual"):
        validate_media_facts(facts)


def test_full_canonical_offline_proof_passes_then_detects_core_corruption(
    canonical_source_mp4: Path,
    static_edit_mask: tuple[Path, np.ndarray],
    tmp_path: Path,
) -> None:
    edit_mask_path, _ = static_edit_mask
    foreground_path = tmp_path / "foreground.png"
    foreground = np.uint8(255) - _read_l_png(edit_mask_path)
    Image.fromarray(foreground, mode="L").save(foreground_path, format="PNG")

    result = run_synthetic_canonical_proof(
        canonical_source_mp4,
        foreground_path,
        tmp_path / "offline-proof",
    )

    assert result.audit.passed is True
    assert result.audit.canonical_contract_passed is True
    assert result.audit.core_passed is True
    assert result.audit.artifact_integrity_passed is True
    assert result.audit.frames_audited == CANONICAL_FRAME_COUNT
    assert result.audit.frames_with_nonempty_core == CANONICAL_FRAME_COUNT
    assert result.audit.total_changed_core_pixels == 0
    assert result.audit.total_changed_core_channel_samples == 0
    assert result.audit.worst_maximum_absolute_channel_delta == 0
    assert result.audit.core_hash_match_count == CANONICAL_FRAME_COUNT
    assert len(result.source_paths) == CANONICAL_FRAME_COUNT
    assert len(result.core_mask_paths) == CANONICAL_FRAME_COUNT
    assert len(result.edit_mask_paths) == CANONICAL_FRAME_COUNT
    assert len(result.generated_paths) == CANONICAL_FRAME_COUNT
    assert len(result.composite_paths) == CANONICAL_FRAME_COUNT
    assert result.mask_transport_path.is_file()
    assert result.preview_path.is_file()
    assert result.source_audio.source_audio_present is False
    assert result.source_audio_manifest_path.is_file()
    assert result.normalized_source_audio_path is None
    assert _audio_streams(result.preview_path) == []
    assert result.preview_label == "Preview derived from verified canonical frames"
    assert result.proof_manifest_path.is_file()
    assert result.audit_path.is_file()
    assert result.manifest.media_provenance is not None
    assert result.manifest.media_provenance.decoded_frame_count == 121
    assert result.manifest.media_provenance.frame_rate_numerator == 24
    assert result.manifest.media_provenance.frame_rate_denominator == 1

    audit_payload = json.loads(result.audit_path.read_text(encoding="utf-8"))
    assert audit_payload["claim"] == (
        "Protected core verified — canonical pre-encode frame sequence."
    )
    assert audit_payload["manifest"]["digest_sha256"] == (
        result.manifest.digest_sha256
    )
    assert audit_payload["audit"]["manifest_digest_sha256"] == (
        result.manifest.digest_sha256
    )
    assert audit_payload["manifest"]["media_provenance"][
        "ffmpeg_version"
    ].startswith("ffmpeg version 8.1")

    for index in (0, 60, 120):
        source = load_rgb_png(result.source_paths[index])
        generated = load_rgb_png(result.generated_paths[index])
        core = load_core_mask(result.core_mask_paths[index])
        assert np.any(source[core] != generated[core])

    corrupted = load_rgb_png(result.composite_paths[60])
    core = load_core_mask(result.core_mask_paths[60])
    y, x = np.argwhere(core)[0]
    corrupted[y, x, 1] ^= np.uint8(1)
    Image.fromarray(corrupted, mode="RGB").save(
        result.composite_paths[60], format="PNG"
    )

    rejected = verify_persisted_sequence(
        result.manifest,
        source_paths=result.source_paths,
        core_mask_paths=result.core_mask_paths,
        composite_paths=result.composite_paths,
    )

    assert rejected.passed is False
    assert rejected.canonical_contract_passed is True
    assert rejected.core_passed is False
    assert rejected.artifact_integrity_passed is False
    assert rejected.total_changed_core_pixels == 1
    assert rejected.total_changed_core_channel_samples == 1
    assert rejected.worst_maximum_absolute_channel_delta == 1


def test_reproducible_framelock_hero_fixture_is_canonical_and_diagnostic(
    tmp_path: Path,
) -> None:
    fixture = create_framelock_hero_fixture(tmp_path / "hero-fixture")
    facts = probe_media_facts(fixture.source_mp4)
    validate_media_facts(facts)

    assert fixture.source_mp4.is_file()
    assert fixture.foreground_mask.is_file()
    assert fixture.ownership_label == "FrameLock-owned synthetic fixture"
    foreground = _read_l_png(fixture.foreground_mask) == np.uint8(255)
    assert np.any(foreground)
    assert np.any(~foreground)

    decoded_paths = decode_rgb24_frames(
        fixture.source_mp4, tmp_path / "hero-decoded"
    )
    first = load_rgb_png(decoded_paths[0])
    middle = load_rgb_png(decoded_paths[60])
    final = load_rgb_png(decoded_paths[120])

    # The package is bright and stationary; the animated studio exterior moves.
    assert float(np.mean(first[foreground])) > float(np.mean(first[~foreground]))
    assert np.any(first[~foreground] != middle[~foreground])
    assert np.any(middle[~foreground] != final[~foreground])
