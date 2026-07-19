import hashlib
from dataclasses import replace
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from framelock_media.artifacts import (
    bgr24_to_rgb24,
    load_rgb_png,
    save_core_mask_png,
    save_rgb_png,
    sha256_file,
)
from framelock_media.composite import CompositeInputError, compose_frame
from framelock_media.contract import DecodeProvenance
from framelock_media.masks import derive_masks
from framelock_media.verify import (
    ArtifactIntegrityError,
    EmptyProtectedCoreError,
    SequenceBindingError,
    calculate_projected_ingest_digest,
    calculate_proof_manifest_digest,
    finalize_proof_manifest,
    freeze_ingest_manifest,
    hash_core_rgb_bytes,
    verify_persisted_frame,
    verify_persisted_sequence,
    write_audit_json,
)


def freeze_fixture_proof_manifest(
    source_paths: list[Path],
    core_mask_paths: list[Path],
    composite_paths: list[Path],
):
    first = load_rgb_png(source_paths[0])
    ingest = freeze_ingest_manifest(
        source_paths,
        core_mask_paths,
        expected_width=first.shape[1],
        expected_height=first.shape[0],
        expected_frame_count=len(source_paths),
    )
    return finalize_proof_manifest(ingest, composite_paths)


def synthetic_frames() -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    height, width = 5, 6
    source = np.zeros((height, width, 3), dtype=np.uint8)
    source[..., 0] = np.arange(width, dtype=np.uint8)
    source[..., 1] = np.arange(height, dtype=np.uint8)[:, None]
    source[..., 2] = 255

    generated = np.full((height, width, 3), [220, 30, 10], dtype=np.uint8)
    core = np.zeros((height, width), dtype=np.bool_)
    core[2, 2:4] = True

    alpha = np.zeros((height, width), dtype=np.float32)
    alpha[1:4, 1:5] = np.float32(0.5)
    alpha[core] = np.float32(1.0)
    return source, generated, core, alpha


def persist_fixture(
    root: Path,
) -> tuple[Path, Path, Path, np.ndarray, np.ndarray]:
    source, generated, core, alpha = synthetic_frames()
    composite = compose_frame(source, generated, core, alpha)
    source_path = root / "source-000000.png"
    mask_path = root / "core-000000.png"
    composite_path = root / "composite-000000.png"
    save_rgb_png(source_path, source)
    save_core_mask_png(mask_path, core)
    save_rgb_png(composite_path, composite)
    return source_path, mask_path, composite_path, source, core


def persist_generation_bound_fixture(tmp_path: Path):
    source = np.full((20, 20, 3), [210, 180, 90], dtype=np.uint8)
    generated = np.full((20, 20, 3), [12, 80, 210], dtype=np.uint8)
    foreground = np.zeros((20, 20), dtype=np.uint8)
    foreground[3:17, 3:17] = np.uint8(255)
    masks = derive_masks(foreground)
    composite = compose_frame(
        source, generated, masks.core, masks.protect_alpha
    )
    source_path = tmp_path / "source.png"
    generated_path = tmp_path / "generated.png"
    core_path = tmp_path / "core.png"
    foreground_path = tmp_path / "foreground.png"
    composite_path = tmp_path / "composite.png"
    media_path = tmp_path / "generated-media.mp4"
    save_rgb_png(source_path, source)
    save_rgb_png(generated_path, generated)
    save_core_mask_png(core_path, masks.core)
    Image.fromarray(foreground, mode="L").save(foreground_path, format="PNG")
    save_rgb_png(composite_path, composite)
    media_path.write_bytes(b"fixture generated media")
    provenance = DecodeProvenance(
        source_media_path=str(media_path.resolve()),
        source_file_sha256=sha256_file(media_path),
        source_container="mp4",
        source_codec="h264",
        source_pixel_format="yuv420p",
        source_color_range=None,
        source_color_space=None,
        source_color_transfer=None,
        source_color_primaries=None,
        source_chroma_location="left",
        ffmpeg_executable="/test/ffmpeg",
        ffmpeg_version="ffmpeg test",
        ffprobe_executable="/test/ffprobe",
        ffprobe_version="ffprobe test",
        probe_argv=("ffprobe", "generated-media.mp4"),
        probe_json_sha256="11" * 32,
        decode_argv=("ffmpeg", "generated-media.mp4"),
        canonical_color_conversion=(
            "BT.709 limited-range YUV to full-range RGB24"
        ),
        width=20,
        height=20,
        decoded_frame_count=1,
        frame_rate_numerator=24,
        frame_rate_denominator=1,
        time_base_numerator=1,
        time_base_denominator=24,
        max_pts_residual_microseconds=0,
        presentation_timestamps_sha256="22" * 32,
        color_conversion_basis="explicit_bt709_limited_fallback",
        color_conversion_assumption="Explicit test fallback assumption.",
    )
    ingest = freeze_ingest_manifest(
        [source_path],
        [core_path],
        expected_width=20,
        expected_height=20,
        expected_frame_count=1,
    )
    manifest = finalize_proof_manifest(
        ingest,
        [composite_path],
        generated_paths=[generated_path],
        prepared_foreground_mask=foreground_path,
        generated_media_provenance=provenance,
    )
    return manifest, source_path, generated_path, core_path, composite_path


