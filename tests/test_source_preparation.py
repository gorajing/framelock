from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image
import pytest

from framelock_media.artifacts import load_rgb_png, sha256_file
from framelock_media.cli import main
from framelock_media.fixtures import create_framelock_hero_fixture
from framelock_media.offline_proof import OfflineProofError, prepare_canonical_source


def test_prepares_an_owned_source_without_awarding_the_generation_claim(
    tmp_path: Path,
) -> None:
    fixture = create_framelock_hero_fixture(tmp_path / "fixture")
    output = tmp_path / "prepared-source"

    result = prepare_canonical_source(
        fixture.source_mp4,
        fixture.foreground_mask,
        output,
    )

    summary = json.loads(result.summary_path.read_text(encoding="utf-8"))
    manifest = json.loads(result.proof_manifest_path.read_text(encoding="utf-8"))
    assert summary["schema_version"] == 2
    assert summary["state"] == "validated"
    assert summary["claim"] is None
    assert summary["next_step"] == "generation"
    assert summary["source"]["sha256"] == sha256_file(result.source_mp4)
    assert summary["foreground_mask"]["sha256"] == sha256_file(
        result.prepared_foreground_mask
    )
    assert summary["proof_manifest"]["sha256"] == sha256_file(
        result.proof_manifest_path
    )
    assert manifest["schema_version"] == 1
    assert manifest["generation_binding"] is None
    assert summary["source_audio"]["present"] is False
    assert summary["source_audio"]["claim_scope"] == (
        "outside_pixel_verification_claim"
    )
    assert summary["source_audio"]["manifest_sha256"] == sha256_file(
        result.source_audio_manifest_path
    )
    assert result.source_audio.source_audio_present is False
    assert result.source_audio_manifest_path.is_file()
    assert result.normalized_source_audio_path is None
    assert len(result.source_paths) == 121
    assert len(result.core_mask_paths) == 121
    assert len(result.edit_mask_paths) == 121
    assert result.source_mp4.parent == output / "inputs"
    assert result.prepared_foreground_mask.parent == output / "inputs"
    assert Path(manifest["frames"][0]["source_path"]).is_relative_to(output)
    assert Path(manifest["frames"][0]["composite_path"]).is_relative_to(output)
    assert Path(manifest["frames"][0]["source_path"]) != Path(
        manifest["frames"][0]["composite_path"]
    )
    assert np.array_equal(
        load_rgb_png(Path(manifest["frames"][60]["source_path"])),
        load_rgb_png(Path(manifest["frames"][60]["composite_path"])),
    )


def test_source_preparation_removes_partial_output_after_invalid_media(
    tmp_path: Path,
) -> None:
    fixture = create_framelock_hero_fixture(tmp_path / "fixture")
    invalid_source = tmp_path / "invalid.mp4"
    invalid_source.write_bytes(b"not an mp4")
    output = tmp_path / "rejected-source"

    with pytest.raises(Exception, match="media command failed"):
        prepare_canonical_source(
            invalid_source,
            fixture.foreground_mask,
            output,
        )

    assert not output.exists()


def test_source_preparation_removes_partial_output_after_invalid_mask(
    tmp_path: Path,
) -> None:
    fixture = create_framelock_hero_fixture(tmp_path / "fixture")
    invalid_mask = tmp_path / "invalid-mask.png"
    Image.fromarray(
        np.full((720, 1280), 255, dtype=np.uint8),
        mode="L",
    ).save(invalid_mask)
    output = tmp_path / "rejected-mask"

    with pytest.raises(Exception, match="no editable exterior"):
        prepare_canonical_source(
            fixture.source_mp4,
            invalid_mask,
            output,
        )

    assert not output.exists()


def test_source_preparation_rejects_an_animated_png_mask(tmp_path: Path) -> None:
    fixture = create_framelock_hero_fixture(tmp_path / "fixture")
    animated_mask = tmp_path / "animated-mask.png"
    with Image.open(fixture.foreground_mask) as source_mask:
        first = source_mask.copy()
    second = Image.fromarray(
        np.flipud(np.asarray(first, dtype=np.uint8)),
        mode="L",
    )
    first.save(
        animated_mask,
        format="PNG",
        save_all=True,
        append_images=[second],
        duration=100,
        loop=0,
    )
    output = tmp_path / "rejected-animated-mask"

    with pytest.raises(OfflineProofError, match="single-frame static PNG"):
        prepare_canonical_source(
            fixture.source_mp4,
            animated_mask,
            output,
        )

    assert not output.exists()


def test_prepare_source_cli_reports_only_pre_generation_evidence(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    fixture = create_framelock_hero_fixture(tmp_path / "fixture")
    output = tmp_path / "prepared-source-cli"

    assert main(
        [
            "prepare-source",
            "--source",
            str(fixture.source_mp4),
            "--foreground-mask",
            str(fixture.foreground_mask),
            "--output",
            str(output),
        ]
    ) == 0

    payload = json.loads(capsys.readouterr().out)
    assert payload["state"] == "validated"
    assert payload["claim"] is None
    assert payload["next_step"] == "generation"
    assert payload["source_sha256"] == sha256_file(output / "inputs/source.mp4")
    assert payload["foreground_mask_sha256"] == sha256_file(
        output / "inputs/foreground.png"
    )
    assert Path(payload["proof_manifest"]).is_file()
