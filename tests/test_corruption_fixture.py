from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np

from framelock_media.artifacts import (
    save_core_mask_png,
    save_rgb_png,
    sha256_file,
)
from framelock_media.corruption_fixture import (
    create_deliberate_corruption_fixture,
    create_deliberate_corruption_fixture_from_manifest,
)
from framelock_media.verify import (
    finalize_proof_manifest,
    freeze_ingest_manifest,
    write_proof_manifest_json,
)


def test_deliberate_corruption_uses_a_copy_and_persists_real_failed_audit(
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "source.png"
    core_path = tmp_path / "core.png"
    composite_path = tmp_path / "composite.png"
    source = np.array(
        [
            [[12, 34, 56], [20, 40, 60]],
            [[80, 100, 120], [140, 160, 180]],
        ],
        dtype=np.uint8,
    )
    core = np.array([[True, False], [False, False]], dtype=np.bool_)
    save_rgb_png(source_path, source)
    save_core_mask_png(core_path, core)
    save_rgb_png(composite_path, source.copy())
    ingest = freeze_ingest_manifest(
        (source_path,),
        (core_path,),
        expected_width=2,
        expected_height=2,
        expected_frame_count=1,
    )
    manifest = finalize_proof_manifest(ingest, (composite_path,))
    original_sha256 = sha256_file(composite_path)

    result = create_deliberate_corruption_fixture(
        manifest=manifest,
        source_paths=(source_path,),
        core_mask_paths=(core_path,),
        composite_paths=(composite_path,),
        output_directory=tmp_path / "corruption-fixture",
        frame_index=0,
    )

    assert sha256_file(composite_path) == original_sha256
    assert result.audit.passed is False
    assert result.audit.core_passed is False
    assert result.audit.artifact_integrity_passed is False
    assert result.audit.total_changed_core_pixels == 1
    assert result.audit.total_changed_core_channel_samples == 1
    assert result.audit.worst_maximum_absolute_channel_delta == 1
    assert result.audit.core_hash_match_count == 0
    assert result.corrupted_frame_path != composite_path
    assert result.corrupted_frame_path.is_file()

    audit_payload = json.loads(result.audit_path.read_text(encoding="utf-8"))
    assert audit_payload["claim"] is None
    summary = json.loads(result.summary_path.read_text(encoding="utf-8"))
    expected_corrupted = source.copy()
    expected_corrupted[0, 0, 1] ^= np.uint8(1)
    corrupted_rgb_sha256 = hashlib.sha256(
        np.ascontiguousarray(expected_corrupted).tobytes(order="C")
    ).hexdigest()
    assert summary == {
        "audit_path": str(result.audit_path.resolve()),
        "audit_sha256": sha256_file(result.audit_path),
        "canonical_artifacts_mutated": False,
        "changed_core_channel_samples": 1,
        "changed_core_pixels": 1,
        "corrupted_channel": 1,
        "corrupted_frame_index": 0,
        "corrupted_frame_file_sha256": sha256_file(
            result.corrupted_frame_path
        ),
        "corrupted_frame_output_core_sha256": (
            result.audit.frame_audits[0].output_core_sha256
        ),
        "corrupted_frame_path": str(result.corrupted_frame_path.resolve()),
        "corrupted_frame_rgb_sha256": corrupted_rgb_sha256,
        "fixture": "one_channel_one_pixel_protected_core_corruption",
        "manifest_path": str(result.manifest_path.resolve()),
        "manifest_sha256": sha256_file(result.manifest_path),
        "passed": False,
        "schema_version": 2,
        "worst_maximum_absolute_channel_delta": 1,
    }

    proof_manifest_path = tmp_path / "proof_manifest.json"
    write_proof_manifest_json(proof_manifest_path, manifest)
    reloaded = create_deliberate_corruption_fixture_from_manifest(
        proof_manifest_path=proof_manifest_path,
        output_directory=tmp_path / "reloaded-corruption-fixture",
        frame_index=0,
    )
    assert reloaded.audit.total_changed_core_channel_samples == 1
    assert reloaded.audit_path.is_file()
