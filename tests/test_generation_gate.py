from __future__ import annotations

from fractions import Fraction
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

import pytest

from framelock_media.contract import MediaFacts
from framelock_media.cli import build_parser
from framelock_media.generation_gate import (
    PricingEvidence,
    assess_generated_media,
    calculate_generation_digest,
    evaluate_comparability,
)


def _facts(**overrides: object) -> MediaFacts:
    values: dict[str, object] = {
        "container": "mp4",
        "width": 1280,
        "height": 720,
        "frame_count": 121,
        "frame_rate": Fraction(24, 1),
        "presentation_timestamps": tuple(index / 24 for index in range(121)),
        "file_size_bytes": 1_000_000,
        "rotation_degrees": 0,
        "sample_aspect_ratio": Fraction(1, 1),
        "declared_duration_seconds": 121 / 24,
    }
    values.update(overrides)
    return MediaFacts(**values)  # type: ignore[arg-type]


def _make_video(path: Path, *, width: int, height: int) -> None:
    ffmpeg = shutil.which("ffmpeg")
    assert ffmpeg is not None
    subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"color=c=0x163144:size={width}x{height}:rate=24",
            "-frames:v",
            "121",
            "-vf",
            "setsar=1",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-video_track_timescale",
            "24000",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )


def _job_record(path: Path, media_path: Path, *, sha256: str | None = None) -> None:
    digest = sha256 or hashlib.sha256(media_path.read_bytes()).hexdigest()
    generation = {
        "sourceSha256": "11" * 32,
        "editMaskSha256": "22" * 32,
        "prompt": "A fixed prompt",
        "endpoint": "fal-ai/example",
        "parameters": {"fixed": True},
    }
    generation_digest = calculate_generation_digest(generation)
    path.write_text(
        json.dumps(
            {
                "id": "synthetic-model-001",
                "state": "generated",
                "createdAt": "2026-07-17T00:00:00.000Z",
                "updatedAt": "2026-07-17T00:01:00.000Z",
                "generation": {**generation, "digest": generation_digest},
                "fal": {
                    "generationDigest": generation_digest,
                    "endpoint": "fal-ai/example",
                    "requestId": "request-001",
                    "sourceUploadUrl": "https://fal.media/private-source.mp4",
                    "modelOutput": {
                        "artifactId": f"sha256:{digest}",
                        "sha256": digest,
                        "url": "https://fal.media/private-result.mp4",
                        "contentType": "video/mp4",
                    },
                },
            }
        ),
        encoding="utf-8",
    )


def test_comparability_rule_treats_missing_sar_as_square_but_never_fixes_5_by_3() -> None:
    canonical = evaluate_comparability(_facts(sample_aspect_ratio=None))
    incompatible = evaluate_comparability(
        _facts(width=1280, height=768, sample_aspect_ratio=None)
    )

    assert canonical.passed is True
    assert canonical.effective_sample_aspect_ratio == Fraction(1, 1)
    assert canonical.sample_aspect_ratio_inferred is True
    assert incompatible.passed is False
    assert incompatible.display_aspect_ratio == Fraction(5, 3)
    assert "display_aspect_ratio" in incompatible.failed_checks


def test_python_generation_digest_matches_the_node_boundary_contract() -> None:
    assert calculate_generation_digest(
        {
            "sourceSha256": (
                "abd4cfa2fcd84a376394a1af421d32ba8687e0d4b5bd44a2607a822b6ecdf67d"
            ),
            "editMaskSha256": (
                "ee375951c0fe4233ad442d7b18a23d770b63a0f195bb8fac1bae769d03b7b2f3"
            ),
            "prompt": (
                "Transform @Video1 into a cinematic locked-off product commercial "
                "in a rain-soaked neon laboratory at night. Animate cyan and "
                "magenta light sweeps, drifting mist and rain around the centered "
                "package. Keep the camera fixed. Preserve the package silhouette, "
                "position, scale and front-facing orientation. Do not crop, "
                "letterbox, stretch, zoom or change aspect ratio."
            ),
            "endpoint": "fal-ai/kling-video/o3/standard/video-to-video/edit",
            "parameters": {"keep_audio": False, "shot_type": "customize"},
        }
    ) == "5904668bac601b16a113e9801688f6f5bb5046d11208a610749e4bb5bc8cf3ec"


def test_comparability_rule_reports_every_failed_automatic_gate() -> None:
    timestamps = list(_facts().presentation_timestamps)
    timestamps[60] += 0.002
    result = evaluate_comparability(
        _facts(
            container="mov",
            frame_count=120,
            frame_rate=Fraction(30, 1),
            presentation_timestamps=tuple(timestamps[:-1]),
            rotation_degrees=90,
            declared_duration_seconds=4.0,
        )
    )

    assert result.passed is False
    assert set(result.failed_checks) == {
        "container",
        "frame_count",
        "frame_rate",
        "rotation",
        "timestamp_residual",
        "duration",
    }


