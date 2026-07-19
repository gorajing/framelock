from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image
import pytest

from framelock_media.mask_preview import (
    MaskPreviewError,
    build_mask_preview,
    verify_mask_preview,
)
from framelock_media.temporal_matte import ingest_rgba_png_sequence


@pytest.fixture(scope="module")
def mask_preview_artifact(
    tmp_path_factory: pytest.TempPathFactory,
):
    root = tmp_path_factory.mktemp("mask-preview")
    rgba_root = root / "rgba"
    rgba_root.mkdir()
    paths: list[Path] = []
    for index in range(121):
        rgba = np.zeros((720, 1280, 4), dtype=np.uint8)
        rgba[..., :3] = np.array([48, 72, 96], dtype=np.uint8)
        left = 180 + index * 3
        rgba[140:650, left : left + 200, 3] = np.uint8(255)
        rgba[140:650, left, 3] = np.uint8(96)
        rgba[140:650, left + 1, 3] = np.uint8(160)
        path = rgba_root / f"frame_{index:06d}.png"
        Image.fromarray(rgba, mode="RGBA").save(
            path,
            format="PNG",
            compress_level=4,
        )
        paths.append(path)
    matte = ingest_rgba_png_sequence(paths, root / "matte")
    preview = build_mask_preview(
        matte.manifest_path,
        root / "preview",
    )
    return matte, preview


def test_builds_and_reencodes_exact_canonical_mask_preview(
    mask_preview_artifact,
) -> None:
    matte, preview = mask_preview_artifact

    assert preview.output_path.name == "mask-preview.mp4"
    assert preview.output_path.is_file()
    assert preview.manifest_digest_sha256
    assert verify_mask_preview(preview.manifest_path) == preview
    payload = json.loads(preview.manifest_path.read_text(encoding="utf-8"))
    assert payload["source"]["temporal_matte_manifest_digest_sha256"] == (
        matte.manifest_digest_sha256
    )
    assert len(payload["source"]["soft_masks"]) == 121
    assert payload["output"]["probe"]["facts"]["codec"] == "h264"
    assert payload["output"]["probe"]["facts"]["pixel_format"] == (
        "yuv420p"
    )


def test_source_mask_tamper_fails(
    mask_preview_artifact,
) -> None:
    matte, preview = mask_preview_artifact
    path = matte.soft_mask_paths[37]
    original = path.read_bytes()
    try:
        with Image.open(path) as image:
            pixels = np.array(image, dtype=np.uint8, copy=True)
        pixels[200, 300] ^= np.uint8(1)
        Image.fromarray(pixels, mode="L").save(path, format="PNG")
        with pytest.raises(MaskPreviewError, match="temporal matte"):
            verify_mask_preview(preview.manifest_path)
    finally:
        path.write_bytes(original)


def test_output_tamper_fails(mask_preview_artifact) -> None:
    _, preview = mask_preview_artifact
    original = preview.output_path.read_bytes()
    try:
        preview.output_path.write_bytes(original + b"tamper")
        with pytest.raises(MaskPreviewError, match="output file"):
            verify_mask_preview(preview.manifest_path)
    finally:
        preview.output_path.write_bytes(original)


def test_manifest_tamper_fails(mask_preview_artifact) -> None:
    _, preview = mask_preview_artifact
    original = preview.manifest_path.read_bytes()
    try:
        payload = json.loads(original)
        payload["output"]["bytes"] += 1
        preview.manifest_path.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        with pytest.raises(MaskPreviewError, match="manifest digest"):
            verify_mask_preview(preview.manifest_path)
    finally:
        preview.manifest_path.write_bytes(original)
