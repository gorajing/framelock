from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
import pytest

import framelock_media.ai_source as ai_source_module
from framelock_media.ai_source import (
    AiSourceError,
    prepare_chroma_rgba,
    prepare_ai_source,
    verify_ai_source_bundle,
    verify_chroma_preparation,
)
from framelock_media.artifacts import load_rgb_png, save_rgb_png, sha256_file
from framelock_media.cli import main
from framelock_media.ffmpeg_pipeline import probe_media_facts
from framelock_media.masks import load_core_mask
from framelock_media.offline_proof import prepare_canonical_source


PROMPT = (
    "A fictional matte-black FRM-01 AI hardware module, centered three-quarter "
    "product view, isolated on transparency, no third-party branding."
)
CREATED_AT = "2026-07-18T20:00:00Z"


def _rgba_hero(path: Path) -> None:
    image = Image.new("RGBA", (640, 640), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        (150, 70, 490, 570),
        radius=42,
        fill=(24, 27, 31, 255),
        outline=(72, 224, 238, 255),
        width=8,
    )
    draw.rectangle((185, 145, 455, 260), fill=(8, 10, 14, 255))
    draw.polygon(
        ((320, 300), (380, 360), (320, 420), (260, 360)),
        fill=(224, 76, 154, 255),
    )
    image.save(path, format="PNG")


def _opaque_hero_and_mask(image_path: Path, mask_path: Path) -> None:
    image = Image.new("RGB", (800, 500), (86, 86, 90))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        (225, 40, 575, 460),
        radius=36,
        fill=(26, 28, 32),
        outline=(70, 220, 235),
        width=8,
    )
    image.save(image_path, format="PNG")

    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((225, 40, 575, 460), radius=36, fill=255)
    mask.save(mask_path, format="PNG")


def _prepared_rgba_from_opaque(
    image_path: Path, mask_path: Path, prepared_path: Path
) -> None:
    with Image.open(image_path) as image, Image.open(mask_path) as mask:
        rgba = image.convert("RGBA")
        rgba.putalpha(mask)
        rgba.save(prepared_path, format="PNG")


def _chroma_source(path: Path) -> None:
    pixels = np.full((4, 8, 3), (0, 255, 0), dtype=np.uint8)
    pixels[:, 3:6] = (255, 0, 0)
    pixels[:, 2] = (0, 200, 0)
    pixels[:, 6] = (80, 160, 40)
    Image.fromarray(pixels, mode="RGB").save(path, format="PNG")


def _rewrite_bundle_manifest(path: Path, payload: dict[str, object]) -> None:
    unsigned = dict(payload)
    unsigned.pop("manifest_digest_sha256", None)
    payload["manifest_digest_sha256"] = hashlib.sha256(
        json.dumps(
            unsigned,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        ).encode("utf-8")
    ).hexdigest()
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _artifact_hashes(root: Path) -> dict[str, str]:
    names = (
        "source_record.json",
        "mask_candidate_original.png",
        "mask_candidate_normalized.png",
        "normalized_plate.png",
        "foreground.png",
        "protected_core.png",
        "boundary_ring.png",
        "canonical_decoded_frame.png",
        "source.mp4",
        "contact_sheet.png",
        "source_bundle.json",
    )
    return {name: sha256_file(root / name) for name in names}


