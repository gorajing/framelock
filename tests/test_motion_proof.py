from __future__ import annotations

from dataclasses import asdict, replace
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from framelock_media.artifacts import (
    load_rgb_png,
    save_core_mask_png,
    save_rgb_png,
)
from framelock_media.masks import load_core_mask
from framelock_media.motion_proof import (
    MotionProofResult,
    _calculate_motion_input_digest,
    _run_motion_proof,
    verify_motion_proof,
)
from framelock_media.verify import (
    ArtifactIntegrityError,
    SequenceBindingError,
    finalize_proof_manifest,
    freeze_ingest_manifest,
)


FRAME_COUNT = 121
FIXTURE_WIDTH = 32
FIXTURE_HEIGHT = 24


def _moving_shape_inputs(
    root: Path,
) -> tuple[tuple[Path, ...], tuple[Path, ...], tuple[Path, ...]]:
    source_root = root / "source"
    generated_root = root / "generated"
    foreground_root = root / "foreground"
    source_root.mkdir(parents=True)
    generated_root.mkdir()
    foreground_root.mkdir()

    yy, xx = np.indices((FIXTURE_HEIGHT, FIXTURE_WIDTH), dtype=np.uint16)
    sources: list[Path] = []
    generated: list[Path] = []
    foregrounds: list[Path] = []
    for index in range(FRAME_COUNT):
        source = np.empty((FIXTURE_HEIGHT, FIXTURE_WIDTH, 3), dtype=np.uint8)
        source[..., 0] = ((xx * 7 + index) % 256).astype(np.uint8)
        source[..., 1] = ((yy * 11 + index * 3) % 256).astype(np.uint8)
        source[..., 2] = np.uint8((37 + index * 5) % 256)
        replacement = np.bitwise_xor(
            source,
            np.array([0xD3, 0x7A, 0x35], dtype=np.uint8),
        )

        foreground = np.zeros((FIXTURE_HEIGHT, FIXTURE_WIDTH), dtype=np.uint8)
        left = 2 + index % 17
        foreground[6:18, left : left + 12] = np.uint8(255)

        source_path = source_root / f"source_{index:06d}.png"
        generated_path = generated_root / f"generated_{index:06d}.png"
        foreground_path = foreground_root / f"foreground_{index:06d}.png"
        save_rgb_png(source_path, source)
        save_rgb_png(generated_path, replacement)
        Image.fromarray(foreground, mode="L").save(
            foreground_path,
            format="PNG",
        )
        sources.append(source_path)
        generated.append(generated_path)
        foregrounds.append(foreground_path)
    return tuple(sources), tuple(generated), tuple(foregrounds)


def _run_fixture(tmp_path: Path) -> MotionProofResult:
    source_paths, generated_paths, foreground_mask_paths = _moving_shape_inputs(
        tmp_path / "inputs"
    )
    return _run_motion_proof(
        source_paths=source_paths,
        generated_paths=generated_paths,
        foreground_mask_paths=foreground_mask_paths,
        motion_root=tmp_path / "motion",
        output_directory=tmp_path / "motion" / "proof",
        expected_width=FIXTURE_WIDTH,
        expected_height=FIXTURE_HEIGHT,
        expected_frame_count=FRAME_COUNT,
        source_media_provenance=None,
        require_canonical_claim=False,
    )


def test_121_frame_moving_shape_uses_the_mask_for_each_frame(
    tmp_path: Path,
) -> None:
    result = _run_fixture(tmp_path)

    assert len(result.composite_paths) == FRAME_COUNT
    assert result.audit.core_passed is True
    assert result.audit.artifact_integrity_passed is True
    assert result.audit.deterministic_composition_checked is True
    assert result.audit.deterministic_composition_passed is True
    assert result.audit.frames_with_nonempty_core == FRAME_COUNT
    assert result.audit.canonical_contract_passed is False
    assert len(result.motion_input_manifest.source_sequence_digest_sha256) == 64
    assert result.motion_input_manifest.source_ingest_digest_sha256 == (
        result.manifest.ingest_digest_sha256
    )

    first_core = load_core_mask(result.core_mask_paths[0])
    middle_core = load_core_mask(result.core_mask_paths[60])
    assert not np.array_equal(first_core, middle_core)
    for index in (0, 60, 120):
        source = load_rgb_png(result.source_paths[index])
        generated = load_rgb_png(result.generated_paths[index])
        composite = load_rgb_png(result.composite_paths[index])
        core = load_core_mask(result.core_mask_paths[index])
        np.testing.assert_array_equal(composite[core], source[core])
        np.testing.assert_array_equal(composite[0, 0], generated[0, 0])


