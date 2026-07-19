from __future__ import annotations

import argparse
from dataclasses import asdict
import json
from pathlib import Path
from typing import Sequence

from .ai_source import prepare_ai_source, prepare_chroma_rgba
from .artifacts import sha256_file
from .corruption_fixture import (
    create_deliberate_corruption_fixture_from_manifest,
)
from .fixtures import create_framelock_hero_fixture
from .finalization_transaction import (
    FinalizationOutput,
    validate_committed_finalization,
)
from .generation_gate import PricingEvidence, assess_generated_media
from .offline_proof import prepare_canonical_source, run_synthetic_canonical_proof
from .real_proof import (
    RealProofError,
    VisualGeometryApproval,
    finalize_real_generation_proof,
    prepare_real_generation_review,
)


def _offline_proof(output: Path) -> dict[str, object]:
    if output.exists():
        raise FileExistsError(f"run directory exists: {output}")
    fixture = create_framelock_hero_fixture(output / "inputs")
    result = run_synthetic_canonical_proof(
        fixture.source_mp4,
        fixture.foreground_mask,
        output / "proof",
    )
    return {
        "audit": {
            "canonical_contract_passed": result.audit.canonical_contract_passed,
            "changed_core_channel_samples": (
                result.audit.total_changed_core_channel_samples
            ),
            "frames_audited": result.audit.frames_audited,
            "passed": result.audit.passed,
        },
        "fixture": asdict(fixture),
        "manifest_digest_sha256": result.manifest.digest_sha256,
        "preview_label": result.preview_label,
        "proof": {
            "audit": str(result.audit_path),
            "mask_transport": str(result.mask_transport_path),
            "manifest": str(result.proof_manifest_path),
            "preview": str(result.preview_path),
        },
        "run_directory": str(output.resolve()),
    }


def _prepare_source(arguments: argparse.Namespace) -> dict[str, object]:
    result = prepare_canonical_source(
        arguments.source,
        arguments.foreground_mask,
        arguments.output,
    )
    summary = json.loads(result.summary_path.read_text(encoding="utf-8"))
    return {
        "state": summary["state"],
        "claim": None,
        "next_step": summary["next_step"],
        "run_directory": str(arguments.output.resolve()),
        "source": str(result.source_mp4.resolve()),
        "source_sha256": sha256_file(result.source_mp4),
        "foreground_mask": str(result.prepared_foreground_mask.resolve()),
        "foreground_mask_sha256": sha256_file(
            result.prepared_foreground_mask
        ),
        "protected_core_pixels_per_frame": summary["foreground_mask"][
            "protected_core_pixels_per_frame"
        ],
        "proof_manifest": str(result.proof_manifest_path.resolve()),
        "proof_manifest_sha256": sha256_file(result.proof_manifest_path),
        "summary": str(result.summary_path.resolve()),
    }


def _text_argument(
    arguments: argparse.Namespace,
    *,
    direct: str,
    file: str,
) -> str | None:
    direct_value = getattr(arguments, direct)
    file_value = getattr(arguments, file)
    if direct_value is not None:
        return str(direct_value)
    if file_value is not None:
        return file_value.read_text(encoding="utf-8")
    return None


def _prepare_ai_source(arguments: argparse.Namespace) -> dict[str, object]:
    prompt = _text_argument(
        arguments,
        direct="prompt",
        file="prompt_file",
    )
    assert prompt is not None
    derivation = _text_argument(
        arguments,
        direct="prepared_rgba_derivation",
        file="prepared_rgba_derivation_file",
    )
    generator_metadata: dict[str, object] | None = None
    if arguments.generator_metadata_file is not None:
        parsed = json.loads(
            arguments.generator_metadata_file.read_text(encoding="utf-8")
        )
        if not isinstance(parsed, dict):
            raise ValueError("generator metadata file must contain a JSON object")
        generator_metadata = parsed
    result = prepare_ai_source(
        arguments.image,
        arguments.output_root,
        prompt=prompt,
        generator=arguments.generator,
        created_at=arguments.created_at,
        generator_metadata=generator_metadata,
        explicit_mask_path=arguments.mask_candidate,
        prepared_rgba_path=arguments.prepared_rgba,
        prepared_rgba_derivation=derivation,
    )
    return {
        "bundle_manifest": str(result.bundle_manifest_path.resolve()),
        "bundle_manifest_digest_sha256": result.manifest_digest_sha256,
        "bundle_manifest_sha256": result.bundle_manifest_sha256,
        "canonical_decoded_frame": str(
            result.canonical_decoded_frame_path.resolve()
        ),
        "canonical_rgb_sha256": result.canonical_rgb_sha256,
        "claim": None,
        "contact_sheet": str(result.contact_sheet_path.resolve()),
        "decoded_frame_count": result.decoded_frame_count,
        "foreground_mask": str(result.foreground_mask_path.resolve()),
        "foreground_mask_sha256": sha256_file(
            result.foreground_mask_path
        ),
        "mask_method": result.mask_method,
        "next_step": "visual_mask_approval_and_application_intake",
        "normalized_plate": str(result.normalized_plate_path.resolve()),
        "normalized_plate_sha256": sha256_file(
            result.normalized_plate_path
        ),
        "original": str(result.original_path.resolve()),
        "original_sha256": sha256_file(result.original_path),
        "source_directory": str(result.directory.resolve()),
        "source_mp4": str(result.source_mp4_path.resolve()),
        "source_mp4_sha256": sha256_file(result.source_mp4_path),
        "source_record": str(result.source_record_path.resolve()),
        "state": "prepared",
        "unique_decoded_rgb_hash_count": (
            result.unique_decoded_rgb_hash_count
        ),
    }