def test_compositor_blends_only_boundary_in_linear_light_then_overwrites_core() -> None:
    source = np.full((3, 3, 3), 255, dtype=np.uint8)
    generated = np.zeros((3, 3, 3), dtype=np.uint8)
    core = np.zeros((3, 3), dtype=np.bool_)
    core[1, 1] = True
    alpha = np.zeros((3, 3), dtype=np.float32)
    alpha[0, 1] = np.float32(0.5)
    alpha[1, 1] = np.float32(1.0)

    output = compose_frame(source, generated, core, alpha)

    np.testing.assert_array_equal(output[1, 1], source[1, 1])
    np.testing.assert_array_equal(output[2, 2], generated[2, 2])
    # A 50/50 linear-light blend under the BT.709 transfer encodes to 180, not 128.
    np.testing.assert_array_equal(output[0, 1], [180, 180, 180])


def test_compositor_rejects_alpha_that_does_not_fully_cover_core() -> None:
    source, generated, core, alpha = synthetic_frames()
    alpha[core] = np.float32(0.75)

    with pytest.raises(CompositeInputError, match="core alpha"):
        compose_frame(source, generated, core, alpha)


def test_compositor_rejects_non_finite_alpha() -> None:
    source, generated, core, alpha = synthetic_frames()
    alpha[0, 0] = np.float32(np.nan)

    with pytest.raises(CompositeInputError, match="finite"):
        compose_frame(source, generated, core, alpha)


def test_rgb_png_writer_is_lossless(tmp_path: Path) -> None:
    source, _, _, _ = synthetic_frames()
    path = tmp_path / "source.png"

    save_rgb_png(path, source)

    np.testing.assert_array_equal(load_rgb_png(path), source)


def test_opencv_style_bgr_input_is_explicitly_converted_to_canonical_rgb() -> None:
    bgr = np.array([[[17, 83, 241], [9, 54, 201]]], dtype=np.uint8)

    rgb = bgr24_to_rgb24(bgr)

    np.testing.assert_array_equal(rgb, [[[241, 83, 17], [201, 54, 9]]])
    assert rgb.flags.c_contiguous


def test_core_hash_is_canonical_row_major_rgb_bytes() -> None:
    frame = np.array(
        [
            [[1, 2, 3], [4, 5, 6]],
            [[7, 8, 9], [10, 11, 12]],
        ],
        dtype=np.uint8,
    )
    core = np.array([[True, False], [False, True]], dtype=np.bool_)
    expected_bytes = bytes([1, 2, 3, 10, 11, 12])

    assert hash_core_rgb_bytes(frame, core) == hashlib.sha256(
        expected_bytes
    ).hexdigest()


