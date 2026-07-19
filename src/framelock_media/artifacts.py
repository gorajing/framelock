from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np
from numpy.typing import NDArray
from PIL import Image


class ArtifactExistsError(FileExistsError):
    """Raised when immutable output would be overwritten."""


class ArtifactFormatError(ValueError):
    """Raised when a persisted artifact is not canonical."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _prepare_new_path(path: Path) -> None:
    if path.exists():
        raise ArtifactExistsError(f"artifact already exists: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)


def _require_rgb24(array: np.ndarray, *, name: str) -> NDArray[np.uint8]:
    if array.dtype != np.uint8 or array.ndim != 3 or array.shape[2] != 3:
        raise ArtifactFormatError(f"{name} must be an HxWx3 uint8 RGB array")
    return np.ascontiguousarray(array)


def _require_binary_mask(array: np.ndarray, *, name: str) -> NDArray[np.uint8]:
    if array.dtype != np.uint8 or array.ndim != 2:
        raise ArtifactFormatError(f"{name} must be a single-channel uint8 array")
    unique = np.unique(array)
    if not np.all(np.isin(unique, np.array([0, 255], dtype=np.uint8))):
        raise ArtifactFormatError(f"{name} values must be inside {{0,255}}")
    return np.ascontiguousarray(array)


def save_rgb_png(path: Path, rgb: np.ndarray) -> None:
    canonical = _require_rgb24(rgb, name="RGB artifact")
    _prepare_new_path(path)
    Image.fromarray(canonical, mode="RGB").save(path, format="PNG")


def load_rgb_png(path: Path) -> NDArray[np.uint8]:
    with Image.open(path) as image:
        if image.format != "PNG" or image.mode != "RGB":
            raise ArtifactFormatError(f"RGB artifact must be an RGB PNG: {path}")
        # Pillow can expose a read-only view. Return owned bytes so callers can
        # construct corruption fixtures without mutating Pillow's backing store.
        array = np.array(image, dtype=np.uint8, copy=True)
    return _require_rgb24(array, name="RGB artifact")


def save_core_mask_png(path: Path, core: np.ndarray) -> None:
    if core.dtype != np.bool_ or core.ndim != 2:
        raise ArtifactFormatError("core mask must be a 2D boolean array")
    encoded = np.where(core, 255, 0).astype(np.uint8)
    _prepare_new_path(path)
    Image.fromarray(encoded, mode="L").save(path, format="PNG")


def save_edit_mask_png(path: Path, edit_mask: np.ndarray) -> None:
    encoded = _require_binary_mask(edit_mask, name="edit mask")
    _prepare_new_path(path)
    Image.fromarray(encoded, mode="L").save(path, format="PNG")


def bgr24_to_rgb24(bgr: np.ndarray) -> NDArray[np.uint8]:
    canonical_bgr = _require_rgb24(bgr, name="BGR input")
    return np.ascontiguousarray(canonical_bgr[..., ::-1])
