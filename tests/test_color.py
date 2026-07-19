import numpy as np

from framelock_media.color import (
    bt709_nonlinear_to_linear,
    linear_to_bt709_nonlinear,
    quantize_full_range_u8,
)


def test_bt709_inverse_transfer_uses_the_declared_threshold_branches() -> None:
    encoded = np.array([0.080_999, 0.081], dtype=np.float32)

    linear = bt709_nonlinear_to_linear(encoded)

    assert linear.dtype == np.float32
    np.testing.assert_allclose(linear[0], encoded[0] / 4.5, rtol=0, atol=1e-7)
    np.testing.assert_allclose(
        linear[1], ((encoded[1] + 0.099) / 1.099) ** (1 / 0.45), rtol=0, atol=1e-7
    )


def test_bt709_forward_transfer_uses_the_declared_threshold_branches() -> None:
    linear = np.array([0.017_999, 0.018], dtype=np.float32)

    encoded = linear_to_bt709_nonlinear(linear)

    assert encoded.dtype == np.float32
    np.testing.assert_allclose(encoded[0], 4.5 * linear[0], rtol=0, atol=1e-7)
    np.testing.assert_allclose(
        encoded[1], 1.099 * linear[1] ** 0.45 - 0.099, rtol=0, atol=1e-7
    )


def test_full_range_quantization_is_clip_then_nonnegative_half_up() -> None:
    values = np.array([-1.0, 0.0, 0.5 / 255, 1.5 / 255, 1.0, 2.0])

    quantized = quantize_full_range_u8(values)

    np.testing.assert_array_equal(quantized, [0, 0, 1, 2, 255, 255])