def _prepare_chroma_rgba(arguments: argparse.Namespace) -> dict[str, object]:
    result = prepare_chroma_rgba(
        arguments.image,
        arguments.output_root,
        key_rgb=tuple(arguments.key_rgb),
        threshold=arguments.threshold,
        softness=arguments.softness,
        despill_strength=arguments.despill_strength,
        algorithm_version=arguments.algorithm_version,
        foreground_excludes_key_color=(
            arguments.foreground_excludes_key_color
        ),
    )
    return {
        "algorithm_id": result.algorithm_id,
        "algorithm_version": result.algorithm_version,
        "claim": None,
        "derivation_manifest": str(
            result.derivation_manifest_path.resolve()
        ),
        "derivation_manifest_digest_sha256": (
            result.manifest_digest_sha256
        ),
        "derivation_manifest_sha256": (
            result.derivation_manifest_sha256
        ),
        "directory": str(result.directory.resolve()),
        "despill_mode": result.despill_mode,
        "original": str(result.original_path.resolve()),
        "original_sha256": sha256_file(result.original_path),
        "parameters": result.parameters,
        "prepared_rgba": str(result.prepared_rgba_path.resolve()),
        "prepared_rgba_sha256": sha256_file(result.prepared_rgba_path),
        "state": "prepared",
    }


def _corruption_fixture(arguments: argparse.Namespace) -> dict[str, object]:
    result = create_deliberate_corruption_fixture_from_manifest(
        proof_manifest_path=arguments.proof_manifest,
        output_directory=arguments.output,
        frame_index=arguments.frame_index,
    )
    return {
        "state": "verification_failed",
        "claim": None,
        "fixture": "one_channel_one_pixel_protected_core_corruption",
        "frame_index": arguments.frame_index,
        "changed_core_pixels": result.audit.total_changed_core_pixels,
        "changed_core_channel_samples": (
            result.audit.total_changed_core_channel_samples
        ),
        "worst_maximum_absolute_channel_delta": (
            result.audit.worst_maximum_absolute_channel_delta
        ),
        "manifest": str(result.manifest_path.resolve()),
        "manifest_sha256": sha256_file(result.manifest_path),
        "audit": str(result.audit_path.resolve()),
        "audit_sha256": sha256_file(result.audit_path),
        "summary": str(result.summary_path.resolve()),
        "summary_sha256": sha256_file(result.summary_path),
    }


def _generation_assessment(arguments: argparse.Namespace) -> dict[str, object]:
    result = assess_generated_media(
        arguments.media,
        arguments.output,
        job_record_path=arguments.job_record,
        pricing=PricingEvidence(
            unit_price_usd=arguments.unit_price_usd,
            billing_unit=arguments.billing_unit,
            estimated_units=arguments.estimated_units,
            estimated_cost_usd=arguments.estimated_cost_usd,
            source=arguments.pricing_source,
            price_observed_at=arguments.price_observed_at,
            snapshot_captured_at=arguments.snapshot_captured_at,
            snapshot_digest_sha256=arguments.snapshot_digest_sha256,
        ),
        paid_attempt_index=arguments.paid_attempt_index,
        paid_attempt_cap=arguments.paid_attempt_cap,
    )
    return {
        "assessment": str(result.assessment_path.resolve()),
        "raw_probe": str(result.raw_probe_path.resolve()),
        "verdict": result.verdict,
    }


def _prepare_generation_review(arguments: argparse.Namespace) -> dict[str, object]:
    result = prepare_real_generation_review(
        source_proof_directory=arguments.source_proof_directory,
        prepared_foreground_mask=arguments.foreground_mask,
        generated_media=arguments.generated_media,
        generation_assessment_path=arguments.generation_assessment,
        job_record_path=arguments.job_record,
        output_directory=arguments.output,
    )
    return {
        "generated_frames": len(result.generated_paths),
        "geometry_overlays": [str(path.resolve()) for path in result.geometry_overlay_paths],
        "geometry_overlay_sha256s": [
            sha256_file(path) for path in result.geometry_overlay_paths
        ],
        "review_manifest": str(result.review_manifest_path.resolve()),
        "review_manifest_sha256": result.review_manifest_sha256,
        "review_manifest_digest_sha256": (
            result.review_manifest_digest_sha256
        ),
        "review_state": "awaiting_visual_geometry_approval",
    }


