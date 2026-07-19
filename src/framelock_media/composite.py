from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

from .color import (
    bt709_nonlinear_to_linear,
    linear_to_bt709_nonlinear,
    quantize_full_range_u8,
)


class CompositeInputError(ValueError):
    """Raised when frame, mask or alpha inputs violate the compositor contract."""


def _require_rgb24(frame: np.ndarray, *, name: str) -> NDArray[np.uint8]:
    if frame.dtype != np.uint8 or frame.ndim != 3 or frame.shape[2] != 3:
        raise CompositeInputError(f"{name} must be an HxWx3 uint8 RGB array")
    return np.ascontiguousarray(frame)


def compose_frame(
    source_rgb: np.ndarray,
    generated_rgb: np.ndarray,
    protect_core: np.ndarray,
    protect_alpha: np.ndarray,
) -> NDArray[np.uint8]:
    source = _require_rgb24(source_rgb, name="source frame")
    generated = _require_rgb24(generated_rgb, name="generated frame")
    if source.shape != generated.shape:
        raise CompositeInputError("source and generated frame shapes must match")
    if protect_core.dtype != np.bool_ or protect_core.ndim != 2:
        raise CompositeInputError("protect core must be a 2D boolean array")
    if protect_alpha.dtype != np.float32 or protect_alpha.ndim != 2:
        raise CompositeInputError("protect alpha must be a 2D float32 array")
    if protect_core.shape != source.shape[:2] or protect_alpha.shape != source.shape[:2]:
        raise CompositeInputError("mask and alpha geometry must match the frames")
    if not np.any(protect_core):
        raise CompositeInputError("protected core must be nonempty")
    if not np.all(np.isfinite(protect_alpha)) or np.any(
        (protect_alpha < 0.0) | (protect_alpha > 1.0)
    ):
        raise CompositeInputError("protect alpha must contain finite values inside [0,1]")
    if not np.all(protect_alpha[protect_core] == np.float32(1.0)):
        raise CompositeInputError("core alpha must equal one")

    source_linear = bt709_nonlinear_to_linear(source.astype(np.float32) / 255.0)
    generated_linear = bt709_nonlinear_to_linear(
        generated.astype(np.float32) / 255.0
    )
    alpha = protect_alpha[..., None]
    blended_linear = alpha * source_linear + (np.float32(1.0) - alpha) * generated_linear
    output = quantize_full_range_u8(linear_to_bt709_nonlinear(blended_linear))
    output[protect_core] = source[protect_core]
    return np.ascontiguousarray(output)
