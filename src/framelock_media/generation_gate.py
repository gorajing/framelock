from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from fractions import Fraction
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from typing import Any

from .artifacts import sha256_file
from .contract import CANONICAL_CONTRACT, MediaFacts
from .ffmpeg_pipeline import (
    BT709_LIMITED_FALLBACK_ASSUMPTION,
    MediaProbeEvidence,
    probe_media_evidence,
)


COMPARABILITY_RULE_VERSION = "framelock-comparability-p0-v1"


def _canonical_generation_value(value: object) -> object:
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("generation parameters must contain finite numbers")
        return value
    if isinstance(value, list):
        return [_canonical_generation_value(item) for item in value]
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise ValueError("generation parameter object keys must be strings")
        return {
            key: _canonical_generation_value(value[key])
            for key in sorted(value)
        }
    raise ValueError("generation parameters must contain only JSON values")


def calculate_generation_digest(generation: dict[str, object]) -> str:
    """Recompute the Node job-store digest at the Python trust boundary."""
    required = {
        "sourceSha256",
        "editMaskSha256",
        "prompt",
        "endpoint",
        "parameters",
    }
    if not required.issubset(generation):
        raise ValueError("generation identity is incomplete")
    source_sha256 = generation["sourceSha256"]
    edit_mask_sha256 = generation["editMaskSha256"]
    prompt = generation["prompt"]
    endpoint = generation["endpoint"]
    parameters = generation["parameters"]
    for value, role in (
        (source_sha256, "source SHA-256"),
        (edit_mask_sha256, "edit-mask SHA-256"),
    ):
        if (
            not isinstance(value, str)
            or len(value) != 64
            or any(character not in "0123456789abcdef" for character in value)
        ):
            raise ValueError(f"generation {role} is malformed")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt.strip()) > 2_000:
        raise ValueError("generation prompt is malformed")
    if not isinstance(endpoint, str) or not endpoint.strip():
        raise ValueError("generation endpoint is malformed")
    if not isinstance(parameters, dict):
        raise ValueError("generation parameters must be a JSON object")
    payload = _canonical_generation_value(
        {
            "editMaskSha256": edit_mask_sha256,
            "endpoint": endpoint.strip(),
            "parameters": parameters,
            "prompt": prompt.strip(),
            "sourceSha256": source_sha256,
        }
    )
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


@dataclass(frozen=True)
class PricingEvidence:
    unit_price_usd: str
    billing_unit: str
    estimated_units: str
    estimated_cost_usd: str
    source: str
    price_observed_at: str
    snapshot_captured_at: str
    snapshot_digest_sha256: str


@dataclass(frozen=True)
class AutomaticCheck:
    name: str
    passed: bool
    actual: str
    expected: str


@dataclass(frozen=True)
class ComparabilityResult:
    passed: bool
    checks: tuple[AutomaticCheck, ...]
    failed_checks: tuple[str, ...]
    effective_sample_aspect_ratio: Fraction
    sample_aspect_ratio_inferred: bool
    display_aspect_ratio: Fraction
    max_timestamp_residual_seconds: float
    measured_duration_seconds: float | None


@dataclass(frozen=True)
class GenerationAssessment:
    verdict: str
    assessment_path: Path
    raw_probe_path: Path


def _fraction_text(value: Fraction) -> str:
    return f"{value.numerator}/{value.denominator}"


def _check(name: str, passed: bool, actual: object, expected: str) -> AutomaticCheck:
    return AutomaticCheck(
        name=name,
        passed=passed,
        actual=str(actual),
        expected=expected,
    )


