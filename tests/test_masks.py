from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from framelock_media.artifacts import (
    ArtifactExistsError,
    save_core_mask_png,
    save_edit_mask_png,
)
from framelock_media.masks import (
    CORE_EROSION_RADIUS,
    FOREGROUND_THRESHOLD,
    EmptyCoreError,
    MaskDomainError,
    NoEditableExteriorError,
    derive_masks,
    erode_to_core,
    load_edit_mask,
    load_core_mask,
    ltx_edit_mask_from_protection,
    validate_ltx_edit_mask_round_trip,
)


def test_persisted_core_mask_converts_only_255_to_true(tmp_path: Path) -> None:
    encoded = np.array([[0, 255], [255, 0]], dtype=np.uint8)
    path = tmp_path / "core.png"
    Image.fromarray(encoded, mode="L").save(path, format="PNG")

    core = load_core_mask(path)

    assert core.dtype == np.bool_
    np.testing.assert_array_equal(core, [[False, True], [True, False]])


def test_persisted_core_mask_rejects_values_outside_zero_and_255(
    tmp_path: Path,
) -> None:
    path = tmp_path / "invalid-core.png"
    Image.fromarray(np.array([[0, 1, 255]], dtype=np.uint8), mode="L").save(
        path, format="PNG"
    )

    with pytest.raises(MaskDomainError, match=r"\{0,255\}"):
        load_core_mask(path)


def test_persisted_core_mask_rejects_animated_png(tmp_path: Path) -> None:
    path = tmp_path / "animated-core.png"
    first = Image.fromarray(
        np.array([[0, 255], [255, 0]], dtype=np.uint8),
        mode="L",
    )
    second = Image.fromarray(
        np.array([[255, 0], [0, 255]], dtype=np.uint8),
        mode="L",
    )
    first.save(
        path,
        format="PNG",
        save_all=True,
        append_images=[second],
        duration=100,
        loop=0,
    )

    with pytest.raises(MaskDomainError, match="single-frame static"):
        load_core_mask(path)


def test_near_white_mask_value_is_corruption_not_protected_membership(
    tmp_path: Path,
) -> None:
    path = tmp_path / "corrupted-core.png"
    Image.fromarray(np.array([[0, 254, 255]], dtype=np.uint8), mode="L").save(
        path, format="PNG"
    )

    with pytest.raises(MaskDomainError, match=r"\{0,255\}"):
        load_core_mask(path)


def test_ltx_edit_mask_has_white_regenerate_black_preserve_polarity() -> None:
    protect = np.array([[False, True], [True, False]], dtype=np.bool_)

    edit = ltx_edit_mask_from_protection(protect)

    assert edit.dtype == np.uint8
    np.testing.assert_array_equal(edit, [[255, 0], [0, 255]])


def test_mask_derivation_freezes_threshold_erosion_edge_alpha_and_edit_semantics() -> None:
    grayscale = np.zeros((25, 25), dtype=np.uint8)
    grayscale[3:22, 3:22] = 127
    grayscale[4:21, 4:21] = 128

    masks = derive_masks(grayscale)

    assert FOREGROUND_THRESHOLD == 128
    assert CORE_EROSION_RADIUS == 4
    np.testing.assert_array_equal(masks.foreground, grayscale >= 128)
    np.testing.assert_array_equal(masks.edge, masks.foreground & ~masks.core)
    np.testing.assert_array_equal(
        masks.edit_mask, np.where(masks.foreground, 0, 255).astype(np.uint8)
    )
    assert np.all(masks.protect_alpha[~masks.foreground] == 0.0)
    assert np.all(masks.protect_alpha[masks.core] == 1.0)
    assert np.all((masks.protect_alpha[masks.edge] >= 0.0))
    assert np.all((masks.protect_alpha[masks.edge] <= 1.0))
    assert np.all(~masks.core | masks.foreground)


def test_all_black_and_thin_foregrounds_fail_the_nonempty_eroded_core_gate() -> None:
    for grayscale in (
        np.zeros((25, 25), dtype=np.uint8),
        np.pad(np.full((3, 3), 255, dtype=np.uint8), 11),
    ):
        with pytest.raises(EmptyCoreError, match="empty"):
            derive_masks(grayscale)


def test_all_white_foreground_fails_the_editable_exterior_gate() -> None:
    with pytest.raises(NoEditableExteriorError, match="exterior"):
        derive_masks(np.full((25, 25), 255, dtype=np.uint8))


def test_encoded_ltx_edit_mask_round_trip_preserves_declared_polarity(
    tmp_path: Path,
) -> None:
    protect = np.array([[False, True], [True, False]], dtype=np.bool_)
    path = tmp_path / "ltx-edit.png"
    save_edit_mask_png(path, ltx_edit_mask_from_protection(protect))

    decoded = load_edit_mask(path)

    validate_ltx_edit_mask_round_trip(decoded, protect)
    np.testing.assert_array_equal(decoded, [[255, 0], [0, 255]])


def test_round_trip_validator_rejects_inverted_ltx_polarity() -> None:
    protect = np.array([[False, True], [True, False]], dtype=np.bool_)
    inverted = np.where(protect, 255, 0).astype(np.uint8)

    with pytest.raises(MaskDomainError, match="polarity"):
        validate_ltx_edit_mask_round_trip(inverted, protect)


def test_erosion_never_expands_and_produces_a_nonempty_core() -> None:
    foreground = np.zeros((7, 7), dtype=np.bool_)
    foreground[1:6, 1:6] = True

    core = erode_to_core(foreground, radius=1)

    assert np.all(~core | foreground)
    assert np.count_nonzero(core) == 9


def test_empty_eroded_core_fails_loudly() -> None:
    foreground = np.zeros((3, 3), dtype=np.bool_)
    foreground[1, 1] = True

    with pytest.raises(EmptyCoreError, match="empty"):
        erode_to_core(foreground, radius=1)


def test_lossless_core_mask_writer_round_trips_and_refuses_overwrite(
    tmp_path: Path,
) -> None:
    core = np.array([[False, True], [True, False]], dtype=np.bool_)
    path = tmp_path / "core.png"

    save_core_mask_png(path, core)
    np.testing.assert_array_equal(load_core_mask(path), core)

    with pytest.raises(ArtifactExistsError, match="already exists"):
        save_core_mask_png(path, core)