def test_alpha_source_build_is_content_addressed_stationary_and_intake_ready(
    tmp_path: Path,
) -> None:
    source = tmp_path / "generated-framelock.png"
    _rgba_hero(source)

    result = prepare_ai_source(
        source,
        tmp_path / "sources",
        prompt=PROMPT,
        generator="openai-imagegen",
        created_at=CREATED_AT,
    )

    original_sha256 = hashlib.sha256(source.read_bytes()).hexdigest()
    assert result.directory == tmp_path / "sources" / "sha256" / original_sha256
    assert result.original_path.read_bytes() == source.read_bytes()
    assert result.unique_decoded_rgb_hash_count == 1
    assert result.decoded_frame_count == 121
    assert verify_ai_source_bundle(result.directory)["manifest_digest_sha256"] == (
        result.manifest_digest_sha256
    )

    source_record = json.loads(result.source_record_path.read_text(encoding="utf-8"))
    assert source_record["provenance_label"] == "ai_generated_source"
    assert source_record["generator"] == {
        "created_at": CREATED_AT,
        "identity": "openai-imagegen",
        "prompt": PROMPT,
    }
    assert source_record["original"]["filename"] == source.name
    assert source_record["original"]["sha256"] == original_sha256
    assert source_record["original"]["content_type"] == "image/png"

    with Image.open(result.normalized_plate_path) as plate:
        assert plate.mode == "RGB"
        assert plate.size == (1280, 720)
    with Image.open(result.foreground_mask_path) as foreground_image:
        assert foreground_image.mode == "L"
        assert foreground_image.size == (1280, 720)
        assert set(np.unique(np.asarray(foreground_image)).tolist()) == {0, 255}
        assert foreground_image.n_frames == 1
    core = load_core_mask(result.protected_core_path)
    ring = load_core_mask(result.boundary_ring_path)
    assert np.any(core)
    assert np.any(ring)
    assert not np.any(core & ring)

    facts = probe_media_facts(result.source_mp4_path)
    assert (facts.width, facts.height) == (1280, 720)
    assert facts.frame_count == 121
    assert str(facts.frame_rate) == "24"
    assert facts.file_size_bytes <= 50 * 1024 * 1024

    with Image.open(result.contact_sheet_path) as contact_sheet:
        assert contact_sheet.mode == "RGB"
        assert contact_sheet.size == (1920, 1080)

    prepared = prepare_canonical_source(
        result.source_mp4_path,
        result.foreground_mask_path,
        tmp_path / "prepared-source",
    )
    decoded_hashes = {
        hashlib.sha256(load_rgb_png(path).tobytes(order="C")).hexdigest()
        for path in prepared.source_paths
    }
    summary = json.loads(prepared.summary_path.read_text(encoding="utf-8"))
    assert decoded_hashes == {result.canonical_rgb_sha256}
    assert summary["claim"] is None
    assert summary["source_audio"]["present"] is False


def test_repeated_build_is_byte_deterministic_and_write_once(tmp_path: Path) -> None:
    source = tmp_path / "generated-framelock.png"
    _rgba_hero(source)

    first = prepare_ai_source(
        source,
        tmp_path / "first",
        prompt=PROMPT,
        generator="openai-imagegen",
        created_at=CREATED_AT,
    )
    second = prepare_ai_source(
        source,
        tmp_path / "second",
        prompt=PROMPT,
        generator="openai-imagegen",
        created_at=CREATED_AT,
    )

    assert _artifact_hashes(first.directory) == _artifact_hashes(second.directory)
    with pytest.raises(FileExistsError, match="already exists"):
        prepare_ai_source(
            source,
            tmp_path / "first",
            prompt=PROMPT,
            generator="openai-imagegen",
            created_at=CREATED_AT,
        )