def test_independent_verifier_reopens_persisted_artifacts_and_passes(
    tmp_path: Path,
) -> None:
    source_path, mask_path, composite_path, _, _ = persist_fixture(tmp_path)
    manifest = freeze_fixture_proof_manifest(
        [source_path], [mask_path], [composite_path]
    )

    audit = verify_persisted_frame(manifest.frames[0])

    assert audit.passed is True
    assert audit.core_passed is True
    assert audit.artifact_integrity_passed is True
    assert audit.changed_core_pixels == 0
    assert audit.changed_core_channel_samples == 0
    assert audit.maximum_absolute_channel_delta == 0
    assert audit.source_core_sha256 == audit.output_core_sha256


def test_generation_bound_verifier_recomputes_the_persisted_composite(
    tmp_path: Path,
) -> None:
    manifest, source, _, core, composite = persist_generation_bound_fixture(
        tmp_path
    )

    audit = verify_persisted_sequence(
        manifest,
        source_paths=[source],
        core_mask_paths=[core],
        composite_paths=[composite],
    )

    assert audit.deterministic_composition_checked is True
    assert audit.deterministic_composition_passed is True
    assert audit.frame_audits[0].generated_artifact_integrity_passed is True
    assert audit.frame_audits[0].deterministic_composition_passed is True


def test_generated_frame_tamper_fails_integrity_and_deterministic_composition(
    tmp_path: Path,
) -> None:
    manifest, source, generated, core, composite = (
        persist_generation_bound_fixture(tmp_path)
    )
    changed = load_rgb_png(generated)
    changed[0, 0, 0] ^= np.uint8(1)
    Image.fromarray(changed, mode="RGB").save(generated, format="PNG")

    audit = verify_persisted_sequence(
        manifest,
        source_paths=[source],
        core_mask_paths=[core],
        composite_paths=[composite],
    )

    assert audit.artifact_integrity_passed is False
    assert audit.deterministic_composition_passed is False
    assert audit.frame_audits[0].generated_artifact_integrity_passed is False


def test_rehashed_but_non_deterministic_exterior_composite_cannot_pass(
    tmp_path: Path,
) -> None:
    manifest, source, _, core, composite = persist_generation_bound_fixture(
        tmp_path
    )
    changed = load_rgb_png(composite)
    changed[0, 0, 1] ^= np.uint8(1)
    Image.fromarray(changed, mode="RGB").save(composite, format="PNG")
    forged_frame = replace(
        manifest.frames[0], composite_file_sha256=sha256_file(composite)
    )
    forged = replace(manifest, frames=(forged_frame,), digest_sha256="")
    forged = replace(
        forged, digest_sha256=calculate_proof_manifest_digest(forged)
    )

    audit = verify_persisted_sequence(
        forged,
        source_paths=[source],
        core_mask_paths=[core],
        composite_paths=[composite],
    )

    assert audit.core_passed is True
    assert audit.artifact_integrity_passed is True
    assert audit.deterministic_composition_passed is False
    assert audit.passed is False


def test_one_channel_one_pixel_persisted_core_corruption_fails(
    tmp_path: Path,
) -> None:
    source_path, mask_path, composite_path, _, core = persist_fixture(tmp_path)
    manifest = freeze_fixture_proof_manifest(
        [source_path], [mask_path], [composite_path]
    )
    corrupted = load_rgb_png(composite_path)
    y, x = np.argwhere(core)[0]
    corrupted[y, x, 1] ^= np.uint8(1)
    Image.fromarray(corrupted, mode="RGB").save(composite_path, format="PNG")

    audit = verify_persisted_frame(manifest.frames[0])

    assert audit.passed is False
    assert audit.core_passed is False
    assert audit.artifact_integrity_passed is False
    assert audit.changed_core_pixels == 1
    assert audit.changed_core_channel_samples == 1
    assert audit.maximum_absolute_channel_delta == 1
    assert audit.source_core_sha256 != audit.output_core_sha256


