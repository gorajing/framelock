from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess

import cv2
import numpy as np
import pytest
from PIL import Image

import framelock_media.temporal_matte as temporal_matte
from framelock_media.ffmpeg_pipeline import encode_mask_transport
from framelock_media.temporal_matte import (
    CANONICAL_TEMPORAL_MATTE_CONTRACT,
    EDIT_MASK_POLARITY,
    SOFT_MASK_POLARITY,
    MatteContract,
    MatteInputError,
    MatteIntegrityError,
    MattePlausibilityError,
    _ingest_rgba_png_sequence,
    _ingest_transparent_video,
    _verify_temporal_matte,
    ingest_rgba_png_sequence,
)


SMALL_CONTRACT = MatteContract(width=32, height=24, frame_count=5)


def _alpha_frame(
    *,
    width: int,
    height: int,
    index: int,
    jump: bool = False,
    horizontal_offset: int = 0,
) -> np.ndarray:
    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    rgba[..., :3] = np.array([82, 166, 214], dtype=np.uint8)
    left = 4 + index + horizontal_offset
    if jump and index >= 1:
        left = width - 12
    rgba[5 : height - 5, left : left + 10, 3] = np.uint8(255)
    # Preserve a soft boundary so extraction cannot silently binarize alpha.
    rgba[5 : height - 5, left, 3] = np.uint8(96)
    rgba[5 : height - 5, left + 1, 3] = np.uint8(160)
    return rgba


def _write_sequence(
    root: Path,
    contract: MatteContract,
    *,
    mode: str = "RGBA",
    jump: bool = False,
    all_transparent: bool = False,
    inverted: bool = False,
    horizontal_offset: int = 0,
    thin_foreground: bool = False,
) -> tuple[Path, ...]:
    root.mkdir(parents=True)
    paths: list[Path] = []
    for index in range(contract.frame_count):
        rgba = _alpha_frame(
            width=contract.width,
            height=contract.height,
            index=index,
            jump=jump,
            horizontal_offset=horizontal_offset,
        )
        if thin_foreground:
            rgba[..., 3] = np.uint8(0)
            rgba[2 : contract.height - 2, 10, 3] = np.uint8(255)
        if all_transparent:
            rgba[..., 3] = np.uint8(0)
        if inverted:
            rgba[..., 3] = np.uint8(255) - rgba[..., 3]
        path = root / f"veed_{index:06d}.png"
        image = Image.fromarray(rgba, mode="RGBA")
        if mode == "RGB":
            image = image.convert("RGB")
        image.save(path, format="PNG")
        paths.append(path)
    return tuple(paths)


def _encode_transparent_video(
    paths: tuple[Path, ...],
    output: Path,
    codec_arguments: list[str],
) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-framerate",
            "24",
            "-start_number",
            "0",
            "-i",
            str(paths[0].parent / "veed_%06d.png"),
            "-frames:v",
            str(len(paths)),
            *codec_arguments,
            "-an",
            "-n",
            str(output),
        ],
        check=True,
        capture_output=True,
        text=True,
    )


def _rewrite_manifest_digest(payload: dict[str, object]) -> None:
    unsigned = dict(payload)
    unsigned.pop("digest_sha256", None)
    payload["digest_sha256"] = hashlib.sha256(
        json.dumps(
            unsigned,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        ).encode("utf-8")
    ).hexdigest()


@pytest.fixture(scope="session")
def canonical_rgba_sequence(
    tmp_path_factory: pytest.TempPathFactory,
) -> tuple[Path, ...]:
    root = tmp_path_factory.mktemp("canonical-rgba-matte")
    contract = CANONICAL_TEMPORAL_MATTE_CONTRACT
    root.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for index in range(contract.frame_count):
        rgba = np.zeros(
            (contract.height, contract.width, 4),
            dtype=np.uint8,
        )
        rgba[..., :3] = np.array([40, 80, 120], dtype=np.uint8)
        left = 420 + index
        rgba[120:660, left : left + 220, 3] = np.uint8(255)
        rgba[120:660, left, 3] = np.uint8(96)
        rgba[120:660, left + 1, 3] = np.uint8(160)
        path = root / f"veed_{index:06d}.png"
        Image.fromarray(rgba, mode="RGBA").save(path, format="PNG")
        paths.append(path)
    return tuple(paths)


