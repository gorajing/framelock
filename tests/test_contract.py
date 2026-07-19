from fractions import Fraction

import pytest

from framelock_media.contract import (
    CANONICAL_CONTRACT,
    ContractViolation,
    MediaFacts,
    validate_media_facts,
)


def canonical_facts(**overrides: object) -> MediaFacts:
    values: dict[str, object] = {
        "container": "mp4",
        "width": 1280,
        "height": 720,
        "frame_count": 121,
        "frame_rate": Fraction(24, 1),
        "presentation_timestamps": tuple(index / 24 for index in range(121)),
        "file_size_bytes": 1_000_000,
        "rotation_degrees": 0,
    }
    values.update(overrides)
    return MediaFacts(**values)  # type: ignore[arg-type]


def test_canonical_contract_is_frozen_to_the_p0_media_envelope() -> None:
    assert CANONICAL_CONTRACT.width == 1280
    assert CANONICAL_CONTRACT.height == 720
    assert CANONICAL_CONTRACT.frame_count == 121
    assert CANONICAL_CONTRACT.frame_rate == Fraction(24, 1)
    assert CANONICAL_CONTRACT.max_pts_residual_seconds == pytest.approx(0.001)
    assert CANONICAL_CONTRACT.duration_seconds == pytest.approx(121 / 24)


def test_exact_canonical_media_facts_pass() -> None:
    result = validate_media_facts(canonical_facts())

    assert result.max_pts_residual_seconds == pytest.approx(0.0)


@pytest.mark.parametrize(
    ("override", "expected_message"),
    [
        ({"container": "mov"}, "container"),
        ({"width": 1279}, "dimensions"),
        ({"height": 721}, "dimensions"),
        ({"frame_count": 120}, "frame count"),
        ({"frame_rate": Fraction(30000, 1001)}, "frame rate"),
        ({"file_size_bytes": 50 * 1024 * 1024 + 1}, "file size"),
        ({"rotation_degrees": 90}, "rotation"),
    ],
)
def test_noncanonical_media_facts_fail_loudly(
    override: dict[str, object], expected_message: str
) -> None:
    with pytest.raises(ContractViolation, match=expected_message):
        validate_media_facts(canonical_facts(**override))


def test_timestamp_residual_over_one_millisecond_fails() -> None:
    timestamps = list(canonical_facts().presentation_timestamps)
    timestamps[60] += 0.001_001

    with pytest.raises(ContractViolation, match="residual"):
        validate_media_facts(
            canonical_facts(presentation_timestamps=tuple(timestamps))
        )


def test_non_increasing_timestamps_fail_even_with_a_canonical_rate() -> None:
    timestamps = list(canonical_facts().presentation_timestamps)
    timestamps[60] = timestamps[59]

    with pytest.raises(ContractViolation, match="strictly increasing"):
        validate_media_facts(
            canonical_facts(presentation_timestamps=tuple(timestamps))
        )


def test_missing_sample_aspect_ratio_is_not_accepted_for_canonical_source() -> None:
    with pytest.raises(ContractViolation, match="sample aspect ratio"):
        validate_media_facts(canonical_facts(sample_aspect_ratio=None))