def test_core_delta_uses_signed_arithmetic_for_zero_to_255(tmp_path: Path) -> None:
    source = np.zeros((2, 2, 3), dtype=np.uint8)
    core = np.zeros((2, 2), dtype=np.bool_)
    core[0, 0] = True
    composite = source.copy()
    composite[0, 0, 0] = np.uint8(255)
    source_path = tmp_path / "source.png"
    mask_path = tmp_path / "core.png"
    composite_path = tmp_path / "composite.png"
    save_rgb_png(source_path, source)
    save_core_mask_png(mask_path, core)
    save_rgb_png(composite_path, composite)
    manifest = freeze_fixture_proof_manifest(
        [source_path], [mask_path], [composite_path]
    )

    audit = verify_persisted_frame(manifest.frames[0])

    assert audit.core_passed is False
    assert audit.changed_core_pixels == 1
    assert audit.changed_core_channel_samples == 1
    assert audit.maximum_absolute_channel_delta == 255


def test_changes_outside_core_do_not_fail_the_core_audit(tmp_path: Path) -> None:
    source_path, mask_path, composite_path, _, core = persist_fixture(tmp_path)
    modified = load_rgb_png(composite_path)
    y, x = np.argwhere(~core)[0]
    modified[y, x] ^= np.array([1, 2, 4], dtype=np.uint8)
    Image.fromarray(modified, mode="RGB").save(composite_path, format="PNG")
    manifest = freeze_fixture_proof_manifest(
        [source_path], [mask_path], [composite_path]
    )

    audit = verify_persisted_frame(manifest.frames[0])

    assert audit.passed is True
    assert audit.core_passed is True
    assert audit.artifact_integrity_passed is True
    assert audit.changed_core_pixels == 0


def test_post_finalization_change_outside_core_fails_only_artifact_integrity(
    tmp_path: Path,
) -> None:
    source_path, mask_path, composite_path, _, core = persist_fixture(tmp_path)
    manifest = freeze_fixture_proof_manifest(
        [source_path], [mask_path], [composite_path]
    )
    modified = load_rgb_png(composite_path)
    y, x = np.argwhere(~core)[0]
    modified[y, x, 2] ^= np.uint8(1)
    Image.fromarray(modified, mode="RGB").save(composite_path, format="PNG")

    audit = verify_persisted_frame(manifest.frames[0])

    assert audit.core_passed is True
    assert audit.artifact_integrity_passed is False
    assert audit.passed is False


def test_empty_persisted_core_fails_instead_of_vacuously_passing(
    tmp_path: Path,
) -> None:
    source = np.zeros((2, 2, 3), dtype=np.uint8)
    source_path = tmp_path / "source.png"
    mask_path = tmp_path / "mask.png"
    output_path = tmp_path / "output.png"
    save_rgb_png(source_path, source)
    save_core_mask_png(mask_path, np.zeros((2, 2), dtype=np.bool_))
    save_rgb_png(output_path, source)
    manifest = freeze_fixture_proof_manifest(
        [source_path], [mask_path], [output_path]
    )

    with pytest.raises(EmptyProtectedCoreError, match="empty"):
        verify_persisted_frame(manifest.frames[0])


def test_source_and_mask_hashes_are_frozen_before_audit(tmp_path: Path) -> None:
    source_path, mask_path, composite_path, source, core = persist_fixture(tmp_path)
    manifest = freeze_fixture_proof_manifest(
        [source_path], [mask_path], [composite_path]
    )

    # A compromised pipeline changes both files identically; equality alone would pass.
    y, x = np.argwhere(core)[0]
    source[y, x, 0] ^= np.uint8(1)
    composite = load_rgb_png(composite_path)
    composite[y, x, 0] = source[y, x, 0]
    Image.fromarray(source, mode="RGB").save(source_path, format="PNG")
    Image.fromarray(composite, mode="RGB").save(composite_path, format="PNG")

    with pytest.raises(ArtifactIntegrityError, match="source hash"):
        verify_persisted_frame(manifest.frames[0])