def test_canonical_rgba_sequence_materializes_bound_soft_and_vace_masks(
    tmp_path: Path,
    canonical_rgba_sequence: tuple[Path, ...],
) -> None:
    output = tmp_path / "matte"

    result = ingest_rgba_png_sequence(canonical_rgba_sequence, output)

    assert len(result.soft_mask_paths) == 121
    assert len(result.edit_mask_paths) == 121
    assert result.soft_mask_paths[0].name == "foreground_000000.png"
    assert result.soft_mask_paths[-1].name == "foreground_000120.png"
    assert result.edit_mask_paths[0].name == "mask_000000.png"
    assert result.edit_mask_paths[-1].name == "mask_000120.png"

    with Image.open(canonical_rgba_sequence[37]) as source:
        expected_alpha = np.array(source.getchannel("A"), dtype=np.uint8)
    with Image.open(result.soft_mask_paths[37]) as soft:
        assert soft.mode == "L"
        np.testing.assert_array_equal(np.asarray(soft), expected_alpha)
    with Image.open(result.edit_mask_paths[37]) as edit:
        assert edit.mode == "L"
        np.testing.assert_array_equal(
            np.asarray(edit),
            np.where(expected_alpha >= 128, 0, 255).astype(np.uint8),
        )

    manifest = json.loads(result.manifest_path.read_text(encoding="utf-8"))
    assert manifest["contract"]["soft_mask_polarity"] == SOFT_MASK_POLARITY
    assert manifest["contract"]["edit_mask_polarity"] == EDIT_MASK_POLARITY
    assert manifest["contract"]["foreground_threshold"] == 128
    assert manifest["contract"]["protected_core_erosion_radius"] == 4
    assert manifest["qa"]["passed"] is True
    assert manifest["qa"]["every_frame_nonempty"] is True
    assert manifest["qa"]["every_frame_nonempty_protected_core"] is True
    assert manifest["qa"]["minimum_protected_core_pixels"] > 0
    assert manifest["qa"]["maximum_centroid_jump_ratio"] > 0
    assert len(manifest["frames"]) == 121
    assert all(frame["source_file_sha256"] for frame in manifest["frames"])
    assert all(frame["soft_mask_file_sha256"] for frame in manifest["frames"])
    assert all(frame["edit_mask_file_sha256"] for frame in manifest["frames"])

    verified = _verify_temporal_matte(
        result.manifest_path,
        expected_contract=CANONICAL_TEMPORAL_MATTE_CONTRACT,
        require_transport_compatibility=True,
    )
    assert verified.manifest_digest_sha256 == result.manifest_digest_sha256

    transport = tmp_path / "vace-mask-transport.mp4"
    encode_mask_transport(result.edit_mask_paths, transport)
    assert transport.is_file()

    with pytest.raises(FileExistsError, match="already exists"):
        ingest_rgba_png_sequence(canonical_rgba_sequence, output)


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        ("missing_alpha", "RGBA"),
        ("wrong_count", "exactly 5"),
        ("wrong_geometry", "32x24"),
        ("wrong_order", "order"),
    ],
)
def test_rgba_sequence_fails_closed_on_invalid_contract(
    tmp_path: Path,
    mutation: str,
    message: str,
) -> None:
    paths = list(_write_sequence(tmp_path / "source", SMALL_CONTRACT))
    if mutation == "missing_alpha":
        with Image.open(paths[2]) as image:
            image.convert("RGB").save(paths[2], format="PNG")
    elif mutation == "wrong_count":
        paths.pop()
    elif mutation == "wrong_geometry":
        with Image.open(paths[2]) as image:
            image.resize((31, 24)).save(paths[2], format="PNG")
    elif mutation == "wrong_order":
        paths[1], paths[2] = paths[2], paths[1]

    with pytest.raises(MatteInputError, match=message):
        _ingest_rgba_png_sequence(
            paths,
            tmp_path / "matte",
            contract=SMALL_CONTRACT,
            require_transport_compatibility=False,
        )

    assert (tmp_path / "matte").exists() is False