def _finalize_generation_proof(arguments: argparse.Namespace) -> dict[str, object]:
    try:
        result = finalize_real_generation_proof(
            prepared_review_directory=arguments.prepared_review_directory,
            visual_approval=VisualGeometryApproval(
                passed=arguments.geometry_approval == "APPROVE 0 60 120",
                reviewer=arguments.reviewer,
                reviewed_source_indices=(0, 60, 120),
                reviewed_overlay_sha256s=tuple(arguments.overlay_sha256),
                review_manifest_sha256=arguments.review_manifest_sha256,
                note=arguments.visual_note,
            ),
        )
    except RealProofError:
        return {
            "state": "verification_failed",
            "claim": None,
            "code": "CANONICAL_FINALIZATION_REJECTED",
            "detail": (
                "Canonical finalization rejected the approved evidence; "
                "no proof was promoted."
            ),
        }
    return {
        "audit": str(result.audit_path.resolve()),
        "canonical_contract_passed": result.audit.canonical_contract_passed,
        "changed_core_channel_samples": (
            result.audit.total_changed_core_channel_samples
        ),
        "claim": (
            "Protected core verified — canonical pre-encode frame sequence."
            if result.audit.passed
            else None
        ),
        "manifest": str(result.proof_manifest_path.resolve()),
        "preview": str(result.preview_path.resolve()),
        "run_manifest": str(result.run_manifest_path.resolve()),
    }


def _finalization_outputs(root: Path) -> tuple[FinalizationOutput, ...]:
    return (
        FinalizationOutput(root / "composite_frames", "directory"),
        FinalizationOutput(root / "proof_manifest.json", "file"),
        FinalizationOutput(root / "audit.json", "file"),
        FinalizationOutput(root / "preview.mp4", "file"),
        FinalizationOutput(root / "run_manifest.json", "file"),
        FinalizationOutput(root / "canonical_frames.zip", "file"),
        FinalizationOutput(root / "canonical_frames_manifest.json", "file"),
        FinalizationOutput(root / "difference_heatmap_000060.png", "file"),
        FinalizationOutput(root / "corruption_fixture", "directory"),
    )