def test_ingest_trust_anchors_are_frozen_before_composition(tmp_path: Path) -> None:
    source_path, mask_path, composite_path, source, core = persist_fixture(tmp_path)
    ingest = freeze_ingest_manifest(
        [source_path],
        [mask_path],
        expected_width=source.shape[1],
        expected_height=source.shape[0],
        expected_frame_count=1,
    )

    # Simulate compromise between ingest and proof finalization. A manifest
    # frozen only after composition could incorrectly bless both new values.
    y, x = np.argwhere(core)[0]
    source[y, x, 0] ^= np.uint8(1)
    composite = load_rgb_png(composite_path)
    composite[y, x, 0] = source[y, x, 0]
    Image.fromarray(source, mode="RGB").save(source_path, format="PNG")
    Image.fromarray(composite, mode="RGB").save(composite_path, format="PNG")

    with pytest.raises(ArtifactIntegrityError, match="source hash"):
        finalize_proof_manifest(ingest, [composite_path])


def test_verifier_rejects_tampered_manifest_digest(tmp_path: Path) -> None:
    source_path, mask_path, composite_path, _, _ = persist_fixture(tmp_path)
    manifest = freeze_fixture_proof_manifest(
        [source_path], [mask_path], [composite_path]
    )
    tampered = replace(manifest, digest_sha256="0" * 64)

    with pytest.raises(ArtifactIntegrityError, match="proof manifest digest"):
        verify_persisted_sequence(
            tampered,
            source_paths=[source_path],
            core_mask_paths=[mask_path],
            composite_paths=[composite_path],
        )


def test_forged_ingest_root_fails_even_with_recomputed_proof_digest(
    tmp_path: Path,
) -> None:
    source_path, mask_path, composite_path, _, _ = persist_fixture(tmp_path)
    manifest = freeze_fixture_proof_manifest(
        [source_path], [mask_path], [composite_path]
    )
    forged = replace(manifest, ingest_digest_sha256="f" * 64)
    forged = replace(
        forged, digest_sha256=calculate_proof_manifest_digest(forged)
    )

    with pytest.raises(ArtifactIntegrityError, match="ingest manifest digest"):
        verify_persisted_sequence(
            forged,
            source_paths=[source_path],
            core_mask_paths=[mask_path],
            composite_paths=[composite_path],
        )


def test_mask_hash_is_frozen_before_composition(tmp_path: Path) -> None:
    source_path, mask_path, composite_path, source, core = persist_fixture(tmp_path)
    ingest = freeze_ingest_manifest(
        [source_path],
        [mask_path],
        expected_width=source.shape[1],
        expected_height=source.shape[0],
        expected_frame_count=1,
    )
    mutated_core = core.copy()
    y, x = np.argwhere(mutated_core)[0]
    mutated_core[y, x] = False
    Image.fromarray(
        np.where(mutated_core, 255, 0).astype(np.uint8), mode="L"
    ).save(mask_path, format="PNG")

    with pytest.raises(ArtifactIntegrityError, match="core mask hash"):
        finalize_proof_manifest(ingest, [composite_path])


def test_source_artifact_cannot_alias_composite_artifact(tmp_path: Path) -> None:
    source_path, mask_path, _, source, _ = persist_fixture(tmp_path)
    ingest = freeze_ingest_manifest(
        [source_path],
        [mask_path],
        expected_width=source.shape[1],
        expected_height=source.shape[0],
        expected_frame_count=1,
    )

    with pytest.raises(SequenceBindingError, match="distinct"):
        finalize_proof_manifest(ingest, [source_path])