@pytest.mark.parametrize(
    ("fixture_kwargs", "message"),
    [
        ({"all_transparent": True}, "nonempty"),
        ({"inverted": True}, "polarity"),
        ({"jump": True}, "centroid jump"),
    ],
)
def test_implausible_alpha_sequences_fail_before_materialization(
    tmp_path: Path,
    fixture_kwargs: dict[str, bool],
    message: str,
) -> None:
    paths = _write_sequence(
        tmp_path / "source",
        SMALL_CONTRACT,
        **fixture_kwargs,
    )

    with pytest.raises(MattePlausibilityError, match=message):
        _ingest_rgba_png_sequence(
            paths,
            tmp_path / "matte",
            contract=SMALL_CONTRACT,
            require_transport_compatibility=False,
        )

    assert (tmp_path / "matte").exists() is False


def test_thin_foreground_with_empty_frozen_core_is_rejected(
    tmp_path: Path,
) -> None:
    paths = _write_sequence(
        tmp_path / "source",
        SMALL_CONTRACT,
        thin_foreground=True,
    )

    with pytest.raises(MattePlausibilityError, match="protected core"):
        _ingest_rgba_png_sequence(
            paths,
            tmp_path / "matte",
            contract=SMALL_CONTRACT,
            require_transport_compatibility=False,
        )


def test_16_bit_rgba_png_is_rejected_before_pillow_quantization(
    tmp_path: Path,
) -> None:
    paths = list(_write_sequence(tmp_path / "source", SMALL_CONTRACT))
    rgba16 = np.zeros(
        (SMALL_CONTRACT.height, SMALL_CONTRACT.width, 4),
        dtype=np.uint16,
    )
    rgba16[..., :3] = np.uint16(24_000)
    rgba16[5:19, 6:16, 3] = np.uint16(65_535)
    rgba16[5:19, 6, 3] = np.uint16(96 * 257)
    rgba16[5:19, 7, 3] = np.uint16(160 * 257)
    assert cv2.imwrite(str(paths[2]), rgba16)
    with Image.open(paths[2]) as image:
        assert image.mode == "RGBA"

    with pytest.raises(MatteInputError, match="8-bit RGBA PNG"):
        _ingest_rgba_png_sequence(
            paths,
            tmp_path / "matte",
            contract=SMALL_CONTRACT,
            require_transport_compatibility=False,
        )


def test_verifier_recomputes_persisted_protected_core_count(
    tmp_path: Path,
) -> None:
    paths = _write_sequence(tmp_path / "source", SMALL_CONTRACT)
    result = _ingest_rgba_png_sequence(
        paths,
        tmp_path / "matte",
        contract=SMALL_CONTRACT,
        require_transport_compatibility=False,
    )
    payload = json.loads(result.manifest_path.read_text(encoding="utf-8"))
    payload["frames"][2]["protected_core_pixels"] += 1
    _rewrite_manifest_digest(payload)
    result.manifest_path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    with pytest.raises(MatteIntegrityError, match="protected_core_pixels"):
        _verify_temporal_matte(
            result.manifest_path,
            expected_contract=SMALL_CONTRACT,
            require_transport_compatibility=False,
        )


@pytest.mark.parametrize(
    "target",
    ["soft", "edit", "manifest", "source", "extra"],
)
def test_verifier_detects_artifact_or_manifest_tamper(
    tmp_path: Path,
    target: str,
) -> None:
    paths = _write_sequence(tmp_path / "source", SMALL_CONTRACT)
    result = _ingest_rgba_png_sequence(
        paths,
        tmp_path / "matte",
        contract=SMALL_CONTRACT,
        require_transport_compatibility=False,
    )

    if target == "soft":
        with Image.open(result.soft_mask_paths[1]) as image:
            changed = np.array(image, dtype=np.uint8)
        changed[8, 8] ^= np.uint8(1)
        Image.fromarray(changed, mode="L").save(
            result.soft_mask_paths[1], format="PNG"
        )
    elif target == "edit":
        with Image.open(result.edit_mask_paths[1]) as image:
            changed = np.array(image, dtype=np.uint8)
        changed[8, 8] ^= np.uint8(255)
        Image.fromarray(changed, mode="L").save(
            result.edit_mask_paths[1], format="PNG"
        )
    elif target == "manifest":
        payload = json.loads(result.manifest_path.read_text(encoding="utf-8"))
        payload["qa"]["passed"] = False
        result.manifest_path.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    elif target == "source":
        with Image.open(paths[1]) as image:
            changed = np.array(image, dtype=np.uint8)
        changed[8, 8, 0] ^= np.uint8(1)
        Image.fromarray(changed, mode="RGBA").save(paths[1], format="PNG")
    else:
        (result.directory / "unbound.png").write_bytes(b"unbound")

    with pytest.raises(MatteIntegrityError):
        _verify_temporal_matte(
            result.manifest_path,
            expected_contract=SMALL_CONTRACT,
            require_transport_compatibility=False,
        )