def _validate_finalization_commit(
    arguments: argparse.Namespace,
) -> dict[str, object]:
    root = arguments.prepared_review_directory.resolve()
    evidence = validate_committed_finalization(
        root=root,
        review_manifest_sha256=arguments.review_manifest_sha256,
        outputs=_finalization_outputs(root),
    )
    return {
        "state": "committed",
        "marker": str(evidence.marker_path.resolve()),
        "marker_sha256": evidence.marker_sha256,
        "schema_version": evidence.schema_version,
        "attempt_id": evidence.attempt_id,
        "review_manifest_sha256": evidence.review_manifest_sha256,
        "output_count": len(evidence.outputs),
        "stale_journal_reconciled": evidence.stale_journal_reconciled,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="framelock-media")
    subcommands = parser.add_subparsers(dest="command", required=True)
    proof = subcommands.add_parser(
        "offline-proof",
        help="create the owned synthetic hero and complete deterministic proof",
    )
    proof.add_argument("--output", required=True, type=Path)
    source = subcommands.add_parser(
        "prepare-source",
        help="validate and freeze one owned source plus its static mask",
    )
    source.add_argument("--source", required=True, type=Path)
    source.add_argument("--foreground-mask", required=True, type=Path)
    source.add_argument("--output", required=True, type=Path)
    ai_source = subcommands.add_parser(
        "prepare-ai-source",
        help="turn one generated still into canonical stationary source inputs",
    )
    ai_source.add_argument("--image", required=True, type=Path)
    ai_source.add_argument("--output-root", required=True, type=Path)
    prompt = ai_source.add_mutually_exclusive_group(required=True)
    prompt.add_argument("--prompt")
    prompt.add_argument("--prompt-file", type=Path)
    ai_source.add_argument("--generator", required=True)
    ai_source.add_argument("--generator-metadata-file", type=Path)
    ai_source.add_argument("--created-at", required=True)
    ai_source.add_argument("--mask-candidate", type=Path)
    ai_source.add_argument("--prepared-rgba", type=Path)
    derivation = ai_source.add_mutually_exclusive_group()
    derivation.add_argument("--prepared-rgba-derivation")
    derivation.add_argument("--prepared-rgba-derivation-file", type=Path)
    chroma = subcommands.add_parser(
        "prepare-chroma-rgba",
        help="derive deterministic alpha and despilled RGB from a chroma still",
    )
    chroma.add_argument("--image", required=True, type=Path)
    chroma.add_argument("--output-root", required=True, type=Path)
    chroma.add_argument(
        "--key-rgb",
        required=True,
        type=int,
        nargs=3,
        metavar=("RED", "GREEN", "BLUE"),
    )
    chroma.add_argument("--threshold", required=True)
    chroma.add_argument("--softness", required=True)
    chroma.add_argument("--despill-strength", required=True)
    chroma.add_argument(
        "--algorithm-version",
        type=int,
        choices=(1, 2),
        default=1,
        help="use v1 compatibility or opt in to v2 opaque-safe despill",
    )
    chroma.add_argument(
        "--foreground-excludes-key-color",
        action="store_true",
        help=(
            "declare that foreground content excludes the dominant key color; "
            "required by algorithm v2"
        ),
    )
    corruption = subcommands.add_parser(
        "corruption-fixture",
        help="copy one proof-bound frame, corrupt one core channel and re-audit",
    )
    corruption.add_argument("--proof-manifest", required=True, type=Path)
    corruption.add_argument("--output", required=True, type=Path)
    corruption.add_argument("--frame-index", type=int, default=60)
    assessment = subcommands.add_parser(
        "assess-generation",
        help="persist an immutable automatic comparability assessment",
    )
    assessment.add_argument("--media", required=True, type=Path)
    assessment.add_argument("--output", required=True, type=Path)
    assessment.add_argument("--job-record", required=True, type=Path)
    assessment.add_argument("--paid-attempt-index", required=True, type=int)
    assessment.add_argument("--paid-attempt-cap", required=True, type=int)
    assessment.add_argument("--unit-price-usd", required=True)
    assessment.add_argument("--billing-unit", required=True)
    assessment.add_argument("--estimated-units", required=True)
    assessment.add_argument("--estimated-cost-usd", required=True)
    assessment.add_argument("--pricing-source", required=True)
    assessment.add_argument("--price-observed-at", required=True)
    assessment.add_argument("--snapshot-captured-at", required=True)
    assessment.add_argument("--snapshot-digest-sha256", required=True)
    review = subcommands.add_parser(
        "prepare-generation-review",
        help="persist generated frames and review overlays before approval",
    )
    review.add_argument(
        "--source-proof-directory", required=True, type=Path
    )
    review.add_argument("--foreground-mask", required=True, type=Path)
    review.add_argument("--generated-media", required=True, type=Path)
    review.add_argument(
        "--generation-assessment", required=True, type=Path
    )
    review.add_argument("--job-record", required=True, type=Path)
    review.add_argument("--output", required=True, type=Path)
    finalize = subcommands.add_parser(
        "finalize-generation-proof",
        help="bind approval to persisted review hashes and verify composition",
    )
    finalize.add_argument(
        "--prepared-review-directory", required=True, type=Path
    )
    finalize.add_argument(
        "--geometry-approval",
        required=True,
        choices=["APPROVE 0 60 120"],
    )
    finalize.add_argument("--review-manifest-sha256", required=True)
    finalize.add_argument(
        "--overlay-sha256", required=True, nargs=3, metavar="SHA256"
    )
    finalize.add_argument("--reviewer", required=True)
    finalize.add_argument("--visual-note", required=True)
    validate_commit = subcommands.add_parser(
        "validate-finalization-commit",
        help="validate the durable commit marker and every owned final output",
    )
    validate_commit.add_argument(
        "--prepared-review-directory", required=True, type=Path
    )
    validate_commit.add_argument(
        "--review-manifest-sha256", required=True
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    if arguments.command == "offline-proof":
        payload = _offline_proof(arguments.output)
    elif arguments.command == "prepare-source":
        payload = _prepare_source(arguments)
    elif arguments.command == "prepare-ai-source":
        payload = _prepare_ai_source(arguments)
    elif arguments.command == "prepare-chroma-rgba":
        payload = _prepare_chroma_rgba(arguments)
    elif arguments.command == "corruption-fixture":
        payload = _corruption_fixture(arguments)
    elif arguments.command == "assess-generation":
        payload = _generation_assessment(arguments)
    elif arguments.command == "prepare-generation-review":
        payload = _prepare_generation_review(arguments)
    elif arguments.command == "finalize-generation-proof":
        payload = _finalize_generation_proof(arguments)
    elif arguments.command == "validate-finalization-commit":
        payload = _validate_finalization_commit(arguments)
    else:  # pragma: no cover - argparse owns command validation.
        raise AssertionError(f"unhandled command: {arguments.command}")
    print(json.dumps(payload, indent=2, sort_keys=True, default=str))
    return 0
