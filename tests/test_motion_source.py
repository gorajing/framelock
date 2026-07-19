from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import subprocess

import numpy as np
from PIL import Image
import pytest

from framelock_media.artifacts import ArtifactExistsError
from framelock_media.contract import CANONICAL_CONTRACT
from framelock_media.motion_source import (
    MotionSourceConstructionError,
    SCALE_CENTER_CROP_MODE,
    construct_motion_source,
    load_motion_source_construction,
)


RAW_WIDTH = 1284
RAW_HEIGHT = 716
RAW_FRAME_COUNT = 145
BARCODE_X = 386
BARCODE_Y = 100
BARCODE_BLOCK_SIZE = 64
BARCODE_BITS = 8


def _ffmpeg(*arguments: str) -> subprocess.CompletedProcess[bytes]:
    executable = shutil.which("ffmpeg")
    assert executable is not None, "motion-source tests require FFmpeg"
    return subprocess.run(
        [executable, "-hide_banner", "-loglevel", "error", *arguments],
        check=True,
        capture_output=True,
    )


def _ffprobe_stream_types(path: Path) -> tuple[str, ...]:
    executable = shutil.which("ffprobe")
    assert executable is not None, "motion-source tests require ffprobe"
    completed = subprocess.run(
        [
            executable,
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(completed.stdout)
    return tuple(stream["codec_type"] for stream in payload["streams"])


def _barcode_indices(path: Path, *, expected_frames: int) -> tuple[int, ...]:
    completed = _ffmpeg(
        "-i",
        str(path),
        "-map",
        "0:v:0",
        "-vf",
        (
            f"crop={BARCODE_BLOCK_SIZE * BARCODE_BITS}:"
            f"{BARCODE_BLOCK_SIZE}:{BARCODE_X}:{BARCODE_Y},"
            f"scale={BARCODE_BITS}:1:flags=area,format=gray"
        ),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-",
    )
    samples = np.frombuffer(completed.stdout, dtype=np.uint8)
    assert samples.size == expected_frames * BARCODE_BITS
    bars = samples.reshape(expected_frames, BARCODE_BITS)
    return tuple(
        sum((int(value) > 128) << bit for bit, value in enumerate(row))
        for row in bars
    )


def _average_rgb(path: Path, *, crop: str) -> tuple[int, int, int]:
    completed = _ffmpeg(
        "-i",
        str(path),
        "-map",
        "0:v:0",
        "-vf",
        f"select=eq(n\\,0),crop={crop},scale=1:1:flags=area,format=rgb24",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
    )
    assert len(completed.stdout) == 3
    return tuple(completed.stdout)  # type: ignore[return-value]


def _first_rgb_frame(path: Path) -> np.ndarray:
    completed = _ffmpeg(
        "-i",
        str(path),
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
    )
    expected_size = CANONICAL_CONTRACT.width * CANONICAL_CONTRACT.height * 3
    assert len(completed.stdout) == expected_size
    return np.frombuffer(completed.stdout, dtype=np.uint8).reshape(
        CANONICAL_CONTRACT.height,
        CANONICAL_CONTRACT.width,
        3,
    )


@pytest.fixture(scope="session")
def raw_motion_mp4(tmp_path_factory: pytest.TempPathFactory) -> Path:
    directory = tmp_path_factory.mktemp("raw-motion-source")
    frames = directory / "frames"
    frames.mkdir()
    for index in range(RAW_FRAME_COUNT):
        rgb = np.full((RAW_HEIGHT, RAW_WIDTH, 3), 96, dtype=np.uint8)
        for bit in range(BARCODE_BITS):
            value = 224 if index & (1 << bit) else 24
            start = BARCODE_X + bit * BARCODE_BLOCK_SIZE
            rgb[
                BARCODE_Y : BARCODE_Y + BARCODE_BLOCK_SIZE,
                start : start + BARCODE_BLOCK_SIZE,
            ] = value
        # Distinct one-pixel edge sentinels make the two-pixel center crop
        # independently observable without changing the interior barcode.
        rgb[:, 0] = (255, 0, 0)
        rgb[:, 1] = (0, 255, 0)
        rgb[:, -2] = (0, 0, 255)
        rgb[:, -1] = (255, 255, 0)
        Image.fromarray(rgb, mode="RGB").save(
            frames / f"frame_{index:06d}.png",
            format="PNG",
            compress_level=1,
        )

    output = directory / "raw-motion.mp4"
    _ffmpeg(
        "-framerate",
        "24",
        "-start_number",
        "0",
        "-i",
        str(frames / "frame_%06d.png"),
        "-frames:v",
        str(RAW_FRAME_COUNT),
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "1",
        "-bf",
        "0",
        "-pix_fmt",
        "yuv420p",
        "-video_track_timescale",
        "24000",
        str(output),
    )
    return output


@pytest.fixture(scope="session")
def continuous_gradient_motion_mp4(
    tmp_path_factory: pytest.TempPathFactory,
) -> Path:
    directory = tmp_path_factory.mktemp("gradient-motion-source")
    x = np.linspace(0, 24, RAW_WIDTH, dtype=np.float64)[None, :]
    y = np.linspace(28, 204, RAW_HEIGHT, dtype=np.float64)[:, None]
    red = np.clip(y + x, 0, 255)
    green = np.clip(y + x / 2 + 8, 0, 255)
    blue = np.clip(y + 16 - x / 3, 0, 255)
    rgb = np.stack((red, green, blue), axis=2).round().astype(np.uint8)
    source_png = directory / "continuous-gradient.png"
    Image.fromarray(rgb, mode="RGB").save(
        source_png,
        format="PNG",
        compress_level=1,
    )
    output = directory / "continuous-gradient.mp4"
    _ffmpeg(
        "-loop",
        "1",
        "-framerate",
        "24",
        "-i",
        str(source_png),
        "-frames:v",
        str(RAW_FRAME_COUNT),
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "1",
        "-bf",
        "0",
        "-pix_fmt",
        "yuv420p",
        "-video_track_timescale",
        "24000",
        str(output),
    )
    return output


def test_constructs_exact_ordered_canonical_source_and_reopens_fail_closed(
    raw_motion_mp4: Path,
    tmp_path: Path,
) -> None:
    result = construct_motion_source(
        raw_motion_mp4,
        tmp_path / "construction",
        pad_gray=133,
    )

    assert result.output_path.name == "source-canonical.mp4"
    assert result.manifest_path.name == "source-construction.json"
    assert result.facts.width == CANONICAL_CONTRACT.width
    assert result.facts.height == CANONICAL_CONTRACT.height
    assert result.facts.frame_count == CANONICAL_CONTRACT.frame_count
    assert result.facts.frame_rate == CANONICAL_CONTRACT.frame_rate
    assert _ffprobe_stream_types(result.output_path) == ("video",)

    # The robust 8-bit visual barcode proves decoded output frame i is raw
    # decoded frame i for the entire authoritative 0..120 selection. A drop,
    # duplicate, interpolation or reorder changes this exact tuple.
    assert _barcode_indices(
        raw_motion_mp4,
        expected_frames=RAW_FRAME_COUNT,
    )[: CANONICAL_CONTRACT.frame_count] == tuple(
        range(CANONICAL_CONTRACT.frame_count)
    )
    assert _barcode_indices(
        result.output_path,
        expected_frames=CANONICAL_CONTRACT.frame_count,
    ) == tuple(range(CANONICAL_CONTRACT.frame_count))

    # The two inserted rows are the recorded solid RGB gray, allowing small
    # codec/color-rounding tolerance while rejecting an unrecorded pad color.
    for value in _average_rgb(result.output_path, crop="1280:2:0:0"):
        assert abs(value - 133) <= 4
    for value in _average_rgb(result.output_path, crop="1280:2:0:718"):
        assert abs(value - 133) <= 4
    # The raw fixture's first and last two columns are saturated edge
    # sentinels. Seeing only the neutral interior at both output sides proves
    # those exact columns were excluded by the recorded center crop.
    for crop in ("2:716:0:2", "2:716:1278:2"):
        for value in _average_rgb(result.output_path, crop=crop):
            assert abs(value - 96) <= 4

    payload = json.loads(result.manifest_path.read_text(encoding="utf-8"))
    assert payload["construction"]["selection"] == {
        "count": 121,
        "end_frame_inclusive": 120,
        "interpolation": "none",
        "order": "decoded_presentation_order_unchanged",
        "start_frame": 0,
    }
    assert payload["construction"]["geometry"] == {
        "crop": {"height": 716, "width": 1280, "x": 2, "y": 0},
        "pad": {
            "bottom": 2,
            "color_rgb_hex": "#858585",
            "left": 0,
            "right": 0,
            "top": 2,
        },
        "source_sample_aspect_ratio_interpretation": "absent_assumed_1_1",
    }
    assert payload["construction"]["audio"] == "discarded"
    identity = payload["construction"]["decoded_frame_identity"]
    assert identity["algorithm"] == "ffmpeg_framehash_sha256_v2"
    assert identity["exact_match"] is True
    assert identity["expected_framehash_sha256"] == identity[
        "output_framehash_sha256"
    ]
    assert len(identity["ordered_frame_sha256"]) == 121
    assert payload["construction"]["ffmpeg_argv"]
    assert payload["construction"]["ffmpeg_version"].startswith("ffmpeg version")

    reopened = load_motion_source_construction(result.manifest_path)
    assert reopened.output_sha256 == result.output_sha256
    assert reopened.manifest_digest_sha256 == result.manifest_digest_sha256

    original_output = result.output_path.read_bytes()
    result.output_path.write_bytes(original_output + b"tamper")
    with pytest.raises(MotionSourceConstructionError, match="output hash"):
        load_motion_source_construction(result.manifest_path)
    result.output_path.write_bytes(original_output)

    payload["construction"]["geometry"]["pad"]["color_rgb_hex"] = "#848484"
    result.manifest_path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    with pytest.raises(MotionSourceConstructionError, match="manifest digest"):
        load_motion_source_construction(result.manifest_path)

    # Recomputing the manifest digest cannot authorize altered construction
    # semantics: the full argv and exact decoded-frame evidence are checked
    # independently on reopen.
    payload["construction"]["geometry"]["pad"]["color_rgb_hex"] = "#858585"
    payload["construction"]["decoded_frame_identity"][
        "ordered_frame_sha256"
    ][0] = "0" * 64
    unsigned_payload = dict(payload)
    unsigned_payload.pop("digest_sha256")
    payload["digest_sha256"] = hashlib.sha256(
        json.dumps(
            unsigned_payload,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        ).encode("utf-8")
    ).hexdigest()
    result.manifest_path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    with pytest.raises(MotionSourceConstructionError, match="identity evidence"):
        load_motion_source_construction(result.manifest_path)


def test_selectable_start_frame_binds_exact_slice_and_reopens(
    raw_motion_mp4: Path,
    tmp_path: Path,
) -> None:
    result = construct_motion_source(
        raw_motion_mp4,
        tmp_path / "start-frame-one",
        pad_gray=133,
        start_frame=1,
    )

    assert _barcode_indices(
        result.output_path,
        expected_frames=CANONICAL_CONTRACT.frame_count,
    ) == tuple(range(1, 122))

    payload = json.loads(result.manifest_path.read_text(encoding="utf-8"))
    construction = payload["construction"]
    assert construction["selection"] == {
        "count": 121,
        "end_frame_inclusive": 121,
        "interpolation": "none",
        "order": "decoded_presentation_order_unchanged",
        "start_frame": 1,
    }
    assert construction["filtergraph"].startswith(
        "trim=start_frame=1:end_frame=122,"
    )
    assert construction["filtergraph"] in construction["ffmpeg_argv"]
    assert construction["filtergraph"] in construction[
        "decoded_frame_identity"
    ]["expected_transform_argv"]

    reopened = load_motion_source_construction(result.manifest_path)
    assert reopened.output_sha256 == result.output_sha256
    assert reopened.manifest_digest_sha256 == result.manifest_digest_sha256


@pytest.mark.parametrize(
    "start_frame",
    [-1, True, 1.0, "1", RAW_FRAME_COUNT - CANONICAL_CONTRACT.frame_count + 1],
)
def test_start_frame_fails_closed_when_invalid_or_out_of_range(
    raw_motion_mp4: Path,
    tmp_path: Path,
    start_frame: object,
) -> None:
    target = tmp_path / f"bad-start-{start_frame!r}"
    with pytest.raises(MotionSourceConstructionError, match="start frame"):
        construct_motion_source(
            raw_motion_mp4,
            target,
            pad_gray=133,
            start_frame=start_frame,  # type: ignore[arg-type]
        )
    assert not target.exists()


def test_refuses_existing_output_or_nonconforming_raw_without_writing(
    raw_motion_mp4: Path,
    tmp_path: Path,
) -> None:
    existing = tmp_path / "existing"
    existing.mkdir()
    sentinel = existing / "owned.txt"
    sentinel.write_text("preserve", encoding="utf-8")

    with pytest.raises(ArtifactExistsError, match="already exists"):
        construct_motion_source(raw_motion_mp4, existing, pad_gray=133)
    assert sentinel.read_text(encoding="utf-8") == "preserve"
    assert tuple(existing.iterdir()) == (sentinel,)

    invalid = tmp_path / "not-an-mp4.txt"
    invalid.write_text("not video", encoding="utf-8")
    target = tmp_path / "invalid-construction"
    with pytest.raises(MotionSourceConstructionError):
        construct_motion_source(invalid, target, pad_gray=133)
    assert not target.exists()


def test_scale_center_crop_is_seam_free_exact_and_reopens(
    continuous_gradient_motion_mp4: Path,
    tmp_path: Path,
) -> None:
    result = construct_motion_source(
        continuous_gradient_motion_mp4,
        tmp_path / "scale-center-crop",
        geometry_mode=SCALE_CENTER_CROP_MODE,
    )

    assert result.geometry_mode == SCALE_CENTER_CROP_MODE
    assert result.facts.width == 1280
    assert result.facts.height == 720
    assert result.facts.frame_count == 121
    assert _ffprobe_stream_types(result.output_path) == ("video",)

    payload = json.loads(result.manifest_path.read_text(encoding="utf-8"))
    assert payload["schema_version"] == 2
    assert payload["construction"]["geometry"] == {
        "crop": {"height": 720, "width": 1280, "x": 6, "y": 0},
        "mode": "scale_center_crop",
        "scale": {
            "algorithm": "lanczos",
            "eval": "init",
            "expected_height": 720,
            "expected_width": 1292,
            "flags": [
                "lanczos",
                "accurate_rnd",
                "full_chroma_int",
                "bitexact",
            ],
            "input_height": 716,
            "input_width": 1284,
            "lanczos_lobes": 3,
            "width_expression": "-2",
        },
        "source_sample_aspect_ratio_interpretation": "absent_assumed_1_1",
    }
    assert payload["construction"]["filtergraph"] == (
        "trim=start_frame=0:end_frame=121,"
        "scale=w=-2:h=720:flags="
        "lanczos+accurate_rnd+full_chroma_int+bitexact:param0=3:eval=init,"
        "crop=w=1280:h=720:x=6:y=0,setsar=1,setpts=PTS-STARTPTS"
    )
    scaled_only = _ffmpeg(
        "-i",
        str(continuous_gradient_motion_mp4),
        "-vf",
        (
            "scale=w=-2:h=720:flags="
            "lanczos+accurate_rnd+full_chroma_int+bitexact:param0=3:eval=init"
        ),
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "yuv420p",
        "-",
    )
    assert len(scaled_only.stdout) == 1292 * 720 * 3 // 2
    identity = payload["construction"]["decoded_frame_identity"]
    assert identity["exact_match"] is True
    assert len(identity["ordered_frame_sha256"]) == 121
    assert identity["expected_framehash_sha256"] == identity[
        "output_framehash_sha256"
    ]

    frame = _first_rgb_frame(result.output_path).astype(np.int16)
    # The source is a smooth vertical gradient. A two-row solid pad would
    # create a large discontinuity between rows 1 and 2 (and 717 and 718).
    # Scaling the owned pixels through both edges keeps those jumps continuous.
    middle = frame[:, 96:-96]
    top_boundary_jump = np.abs(middle[2] - middle[1]).mean()
    bottom_boundary_jump = np.abs(middle[-2] - middle[-3]).mean()
    assert top_boundary_jump <= 2.0
    assert bottom_boundary_jump <= 2.0
    assert abs(float(middle[0].mean()) - 133.0) >= 40.0
    assert abs(float(middle[-1].mean()) - 133.0) >= 40.0

    reopened = load_motion_source_construction(result.manifest_path)
    assert reopened.geometry_mode == SCALE_CENTER_CROP_MODE
    assert reopened.output_sha256 == result.output_sha256


def test_geometry_modes_reject_inapplicable_or_missing_pad_gray(
    raw_motion_mp4: Path,
    tmp_path: Path,
) -> None:
    with pytest.raises(MotionSourceConstructionError, match="requires pad gray"):
        construct_motion_source(
            raw_motion_mp4,
            tmp_path / "missing-pad",
        )
    with pytest.raises(MotionSourceConstructionError, match="does not accept pad gray"):
        construct_motion_source(
            raw_motion_mp4,
            tmp_path / "scale-with-pad",
            geometry_mode=SCALE_CENTER_CROP_MODE,
            pad_gray=133,
        )


@pytest.mark.parametrize("pad_gray", [-1, 256, True])
def test_pad_gray_must_be_an_explicit_byte(
    raw_motion_mp4: Path,
    tmp_path: Path,
    pad_gray: object,
) -> None:
    target = tmp_path / f"bad-gray-{pad_gray}"
    with pytest.raises(MotionSourceConstructionError, match="pad gray"):
        construct_motion_source(
            raw_motion_mp4,
            target,
            pad_gray=pad_gray,  # type: ignore[arg-type]
        )
    assert not target.exists()
