from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess

import numpy as np
import pytest

import framelock_media.cli as framelock_cli
import framelock_media.real_proof as real_proof
from framelock_media.artifacts import load_rgb_png, sha256_file
from framelock_media.cli import build_parser
from framelock_media.fixtures import create_framelock_hero_fixture
from framelock_media.finalization_transaction import (
    FINALIZATION_COMMIT_NAME,
    FINALIZATION_JOURNAL_NAME,
    FinalizationOutput,
    FinalizationTransaction,
    FinalizationTransactionError,
    finalization_lock,
    validate_committed_finalization,
)
from framelock_media.generation_gate import assess_generated_media
from framelock_media.generation_gate import calculate_generation_digest
from framelock_media.offline_proof import run_synthetic_canonical_proof
from framelock_media.real_proof import (
    RealProofError,
    VisualGeometryApproval,
    _source_ingest,
    finalize_real_generation_proof,
    prepare_real_generation_review,
)


def _with_audio(source: Path, output: Path, *, frequency: int) -> None:
    ffmpeg = shutil.which("ffmpeg")
    assert ffmpeg is not None
    subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source),
            "-f",
            "lavfi",
            "-i",
            (
                f"sine=frequency={frequency}:sample_rate=44100:"
                "duration=5.0416666667"
            ),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            "-map_metadata",
            "-1",
            str(output),
        ],
        check=True,
        capture_output=True,
        text=True,
    )


def _dominant_audio_frequency(path: Path) -> float:
    ffmpeg = shutil.which("ffmpeg")
    assert ffmpeg is not None
    completed = subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            "48000",
            "-f",
            "f32le",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    )
    samples = np.frombuffer(completed.stdout, dtype=np.float32)
    analysis = samples[4_800:38_400] * np.hanning(33_600)
    magnitudes = np.abs(np.fft.rfft(analysis))
    frequencies = np.fft.rfftfreq(len(analysis), 1 / 48_000)
    return float(frequencies[int(np.argmax(magnitudes))])