def test_mp4_alpha_input_is_explicitly_rejected(tmp_path: Path) -> None:
    source = tmp_path / "fal-result.mp4"
    source.write_bytes(b"not authoritative alpha")

    with pytest.raises(MatteInputError, match="MP4.*alpha"):
        _ingest_transparent_video(
            source,
            tmp_path / "matte",
            contract=SMALL_CONTRACT,
            require_transport_compatibility=False,
        )


@pytest.mark.parametrize(
    ("suffix", "codec_arguments", "expected_kind"),
    [
        ("mov", ["-c:v", "qtrle", "-pix_fmt", "argb"], "transparent_mov"),
        (
            "webm",
            [
                "-c:v",
                "libvpx-vp9",
                "-lossless",
                "1",
                "-pix_fmt",
                "yuva420p",
            ],
            "transparent_webm",
        ),
    ],
)
def test_transparent_video_decodes_alpha_twice_identically(
    tmp_path: Path,
    suffix: str,
    codec_arguments: list[str],
    expected_kind: str,
) -> None:
    paths = _write_sequence(tmp_path / "source", SMALL_CONTRACT)
    video = tmp_path / f"transparent.{suffix}"
    _encode_transparent_video(paths, video, codec_arguments)

    result = _ingest_transparent_video(
        video,
        tmp_path / "matte",
        contract=SMALL_CONTRACT,
        require_transport_compatibility=False,
    )

    assert len(result.soft_mask_paths) == SMALL_CONTRACT.frame_count
    payload = json.loads(result.manifest_path.read_text(encoding="utf-8"))
    assert payload["source"]["kind"] == expected_kind
    assert payload["source"]["deterministic_decode_passed"] is True
    assert payload["source"]["decode_pass_count"] == 2
    assert payload["source"]["source_file_sha256"]
    assert payload["source"]["alpha_bit_depth"] == 8
    assert payload["source"]["decode_algorithm_id"] == (
        "framelock_transparent_rgba8_passthrough_v1"
    )
    decode_template = payload["source"]["decode_argv_template"]
    assert ["-fps_mode", "passthrough"] == decode_template[
        decode_template.index("-fps_mode") : decode_template.index("-fps_mode") + 2
    ]
    assert "-vf" not in decode_template
    assert "-r" not in decode_template
    if suffix == "webm":
        assert "libvpx-vp9" in decode_template