def test_opaque_source_requires_explicit_mask_and_cli_records_that_method(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    source = tmp_path / "opaque-source.png"
    mask = tmp_path / "explicit-mask.png"
    prompt_file = tmp_path / "image-prompt.txt"
    metadata_file = tmp_path / "generator-metadata.json"
    _opaque_hero_and_mask(source, mask)
    prompt_file.write_text(PROMPT, encoding="utf-8")
    metadata_file.write_text(
        json.dumps({"tool": "image_gen.imagegen", "request_id": "local-test"}),
        encoding="utf-8",
    )

    with pytest.raises(AiSourceError, match="explicit mask candidate"):
        prepare_ai_source(
            source,
            tmp_path / "rejected",
            prompt=PROMPT,
            generator="openai-imagegen",
            created_at=CREATED_AT,
        )
    assert not (tmp_path / "rejected").exists()

    assert main(
        [
            "prepare-ai-source",
            "--image",
            str(source),
            "--mask-candidate",
            str(mask),
            "--output-root",
            str(tmp_path / "accepted"),
            "--prompt-file",
            str(prompt_file),
            "--generator",
            "openai-imagegen",
            "--generator-metadata-file",
            str(metadata_file),
            "--created-at",
            CREATED_AT,
        ]
    ) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["state"] == "prepared"
    assert payload["claim"] is None
    assert payload["mask_method"] == "explicit_local_mask"
    assert payload["unique_decoded_rgb_hash_count"] == 1
    directory = Path(payload["source_directory"])
    assert verify_ai_source_bundle(directory)["mask"]["method"] == (
        "explicit_local_mask"
    )
    record = json.loads((directory / "source_record.json").read_text("utf-8"))
    assert record["generator"]["prompt"] == PROMPT
    assert record["generator"]["metadata"] == {
        "request_id": "local-test",
        "tool": "image_gen.imagegen",
    }


def test_separate_prepared_rgba_binds_local_derivation_without_replacing_original(
    tmp_path: Path,
) -> None:
    source = tmp_path / "chroma-original.png"
    mask = tmp_path / "extracted-mask.png"
    prepared_rgba = tmp_path / "despilled-working.png"
    _opaque_hero_and_mask(source, mask)
    _prepared_rgba_from_opaque(source, mask, prepared_rgba)

    result = prepare_ai_source(
        source,
        tmp_path / "sources",
        prompt=PROMPT,
        generator="openai-imagegen",
        created_at=CREATED_AT,
        prepared_rgba_path=prepared_rgba,
        prepared_rgba_derivation=(
            "Local deterministic chroma removal; despilled RGB plus extracted alpha."
        ),
    )

    assert result.original_path.read_bytes() == source.read_bytes()
    assert (result.directory / "prepared_working_rgba.png").read_bytes() == (
        prepared_rgba.read_bytes()
    )
    manifest = verify_ai_source_bundle(result.directory)
    assert manifest["mask"]["method"] == "prepared_rgba_alpha"
    assert manifest["working_image"] == {
        "derivation": (
            "Local deterministic chroma removal; despilled RGB plus extracted alpha."
        ),
        "path": "prepared_working_rgba.png",
        "sha256": sha256_file(prepared_rgba),
    }


def test_chroma_command_is_versioned_deterministic_and_preserves_original(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    source = tmp_path / "green-source.png"
    _chroma_source(source)

    assert main(
        [
            "prepare-chroma-rgba",
            "--image",
            str(source),
            "--output-root",
            str(tmp_path / "first"),
            "--key-rgb",
            "0",
            "255",
            "0",
            "--threshold",
            "30",
            "--softness",
            "50",
            "--despill-strength",
            "1",
        ]
    ) == 0
    payload = json.loads(capsys.readouterr().out)
    first_directory = Path(payload["directory"])
    assert payload["claim"] is None
    assert payload["algorithm_id"] == "framelock_rgb_euclidean_chroma_key"
    assert payload["algorithm_version"] == 1
    assert payload["parameters"] == {
        "despill_strength": "1",
        "key_rgb": [0, 255, 0],
        "softness_rgb_distance": "50",
        "threshold_rgb_distance": "30",
    }

    second = prepare_chroma_rgba(
        source,
        tmp_path / "second",
        key_rgb=(0, 255, 0),
        threshold="30",
        softness="50",
        despill_strength="1",
    )
    assert (first_directory / "original/generated.png").read_bytes() == (
        source.read_bytes()
    )
    assert sha256_file(first_directory / "prepared_rgba.png") == sha256_file(
        second.prepared_rgba_path
    )
    assert sha256_file(first_directory / "chroma_derivation.json") == sha256_file(
        second.derivation_manifest_path
    )
    manifest = verify_chroma_preparation(first_directory)
    assert manifest["claim"] is None
    assert manifest["algorithm"]["alpha_formula"] == (
        "alpha8=floor(255*clamp((euclidean_rgb_distance-threshold)/softness,0,1)+0.5)"
    )
    assert manifest["algorithm"]["despill_formula"] == (
        "dominant'=floor(dominant-spill*strength*(255-alpha8)/255+0.5)"
    )
    assert "despill_mode" not in manifest["algorithm"]
    assert "foreground_excludes_dominant_key_color" not in (
        manifest["algorithm"]
    )

    with Image.open(first_directory / "prepared_rgba.png") as prepared:
        pixels = np.asarray(prepared, dtype=np.uint8)
    np.testing.assert_array_equal(pixels[0, 0], [0, 0, 0, 0])
    np.testing.assert_array_equal(pixels[0, 2], [0, 100, 0, 128])
    np.testing.assert_array_equal(pixels[0, 3], [255, 0, 0, 255])
    np.testing.assert_array_equal(pixels[0, 6], [80, 160, 40, 255])


def test_chroma_v2_removes_opaque_spill_only_after_explicit_declaration(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    source = tmp_path / "green-source.png"
    _chroma_source(source)

    with pytest.raises(AiSourceError, match="explicitly declare"):
        prepare_chroma_rgba(
            source,
            tmp_path / "unsafe",
            key_rgb=(0, 255, 0),
            threshold="30",
            softness="50",
            despill_strength="1",
            algorithm_version=2,
        )
    assert not (tmp_path / "unsafe").exists()

    assert main(
        [
            "prepare-chroma-rgba",
            "--image",
            str(source),
            "--output-root",
            str(tmp_path / "first"),
            "--key-rgb",
            "0",
            "255",
            "0",
            "--threshold",
            "30",
            "--softness",
            "50",
            "--despill-strength",
            "1",
            "--algorithm-version",
            "2",
            "--foreground-excludes-key-color",
        ]
    ) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["algorithm_version"] == 2
    assert payload["despill_mode"] == "foreground_key_color_excluded"
    first_directory = Path(payload["directory"])

    second = prepare_chroma_rgba(
        source,
        tmp_path / "second",
        key_rgb=(0, 255, 0),
        threshold="30",
        softness="50",
        despill_strength="1",
        algorithm_version=2,
        foreground_excludes_key_color=True,
    )
    assert sha256_file(first_directory / "prepared_rgba.png") == sha256_file(
        second.prepared_rgba_path
    )
    assert sha256_file(first_directory / "chroma_derivation.json") == sha256_file(
        second.derivation_manifest_path
    )

    manifest = verify_chroma_preparation(first_directory)
    algorithm = manifest["algorithm"]
    assert algorithm["version"] == 2
    assert algorithm["despill_mode"] == "foreground_key_color_excluded"
    assert algorithm["foreground_excludes_dominant_key_color"] is True
    assert algorithm["despill_formula"] == (
        "dominant'=floor(dominant-spill*strength+0.5)"
    )

    with Image.open(first_directory / "prepared_rgba.png") as prepared:
        v2_pixels = np.asarray(prepared, dtype=np.uint8)
    np.testing.assert_array_equal(v2_pixels[0, 0], [0, 0, 0, 0])
    np.testing.assert_array_equal(v2_pixels[0, 2], [0, 0, 0, 128])
    np.testing.assert_array_equal(v2_pixels[0, 3], [255, 0, 0, 255])
    np.testing.assert_array_equal(v2_pixels[0, 6], [80, 80, 40, 255])


def test_chroma_preparation_rejects_unknown_or_misdeclared_versions(
    tmp_path: Path,
) -> None:
    source = tmp_path / "green-source.png"
    _chroma_source(source)

    with pytest.raises(AiSourceError, match="unsupported"):
        prepare_chroma_rgba(
            source,
            tmp_path / "unknown",
            key_rgb=(0, 255, 0),
            threshold="30",
            softness="50",
            despill_strength="1",
            algorithm_version=3,
        )
    with pytest.raises(AiSourceError, match="version 2"):
        prepare_chroma_rgba(
            source,
            tmp_path / "misdeclared-v1",
            key_rgb=(0, 255, 0),
            threshold="30",
            softness="50",
            despill_strength="1",
            algorithm_version=1,
            foreground_excludes_key_color=True,
        )
    with pytest.raises(AiSourceError, match="boolean"):
        prepare_chroma_rgba(
            source,
            tmp_path / "nonboolean-declaration",
            key_rgb=(0, 255, 0),
            threshold="30",
            softness="50",
            despill_strength="1",
            algorithm_version=2,
            foreground_excludes_key_color=1,  # type: ignore[arg-type]
        )
    assert not (tmp_path / "unknown").exists()
    assert not (tmp_path / "misdeclared-v1").exists()
    assert not (tmp_path / "nonboolean-declaration").exists()


@pytest.mark.parametrize(
    ("key_rgb", "threshold", "softness", "despill_strength", "message"),
    (
        ((128, 128, 128), "30", "50", "1", "dominant"),
        ((0, 255, 0), "-1", "50", "1", "threshold"),
        ((0, 255, 0), "30", "0", "1", "softness"),
        ((0, 255, 0), "30", "50", "1.1", "despill"),
        ((0, 255, 0), "420", "50", "1", "reachable"),
    ),
)
def test_chroma_preparation_rejects_unsafe_parameters_before_output(
    tmp_path: Path,
    key_rgb: tuple[int, int, int],
    threshold: str,
    softness: str,
    despill_strength: str,
    message: str,
) -> None:
    source = tmp_path / "green-source.png"
    _chroma_source(source)

    with pytest.raises(AiSourceError, match=message):
        prepare_chroma_rgba(
            source,
            tmp_path / "rejected",
            key_rgb=key_rgb,
            threshold=threshold,
            softness=softness,
            despill_strength=despill_strength,
        )
    assert not (tmp_path / "rejected").exists()


def test_bundle_verifier_rederives_media_and_mask_semantics(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "generated-framelock.png"
    _rgba_hero(source)
    result = prepare_ai_source(
        source,
        tmp_path / "sources",
        prompt=PROMPT,
        generator="openai-imagegen",
        created_at=CREATED_AT,
    )

    monkeypatch.setattr(ai_source_module, "_audio_stream_count", lambda _: 1)
    with pytest.raises(AiSourceError, match="silent"):
        verify_ai_source_bundle(result.directory)
    monkeypatch.undo()

    original_decode = ai_source_module.decode_rgb24_frames_with_provenance

    def decode_with_one_drift(media_path: Path, output_directory: Path):
        decoded = original_decode(media_path, output_directory)
        path = decoded.paths[60]
        frame = load_rgb_png(path)
        frame[0, 0, 0] ^= np.uint8(1)
        path.unlink()
        save_rgb_png(path, frame)
        return decoded

    monkeypatch.setattr(
        ai_source_module,
        "decode_rgb24_frames_with_provenance",
        decode_with_one_drift,
    )
    with pytest.raises(AiSourceError, match="stationary"):
        verify_ai_source_bundle(result.directory)
    monkeypatch.undo()

    original_manifest_bytes = result.bundle_manifest_path.read_bytes()
    manifest = json.loads(original_manifest_bytes)
    manifest["source_video"]["decoded_frame_count"] = 120
    _rewrite_bundle_manifest(result.bundle_manifest_path, manifest)
    with pytest.raises(AiSourceError, match="video evidence differs"):
        verify_ai_source_bundle(result.directory)
    result.bundle_manifest_path.write_bytes(original_manifest_bytes)

    core_path = result.protected_core_path
    core = load_core_mask(core_path)
    y, x = np.argwhere(core)[0]
    core[y, x] = False
    core_path.unlink()
    Image.fromarray(np.where(core, 255, 0).astype(np.uint8), mode="L").save(
        core_path,
        format="PNG",
    )
    manifest = json.loads(original_manifest_bytes)
    manifest["mask"]["protected_core"]["sha256"] = sha256_file(core_path)
    manifest["mask"]["protected_core_pixels"] = int(np.count_nonzero(core))
    _rewrite_bundle_manifest(result.bundle_manifest_path, manifest)
    with pytest.raises(AiSourceError, match="protected core differs"):
        verify_ai_source_bundle(result.directory)


def test_animated_source_fails_before_any_content_addressed_output(
    tmp_path: Path,
) -> None:
    source = tmp_path / "animated.png"
    first = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    second = Image.new("RGBA", (64, 64), (255, 255, 255, 255))
    first.save(source, format="PNG", save_all=True, append_images=[second])

    with pytest.raises(AiSourceError, match="single-frame"):
        prepare_ai_source(
            source,
            tmp_path / "sources",
            prompt=PROMPT,
            generator="openai-imagegen",
            created_at=CREATED_AT,
        )
    assert not (tmp_path / "sources").exists()