@pytest.fixture(scope="module")
def proof_inputs(
    tmp_path_factory: pytest.TempPathFactory,
) -> tuple[Path, Path, Path, Path]:
    root = tmp_path_factory.mktemp("real-proof-inputs")
    fixture = create_framelock_hero_fixture(root / "fixture")
    source_media = root / "source-with-700hz-audio.mp4"
    model_media = root / "model-with-1400hz-audio.mp4"
    _with_audio(fixture.source_mp4, source_media, frequency=700)
    _with_audio(fixture.source_mp4, model_media, frequency=1_400)
    offline = run_synthetic_canonical_proof(
        source_media,
        fixture.foreground_mask,
        root / "offline",
    )
    model_sha256 = sha256_file(model_media)
    mask_sha256 = sha256_file(fixture.foreground_mask)
    job_path = root / "job.json"
    generation = {
        "sourceSha256": offline.manifest.media_provenance.source_file_sha256,
        "editMaskSha256": mask_sha256,
        "prompt": "Transform the exterior",
        "endpoint": "fal-ai/example",
        "parameters": {"fixed": True},
    }
    generation_digest = calculate_generation_digest(generation)
    job_path.write_text(
        json.dumps(
            {
                "id": "synthetic-proof-model-001",
                "state": "generated",
                "createdAt": "2026-07-17T00:00:00.000Z",
                "updatedAt": "2026-07-17T00:01:00.000Z",
                "generation": {**generation, "digest": generation_digest},
                "fal": {
                    "generationDigest": generation_digest,
                    "endpoint": "fal-ai/example",
                    "requestId": "request-proof-001",
                    "modelOutput": {
                        "artifactId": f"sha256:{model_sha256}",
                        "sha256": model_sha256,
                        "url": "https://fal.media/private-result.mp4",
                        "contentType": "video/mp4",
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    assessment = assess_generated_media(
        model_media,
        root / "assessment",
        job_record_path=job_path,
        paid_attempt_index=1,
        paid_attempt_cap=3,
    )
    assert assessment.verdict == "comparable_pending_visual_approval"
    return (
        root / "offline",
        fixture.foreground_mask,
        job_path,
        assessment.assessment_path,
    )


def test_real_generation_proof_binds_job_assessment_composite_and_audit(
    proof_inputs: tuple[Path, Path, Path, Path],
    tmp_path: Path,
) -> None:
    source_proof, foreground, job_path, assessment_path = proof_inputs
    job = json.loads(job_path.read_text(encoding="utf-8"))
    generated_media = Path(
        json.loads(assessment_path.read_text(encoding="utf-8"))["model_output"][
            "path"
        ]
    )

    review_directory = tmp_path / "real-proof"
    prepared = prepare_real_generation_review(
        source_proof_directory=source_proof,
        prepared_foreground_mask=foreground,
        generated_media=generated_media,
        generation_assessment_path=assessment_path,
        job_record_path=job_path,
        output_directory=review_directory,
    )
    overlay_hashes_before_approval = tuple(
        sha256_file(path) for path in prepared.geometry_overlay_paths
    )
    review_manifest = json.loads(
        prepared.review_manifest_path.read_text(encoding="utf-8")
    )
    assert review_manifest["schema_version"] == 2
    assert review_manifest["source_audio"]["source_audio_present"] is True
    assert prepared.source_audio is not None
    assert prepared.source_audio.source_audio_present is True
    assert prepared.review_manifest_path.is_file()
    assert not (review_directory / "proof_manifest.json").exists()

    with pytest.raises(ValueError, match="overlay hashes"):
        finalize_real_generation_proof(
            prepared_review_directory=review_directory,
            visual_approval=VisualGeometryApproval(
                passed=True,
                reviewer="test-human-review",
                reviewed_source_indices=(0, 60, 120),
                reviewed_overlay_sha256s=("00" * 32,) * 3,
                review_manifest_sha256=prepared.review_manifest_sha256,
                note="Object position and scale match at all three review frames.",
            ),
        )
    assert not (review_directory / "proof_manifest.json").exists()

    result = finalize_real_generation_proof(
        prepared_review_directory=review_directory,
        visual_approval=VisualGeometryApproval(
            passed=True,
            reviewer="test-human-review",
            reviewed_source_indices=(0, 60, 120),
            reviewed_overlay_sha256s=overlay_hashes_before_approval,
            review_manifest_sha256=prepared.review_manifest_sha256,
            note="Object position and scale match at all three review frames.",
        ),
    )

    assert result.audit.passed is True
    assert result.audit.canonical_contract_passed is True
    assert result.audit.total_changed_core_channel_samples == 0
    assert result.audit.core_hash_match_count == 121
    assert result.proof_manifest_path.is_file()
    assert result.audit_path.is_file()
    assert result.preview_path.is_file()
    assert result.run_manifest_path.is_file()
    assert result.difference_heatmap_path.is_file()
    assert result.frame_archive.archive_path.is_file()
    assert result.frame_archive.manifest_path.is_file()
    assert result.frame_archive.frame_count == 121
    assert result.corruption_fixture.audit_path.is_file()
    assert result.corruption_fixture.manifest_path.is_file()
    assert result.corruption_fixture.summary_path.is_file()
    assert result.corruption_fixture.audit.passed is False
    assert (
        result.corruption_fixture.audit.total_changed_core_channel_samples
        == 1
    )
    assert result.corruption_fixture.audit.canonical_contract_passed is True
    assert len(result.generated_paths) == 121
    assert len(result.composite_paths) == 121
    assert len(result.geometry_overlay_paths) == 3
    assert all(path.is_file() for path in result.geometry_overlay_paths)
    assert tuple(sha256_file(path) for path in result.geometry_overlay_paths) == (
        overlay_hashes_before_approval
    )
    assert result.generated_decode_provenance.source_file_sha256 == (
        job["fal"]["modelOutput"]["sha256"]
    )

    run_manifest = json.loads(result.run_manifest_path.read_text(encoding="utf-8"))
    assert run_manifest["schema_version"] == 6
    assert run_manifest["claim"] == (
        "Protected core verified — canonical pre-encode frame sequence."
    )
    assert run_manifest["visual_geometry_approval"]["passed"] is True
    assert run_manifest["visual_geometry_approval"]["reviewed_source_indices"] == [
        0,
        60,
        120,
    ]
    assert run_manifest["job"]["request_id"] == "request-proof-001"
    assert run_manifest["job"]["generation_digest"] == job["generation"][
        "digest"
    ]
    assert run_manifest["visual_geometry_approval"][
        "review_manifest_sha256"
    ] == sha256_file(prepared.review_manifest_path)
    assert run_manifest["proof"]["deterministic_composition_checked"] is True
    assert run_manifest["proof"]["deterministic_composition_passed"] is True
    protected_core_path = source_proof / "masks" / "protected_core.png"
    boundary_ring_path = source_proof / "masks" / "feather_boundary.png"
    expected_delta = np.max(
        np.abs(
            load_rgb_png(result.source_paths[60]).astype(np.int16)
            - load_rgb_png(result.composite_paths[60]).astype(np.int16)
        ),
        axis=2,
    ).astype(np.uint8)
    expected_heatmap = np.zeros((*expected_delta.shape, 3), dtype=np.uint8)
    expected_heatmap[:, :, 0] = expected_delta
    expected_heatmap[:, :, 1] = expected_delta // 4
    assert np.array_equal(
        load_rgb_png(result.difference_heatmap_path),
        expected_heatmap,
    )
    assert run_manifest["visualizations"] == {
        "boundary_ring_frame_60": {
            "claim_scope": "visual_only_not_exactness_contract",
            "path": str(boundary_ring_path.resolve()),
            "sha256": sha256_file(boundary_ring_path),
        },
        "difference_heatmap_frame_60": {
            "claim_scope": "visual_only_not_verifier_output",
            "composite_file_sha256": sha256_file(result.composite_paths[60]),
            "path": str(result.difference_heatmap_path.resolve()),
            "sha256": sha256_file(result.difference_heatmap_path),
            "source_file_sha256": sha256_file(result.source_paths[60]),
        },
        "protected_core_frame_60": {
            "claim_scope": "exactness_contract_mask",
            "path": str(protected_core_path.resolve()),
            "sha256": sha256_file(protected_core_path),
        },
    }
    proof_payload = json.loads(result.proof_manifest_path.read_text(encoding="utf-8"))
    assert proof_payload["schema_version"] == 2
    assert proof_payload["ingest_schema_version"] == 1
    assert len(proof_payload["frames"]) == 121
    assert all(frame["generated_file_sha256"] for frame in proof_payload["frames"])
    assert proof_payload["generation_binding"]["generated_media_provenance"] == (
        run_manifest["generated_decode_provenance"]
    )
    assert run_manifest["proof"]["manifest_digest_sha256"] == (
        result.manifest.digest_sha256
    )
    assert run_manifest["preview"]["label"] == (
        "Preview derived from verified canonical frames"
    )
    assert run_manifest["audio"]["source_audio_present"] is True
    assert run_manifest["audio"]["claim_scope"] == (
        "outside_pixel_verification_claim"
    )
    assert run_manifest["audio"]["preview_audio_policy"] == (
        "normalized_source_pcm_delivery_encode"
    )
    assert run_manifest["exports"]["canonical_frames"] == {
        "archive_path": str(result.frame_archive.archive_path.resolve()),
        "archive_sha256": result.frame_archive.archive_sha256,
        "frame_count": 121,
        "label": "Proof-bound canonical pre-encode RGB24 PNG sequence",
        "manifest_path": str(result.frame_archive.manifest_path.resolve()),
        "manifest_sha256": result.frame_archive.manifest_sha256,
        "total_uncompressed_bytes": result.frame_archive.total_uncompressed_bytes,
    }
    assert run_manifest["negative_test"] == {
        "audit_path": str(result.corruption_fixture.audit_path.resolve()),
        "audit_sha256": sha256_file(result.corruption_fixture.audit_path),
        "canonical_artifacts_mutated": False,
        "changed_core_channel_samples": 1,
        "changed_core_pixels": 1,
        "channel": 1,
        "claim": None,
        "fixture": "one_channel_one_pixel_protected_core_corruption",
        "frame_index": 60,
        "manifest_path": str(result.corruption_fixture.manifest_path.resolve()),
        "manifest_sha256": sha256_file(result.corruption_fixture.manifest_path),
        "passed": False,
        "summary_path": str(result.corruption_fixture.summary_path.resolve()),
        "summary_sha256": sha256_file(result.corruption_fixture.summary_path),
        "verifier": "verify_persisted_sequence",
        "worst_maximum_absolute_channel_delta": 1,
    }
    assert _dominant_audio_frequency(result.preview_path) == pytest.approx(
        700,
        abs=3,
    )
    transaction_journal = review_directory / ".finalization-transaction.json"
    commit_marker = review_directory / ".finalization-committed.json"
    assert not transaction_journal.exists()
    assert commit_marker.is_file()
    commit_payload = json.loads(commit_marker.read_text(encoding="utf-8"))
    assert commit_payload["schema_version"] == 1
    assert commit_payload["review_manifest_sha256"] == (
        prepared.review_manifest_sha256
    )
    assert commit_payload["attempt_id"]
    assert {entry["path"] for entry in commit_payload["outputs"]} == {
        "audit.json",
        "canonical_frames.zip",
        "canonical_frames_manifest.json",
        "composite_frames",
        "corruption_fixture",
        "difference_heatmap_000060.png",
        "preview.mp4",
        "proof_manifest.json",
        "run_manifest.json",
    }


def test_legacy_schema_v1_source_proof_without_audio_sidecar_still_loads(
    proof_inputs: tuple[Path, Path, Path, Path],
) -> None:
    source_proof, _, _, _ = proof_inputs
    proof_payload = json.loads(
        (source_proof / "proof_manifest.json").read_text(encoding="utf-8")
    )
    assert proof_payload["schema_version"] == 1
    audio_manifest = source_proof / "source_audio.json"
    held_manifest = source_proof / "source_audio.held-for-legacy-test.json"
    audio_manifest.rename(held_manifest)
    try:
        ingest, source_paths, core_paths, _, source_audio = _source_ingest(
            source_proof
        )
    finally:
        held_manifest.rename(audio_manifest)

    assert ingest.schema_version == 1
    assert len(source_paths) == 121
    assert len(core_paths) == 121
    assert source_audio is None


def test_review_preparation_process_death_keeps_final_path_retryable(
    proof_inputs: tuple[Path, Path, Path, Path],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_proof, foreground, job_path, assessment_path = proof_inputs
    generated_media = Path(
        json.loads(assessment_path.read_text(encoding="utf-8"))["model_output"][
            "path"
        ]
    )
    review_directory = tmp_path / "canonical"
    original_write_immutable_json = real_proof._write_immutable_json

    def review_manifest_then_die(
        path: Path,
        payload: dict[str, object],
    ) -> None:
        original_write_immutable_json(path, payload)
        if path.name == real_proof.REVIEW_MANIFEST_NAME:
            raise _SimulatedProcessDeath(
                "simulated death before review publication"
            )

    monkeypatch.setattr(
        real_proof,
        "_write_immutable_json",
        review_manifest_then_die,
    )
    with pytest.raises(
        _SimulatedProcessDeath,
        match="before review publication",
    ):
        prepare_real_generation_review(
            source_proof_directory=source_proof,
            prepared_foreground_mask=foreground,
            generated_media=generated_media,
            generation_assessment_path=assessment_path,
            job_record_path=job_path,
            output_directory=review_directory,
        )

    assert not review_directory.exists()
    interrupted_staging = tuple(
        tmp_path.glob(".canonical.preparing-*")
    )
    assert len(interrupted_staging) == 1
    assert (interrupted_staging[0] / real_proof.REVIEW_MANIFEST_NAME).is_file()

    monkeypatch.undo()
    prepared = prepare_real_generation_review(
        source_proof_directory=source_proof,
        prepared_foreground_mask=foreground,
        generated_media=generated_media,
        generation_assessment_path=assessment_path,
        job_record_path=job_path,
        output_directory=review_directory,
    )

    assert prepared.review_manifest_path == (
        review_directory / real_proof.REVIEW_MANIFEST_NAME
    )
    assert prepared.review_manifest_path.is_file()
    assert len(prepared.generated_paths) == 121
    assert all(path.is_file() for path in prepared.generated_paths)
    assert all(review_directory in path.parents for path in prepared.generated_paths)
    assert all(
        review_directory in path.parents
        for path in prepared.geometry_overlay_paths
    )
    assert prepared.source_audio is not None
    review_payload = json.loads(
        prepared.review_manifest_path.read_text(encoding="utf-8")
    )
    assert all(
        review_directory in Path(frame["path"]).parents
        for frame in review_payload["generated_frames"]
    )

    foreign_directory = tmp_path / "foreign-canonical"
    foreign_directory.mkdir()
    foreign_file = foreign_directory / "do-not-overwrite.txt"
    foreign_file.write_text("foreign evidence\n", encoding="utf-8")
    with pytest.raises(FileExistsError, match="review directory exists"):
        prepare_real_generation_review(
            source_proof_directory=source_proof,
            prepared_foreground_mask=foreground,
            generated_media=generated_media,
            generation_assessment_path=assessment_path,
            job_record_path=job_path,
            output_directory=foreign_directory,
        )
    assert foreign_file.read_text(encoding="utf-8") == "foreign evidence\n"


class _SimulatedProcessDeath(BaseException):
    """Bypass ordinary exception cleanup like SIGKILL would."""


def test_committed_transaction_completes_journal_cleanup_fail_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "commit-cleanup"
    root.mkdir()
    proof_path = root / "proof.json"
    evidence_directory = root / "evidence"
    outputs = (
        FinalizationOutput(proof_path, "file"),
        FinalizationOutput(evidence_directory, "directory"),
    )
    review_sha256 = "ab" * 32
    with finalization_lock(root):
        transaction = FinalizationTransaction.begin(
            root=root,
            review_manifest_sha256=review_sha256,
            outputs=outputs,
        )
        proof_path.write_text('{"passed": true}\n', encoding="utf-8")
        evidence_directory.mkdir()
        (evidence_directory / "frame.png").write_bytes(b"frame evidence")

        original_unlink = Path.unlink

        def die_before_journal_unlink(
            path: Path,
            *args: object,
            **kwargs: object,
        ) -> None:
            if (
                path.name == FINALIZATION_JOURNAL_NAME
                and (root / FINALIZATION_COMMIT_NAME).is_file()
            ):
                raise _SimulatedProcessDeath(
                    "simulated death before journal cleanup"
                )
            original_unlink(path, *args, **kwargs)

        monkeypatch.setattr(Path, "unlink", die_before_journal_unlink)
        with pytest.raises(
            _SimulatedProcessDeath,
            match="before journal cleanup",
        ):
            transaction.commit()

    journal_path = root / FINALIZATION_JOURNAL_NAME
    commit_path = root / FINALIZATION_COMMIT_NAME
    assert journal_path.is_file()
    assert commit_path.is_file()
    assert proof_path.is_file()
    assert evidence_directory.is_dir()

    monkeypatch.undo()
    evidence = validate_committed_finalization(
        root=root,
        review_manifest_sha256=review_sha256,
        outputs=outputs,
    )

    assert not journal_path.exists()
    assert commit_path.is_file()
    assert evidence.marker_path == commit_path
    assert evidence.marker_sha256 == sha256_file(commit_path)
    assert evidence.review_manifest_sha256 == review_sha256
    assert evidence.stale_journal_reconciled is True
    assert {record["path"] for record in evidence.outputs} == {
        "proof.json",
        "evidence",
    }
    assert proof_path.read_text(encoding="utf-8") == '{"passed": true}\n'
    assert (evidence_directory / "frame.png").read_bytes() == b"frame evidence"
    with finalization_lock(root):
        with pytest.raises(
            FileExistsError,
            match="proof artifacts already exist",
        ):
            FinalizationTransaction.begin(
                root=root,
                review_manifest_sha256=review_sha256,
                outputs=outputs,
            )


def test_committed_transaction_validator_rejects_output_tampering(
    tmp_path: Path,
) -> None:
    root = tmp_path / "commit-tamper"
    root.mkdir()
    proof_path = root / "proof.json"
    evidence_directory = root / "evidence"
    outputs = (
        FinalizationOutput(proof_path, "file"),
        FinalizationOutput(evidence_directory, "directory"),
    )
    review_sha256 = "cd" * 32
    with finalization_lock(root):
        transaction = FinalizationTransaction.begin(
            root=root,
            review_manifest_sha256=review_sha256,
            outputs=outputs,
        )
        proof_path.write_text('{"passed": true}\n', encoding="utf-8")
        evidence_directory.mkdir()
        (evidence_directory / "frame.png").write_bytes(b"frame evidence")
        transaction.commit()

    proof_path.write_text('{"passed": false}\n', encoding="utf-8")
    with pytest.raises(
        FinalizationTransactionError,
        match="committed finalization output set is incomplete or differs",
    ):
        validate_committed_finalization(
            root=root,
            review_manifest_sha256=review_sha256,
            outputs=outputs,
        )

    assert (root / FINALIZATION_COMMIT_NAME).is_file()
    assert not (root / FINALIZATION_JOURNAL_NAME).exists()
    assert proof_path.read_text(encoding="utf-8") == '{"passed": false}\n'

    proof_path.write_text('{"passed": true}\n', encoding="utf-8")
    marker_path = root / FINALIZATION_COMMIT_NAME
    marker = json.loads(marker_path.read_text(encoding="utf-8"))
    marker["outputs"][0]["sha256"] = "00" * 32
    marker_path.write_text(json.dumps(marker), encoding="utf-8")
    with pytest.raises(
        FinalizationTransactionError,
        match="finalization commit marker is malformed",
    ):
        validate_committed_finalization(
            root=root,
            review_manifest_sha256=review_sha256,
            outputs=outputs,
        )


@pytest.mark.parametrize(
    "failure_point",
    (
        "after_composite",
        "after_archive_and_corruption",
        "after_run_manifest_before_commit",
    ),
)
def test_uncommitted_finalization_transaction_recovers_only_owned_outputs(
    proof_inputs: tuple[Path, Path, Path, Path],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure_point: str,
) -> None:
    source_proof, foreground, job_path, assessment_path = proof_inputs
    generated_media = Path(
        json.loads(assessment_path.read_text(encoding="utf-8"))["model_output"][
            "path"
        ]
    )
    review_directory = tmp_path / failure_point
    prepared = prepare_real_generation_review(
        source_proof_directory=source_proof,
        prepared_foreground_mask=foreground,
        generated_media=generated_media,
        generation_assessment_path=assessment_path,
        job_record_path=job_path,
        output_directory=review_directory,
    )
    approval = VisualGeometryApproval(
        passed=True,
        reviewer="crash-recovery-reviewer",
        reviewed_source_indices=(0, 60, 120),
        reviewed_overlay_sha256s=tuple(
            sha256_file(path) for path in prepared.geometry_overlay_paths
        ),
        review_manifest_sha256=prepared.review_manifest_sha256,
        note="Object position and scale match at all three review frames.",
    )
    foreign_path = review_directory / "foreign-preexisting-evidence.txt"
    foreign_path.write_text("retain exactly\n", encoding="utf-8")

    if failure_point == "after_composite":
        original_compose_sequence = real_proof._compose_sequence

        def compose_then_die(*args: object, **kwargs: object) -> object:
            original_compose_sequence(*args, **kwargs)
            raise _SimulatedProcessDeath("simulated death after composite")

        monkeypatch.setattr(
            real_proof,
            "_compose_sequence",
            compose_then_die,
        )
    elif failure_point == "after_archive_and_corruption":
        original_corruption_fixture = (
            real_proof.create_deliberate_corruption_fixture
        )

        def corrupt_then_die(*args: object, **kwargs: object) -> object:
            original_corruption_fixture(*args, **kwargs)
            raise _SimulatedProcessDeath(
                "simulated death after archive and corruption"
            )

        monkeypatch.setattr(
            real_proof,
            "create_deliberate_corruption_fixture",
            corrupt_then_die,
        )
    else:
        original_write_immutable_json = real_proof._write_immutable_json

        def run_manifest_then_die(
            path: Path,
            payload: dict[str, object],
        ) -> None:
            original_write_immutable_json(path, payload)
            if path.name == "run_manifest.json":
                raise _SimulatedProcessDeath(
                    "simulated death after run manifest before commit"
                )

        monkeypatch.setattr(
            real_proof,
            "_write_immutable_json",
            run_manifest_then_die,
        )

    with pytest.raises(_SimulatedProcessDeath, match="simulated death"):
        finalize_real_generation_proof(
            prepared_review_directory=review_directory,
            visual_approval=approval,
        )

    journal_path = review_directory / ".finalization-transaction.json"
    commit_path = review_directory / ".finalization-committed.json"
    assert journal_path.is_file()
    assert not commit_path.exists()
    journal = json.loads(journal_path.read_text(encoding="utf-8"))
    assert journal["schema_version"] == 1
    assert journal["attempt_id"]
    assert journal["review_manifest_sha256"] == prepared.review_manifest_sha256
    assert set(journal["owned_output_paths"]) == {
        "audit.json",
        "canonical_frames.zip",
        "canonical_frames_manifest.json",
        "composite_frames",
        "corruption_fixture",
        "difference_heatmap_000060.png",
        "preview.mp4",
        "proof_manifest.json",
        "run_manifest.json",
    }
    assert (review_directory / "composite_frames").is_dir()
    if failure_point != "after_composite":
        assert (review_directory / "canonical_frames.zip").is_file()
        assert (review_directory / "corruption_fixture").is_dir()
    if failure_point == "after_run_manifest_before_commit":
        assert (review_directory / "run_manifest.json").is_file()
    assert foreign_path.read_text(encoding="utf-8") == "retain exactly\n"
    finalization_outputs = (
        FinalizationOutput(
            review_directory / "composite_frames",
            "directory",
        ),
        FinalizationOutput(review_directory / "proof_manifest.json", "file"),
        FinalizationOutput(review_directory / "audit.json", "file"),
        FinalizationOutput(review_directory / "preview.mp4", "file"),
        FinalizationOutput(review_directory / "run_manifest.json", "file"),
        FinalizationOutput(review_directory / "canonical_frames.zip", "file"),
        FinalizationOutput(
            review_directory / "canonical_frames_manifest.json",
            "file",
        ),
        FinalizationOutput(
            review_directory / "difference_heatmap_000060.png",
            "file",
        ),
        FinalizationOutput(
            review_directory / "corruption_fixture",
            "directory",
        ),
    )
    with pytest.raises(
        FinalizationTransactionError,
        match="commit marker is missing",
    ):
        validate_committed_finalization(
            root=review_directory,
            review_manifest_sha256=prepared.review_manifest_sha256,
            outputs=finalization_outputs,
        )
    assert journal_path.is_file()

    monkeypatch.undo()
    result = finalize_real_generation_proof(
        prepared_review_directory=review_directory,
        visual_approval=approval,
    )

    assert result.audit.passed is True
    assert not journal_path.exists()
    assert commit_path.is_file()
    assert foreign_path.read_text(encoding="utf-8") == "retain exactly\n"
    assert result.frame_archive.archive_path.is_file()
    assert result.corruption_fixture.audit.passed is False
    assert result.source_audio is not None
    run_manifest = json.loads(
        result.run_manifest_path.read_text(encoding="utf-8")
    )
    assert run_manifest["audio"]["source_audio_present"] is True


def test_preexisting_finalization_output_is_never_claimed_or_removed(
    proof_inputs: tuple[Path, Path, Path, Path],
    tmp_path: Path,
) -> None:
    source_proof, foreground, job_path, assessment_path = proof_inputs
    generated_media = Path(
        json.loads(assessment_path.read_text(encoding="utf-8"))["model_output"][
            "path"
        ]
    )
    review_directory = tmp_path / "preexisting-output"
    prepared = prepare_real_generation_review(
        source_proof_directory=source_proof,
        prepared_foreground_mask=foreground,
        generated_media=generated_media,
        generation_assessment_path=assessment_path,
        job_record_path=job_path,
        output_directory=review_directory,
    )
    approval = VisualGeometryApproval(
        passed=True,
        reviewer="preexisting-output-reviewer",
        reviewed_source_indices=(0, 60, 120),
        reviewed_overlay_sha256s=tuple(
            sha256_file(path) for path in prepared.geometry_overlay_paths
        ),
        review_manifest_sha256=prepared.review_manifest_sha256,
        note="Object position and scale match at all three review frames.",
    )
    preexisting = review_directory / "preview.mp4"
    preexisting.write_bytes(b"foreign preview bytes")

    with pytest.raises(FileExistsError, match="proof artifacts already exist"):
        finalize_real_generation_proof(
            prepared_review_directory=review_directory,
            visual_approval=approval,
        )

    assert preexisting.read_bytes() == b"foreign preview bytes"
    assert not (review_directory / ".finalization-transaction.json").exists()
    assert not (review_directory / ".finalization-committed.json").exists()


def test_malformed_finalization_journal_fails_closed_without_cleanup(
    proof_inputs: tuple[Path, Path, Path, Path],
    tmp_path: Path,
) -> None:
    source_proof, foreground, job_path, assessment_path = proof_inputs
    generated_media = Path(
        json.loads(assessment_path.read_text(encoding="utf-8"))["model_output"][
            "path"
        ]
    )
    review_directory = tmp_path / "malformed-journal"
    prepared = prepare_real_generation_review(
        source_proof_directory=source_proof,
        prepared_foreground_mask=foreground,
        generated_media=generated_media,
        generation_assessment_path=assessment_path,
        job_record_path=job_path,
        output_directory=review_directory,
    )
    approval = VisualGeometryApproval(
        passed=True,
        reviewer="malformed-journal-reviewer",
        reviewed_source_indices=(0, 60, 120),
        reviewed_overlay_sha256s=tuple(
            sha256_file(path) for path in prepared.geometry_overlay_paths
        ),
        review_manifest_sha256=prepared.review_manifest_sha256,
        note="Object position and scale match at all three review frames.",
    )
    journal_path = review_directory / ".finalization-transaction.json"
    journal_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "attempt_id": "not-a-valid-attempt",
                "review_manifest_sha256": prepared.review_manifest_sha256,
                "owned_output_paths": ["../generated_frames"],
            }
        ),
        encoding="utf-8",
    )
    residue = review_directory / "proof_manifest.json"
    residue.write_bytes(b"must not be removed")

    with pytest.raises(RealProofError, match="transaction journal is malformed"):
        finalize_real_generation_proof(
            prepared_review_directory=review_directory,
            visual_approval=approval,
        )

    assert residue.read_bytes() == b"must not be removed"
    assert journal_path.is_file()


@pytest.mark.parametrize(
    "failure_point",
    ("mid_composition", "proof_manifest_producer"),
)
def test_failed_finalization_removes_only_new_artifacts_and_can_retry(
    proof_inputs: tuple[Path, Path, Path, Path],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure_point: str,
) -> None:
    source_proof, foreground, job_path, assessment_path = proof_inputs
    generated_media = Path(
        json.loads(assessment_path.read_text(encoding="utf-8"))["model_output"][
            "path"
        ]
    )
    review_directory = tmp_path / failure_point
    prepared = prepare_real_generation_review(
        source_proof_directory=source_proof,
        prepared_foreground_mask=foreground,
        generated_media=generated_media,
        generation_assessment_path=assessment_path,
        job_record_path=job_path,
        output_directory=review_directory,
    )
    approval = VisualGeometryApproval(
        passed=True,
        reviewer="failure-injection-reviewer",
        reviewed_source_indices=(0, 60, 120),
        reviewed_overlay_sha256s=tuple(
            sha256_file(path) for path in prepared.geometry_overlay_paths
        ),
        review_manifest_sha256=prepared.review_manifest_sha256,
        note="Object position and scale match at all three review frames.",
    )
    immutable_review_paths = (
        prepared.review_manifest_path,
        *prepared.generated_paths,
        *prepared.geometry_overlay_paths,
    )
    assert prepared.source_audio is not None
    assert prepared.source_audio.normalized_audio_path is not None
    review_payload = json.loads(
        prepared.review_manifest_path.read_text(encoding="utf-8")
    )
    immutable_review_paths += (
        Path(review_payload["source_audio"]["manifest_path"]),
        Path(prepared.source_audio.normalized_audio_path),
    )
    immutable_hashes_before = {
        path: sha256_file(path) for path in immutable_review_paths
    }

    if failure_point == "mid_composition":
        original_save_rgb_png = real_proof.save_rgb_png

        def save_then_fail(path: Path, frame: object) -> None:
            original_save_rgb_png(path, frame)
            if path.name == "composite_000003.png":
                raise RuntimeError("injected mid-composition failure")

        monkeypatch.setattr(real_proof, "save_rgb_png", save_then_fail)
    else:
        original_write_proof_manifest_json = real_proof.write_proof_manifest_json

        def write_then_fail(path: Path, manifest: object) -> None:
            original_write_proof_manifest_json(path, manifest)
            raise RuntimeError("injected proof-manifest producer failure")

        monkeypatch.setattr(
            real_proof,
            "write_proof_manifest_json",
            write_then_fail,
        )

    with pytest.raises(RuntimeError, match="injected"):
        finalize_real_generation_proof(
            prepared_review_directory=review_directory,
            visual_approval=approval,
        )

    finalization_paths = (
        review_directory / "composite_frames",
        review_directory / "proof_manifest.json",
        review_directory / "audit.json",
        review_directory / "preview.mp4",
        review_directory / "run_manifest.json",
        review_directory / "canonical_frames.zip",
        review_directory / "canonical_frames_manifest.json",
        review_directory / "difference_heatmap_000060.png",
        review_directory / "corruption_fixture",
    )
    assert all(not path.exists() for path in finalization_paths)
    assert not (review_directory / ".finalization-transaction.json").exists()
    assert not (review_directory / ".finalization-committed.json").exists()
    assert {path: sha256_file(path) for path in immutable_review_paths} == (
        immutable_hashes_before
    )

    monkeypatch.undo()
    result = finalize_real_generation_proof(
        prepared_review_directory=review_directory,
        visual_approval=approval,
    )
    assert result.audit.passed is True
    assert all(path.exists() for path in finalization_paths)

    persisted_hashes = {
        path.relative_to(review_directory): sha256_file(path)
        for path in review_directory.rglob("*")
        if path.is_file()
    }
    with pytest.raises(FileExistsError, match="proof artifacts already exist"):
        finalize_real_generation_proof(
            prepared_review_directory=review_directory,
            visual_approval=approval,
        )
    assert {
        path.relative_to(review_directory): sha256_file(path)
        for path in review_directory.rglob("*")
        if path.is_file()
    } == persisted_hashes


def test_cli_splits_review_preparation_from_bound_geometry_approval() -> None:
    prepared = build_parser().parse_args(
        [
            "prepare-generation-review",
            "--source-proof-directory",
            "source-proof",
            "--foreground-mask",
            "foreground.png",
            "--generated-media",
            "model-output.mp4",
            "--generation-assessment",
            "comparability.json",
            "--job-record",
            "job.json",
            "--output",
            "canonical",
        ]
    )
    finalized = build_parser().parse_args(
        [
            "finalize-generation-proof",
            "--prepared-review-directory",
            "canonical",
            "--geometry-approval",
            "APPROVE 0 60 120",
            "--review-manifest-sha256",
            "11" * 32,
            "--overlay-sha256",
            "22" * 32,
            "33" * 32,
            "44" * 32,
            "--reviewer",
            "reviewer",
            "--visual-note",
            "Position and scale align.",
        ]
    )
    corruption = build_parser().parse_args(
        [
            "corruption-fixture",
            "--proof-manifest",
            "proof_manifest.json",
            "--output",
            "corruption-fixture",
        ]
    )

    assert prepared.command == "prepare-generation-review"
    assert prepared.output == Path("canonical")
    assert finalized.command == "finalize-generation-proof"
    assert finalized.geometry_approval == "APPROVE 0 60 120"
    assert finalized.prepared_review_directory == Path("canonical")
    assert corruption.command == "corruption-fixture"
    assert corruption.proof_manifest == Path("proof_manifest.json")
    assert corruption.frame_index == 60


def test_cli_reports_definitive_canonical_rejection_as_safe_typed_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    arguments = build_parser().parse_args(
        [
            "finalize-generation-proof",
            "--prepared-review-directory",
            "canonical",
            "--geometry-approval",
            "APPROVE 0 60 120",
            "--review-manifest-sha256",
            "11" * 32,
            "--overlay-sha256",
            "22" * 32,
            "33" * 32,
            "44" * 32,
            "--reviewer",
            "reviewer",
            "--visual-note",
            "Position and scale align.",
        ]
    )

    def reject(**_kwargs: object) -> None:
        raise RealProofError("private path /tmp/secret must not escape")

    monkeypatch.setattr(framelock_cli, "finalize_real_generation_proof", reject)

    assert framelock_cli._finalize_generation_proof(arguments) == {
        "state": "verification_failed",
        "claim": None,
        "code": "CANONICAL_FINALIZATION_REJECTED",
        "detail": (
            "Canonical finalization rejected the approved evidence; "
            "no proof was promoted."
        ),
    }