def test_probe_accepts_explicit_uppercase_veed_alpha_mode_tag(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "veed-matte.webm"
    source.write_bytes(b"synthetic probe fixture")
    timestamps = [0, 42, 83, 125, 167]
    payload = {
        "frames": [
            {
                "best_effort_timestamp": timestamp,
                "height": SMALL_CONTRACT.height,
                "pix_fmt": "yuv420p",
                "pts": timestamp,
                "width": SMALL_CONTRACT.width,
            }
            for timestamp in timestamps
        ],
        "format": {"format_name": "matroska,webm"},
        "streams": [
            {
                "avg_frame_rate": "24/1",
                "codec_name": "vp9",
                "height": SMALL_CONTRACT.height,
                "nb_read_frames": str(SMALL_CONTRACT.frame_count),
                "pix_fmt": "yuv420p",
                "r_frame_rate": "24/1",
                "sample_aspect_ratio": "1:1",
                "tags": {"ALPHA_MODE": "1"},
                "time_base": "1/1000",
                "width": SMALL_CONTRACT.width,
            }
        ],
    }
    monkeypatch.setattr(
        temporal_matte,
        "_executable",
        lambda name: f"/mock/{name}",
    )
    monkeypatch.setattr(
        temporal_matte,
        "_version_line",
        lambda executable: f"{executable} mock version",
    )
    monkeypatch.setattr(
        temporal_matte,
        "_run",
        lambda argv: json.dumps(payload),
    )

    probe = temporal_matte._probe_transparent_video(
        source,
        contract=SMALL_CONTRACT,
    )

    assert probe.alpha_signal == "stream_tag_alpha_mode=1"
    assert probe.alpha_bit_depth == 8


def test_conflicting_case_variants_of_alpha_mode_fail_closed() -> None:
    with pytest.raises(MatteInputError, match="alpha mode metadata conflicts"):
        temporal_matte._explicit_alpha_mode(
            {"tags": {"alpha_mode": "0", "ALPHA_MODE": "1"}}
        )


def test_ingest_rejects_source_replaced_after_second_decode(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first_paths = _write_sequence(tmp_path / "first", SMALL_CONTRACT)
    second_paths = _write_sequence(
        tmp_path / "second",
        SMALL_CONTRACT,
        horizontal_offset=8,
    )
    source = tmp_path / "source.webm"
    replacement = tmp_path / "replacement.webm"
    codec = ["-c:v", "libvpx-vp9", "-lossless", "1", "-pix_fmt", "yuva420p"]
    _encode_transparent_video(first_paths, source, codec)
    _encode_transparent_video(second_paths, replacement, codec)
    original_decode = temporal_matte._decode_transparent_video
    calls = 0

    def replacing_decode(*args: object, **kwargs: object) -> object:
        nonlocal calls
        decoded = original_decode(*args, **kwargs)
        calls += 1
        if calls == 2:
            os.replace(replacement, source)
        return decoded

    monkeypatch.setattr(
        temporal_matte,
        "_decode_transparent_video",
        replacing_decode,
    )

    with pytest.raises(MatteInputError, match="source.*changed"):
        _ingest_transparent_video(
            source,
            tmp_path / "matte",
            contract=SMALL_CONTRACT,
            require_transport_compatibility=False,
        )


def test_ingest_rejects_source_replaced_after_seal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first_paths = _write_sequence(tmp_path / "first", SMALL_CONTRACT)
    second_paths = _write_sequence(
        tmp_path / "second",
        SMALL_CONTRACT,
        horizontal_offset=8,
    )
    source = tmp_path / "source.mov"
    replacement = tmp_path / "replacement.mov"
    codec = ["-c:v", "qtrle", "-pix_fmt", "argb"]
    _encode_transparent_video(first_paths, source, codec)
    _encode_transparent_video(second_paths, replacement, codec)
    original_build = temporal_matte._build_matte

    def replacing_build(*args: object, **kwargs: object) -> object:
        result = original_build(*args, **kwargs)
        os.replace(replacement, source)
        return result

    monkeypatch.setattr(temporal_matte, "_build_matte", replacing_build)

    with pytest.raises(MatteInputError, match="source.*changed"):
        _ingest_transparent_video(
            source,
            tmp_path / "matte",
            contract=SMALL_CONTRACT,
            require_transport_compatibility=False,
        )


def test_verifier_fresh_decode_rejects_rewritten_replacement_manifest(
    tmp_path: Path,
) -> None:
    first_paths = _write_sequence(tmp_path / "first", SMALL_CONTRACT)
    second_paths = _write_sequence(
        tmp_path / "second",
        SMALL_CONTRACT,
        horizontal_offset=8,
    )
    source = tmp_path / "source.mov"
    replacement = tmp_path / "replacement.mov"
    codec = ["-c:v", "qtrle", "-pix_fmt", "argb"]
    _encode_transparent_video(first_paths, source, codec)
    _encode_transparent_video(second_paths, replacement, codec)
    result = _ingest_transparent_video(
        source,
        tmp_path / "matte",
        contract=SMALL_CONTRACT,
        require_transport_compatibility=False,
    )
    os.replace(replacement, source)
    replacement_hash = temporal_matte.sha256_file(source)
    payload = json.loads(result.manifest_path.read_text(encoding="utf-8"))
    payload["source"]["source_file_sha256"] = replacement_hash
    for frame in payload["frames"]:
        frame["source_file_sha256"] = replacement_hash
    payload["source"]["ordered_frame_digest_sha256"] = (
        temporal_matte._ordered_source_digest(payload["frames"])
    )
    _rewrite_manifest_digest(payload)
    result.manifest_path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    with pytest.raises(MatteIntegrityError, match="fresh|probe|decode|alpha"):
        _verify_temporal_matte(
            result.manifest_path,
            expected_contract=SMALL_CONTRACT,
            require_transport_compatibility=False,
        )


def test_verifier_rejects_source_change_during_fresh_decode(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first_paths = _write_sequence(tmp_path / "first", SMALL_CONTRACT)
    second_paths = _write_sequence(
        tmp_path / "second",
        SMALL_CONTRACT,
        horizontal_offset=8,
    )
    source = tmp_path / "source.webm"
    replacement = tmp_path / "replacement.webm"
    codec = ["-c:v", "libvpx-vp9", "-lossless", "1", "-pix_fmt", "yuva420p"]
    _encode_transparent_video(first_paths, source, codec)
    _encode_transparent_video(second_paths, replacement, codec)
    result = _ingest_transparent_video(
        source,
        tmp_path / "matte",
        contract=SMALL_CONTRACT,
        require_transport_compatibility=False,
    )
    original_decode = temporal_matte._decode_transparent_video
    calls = 0

    def replacing_decode(*args: object, **kwargs: object) -> object:
        nonlocal calls
        decoded = original_decode(*args, **kwargs)
        calls += 1
        if calls == 1:
            os.replace(replacement, source)
        return decoded

    monkeypatch.setattr(
        temporal_matte,
        "_decode_transparent_video",
        replacing_decode,
    )

    with pytest.raises(MatteIntegrityError, match="source.*changed"):
        _verify_temporal_matte(
            result.manifest_path,
            expected_contract=SMALL_CONTRACT,
            require_transport_compatibility=False,
        )


def test_high_bit_depth_transparent_mov_is_rejected(tmp_path: Path) -> None:
    paths = _write_sequence(tmp_path / "source", SMALL_CONTRACT)
    video = tmp_path / "high-bit.mov"
    _encode_transparent_video(
        paths,
        video,
        [
            "-c:v",
            "prores_ks",
            "-profile:v",
            "4",
            "-pix_fmt",
            "yuva444p12le",
        ],
    )

    with pytest.raises(MatteInputError, match="8-bit alpha"):
        _ingest_transparent_video(
            video,
            tmp_path / "matte",
            contract=SMALL_CONTRACT,
            require_transport_compatibility=False,
        )


@pytest.mark.parametrize(
    ("mutation", "message"),
    [("rotation", "rotation"), ("sar", "sample aspect ratio")],
)
def test_transparent_video_rejects_noncanonical_display_geometry(
    tmp_path: Path,
    mutation: str,
    message: str,
) -> None:
    paths = _write_sequence(tmp_path / "source", SMALL_CONTRACT)
    original = tmp_path / "original.mov"
    mutated = tmp_path / f"{mutation}.mov"
    _encode_transparent_video(
        paths,
        original,
        ["-c:v", "qtrle", "-pix_fmt", "argb"],
    )
    command = [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
    ]
    if mutation == "rotation":
        command.extend(["-display_rotation:v:0", "90"])
    command.extend(["-i", str(original)])
    if mutation == "rotation":
        command.extend(
            ["-map", "0:v:0", "-c", "copy"]
        )
    else:
        command.extend(
            ["-vf", "setsar=2/1", "-c:v", "qtrle", "-pix_fmt", "argb"]
        )
    command.extend(["-an", "-n", str(mutated)])
    subprocess.run(command, check=True, capture_output=True, text=True)

    with pytest.raises(MatteInputError, match=message):
        _ingest_transparent_video(
            mutated,
            tmp_path / "matte",
            contract=SMALL_CONTRACT,
            require_transport_compatibility=False,
        )
