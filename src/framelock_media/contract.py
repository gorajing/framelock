from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
import math


class ContractViolation(ValueError):
    """Raised when media cannot enter the canonical P0 pipeline."""


@dataclass(frozen=True)
class CanonicalContract:
    width: int = 1280
    height: int = 720
    frame_count: int = 121
    frame_rate: Fraction = Fraction(24, 1)
    max_pts_residual_seconds: float = 0.001
    max_file_size_bytes: int = 50 * 1024 * 1024

    @property
    def duration_seconds(self) -> float:
        return self.frame_count / float(self.frame_rate)


CANONICAL_CONTRACT = CanonicalContract()


@dataclass(frozen=True)
class MediaFacts:
    container: str
    width: int
    height: int
    frame_count: int
    frame_rate: Fraction
    presentation_timestamps: tuple[float, ...]
    file_size_bytes: int
    rotation_degrees: int
    sample_aspect_ratio: Fraction | None = Fraction(1, 1)
    declared_duration_seconds: float | None = None
    codec_name: str = "unknown"
    pixel_format: str = "unknown"
    time_base: Fraction = Fraction(1, 24)
    color_range: str | None = None
    color_space: str | None = None
    color_transfer: str | None = None
    color_primaries: str | None = None
    chroma_location: str | None = None


@dataclass(frozen=True)
class DecodeProvenance:
    source_media_path: str
    source_file_sha256: str
    source_container: str
    source_codec: str
    source_pixel_format: str
    source_color_range: str | None
    source_color_space: str | None
    source_color_transfer: str | None
    source_color_primaries: str | None
    source_chroma_location: str | None
    ffmpeg_executable: str
    ffmpeg_version: str
    ffprobe_executable: str
    ffprobe_version: str
    probe_argv: tuple[str, ...]
    probe_json_sha256: str
    decode_argv: tuple[str, ...]
    canonical_color_conversion: str
    width: int
    height: int
    decoded_frame_count: int
    frame_rate_numerator: int
    frame_rate_denominator: int
    time_base_numerator: int
    time_base_denominator: int
    max_pts_residual_microseconds: int
    presentation_timestamps_sha256: str
    color_conversion_basis: str
    color_conversion_assumption: str | None


@dataclass(frozen=True)
class ValidatedMedia:
    max_pts_residual_seconds: float


def validate_media_facts(
    facts: MediaFacts, contract: CanonicalContract = CANONICAL_CONTRACT
) -> ValidatedMedia:
    if facts.container.lower() != "mp4":
        raise ContractViolation("container must be MP4")
    if (facts.width, facts.height) != (contract.width, contract.height):
        raise ContractViolation(
            f"dimensions must be {contract.width}x{contract.height}"
        )
    if facts.frame_count != contract.frame_count:
        raise ContractViolation(f"frame count must be {contract.frame_count}")
    if facts.frame_rate != contract.frame_rate:
        raise ContractViolation(f"frame rate must be {contract.frame_rate}")
    if not 0 <= facts.file_size_bytes <= contract.max_file_size_bytes:
        raise ContractViolation(
            f"file size must be at most {contract.max_file_size_bytes} bytes"
        )
    if facts.rotation_degrees != 0:
        raise ContractViolation("rotation metadata must be zero")
    if facts.sample_aspect_ratio != Fraction(1, 1):
        raise ContractViolation("sample aspect ratio must be 1:1")
    if len(facts.presentation_timestamps) != contract.frame_count:
        raise ContractViolation(
            "presentation timestamp count must match the frame count"
        )
    if not all(math.isfinite(value) for value in facts.presentation_timestamps):
        raise ContractViolation("presentation timestamps must be finite")
    if any(
        current <= previous
        for previous, current in zip(
            facts.presentation_timestamps, facts.presentation_timestamps[1:]
        )
    ):
        raise ContractViolation("presentation timestamps must be strictly increasing")

    start = facts.presentation_timestamps[0]
    frame_interval = float(contract.frame_rate.denominator) / float(
        contract.frame_rate.numerator
    )
    residuals = (
        abs((timestamp - start) - index * frame_interval)
        for index, timestamp in enumerate(facts.presentation_timestamps)
    )
    maximum_residual = max(residuals, default=0.0)
    if maximum_residual > contract.max_pts_residual_seconds + 1e-12:
        raise ContractViolation(
            "normalized presentation timestamp residual exceeds 1 ms"
        )
    if facts.declared_duration_seconds is not None:
        if not math.isfinite(facts.declared_duration_seconds):
            raise ContractViolation("declared duration must be finite")
        duration_residual = abs(
            facts.declared_duration_seconds - contract.duration_seconds
        )
        frame_interval = 1.0 / float(contract.frame_rate)
        if duration_residual > frame_interval + 1e-12:
            raise ContractViolation("declared duration differs by more than one frame")
    return ValidatedMedia(max_pts_residual_seconds=maximum_residual)
