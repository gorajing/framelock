from __future__ import annotations

import numpy as np
from numpy.typing import NDArray


FloatArray = NDArray[np.float32]
ByteArray = NDArray[np.uint8]


def _finite_float32(values: np.ndarray, *, name: str) -> FloatArray:
    converted = np.asarray(values, dtype=np.float32)
    if not np.all(np.isfinite(converted)):
        raise ValueError(f"{name} must contain only finite values")
    return converted


def bt709_nonlinear_to_linear(values: np.ndarray) -> FloatArray:
    encoded = _finite_float32(values, name="BT.709 encoded samples")
    if np.any((encoded < 0.0) | (encoded > 1.0)):
        raise ValueError("BT.709 encoded samples must be inside [0,1]")
    result = np.where(
        encoded < np.float32(0.081),
        encoded / np.float32(4.5),
        ((encoded + np.float32(0.099)) / np.float32(1.099))
        ** np.float32(1.0 / 0.45),
    )
    return np.asarray(result, dtype=np.float32)


def linear_to_bt709_nonlinear(values: np.ndarray) -> FloatArray:
    linear = _finite_float32(values, name="linear-light samples")
    if np.any((linear < 0.0) | (linear > 1.0)):
        raise ValueError("linear-light samples must be inside [0,1]")
    result = np.where(
        linear < np.float32(0.018),
        np.float32(4.5) * linear,
        np.float32(1.099) * linear ** np.float32(0.45) - np.float32(0.099),
    )
    return np.asarray(result, dtype=np.float32)


def quantize_full_range_u8(values: np.ndarray) -> ByteArray:
    finite = _finite_float32(values, name="samples to quantize")
    clipped = np.clip(finite, 0.0, 1.0)
    quantized = np.floor(clipped * np.float32(255.0) + np.float32(0.5))
    return np.asarray(quantized, dtype=np.uint8)
