from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from numpy.typing import NDArray
from PIL import Image


FOREGROUND_THRESHOLD = 128
CORE_EROSION_RADIUS = 4


class MaskDomainError(ValueError):
    """Raised when a mask is not in its declared domain."""


class EmptyCoreError(ValueError):
    """Raised when erosion produces no protected pixels."""


class NoEditableExteriorError(ValueError):
    """Raised when the generator would have no pixels to regenerate."""


@dataclass(frozen=True)
class DerivedMasks:
    foreground: NDArray[np.bool_]
    core: NDArray[np.bool_]
    edge: NDArray[np.bool_]
    protect_alpha: NDArray[np.float32]
    edit_mask: NDArray[np.uint8]


def _require_bool_mask(mask: np.ndarray, *, name: str) -> NDArray[np.bool_]:
    if mask.dtype != np.bool_ or mask.ndim != 2:
        raise MaskDomainError(f"{name} must be a two-dimensional boolean array")
    return np.ascontiguousarray(mask)


def _load_binary_l_png(path: Path, *, role: str) -> NDArray[np.uint8]:
    with Image.open(path) as image:
        if image.format != "PNG" or image.mode != "L":
            raise MaskDomainError(f"{role} must be a single-channel grayscale PNG")
        if bool(getattr(image, "is_animated", False)) or image.n_frames != 1:
            raise MaskDomainError(
                f"{role} must be a single-frame static grayscale PNG"
            )
        encoded = np.asarray(image, dtype=np.uint8)
    if encoded.ndim != 2 or encoded.dtype != np.uint8:
        raise MaskDomainError(f"{role} must decode to a two-dimensional uint8 array")
    unique = np.unique(encoded)
    if not np.all(np.isin(unique, np.array([0, 255], dtype=np.uint8))):
        raise MaskDomainError(f"{role} values must be inside {{0,255}}")
    return np.ascontiguousarray(encoded)


def load_core_mask(path: Path) -> NDArray[np.bool_]:
    return _load_binary_l_png(path, role="core mask") == np.uint8(255)


def load_edit_mask(path: Path) -> NDArray[np.uint8]:
    return _load_binary_l_png(path, role="edit mask")


def ltx_edit_mask_from_protection(protect: np.ndarray) -> NDArray[np.uint8]:
    declared = _require_bool_mask(protect, name="protection mask")
    return np.where(declared, 0, 255).astype(np.uint8)


def validate_ltx_edit_mask_round_trip(
    decoded_edit_mask: np.ndarray, protect: np.ndarray
) -> None:
    expected = ltx_edit_mask_from_protection(protect)
    if decoded_edit_mask.dtype != np.uint8 or decoded_edit_mask.ndim != 2:
        raise MaskDomainError("round-trip edit mask must be a 2D uint8 array")
    unique = np.unique(decoded_edit_mask)
    if not np.all(np.isin(unique, np.array([0, 255], dtype=np.uint8))):
        raise MaskDomainError("round-trip edit mask values must be inside {0,255}")
    if decoded_edit_mask.shape != expected.shape or not np.array_equal(
        decoded_edit_mask, expected
    ):
        raise MaskDomainError("round-trip edit mask polarity does not match")


def erode_to_core(
    foreground: np.ndarray, *, radius: int = CORE_EROSION_RADIUS
) -> NDArray[np.bool_]:
    declared = _require_bool_mask(foreground, name="foreground mask")
    if radius < 0:
        raise MaskDomainError("erosion radius must be nonnegative")
    if radius == 0:
        core = declared.copy()
    else:
        diameter = radius * 2 + 1
        kernel = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (diameter, diameter)
        )
        eroded = cv2.erode(
            declared.astype(np.uint8),
            kernel,
            iterations=1,
            borderType=cv2.BORDER_CONSTANT,
            borderValue=0,
        )
        core = eroded == np.uint8(1)
    if not np.any(core):
        raise EmptyCoreError("eroded protected core is empty")
    return np.ascontiguousarray(core)


def derive_masks(grayscale: np.ndarray) -> DerivedMasks:
    if grayscale.dtype != np.uint8 or grayscale.ndim != 2:
        raise MaskDomainError("source grayscale mask must be a 2D uint8 array")
    foreground = np.ascontiguousarray(grayscale >= FOREGROUND_THRESHOLD)
    if np.all(foreground):
        raise NoEditableExteriorError("foreground leaves no editable exterior")
    core = erode_to_core(foreground)
    edge = np.ascontiguousarray(foreground & ~core)
    distance = cv2.distanceTransform(
        foreground.astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_5
    ).astype(np.float32)
    protect_alpha = np.zeros(foreground.shape, dtype=np.float32)
    protect_alpha[edge] = np.clip(
        distance[edge] / np.float32(CORE_EROSION_RADIUS), 0.0, 1.0
    )
    protect_alpha[core] = np.float32(1.0)
    edit_mask = np.where(foreground, 0, 255).astype(np.uint8)
    return DerivedMasks(
        foreground=foreground,
        core=core,
        edge=edge,
        protect_alpha=protect_alpha,
        edit_mask=edit_mask,
    )