def test_canonical_verdict_reopens_every_artifact_at_declared_geometry(
    tmp_path: Path,
) -> None:
    sources: list[Path] = []
    masks: list[Path] = []
    composites: list[Path] = []
    pixel = np.array([[[1, 17, 251]]], dtype=np.uint8)
    core = np.array([[True]], dtype=np.bool_)
    for index in range(121):
        source_path = tmp_path / f"source-{index:06d}.png"
        mask_path = tmp_path / f"core-{index:06d}.png"
        composite_path = tmp_path / f"composite-{index:06d}.png"
        save_rgb_png(source_path, pixel)
        save_core_mask_png(mask_path, core)
        save_rgb_png(composite_path, pixel)
        sources.append(source_path)
        masks.append(mask_path)
        composites.append(composite_path)
    ingest = freeze_ingest_manifest(
        sources,
        masks,
        expected_width=1,
        expected_height=1,
        expected_frame_count=121,
    )
    proof = finalize_proof_manifest(ingest, composites)

    # Recompute both digests after lying about geometry. Digest consistency is
    # not evidence that reopened pixels satisfy the declared contract.
    forged = replace(proof, expected_width=1280, expected_height=720)
    forged = replace(
        forged,
        ingest_digest_sha256=calculate_projected_ingest_digest(forged),
    )
    forged = replace(
        forged, digest_sha256=calculate_proof_manifest_digest(forged)
    )

    with pytest.raises(SequenceBindingError, match="geometry"):
        verify_persisted_sequence(
            forged,
            source_paths=sources,
            core_mask_paths=masks,
            composite_paths=composites,
        )


def test_audit_writer_recomputes_before_emitting_green_claim(tmp_path: Path) -> None:
    source_path, mask_path, composite_path, _, _ = persist_fixture(tmp_path)
    manifest = freeze_fixture_proof_manifest(
        [source_path], [mask_path], [composite_path]
    )
    summary = verify_persisted_sequence(
        manifest,
        source_paths=[source_path],
        core_mask_paths=[mask_path],
        composite_paths=[composite_path],
    )
    forged_summary = replace(summary, passed=True)

    with pytest.raises(ArtifactIntegrityError, match="recomputed"):
        write_audit_json(tmp_path / "forged-audit.json", forged_summary, manifest)


def test_sequence_audit_and_json_are_derived_from_persisted_artifacts(
    tmp_path: Path,
) -> None:
    frame_root = tmp_path / "frames"
    frame_root.mkdir()
    source_path, mask_path, composite_path, _, _ = persist_fixture(frame_root)
    manifest = freeze_fixture_proof_manifest(
        [source_path], [mask_path], [composite_path]
    )

    summary = verify_persisted_sequence(
        manifest,
        source_paths=[source_path],
        core_mask_paths=[mask_path],
        composite_paths=[composite_path],
    )
    audit_path = tmp_path / "audit.json"
    write_audit_json(audit_path, summary, manifest)

    assert summary.passed is False
    assert summary.canonical_contract_passed is False
    assert summary.core_passed is True
    assert summary.frames_audited == 1
    assert summary.frames_with_nonempty_core == 1
    assert summary.total_changed_core_pixels == 0
    assert summary.artifact_integrity_passed is True
    assert manifest.mask_parameters.foreground_threshold == 128
    assert manifest.mask_parameters.erosion_radius == 4
    assert len(manifest.digest_sha256) == 64
    audit_payload = json.loads(audit_path.read_text(encoding="utf-8"))
    assert audit_payload["claim"] is None
    assert audit_payload["manifest"]["digest_sha256"] == manifest.digest_sha256
    assert audit_payload["audit"]["core_passed"] is True
    assert audit_path.read_text(encoding="utf-8").endswith("\n")


@pytest.mark.parametrize("mutation", ["missing", "extra", "swap"])
def test_sequence_verifier_rejects_path_count_or_order_drift(
    tmp_path: Path, mutation: str
) -> None:
    first_root = tmp_path / "first"
    second_root = tmp_path / "second"
    first_root.mkdir()
    second_root.mkdir()
    first = persist_fixture(first_root)[:3]
    second = persist_fixture(second_root)[:3]
    sources = [first[0], second[0]]
    masks = [first[1], second[1]]
    composites = [first[2], second[2]]
    manifest = freeze_fixture_proof_manifest(sources, masks, composites)

    if mutation == "missing":
        sources = sources[:1]
    elif mutation == "extra":
        masks = [*masks, masks[-1]]
    else:
        composites = list(reversed(composites))

    with pytest.raises(SequenceBindingError, match="manifest"):
        verify_persisted_sequence(
            manifest,
            source_paths=sources,
            core_mask_paths=masks,
            composite_paths=composites,
        )