def evaluate_comparability(facts: MediaFacts) -> ComparabilityResult:
    inferred_sar = facts.sample_aspect_ratio is None
    effective_sar = facts.sample_aspect_ratio or Fraction(1, 1)
    display_aspect = Fraction(facts.width, facts.height) * effective_sar
    timestamps = facts.presentation_timestamps
    strictly_increasing = all(
        current > previous
        for previous, current in zip(timestamps, timestamps[1:])
    )
    residuals: tuple[float, ...] = ()
    if timestamps:
        start = timestamps[0]
        frame_interval = 1 / float(CANONICAL_CONTRACT.frame_rate)
        residuals = tuple(
            abs((timestamp - start) - index * frame_interval)
            for index, timestamp in enumerate(timestamps)
        )
    max_residual = max(residuals, default=math.inf)
    measured_duration = (
        timestamps[-1] - timestamps[0]
        + 1 / float(CANONICAL_CONTRACT.frame_rate)
        if timestamps and strictly_increasing
        else None
    )
    duration = (
        facts.declared_duration_seconds
        if facts.declared_duration_seconds is not None
        else measured_duration
    )
    duration_passed = (
        duration is not None
        and math.isfinite(duration)
        and abs(duration - CANONICAL_CONTRACT.duration_seconds)
        <= 1 / float(CANONICAL_CONTRACT.frame_rate) + 1e-12
    )

    checks = (
        _check("container", facts.container.lower() == "mp4", facts.container, "mp4"),
        _check(
            "display_aspect_ratio",
            display_aspect == Fraction(16, 9),
            _fraction_text(display_aspect),
            "16/9",
        ),
        _check(
            "frame_count",
            facts.frame_count == CANONICAL_CONTRACT.frame_count
            and len(timestamps) == CANONICAL_CONTRACT.frame_count,
            f"decoded={facts.frame_count},pts={len(timestamps)}",
            str(CANONICAL_CONTRACT.frame_count),
        ),
        _check(
            "frame_rate",
            facts.frame_rate == CANONICAL_CONTRACT.frame_rate,
            _fraction_text(facts.frame_rate),
            _fraction_text(CANONICAL_CONTRACT.frame_rate),
        ),
        _check("rotation", facts.rotation_degrees == 0, facts.rotation_degrees, "0"),
        _check(
            "timestamps_strictly_increasing",
            strictly_increasing,
            strictly_increasing,
            "true",
        ),
        _check(
            "timestamp_residual",
            math.isfinite(max_residual)
            and max_residual
            <= CANONICAL_CONTRACT.max_pts_residual_seconds + 1e-12,
            f"{max_residual:.9f}",
            f"<={CANONICAL_CONTRACT.max_pts_residual_seconds:.3f}s",
        ),
        _check(
            "duration",
            duration_passed,
            "missing" if duration is None else f"{duration:.9f}",
            (
                f"{CANONICAL_CONTRACT.duration_seconds:.9f}s "
                f"+/-{1 / float(CANONICAL_CONTRACT.frame_rate):.9f}s"
            ),
        ),
    )
    failed_checks = tuple(item.name for item in checks if not item.passed)
    return ComparabilityResult(
        passed=not failed_checks,
        checks=checks,
        failed_checks=failed_checks,
        effective_sample_aspect_ratio=effective_sar,
        sample_aspect_ratio_inferred=inferred_sar,
        display_aspect_ratio=display_aspect,
        max_timestamp_residual_seconds=max_residual,
        measured_duration_seconds=measured_duration,
    )


def _read_job_provenance(path: Path, media_sha256: str) -> dict[str, Any]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("job record must be a JSON object")
    generation = raw.get("generation")
    fal = raw.get("fal")
    if not isinstance(generation, dict) or not isinstance(fal, dict):
        raise ValueError("generated job record is missing generation or fal provenance")
    model_output = fal.get("modelOutput")
    if not isinstance(model_output, dict):
        raise ValueError("generated job record is missing model output provenance")
    if model_output.get("sha256") != media_sha256:
        raise ValueError("model output does not match the job record SHA-256")
    recomputed_generation_digest = calculate_generation_digest(generation)
    if generation.get("digest") != recomputed_generation_digest:
        raise ValueError("job digest differs from recomputed generation digest")
    if generation.get("digest") != fal.get("generationDigest"):
        raise ValueError("job generation digest differs from fal provenance")
    if generation.get("endpoint") != fal.get("endpoint"):
        raise ValueError("job endpoint differs from fal provenance")
    return {
        "id": raw.get("id"),
        "state": raw.get("state"),
        "createdAt": raw.get("createdAt"),
        "updatedAt": raw.get("updatedAt"),
        "generation": generation,
        "fal": {
            "generationDigest": fal.get("generationDigest"),
            "endpoint": fal.get("endpoint"),
            "requestId": fal.get("requestId"),
            "modelOutput": {
                "artifactId": model_output.get("artifactId"),
                "sha256": model_output.get("sha256"),
                "contentType": model_output.get("contentType"),
            },
        },
    }