def test_one_channel_one_pixel_motion_core_corruption_fails(
    tmp_path: Path,
) -> None:
    result = _run_fixture(tmp_path)
    frame_index = 73
    composite_path = result.composite_paths[frame_index]
    composite = load_rgb_png(composite_path)
    core = load_core_mask(result.core_mask_paths[frame_index])
    y, x = np.argwhere(core)[0]
    composite[y, x, 1] ^= np.uint8(1)
    Image.fromarray(composite, mode="RGB").save(composite_path, format="PNG")

    audit = verify_motion_proof(result)

    assert audit.passed is False
    assert audit.core_passed is False
    assert audit.artifact_integrity_passed is False
    assert audit.deterministic_composition_passed is False
    assert audit.total_changed_core_pixels == 1
    assert audit.total_changed_core_channel_samples == 1
    assert audit.worst_maximum_absolute_channel_delta == 1


def test_motion_proof_rejects_a_mask_frame_swap(tmp_path: Path) -> None:
    result = _run_fixture(tmp_path)
    swapped = list(result.foreground_mask_paths)
    swapped[41], swapped[42] = swapped[42], swapped[41]

    with pytest.raises(SequenceBindingError, match="foreground mask sequence"):
        verify_motion_proof(result, foreground_mask_paths=swapped)


def test_motion_proof_cross_binds_temporal_and_pixel_verifier_cores(
    tmp_path: Path,
) -> None:
    result = _run_fixture(tmp_path)
    unrelated_root = tmp_path / "unrelated-cores"
    unrelated_root.mkdir()
    unrelated_core_paths: list[Path] = []
    for index in range(FRAME_COUNT):
        original_core = load_core_mask(result.core_mask_paths[index])
        core = np.zeros((FIXTURE_HEIGHT, FIXTURE_WIDTH), dtype=np.bool_)
        y, x = np.argwhere(original_core)[0]
        core[y, x] = True
        path = unrelated_root / f"core_{index:06d}.png"
        save_core_mask_png(path, core)
        unrelated_core_paths.append(path)

    weaker_ingest = freeze_ingest_manifest(
        result.source_paths,
        unrelated_core_paths,
        expected_width=FIXTURE_WIDTH,
        expected_height=FIXTURE_HEIGHT,
        expected_frame_count=FRAME_COUNT,
    )
    weaker_manifest = finalize_proof_manifest(
        weaker_ingest,
        result.composite_paths,
    )
    split_brain_result = replace(
        result,
        core_mask_paths=tuple(unrelated_core_paths),
        manifest=weaker_manifest,
    )

    with pytest.raises(SequenceBindingError, match="core mask sequence"):
        verify_motion_proof(split_brain_result)


def test_motion_proof_reopens_persisted_temporal_manifest(
    tmp_path: Path,
) -> None:
    result = _run_fixture(tmp_path)
    payload = json.loads(
        result.motion_input_manifest_path.read_text(encoding="utf-8")
    )
    payload["digest_sha256"] = "0" * 64
    result.motion_input_manifest_path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    with pytest.raises(
        ArtifactIntegrityError,
        match="motion input manifest digest",
    ):
        verify_motion_proof(result)


def test_motion_proof_rejects_output_outside_dedicated_motion_root(
    tmp_path: Path,
) -> None:
    source_paths, generated_paths, foreground_mask_paths = _moving_shape_inputs(
        tmp_path / "inputs"
    )
    static_output = tmp_path / "static-artifacts" / "proof"

    with pytest.raises(SequenceBindingError, match="dedicated motion root"):
        _run_motion_proof(
            source_paths=source_paths,
            generated_paths=generated_paths,
            foreground_mask_paths=foreground_mask_paths,
            motion_root=tmp_path / "motion-artifacts",
            output_directory=static_output,
            expected_width=FIXTURE_WIDTH,
            expected_height=FIXTURE_HEIGHT,
            expected_frame_count=FRAME_COUNT,
            source_media_provenance=None,
            require_canonical_claim=False,
        )

    assert static_output.exists() is False


@pytest.mark.parametrize(
    ("field", "message"),
    [
        ("source_sequence_digest_sha256", "ordered source sequence"),
        ("source_ingest_digest_sha256", "source decode provenance"),
    ],
)
def test_motion_proof_cross_binds_source_frames_and_decode_provenance(
    tmp_path: Path,
    field: str,
    message: str,
) -> None:
    result = _run_fixture(tmp_path)
    forged_inputs = replace(
        result.motion_input_manifest,
        digest_sha256="",
        **{field: "f" * 64},
    )
    forged_inputs = replace(
        forged_inputs,
        digest_sha256=_calculate_motion_input_digest(forged_inputs),
    )
    result.motion_input_manifest_path.write_text(
        json.dumps(asdict(forged_inputs), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    forged_result = replace(result, motion_input_manifest=forged_inputs)

    with pytest.raises(SequenceBindingError, match=message):
        verify_motion_proof(forged_result)