def test_real_non_16_by_9_output_persists_not_comparable_evidence(
    tmp_path: Path,
) -> None:
    media = tmp_path / "model-output.mp4"
    _make_video(media, width=1280, height=768)
    job = tmp_path / "job.json"
    _job_record(job, media)

    result = assess_generated_media(
        media,
        tmp_path / "assessment",
        job_record_path=job,
        pricing=PricingEvidence(
            unit_price_usd="0.0024075",
            billing_unit="megapixels",
            estimated_units="111.5136",
            estimated_cost_usd="0.268468992",
            source="authenticated_fal_pricing",
            price_observed_at="2026-07-17T18:47:33.000Z",
            snapshot_captured_at="2026-07-17T19:00:00.000Z",
            snapshot_digest_sha256="ab" * 32,
        ),
        paid_attempt_index=1,
        paid_attempt_cap=3,
    )

    payload = json.loads(result.assessment_path.read_text(encoding="utf-8"))
    assert result.verdict == "not_comparable"
    assert payload["verdict"] == "not_comparable"
    assert payload["media"]["width"] == 1280
    assert payload["media"]["height"] == 768
    assert payload["media"]["display_aspect_ratio"] == "5/3"
    assert payload["normalization_applied"] is False
    assert payload["media"]["color"]["canonical_decode_basis"] == (
        "explicit_bt709_limited_fallback"
    )
    assert payload["media"]["color"]["canonical_decode_assumption"]
    assert payload["visual_geometry_approval"] == (
        "not_reached_automatic_gate_failed"
    )
    assert payload["job_provenance"]["fal"]["requestId"] == "request-001"
    assert "sourceUploadUrl" not in payload["job_provenance"]["fal"]
    assert "url" not in payload["job_provenance"]["fal"]["modelOutput"]
    assert payload["pricing"]["estimated_cost_usd"] == "0.268468992"
    assert payload["attempt"] == {"cap": 3, "index": 1}
    assert len(payload["inspection_frames"]) == 3
    assert all(Path(item["path"]).is_file() for item in payload["inspection_frames"])
    raw_probe = result.raw_probe_path.read_text(encoding="utf-8")
    assert hashlib.sha256(raw_probe.encode("utf-8")).hexdigest() == payload[
        "probe"
    ]["raw_json_sha256"]


def test_assessment_refuses_output_that_does_not_match_persisted_job_hash(
    tmp_path: Path,
) -> None:
    media = tmp_path / "model-output.mp4"
    _make_video(media, width=1280, height=720)
    job = tmp_path / "job.json"
    _job_record(job, media, sha256="ff" * 32)

    with pytest.raises(ValueError, match="does not match the job record"):
        assess_generated_media(
            media,
            tmp_path / "assessment",
            job_record_path=job,
            paid_attempt_index=2,
            paid_attempt_cap=3,
        )


def test_assessment_recomputes_generation_digest_instead_of_trusting_job_fields(
    tmp_path: Path,
) -> None:
    media = tmp_path / "model-output.mp4"
    _make_video(media, width=1280, height=720)
    job = tmp_path / "job.json"
    _job_record(job, media)
    payload = json.loads(job.read_text(encoding="utf-8"))
    payload["generation"]["prompt"] = "Tampered after the request"
    job.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(ValueError, match="recomputed generation digest"):
        assess_generated_media(
            media,
            tmp_path / "assessment",
            job_record_path=job,
            paid_attempt_index=2,
            paid_attempt_cap=3,
        )


def test_cli_freezes_explicit_generation_assessment_inputs() -> None:
    parsed = build_parser().parse_args(
        [
            "assess-generation",
            "--media",
            "model-output.mp4",
            "--output",
            "assessment",
            "--job-record",
            "job.json",
            "--paid-attempt-index",
            "1",
            "--paid-attempt-cap",
            "3",
            "--unit-price-usd",
            "0.0024075",
            "--billing-unit",
            "megapixels",
            "--estimated-units",
            "111.5136",
            "--estimated-cost-usd",
            "0.268468992",
            "--pricing-source",
            "authenticated_fal_pricing",
            "--price-observed-at",
            "2026-07-17T18:47:33.000Z",
            "--snapshot-captured-at",
            "2026-07-17T19:00:00.000Z",
            "--snapshot-digest-sha256",
            "ab" * 32,
        ]
    )

    assert parsed.command == "assess-generation"
    assert parsed.media == Path("model-output.mp4")
    assert parsed.paid_attempt_index == 1
    assert parsed.estimated_cost_usd == "0.268468992"
    assert parsed.snapshot_digest_sha256 == "ab" * 32