def _ffmpeg_version(executable: str) -> str:
    completed = subprocess.run(
        [executable, "-version"],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    lines = completed.stdout.splitlines()
    if not lines:
        raise RuntimeError("ffmpeg did not report a version")
    return lines[0]


def _extract_inspection_frames(
    media_path: Path,
    temporary_directory: Path,
    final_directory: Path,
) -> tuple[list[dict[str, object]], list[list[str]], str, str]:
    executable_path = shutil.which("ffmpeg")
    if executable_path is None:
        raise RuntimeError("ffmpeg is required for generation assessment")
    executable = str(Path(executable_path).resolve())
    temporary_directory.mkdir(parents=True)
    frames: list[dict[str, object]] = []
    commands: list[list[str]] = []
    for index in (0, 60, 120):
        name = f"raw_{index:06d}.png"
        temporary_path = temporary_directory / name
        argv = [
            executable,
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-xerror",
            "-noautorotate",
            "-i",
            str(media_path),
            "-map",
            "0:V:0",
            "-an",
            "-sn",
            "-dn",
            "-vf",
            f"select=eq(n\\,{index})",
            "-frames:v",
            "1",
            "-c:v",
            "png",
            "-pix_fmt",
            "rgb24",
            "-threads:v",
            "1",
            "-n",
            str(temporary_path),
        ]
        subprocess.run(
            argv,
            check=True,
            capture_output=True,
            text=True,
            timeout=180,
        )
        if not temporary_path.is_file():
            raise RuntimeError(f"ffmpeg did not extract inspection frame {index}")
        commands.append(argv)
        frames.append(
            {
                "source_index": index,
                "path": str((final_directory / name).resolve()),
                "sha256": sha256_file(temporary_path),
            }
        )
    return frames, commands, executable, _ffmpeg_version(executable)


def _facts_payload(
    facts: MediaFacts,
    comparison: ComparabilityResult,
    probe: MediaProbeEvidence,
) -> dict[str, object]:
    timestamp_bytes = "\n".join(probe.timestamp_tokens).encode("ascii")
    color_metadata_complete = all(
        value is not None
        for value in (
            facts.color_range,
            facts.color_space,
            facts.color_transfer,
            facts.color_primaries,
        )
    )
    return {
        "container": facts.container,
        "codec": facts.codec_name,
        "pixel_format": facts.pixel_format,
        "width": facts.width,
        "height": facts.height,
        "reported_sample_aspect_ratio": (
            _fraction_text(facts.sample_aspect_ratio)
            if facts.sample_aspect_ratio is not None
            else None
        ),
        "sample_aspect_ratio_inferred": comparison.sample_aspect_ratio_inferred,
        "effective_sample_aspect_ratio": _fraction_text(
            comparison.effective_sample_aspect_ratio
        ),
        "display_aspect_ratio": _fraction_text(comparison.display_aspect_ratio),
        "frame_count": facts.frame_count,
        "frame_rate": _fraction_text(facts.frame_rate),
        "time_base": _fraction_text(facts.time_base),
        "rotation_degrees": facts.rotation_degrees,
        "declared_duration_seconds": facts.declared_duration_seconds,
        "measured_duration_seconds": comparison.measured_duration_seconds,
        "file_size_bytes": facts.file_size_bytes,
        "presentation_timestamp_count": len(facts.presentation_timestamps),
        "presentation_timestamps_sha256": hashlib.sha256(
            timestamp_bytes
        ).hexdigest(),
        "max_timestamp_residual_microseconds": round(
            comparison.max_timestamp_residual_seconds * 1_000_000
        ),
        "color": {
            "range": facts.color_range,
            "space": facts.color_space,
            "transfer": facts.color_transfer,
            "primaries": facts.color_primaries,
            "chroma_location": facts.chroma_location,
            "canonical_decode_basis": (
                "declared_source_metadata"
                if color_metadata_complete
                else "explicit_bt709_limited_fallback"
            ),
            "canonical_decode_assumption": (
                None
                if color_metadata_complete
                else BT709_LIMITED_FALLBACK_ASSUMPTION
            ),
        },
    }


def assess_generated_media(
    media_path: Path,
    output_directory: Path,
    *,
    job_record_path: Path | None = None,
    pricing: PricingEvidence | None = None,
    paid_attempt_index: int,
    paid_attempt_cap: int,
) -> GenerationAssessment:
    if not (1 <= paid_attempt_index <= paid_attempt_cap):
        raise ValueError("paid attempt index must be within the declared cap")
    if output_directory.exists():
        if not output_directory.is_dir() or any(output_directory.iterdir()):
            raise FileExistsError(
                f"assessment directory already exists: {output_directory}"
            )
        output_directory.rmdir()
    output_directory.parent.mkdir(parents=True, exist_ok=True)
    media_sha256 = sha256_file(media_path)
    job_provenance = (
        _read_job_provenance(job_record_path, media_sha256)
        if job_record_path is not None
        else None
    )
    probe = probe_media_evidence(media_path)
    comparison = evaluate_comparability(probe.facts)
    verdict = (
        "comparable_pending_visual_approval"
        if comparison.passed
        else "not_comparable"
    )
    temporary = Path(
        tempfile.mkdtemp(
            prefix=f".{output_directory.name}.tmp-",
            dir=str(output_directory.parent),
        )
    )
    try:
        raw_probe_temporary = temporary / "ffprobe.raw.json"
        raw_probe_temporary.write_text(probe.raw_json, encoding="utf-8")
        final_inspection_directory = output_directory / "inspection"
        inspection_frames, inspection_argv, ffmpeg_executable, ffmpeg_version = (
            _extract_inspection_frames(
                media_path,
                temporary / "inspection",
                final_inspection_directory,
            )
        )
        if comparison.passed:
            normalization_plan = (
                "none"
                if (probe.facts.width, probe.facts.height)
                == (CANONICAL_CONTRACT.width, CANONICAL_CONTRACT.height)
                else "scale_16_9_to_1280x720"
            )
        else:
            normalization_plan = "not_permitted"
        payload: dict[str, object] = {
            "schema_version": 1,
            "rule_version": COMPARABILITY_RULE_VERSION,
            "evaluated_at": datetime.now(timezone.utc).isoformat(),
            "verdict": verdict,
            "automatic_checks_passed": comparison.passed,
            "failed_checks": list(comparison.failed_checks),
            "checks": [asdict(item) for item in comparison.checks],
            "normalization_plan": normalization_plan,
            "normalization_applied": False,
            "visual_geometry_approval": (
                "pending_human_review"
                if comparison.passed
                else "not_reached_automatic_gate_failed"
            ),
            "visual_geometry_note": (
                "Review source indices 0, 60 and 120 with the protection overlay."
                if comparison.passed
                else (
                    "Cropping and aspect-distorting scaling are outside the frozen "
                    "contract."
                )
            ),
            "model_output": {
                "path": str(media_path.resolve()),
                "sha256": media_sha256,
                "bytes": media_path.stat().st_size,
            },
            "media": _facts_payload(probe.facts, comparison, probe),
            "probe": {
                "path": str((output_directory / "ffprobe.raw.json").resolve()),
                "raw_json_sha256": hashlib.sha256(
                    probe.raw_json.encode("utf-8")
                ).hexdigest(),
                "argv": list(probe.argv),
                "ffprobe_executable": probe.ffprobe_executable,
                "ffprobe_version": probe.ffprobe_version,
            },
            "inspection_frames": inspection_frames,
            "inspection_decode": {
                "argv": inspection_argv,
                "ffmpeg_executable": ffmpeg_executable,
                "ffmpeg_version": ffmpeg_version,
            },
            "attempt": {"index": paid_attempt_index, "cap": paid_attempt_cap},
            "pricing": asdict(pricing) if pricing is not None else None,
            "job_provenance": job_provenance,
        }
        (temporary / "comparability.json").write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, output_directory)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return GenerationAssessment(
        verdict=verdict,
        assessment_path=output_directory / "comparability.json",
        raw_probe_path=output_directory / "ffprobe.raw.json",
    )
