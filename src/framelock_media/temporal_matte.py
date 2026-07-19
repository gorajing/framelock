from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from typing import Sequence

import numpy as np
from numpy.typing import NDArray
from PIL import Image, UnidentifiedImageError

from .artifacts import sha256_file
from .contract import CANONICAL_CONTRACT
from .ffmpeg_pipeline import (
    MaskTransportViolation,
    _validate_authoritative_masks,
)
from .masks import (
    CORE_EROSION_RADIUS,
    EmptyCoreError,
    FOREGROUND_THRESHOLD,
    erode_to_core,
)


SOFT_MASK_POLARITY = "alpha_0_background_alpha_255_foreground"
EDIT_MASK_POLARITY = "0_protect_foreground_255_edit_exterior"
FOREGROUND_MEMBERSHIP = f"alpha>={FOREGROUND_THRESHOLD}"
ACCEPTED_INPUT_TYPES = (
    "rgba_png_sequence",
    "transparent_webm",
    "transparent_mov",
)
REJECTED_INPUT_TYPES = ("mp4",)
MANIFEST_NAME = "temporal_matte_manifest.json"
SOFT_MASK_STEM = "foreground"
EDIT_MASK_STEM = "mask"
MAXIMUM_BORDER_FOREGROUND_RATIO = 0.20
MINIMUM_FOREGROUND_AREA_RATIO = 0.001
MAXIMUM_FOREGROUND_AREA_RATIO = 0.60
MAXIMUM_CENTROID_JUMP_RATIO = 0.12
FFMPEG_TIMEOUT_SECONDS = 180
TRANSPARENT_DECODE_ALGORITHM_ID = (
    "framelock_transparent_rgba8_passthrough_v1"
)
EIGHT_BIT_DIRECT_ALPHA_PIXEL_FORMATS = frozenset(
    {
        "abgr",
        "argb",
        "bgra",
        "gbrap",
        "rgba",
        "ya8",
        "yuva420p",
        "yuva422p",
        "yuva444p",
    }
)
EIGHT_BIT_WEBM_COLOR_PIXEL_FORMATS = frozenset(
    {"yuv420p", "yuv422p", "yuv444p"}
)
_SEQUENCE_NAME = re.compile(r"^(?P<stem>.+)_(?P<index>[0-9]{6})\.png$")
_HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_MANIFEST_KEYS = frozenset(
    {
        "artifact_root",
        "artifacts",
        "contract",
        "digest_sha256",
        "frames",
        "qa",
        "schema_version",
        "source",
    }
)
_FRAME_KEYS = frozenset(
    {
        "border_foreground_ratio",
        "centroid_jump_ratio",
        "centroid_x",
        "centroid_y",
        "edge_touches",
        "edit_mask_file_sha256",
        "edit_mask_path",
        "edit_mask_pixels_sha256",
        "foreground_area_pixels",
        "foreground_area_ratio",
        "index",
        "protected_core_pixels",
        "soft_mask_file_sha256",
        "soft_mask_path",
        "soft_mask_pixels_sha256",
        "source_alpha_sha256",
        "source_file_sha256",
        "source_path",
        "source_rgba_sha256",
        "source_timestamp",
    }
)
_ARTIFACT_KEYS = frozenset(
    {
        "edit_mask_ordered_digest_sha256",
        "soft_mask_ordered_digest_sha256",
        "vace_transport_compatible",
        "vace_transport_validator",
    }
)
_SEQUENCE_SOURCE_KEYS = frozenset(
    {
        "decode_pass_count",
        "deterministic_decode_passed",
        "kind",
        "normalization_operation",
        "ordered_frame_digest_sha256",
        "source_artifact_count",
    }
)
_VIDEO_SOURCE_KEYS = frozenset(
    {
        "alpha_signal",
        "alpha_bit_depth",
        "decode_pass_count",
        "decode_algorithm_id",
        "decode_argv_template",
        "deterministic_decode_passed",
        "ffmpeg_executable",
        "ffmpeg_version",
        "ffprobe_executable",
        "ffprobe_version",
        "kind",
        "normalization_operation",
        "ordered_frame_digest_sha256",
        "presentation_timestamps_sha256",
        "probe_argv",
        "probe_json_sha256",
        "rotation_degrees",
        "sample_aspect_ratio",
        "sample_aspect_ratio_basis",
        "source_codec",
        "source_file_sha256",
        "source_path",
        "source_pixel_format",
    }
)


class TemporalMatteError(ValueError):
    """Base error for fail-closed temporal matte ingestion."""


class MatteInputError(TemporalMatteError):
    """Raised when the declared source cannot enter the matte pipeline."""


class MattePlausibilityError(TemporalMatteError):
    """Raised when an alpha sequence is not a plausible foreground matte."""


class MatteIntegrityError(TemporalMatteError):
    """Raised when persisted matte evidence no longer matches its manifest."""


@dataclass(frozen=True)
class MatteContract:
    width: int = CANONICAL_CONTRACT.width
    height: int = CANONICAL_CONTRACT.height
    frame_count: int = CANONICAL_CONTRACT.frame_count
    frame_rate_numerator: int = CANONICAL_CONTRACT.frame_rate.numerator
    frame_rate_denominator: int = CANONICAL_CONTRACT.frame_rate.denominator
    foreground_threshold: int = FOREGROUND_THRESHOLD
    minimum_foreground_area_ratio: float = MINIMUM_FOREGROUND_AREA_RATIO
    maximum_foreground_area_ratio: float = MAXIMUM_FOREGROUND_AREA_RATIO
    maximum_centroid_jump_ratio: float = MAXIMUM_CENTROID_JUMP_RATIO
    maximum_border_foreground_ratio: float = (
        MAXIMUM_BORDER_FOREGROUND_RATIO
    )

    def __post_init__(self) -> None:
        if self.width <= 0 or self.height <= 0 or self.frame_count <= 0:
            raise ValueError("matte geometry and frame count must be positive")
        if self.frame_rate_numerator <= 0 or self.frame_rate_denominator <= 0:
            raise ValueError("matte frame rate must be positive")
        if self.foreground_threshold != FOREGROUND_THRESHOLD:
            raise ValueError(
                "temporal matte threshold must remain frozen at "
                f"{FOREGROUND_THRESHOLD}"
            )
        if not (
            0.0
            < self.minimum_foreground_area_ratio
            < self.maximum_foreground_area_ratio
            < 1.0
        ):
            raise ValueError("matte foreground-area thresholds are invalid")
        if not 0.0 < self.maximum_centroid_jump_ratio < 1.0:
            raise ValueError("matte centroid-jump threshold is invalid")
        if not 0.0 < self.maximum_border_foreground_ratio < 1.0:
            raise ValueError("matte border threshold is invalid")

    @property
    def frame_rate(self) -> Fraction:
        return Fraction(
            self.frame_rate_numerator,
            self.frame_rate_denominator,
        )


CANONICAL_TEMPORAL_MATTE_CONTRACT = MatteContract()


@dataclass(frozen=True)
class TemporalMatteResult:
    directory: Path
    soft_mask_paths: tuple[Path, ...]
    edit_mask_paths: tuple[Path, ...]
    manifest_path: Path
    manifest_digest_sha256: str


@dataclass(frozen=True)
class _FrameMetric:
    foreground_area_pixels: int
    foreground_area_ratio: float
    centroid_x: float
    centroid_y: float
    centroid_jump_ratio: float
    edge_touches: dict[str, bool]
    border_foreground_ratio: float
    protected_core_pixels: int


@dataclass(frozen=True)
class _VideoProbe:
    source_kind: str
    source_codec: str
    source_pixel_format: str
    alpha_signal: str
    alpha_bit_depth: int
    rotation_degrees: int
    sample_aspect_ratio: str
    sample_aspect_ratio_basis: str
    presentation_timestamps: tuple[str, ...]
    probe_argv: tuple[str, ...]
    probe_json_sha256: str
    ffprobe_executable: str
    ffprobe_version: str


@dataclass(frozen=True)
class _DecodedVideoPass:
    paths: tuple[Path, ...]
    rgba_hashes: tuple[str, ...]
    alpha_hashes: tuple[str, ...]
    argv: tuple[str, ...]
    argv_template: tuple[str, ...]
    ffmpeg_executable: str
    ffmpeg_version: str


@dataclass(frozen=True)
class _FreshVideoEvidence:
    probe: _VideoProbe
    decoded: _DecodedVideoPass


def _canonical_json_bytes(payload: object) -> bytes:
    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _pixel_sha256(array: np.ndarray) -> str:
    return _sha256_bytes(
        np.ascontiguousarray(array).tobytes(order="C")
    )


def _rounded(value: float) -> float:
    return round(float(value), 12)


def _contract_payload(contract: MatteContract) -> dict[str, object]:
    final_index = contract.frame_count - 1
    return {
        "accepted_input_types": list(ACCEPTED_INPUT_TYPES),
        "edit_mask_pattern": (
            f"mask_000000.png..mask_{final_index:06d}.png"
        ),
        "edit_mask_polarity": EDIT_MASK_POLARITY,
        "foreground_membership": FOREGROUND_MEMBERSHIP,
        "foreground_threshold": contract.foreground_threshold,
        "protected_core_erosion_radius": CORE_EROSION_RADIUS,
        "frame_count": contract.frame_count,
        "frame_rate_denominator": contract.frame_rate_denominator,
        "frame_rate_numerator": contract.frame_rate_numerator,
        "height": contract.height,
        "rejected_input_types": list(REJECTED_INPUT_TYPES),
        "soft_mask_pattern": (
            "foreground_000000.png.."
            f"foreground_{final_index:06d}.png"
        ),
        "soft_mask_polarity": SOFT_MASK_POLARITY,
        "width": contract.width,
    }


def _qa_threshold_payload(contract: MatteContract) -> dict[str, float]:
    return {
        "maximum_border_foreground_ratio": (
            contract.maximum_border_foreground_ratio
        ),
        "maximum_centroid_jump_ratio": (
            contract.maximum_centroid_jump_ratio
        ),
        "maximum_foreground_area_ratio": (
            contract.maximum_foreground_area_ratio
        ),
        "minimum_foreground_area_ratio": (
            contract.minimum_foreground_area_ratio
        ),
    }


def _executable(name: str) -> str:
    resolved = shutil.which(name)
    if resolved is None:
        raise MatteInputError(f"required executable is unavailable: {name}")
    return resolved


def _version_line(executable: str) -> str:
    completed = subprocess.run(
        [executable, "-version"],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    first_line = completed.stdout.splitlines()
    if not first_line:
        raise MatteInputError(f"{Path(executable).name} version is empty")
    return first_line[0]


def _run(argv: Sequence[str]) -> str:
    try:
        completed = subprocess.run(
            list(argv),
            check=True,
            capture_output=True,
            text=True,
            timeout=FFMPEG_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError) as error:
        detail = ""
        if isinstance(error, subprocess.CalledProcessError):
            detail = (error.stderr or "").strip()
        message = "transparent matte media command failed"
        if detail:
            message = f"{message}: {detail}"
        raise MatteInputError(message) from error
    return completed.stdout


def _require_new_output(output_directory: Path) -> Path:
    target = Path(output_directory)
    if target.exists() or target.is_symlink():
        raise FileExistsError(
            f"temporal matte artifact directory already exists: {target}"
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def _require_sequence_order(
    frame_paths: Sequence[Path],
    *,
    contract: MatteContract,
) -> tuple[Path, ...]:
    paths = tuple(Path(path) for path in frame_paths)
    if len(paths) != contract.frame_count:
        raise MatteInputError(
            "RGBA PNG sequence must contain exactly "
            f"{contract.frame_count} frames"
        )
    if len({path.resolve() for path in paths}) != len(paths):
        raise MatteInputError("RGBA PNG sequence paths must be unique")
    parents = {path.resolve().parent for path in paths}
    if len(parents) != 1:
        raise MatteInputError("RGBA PNG sequence must share one directory")
    stems: set[str] = set()
    indices: list[int] = []
    for path in paths:
        match = _SEQUENCE_NAME.fullmatch(path.name)
        if match is None:
            raise MatteInputError(
                "RGBA PNG sequence names must end in _000000.png style indices"
            )
        stems.add(match.group("stem"))
        indices.append(int(match.group("index")))
    if len(stems) != 1 or indices != list(range(contract.frame_count)):
        raise MatteInputError(
            "RGBA PNG sequence order must be consecutive from index 000000"
        )
    return paths


def _require_rgba8_png_header(path: Path, contract: MatteContract) -> None:
    try:
        with path.open("rb") as handle:
            header = handle.read(33)
    except OSError as error:
        raise MatteInputError(f"RGBA source frame is unreadable: {path}") from error
    if (
        len(header) != 33
        or header[:8] != b"\x89PNG\r\n\x1a\n"
        or int.from_bytes(header[8:12], "big") != 13
        or header[12:16] != b"IHDR"
    ):
        raise MatteInputError("source frame must have a canonical PNG IHDR")
    width = int.from_bytes(header[16:20], "big")
    height = int.from_bytes(header[20:24], "big")
    bit_depth = header[24]
    color_type = header[25]
    if bit_depth != 8 or color_type != 6:
        raise MatteInputError(
            "source frame must be an 8-bit RGBA PNG without quantization"
        )
    if (width, height) != (contract.width, contract.height):
        raise MatteInputError(
            "RGBA source frame geometry must be "
            f"{contract.width}x{contract.height}"
        )


def _load_rgba(path: Path, contract: MatteContract) -> NDArray[np.uint8]:
    if not path.is_file():
        raise MatteInputError(f"RGBA source frame is missing: {path}")
    _require_rgba8_png_header(path, contract)
    try:
        with Image.open(path) as image:
            if (
                image.format != "PNG"
                or image.mode != "RGBA"
                or bool(getattr(image, "is_animated", False))
                or image.n_frames != 1
            ):
                raise MatteInputError(
                    "source frame must be a static RGBA PNG with explicit alpha"
                )
            if image.size != (contract.width, contract.height):
                raise MatteInputError(
                    "RGBA source frame geometry must be "
                    f"{contract.width}x{contract.height}"
                )
            array = np.array(image, dtype=np.uint8, copy=True)
    except (OSError, UnidentifiedImageError) as error:
        raise MatteInputError(f"RGBA source frame is unreadable: {path}") from error
    if array.shape != (contract.height, contract.width, 4):
        raise MatteInputError("RGBA source frame decoded shape is invalid")
    return np.ascontiguousarray(array)


def _load_l_png(
    path: Path,
    *,
    contract: MatteContract,
    role: str,
) -> NDArray[np.uint8]:
    try:
        with Image.open(path) as image:
            if (
                image.format != "PNG"
                or image.mode != "L"
                or bool(getattr(image, "is_animated", False))
                or image.n_frames != 1
            ):
                raise MatteIntegrityError(
                    f"{role} must remain a static single-channel PNG"
                )
            if image.size != (contract.width, contract.height):
                raise MatteIntegrityError(
                    f"{role} geometry no longer matches the matte contract"
                )
            array = np.array(image, dtype=np.uint8, copy=True)
    except (OSError, UnidentifiedImageError) as error:
        raise MatteIntegrityError(f"{role} is unreadable: {path}") from error
    return np.ascontiguousarray(array)


def _save_l_png(path: Path, grayscale: np.ndarray) -> None:
    if path.exists():
        raise FileExistsError(f"immutable matte artifact already exists: {path}")
    if grayscale.dtype != np.uint8 or grayscale.ndim != 2:
        raise MatteInputError("matte artifact must be a 2D uint8 array")
    Image.fromarray(
        np.ascontiguousarray(grayscale),
        mode="L",
    ).save(
        path,
        format="PNG",
        compress_level=9,
        optimize=False,
    )


def _frame_metric(
    alpha: np.ndarray,
    *,
    contract: MatteContract,
    previous_centroid: tuple[float, float] | None,
) -> _FrameMetric:
    foreground = np.ascontiguousarray(
        alpha >= np.uint8(contract.foreground_threshold)
    )
    area = int(np.count_nonzero(foreground))
    area_ratio = area / float(contract.width * contract.height)
    if area == 0:
        raise MattePlausibilityError(
            "temporal matte requires nonempty foreground on every frame"
        )
    try:
        protected_core = erode_to_core(
            foreground,
            radius=CORE_EROSION_RADIUS,
        )
    except EmptyCoreError as error:
        raise MattePlausibilityError(
            "temporal matte protected core is empty after frozen 4px erosion"
        ) from error
    ys, xs = np.nonzero(foreground)
    centroid_x = float(np.mean(xs, dtype=np.float64))
    centroid_y = float(np.mean(ys, dtype=np.float64))
    if previous_centroid is None:
        jump_ratio = 0.0
    else:
        jump_ratio = math.hypot(
            centroid_x - previous_centroid[0],
            centroid_y - previous_centroid[1],
        ) / math.hypot(contract.width, contract.height)
    edge_touches = {
        "bottom": bool(np.any(foreground[-1, :])),
        "left": bool(np.any(foreground[:, 0])),
        "right": bool(np.any(foreground[:, -1])),
        "top": bool(np.any(foreground[0, :])),
    }
    border = np.zeros(foreground.shape, dtype=np.bool_)
    border[0, :] = True
    border[-1, :] = True
    border[:, 0] = True
    border[:, -1] = True
    border_foreground_ratio = float(
        np.count_nonzero(foreground & border) / np.count_nonzero(border)
    )
    return _FrameMetric(
        foreground_area_pixels=area,
        foreground_area_ratio=_rounded(area_ratio),
        centroid_x=_rounded(centroid_x),
        centroid_y=_rounded(centroid_y),
        centroid_jump_ratio=_rounded(jump_ratio),
        edge_touches=edge_touches,
        border_foreground_ratio=_rounded(border_foreground_ratio),
        protected_core_pixels=int(np.count_nonzero(protected_core)),
    )


def _validate_metrics(
    metrics: Sequence[_FrameMetric],
    *,
    contract: MatteContract,
) -> None:
    if len(metrics) != contract.frame_count:
        raise MattePlausibilityError(
            "temporal matte QA frame count is incomplete"
        )
    for index, metric in enumerate(metrics):
        if (
            metric.border_foreground_ratio
            > contract.maximum_border_foreground_ratio
        ):
            raise MattePlausibilityError(
                "mask polarity is implausible because foreground dominates "
                f"the border on frame {index}"
            )
        if (
            metric.foreground_area_ratio
            > contract.maximum_foreground_area_ratio
        ):
            raise MattePlausibilityError(
                "mask polarity is implausible because foreground area is "
                f"too large on frame {index}"
            )
        if (
            metric.foreground_area_ratio
            < contract.minimum_foreground_area_ratio
        ):
            raise MattePlausibilityError(
                f"foreground area ratio is implausibly small on frame {index}"
            )
        if (
            metric.centroid_jump_ratio
            > contract.maximum_centroid_jump_ratio
        ):
            raise MattePlausibilityError(
                f"centroid jump is implausible on frame {index}"
            )


def _qa_payload(
    metrics: Sequence[_FrameMetric],
    *,
    contract: MatteContract,
) -> dict[str, object]:
    _validate_metrics(metrics, contract=contract)
    areas = [metric.foreground_area_ratio for metric in metrics]
    jumps = [metric.centroid_jump_ratio for metric in metrics]
    border_ratios = [metric.border_foreground_ratio for metric in metrics]
    protected_core_counts = [
        metric.protected_core_pixels for metric in metrics
    ]
    edge_frames = [
        index
        for index, metric in enumerate(metrics)
        if any(metric.edge_touches.values())
    ]
    return {
        "area_ratio_maximum": _rounded(max(areas)),
        "area_ratio_mean": _rounded(sum(areas) / len(areas)),
        "area_ratio_minimum": _rounded(min(areas)),
        "edge_touch_frame_count": len(edge_frames),
        "edge_touch_frame_indices": edge_frames,
        "every_frame_nonempty": True,
        "every_frame_nonempty_protected_core": True,
        "foreground_frame_count": len(metrics),
        "mask_polarity_check_passed": True,
        "maximum_border_foreground_ratio": _rounded(max(border_ratios)),
        "maximum_centroid_jump_ratio": _rounded(max(jumps)),
        "minimum_protected_core_pixels": min(protected_core_counts),
        "passed": True,
        "thresholds": _qa_threshold_payload(contract),
    }


def _frame_metric_payload(metric: _FrameMetric) -> dict[str, object]:
    return {
        "border_foreground_ratio": metric.border_foreground_ratio,
        "centroid_jump_ratio": metric.centroid_jump_ratio,
        "centroid_x": metric.centroid_x,
        "centroid_y": metric.centroid_y,
        "edge_touches": metric.edge_touches,
        "foreground_area_pixels": metric.foreground_area_pixels,
        "foreground_area_ratio": metric.foreground_area_ratio,
        "protected_core_pixels": metric.protected_core_pixels,
    }


def _ordered_source_digest(frames: Sequence[dict[str, object]]) -> str:
    projection = [
        {
            "index": frame["index"],
            "source_alpha_sha256": frame["source_alpha_sha256"],
            "source_file_sha256": frame["source_file_sha256"],
            "source_path": frame["source_path"],
            "source_rgba_sha256": frame["source_rgba_sha256"],
            "source_timestamp": frame["source_timestamp"],
        }
        for frame in frames
    ]
    return _sha256_bytes(_canonical_json_bytes(projection))


def _ordered_mask_digest(
    frames: Sequence[dict[str, object]],
    *,
    role: str,
) -> str:
    projection = [
        {
            "file_sha256": frame[f"{role}_file_sha256"],
            "index": frame["index"],
            "path": frame[f"{role}_path"],
            "pixels_sha256": frame[f"{role}_pixels_sha256"],
        }
        for frame in frames
    ]
    return _sha256_bytes(_canonical_json_bytes(projection))


def _source_frame_record(
    *,
    index: int,
    rgba: np.ndarray,
    source_path: Path,
    source_file_sha256: str,
    source_timestamp: str | None,
) -> dict[str, object]:
    alpha = np.ascontiguousarray(rgba[..., 3])
    return {
        "index": index,
        "source_alpha_sha256": _pixel_sha256(alpha),
        "source_file_sha256": source_file_sha256,
        "source_path": str(source_path.resolve()),
        "source_rgba_sha256": _pixel_sha256(rgba),
        "source_timestamp": source_timestamp,
    }


def _build_matte(
    *,
    decoded_rgba_paths: Sequence[Path],
    source_paths: Sequence[Path],
    source_file_hashes: Sequence[str],
    source_timestamps: Sequence[str | None],
    source_payload: dict[str, object],
    output_directory: Path,
    contract: MatteContract,
    require_transport_compatibility: bool,
) -> TemporalMatteResult:
    target = _require_new_output(output_directory)
    if not (
        len(decoded_rgba_paths)
        == len(source_paths)
        == len(source_file_hashes)
        == len(source_timestamps)
        == contract.frame_count
    ):
        raise MatteInputError("decoded matte source sequence is incomplete")

    source_records: list[dict[str, object]] = []
    metrics: list[_FrameMetric] = []
    previous_centroid: tuple[float, float] | None = None
    for index, decoded_path in enumerate(decoded_rgba_paths):
        rgba = _load_rgba(decoded_path, contract)
        if (
            decoded_path.resolve() == source_paths[index].resolve()
            and sha256_file(source_paths[index]) != source_file_hashes[index]
        ):
            raise MatteIntegrityError(
                f"source frame {index} changed during matte ingestion"
            )
        source_records.append(
            _source_frame_record(
                index=index,
                rgba=rgba,
                source_path=source_paths[index],
                source_file_sha256=source_file_hashes[index],
                source_timestamp=source_timestamps[index],
            )
        )
        metric = _frame_metric(
            rgba[..., 3],
            contract=contract,
            previous_centroid=previous_centroid,
        )
        metrics.append(metric)
        previous_centroid = (metric.centroid_x, metric.centroid_y)
    qa = _qa_payload(metrics, contract=contract)

    temporary = Path(
        tempfile.mkdtemp(prefix=f".{target.name}.tmp-", dir=str(target.parent))
    )
    finalized = False
    try:
        frame_records: list[dict[str, object]] = []
        soft_paths_in_temporary: list[Path] = []
        edit_paths_in_temporary: list[Path] = []
        for index, decoded_path in enumerate(decoded_rgba_paths):
            rgba = _load_rgba(decoded_path, contract)
            if (
                decoded_path.resolve() == source_paths[index].resolve()
                and sha256_file(source_paths[index])
                != source_file_hashes[index]
            ):
                raise MatteIntegrityError(
                    f"source frame {index} changed during matte materialization"
                )
            alpha = np.ascontiguousarray(rgba[..., 3])
            edit = np.where(
                alpha >= np.uint8(contract.foreground_threshold),
                0,
                255,
            ).astype(np.uint8)
            soft_temporary = temporary / f"{SOFT_MASK_STEM}_{index:06d}.png"
            edit_temporary = temporary / f"{EDIT_MASK_STEM}_{index:06d}.png"
            _save_l_png(soft_temporary, alpha)
            _save_l_png(edit_temporary, edit)
            soft_final = target / soft_temporary.name
            edit_final = target / edit_temporary.name
            record = dict(source_records[index])
            record.update(
                {
                    "edit_mask_file_sha256": sha256_file(edit_temporary),
                    "edit_mask_path": str(edit_final.resolve()),
                    "edit_mask_pixels_sha256": _pixel_sha256(edit),
                    "soft_mask_file_sha256": sha256_file(soft_temporary),
                    "soft_mask_path": str(soft_final.resolve()),
                    "soft_mask_pixels_sha256": _pixel_sha256(alpha),
                }
            )
            record.update(_frame_metric_payload(metrics[index]))
            frame_records.append(record)
            soft_paths_in_temporary.append(soft_temporary)
            edit_paths_in_temporary.append(edit_temporary)

        transport_compatible = False
        if require_transport_compatibility:
            if contract != CANONICAL_TEMPORAL_MATTE_CONTRACT:
                raise MatteInputError(
                    "VACE mask transport compatibility requires the canonical "
                    "121-frame 1280x720 contract"
                )
            _validate_authoritative_masks(edit_paths_in_temporary)
            transport_compatible = True

        source_payload = dict(source_payload)
        source_payload["ordered_frame_digest_sha256"] = (
            _ordered_source_digest(frame_records)
        )
        manifest: dict[str, object] = {
            "artifact_root": str(target.resolve()),
            "artifacts": {
                "edit_mask_ordered_digest_sha256": _ordered_mask_digest(
                    frame_records,
                    role="edit_mask",
                ),
                "soft_mask_ordered_digest_sha256": _ordered_mask_digest(
                    frame_records,
                    role="soft_mask",
                ),
                "vace_transport_compatible": transport_compatible,
                "vace_transport_validator": (
                    "framelock_media.ffmpeg_pipeline."
                    "_validate_authoritative_masks"
                    if require_transport_compatibility
                    else None
                ),
            },
            "contract": _contract_payload(contract),
            "frames": frame_records,
            "qa": qa,
            "schema_version": 1,
            "source": source_payload,
        }
        manifest["digest_sha256"] = _sha256_bytes(
            _canonical_json_bytes(manifest)
        )
        manifest_path = temporary / MANIFEST_NAME
        with manifest_path.open("xb") as handle:
            handle.write(
                (
                    json.dumps(manifest, indent=2, sort_keys=True) + "\n"
                ).encode("utf-8")
            )
        os.replace(temporary, target)
        finalized = True
    finally:
        if not finalized:
            shutil.rmtree(temporary, ignore_errors=True)

    return _verify_temporal_matte(
        target / MANIFEST_NAME,
        expected_contract=contract,
        require_transport_compatibility=require_transport_compatibility,
    )


def _sequence_source_payload(paths: Sequence[Path]) -> dict[str, object]:
    return {
        "decode_pass_count": 0,
        "deterministic_decode_passed": True,
        "kind": "rgba_png_sequence",
        "normalization_operation": "extract_alpha_without_resampling",
        "source_artifact_count": len(paths),
    }


def _ingest_rgba_png_sequence(
    frame_paths: Sequence[Path],
    output_directory: Path,
    *,
    contract: MatteContract,
    require_transport_compatibility: bool,
) -> TemporalMatteResult:
    paths = _require_sequence_order(frame_paths, contract=contract)
    # Validate all inputs before the immutable output directory is created.
    for path in paths:
        _load_rgba(path, contract)
    hashes = tuple(sha256_file(path) for path in paths)
    return _build_matte(
        decoded_rgba_paths=paths,
        source_paths=paths,
        source_file_hashes=hashes,
        source_timestamps=(None,) * contract.frame_count,
        source_payload=_sequence_source_payload(paths),
        output_directory=output_directory,
        contract=contract,
        require_transport_compatibility=require_transport_compatibility,
    )


def ingest_rgba_png_sequence(
    frame_paths: Sequence[Path],
    output_directory: Path,
) -> TemporalMatteResult:
    """Extract a canonical soft-alpha and VACE edit-mask sequence.

    Accepted sequence inputs are exactly 121 ordered, static RGBA PNGs at
    1280x720. Alpha is copied byte-for-byte; no frame, geometry, timing or
    alpha synthesis is allowed.
    """
    return _ingest_rgba_png_sequence(
        frame_paths,
        output_directory,
        contract=CANONICAL_TEMPORAL_MATTE_CONTRACT,
        require_transport_compatibility=True,
    )


def _parse_fraction(value: object, *, role: str) -> Fraction:
    if not isinstance(value, str):
        raise MatteInputError(f"transparent video {role} is missing")
    try:
        fraction = Fraction(value)
    except (ValueError, ZeroDivisionError) as error:
        raise MatteInputError(f"transparent video {role} is invalid") from error
    if fraction <= 0:
        raise MatteInputError(f"transparent video {role} must be positive")
    return fraction


def _is_alpha_pixel_format_family(pixel_format: str) -> bool:
    return (
        pixel_format in {"abgr", "argb", "bgra", "rgba"}
        or pixel_format.startswith("gbrap")
        or pixel_format.startswith("yuva")
        or pixel_format.startswith("ya")
    )


def _explicit_alpha_mode(stream: dict[str, object]) -> object | None:
    tags = stream.get("tags")
    if not isinstance(tags, dict):
        return None
    matches = [
        value
        for key, value in tags.items()
        if isinstance(key, str) and key.casefold() == "alpha_mode"
    ]
    if not matches:
        return None
    normalized_values = {str(value) for value in matches}
    if len(normalized_values) != 1:
        raise MatteInputError(
            "transparent video alpha mode metadata conflicts"
        )
    return matches[0]


def _rotation_degrees(stream: dict[str, object]) -> int:
    values: list[int] = []
    tags = stream.get("tags")
    if isinstance(tags, dict) and tags.get("rotate") not in {None, ""}:
        try:
            values.append(int(str(tags["rotate"])))
        except ValueError as error:
            raise MatteInputError(
                "transparent video rotation tag is invalid"
            ) from error
    side_data = stream.get("side_data_list")
    if isinstance(side_data, list):
        for entry in side_data:
            if not isinstance(entry, dict) or "rotation" not in entry:
                continue
            try:
                values.append(int(entry["rotation"]))
            except (TypeError, ValueError) as error:
                raise MatteInputError(
                    "transparent video display rotation is invalid"
                ) from error
    if len(set(values)) > 1:
        raise MatteInputError("transparent video rotation metadata conflicts")
    rotation = values[0] if values else 0
    if rotation != 0:
        raise MatteInputError("transparent video rotation must be zero")
    return rotation


def _square_sample_aspect_ratio(
    stream: dict[str, object],
) -> tuple[str, str]:
    value = stream.get("sample_aspect_ratio")
    if value in {None, "", "N/A", "0:1", "0/1"}:
        return "1/1", "absent_treated_as_square"
    if not isinstance(value, str):
        raise MatteInputError(
            "transparent video sample aspect ratio is invalid"
        )
    try:
        ratio = Fraction(value.replace(":", "/"))
    except (ValueError, ZeroDivisionError) as error:
        raise MatteInputError(
            "transparent video sample aspect ratio is invalid"
        ) from error
    if ratio != Fraction(1, 1):
        raise MatteInputError(
            "transparent video sample aspect ratio must be 1:1"
        )
    return "1/1", "declared_square"


def _probe_transparent_video(
    path: Path,
    *,
    contract: MatteContract,
) -> _VideoProbe:
    if not path.is_file():
        raise MatteInputError(f"transparent video is missing: {path}")
    suffix = path.suffix.lower()
    if suffix == ".mp4":
        raise MatteInputError(
            "MP4 is rejected as an authoritative alpha source; provide an "
            "RGBA PNG sequence, transparent WebM or transparent MOV"
        )
    if suffix not in {".mov", ".webm"}:
        raise MatteInputError(
            "transparent video input must be a WebM or MOV container"
        )
    ffprobe = _executable("ffprobe")
    argv = (
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-count_frames",
        "-show_streams",
        "-show_frames",
        "-show_format",
        "-show_entries",
        (
            "stream=codec_name,pix_fmt,width,height,r_frame_rate,"
            "avg_frame_rate,time_base,nb_read_frames,sample_aspect_ratio:"
            "stream_tags=alpha_mode,rotate:"
            "stream_side_data=rotation,displaymatrix:"
            "frame=pts,best_effort_timestamp,width,height,pix_fmt:"
            "format=format_name"
        ),
        "-of",
        "json",
        str(path),
    )
    raw = _run(argv)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise MatteInputError(
            "transparent video probe returned invalid JSON"
        ) from error
    streams = payload.get("streams")
    frames = payload.get("frames")
    format_payload = payload.get("format")
    if (
        not isinstance(streams, list)
        or len(streams) != 1
        or not isinstance(streams[0], dict)
        or not isinstance(frames, list)
        or not isinstance(format_payload, dict)
    ):
        raise MatteInputError(
            "transparent video must expose one decodable video stream"
        )
    stream = streams[0]
    if (
        stream.get("width") != contract.width
        or stream.get("height") != contract.height
    ):
        raise MatteInputError(
            "transparent video geometry must be "
            f"{contract.width}x{contract.height}"
        )
    if len(frames) != contract.frame_count:
        raise MatteInputError(
            "transparent video must decode to exactly "
            f"{contract.frame_count} frames"
        )
    if _parse_fraction(stream.get("r_frame_rate"), role="frame rate") != (
        contract.frame_rate
    ):
        raise MatteInputError(
            f"transparent video frame rate must be {contract.frame_rate}"
        )
    average_rate = _parse_fraction(
        stream.get("avg_frame_rate"),
        role="average frame rate",
    )
    if average_rate != contract.frame_rate:
        raise MatteInputError(
            f"transparent video average frame rate must be {contract.frame_rate}"
        )
    time_base = _parse_fraction(stream.get("time_base"), role="time base")
    timestamp_values: list[Fraction] = []
    timestamp_tokens: list[str] = []
    for index, raw_frame in enumerate(frames):
        if not isinstance(raw_frame, dict):
            raise MatteInputError(f"transparent video frame {index} is malformed")
        if (
            raw_frame.get("width") != contract.width
            or raw_frame.get("height") != contract.height
        ):
            raise MatteInputError(
                f"transparent video frame {index} changes geometry"
            )
        pts = raw_frame.get("pts")
        if pts is None:
            pts = raw_frame.get("best_effort_timestamp")
        try:
            exact = int(pts) * time_base
        except (TypeError, ValueError) as error:
            raise MatteInputError(
                f"transparent video frame {index} lacks an integer timestamp"
            ) from error
        timestamp_values.append(exact)
        timestamp_tokens.append(f"{exact.numerator}/{exact.denominator}")
    if any(
        current <= previous
        for previous, current in zip(
            timestamp_values,
            timestamp_values[1:],
        )
    ):
        raise MatteInputError(
            "transparent video frame order must have increasing timestamps"
        )
    start = timestamp_values[0]
    expected_interval = Fraction(1, 1) / contract.frame_rate
    residual = max(
        abs(float((timestamp - start) - index * expected_interval))
        for index, timestamp in enumerate(timestamp_values)
    )
    if residual > CANONICAL_CONTRACT.max_pts_residual_seconds:
        raise MatteInputError(
            "transparent video timestamps differ from the 24 FPS order"
        )

    source_codec = str(stream.get("codec_name", "unknown"))
    source_pixel_format = str(stream.get("pix_fmt", "unknown"))
    rotation_degrees = _rotation_degrees(stream)
    sample_aspect_ratio, sample_aspect_ratio_basis = (
        _square_sample_aspect_ratio(stream)
    )
    alpha_mode = _explicit_alpha_mode(stream)
    has_pixel_alpha = (
        source_pixel_format in EIGHT_BIT_DIRECT_ALPHA_PIXEL_FORMATS
    )
    has_webm_alpha = (
        suffix == ".webm"
        and source_codec in {"vp8", "vp9"}
        and str(alpha_mode) == "1"
        and source_pixel_format in EIGHT_BIT_WEBM_COLOR_PIXEL_FORMATS
    )
    if (
        _is_alpha_pixel_format_family(source_pixel_format)
        and not has_pixel_alpha
    ) or (
        suffix == ".webm"
        and str(alpha_mode) == "1"
        and source_pixel_format not in EIGHT_BIT_WEBM_COLOR_PIXEL_FORMATS
    ):
        raise MatteInputError(
            "transparent video alpha must be an explicitly supported 8-bit alpha"
        )
    accepted_alpha = has_webm_alpha if suffix == ".webm" else has_pixel_alpha
    if not accepted_alpha:
        raise MatteInputError(
            "transparent video stream does not signal an authoritative alpha plane"
        )
    frame_pixel_formats = {
        str(raw_frame.get("pix_fmt", "unknown"))
        for raw_frame in frames
        if isinstance(raw_frame, dict)
    }
    if frame_pixel_formats != {source_pixel_format}:
        raise MatteInputError(
            "transparent video frame pixel formats differ from the 8-bit stream"
        )
    format_name = str(format_payload.get("format_name", ""))
    if suffix == ".webm" and not any(
        token in format_name for token in ("matroska", "webm")
    ):
        raise MatteInputError("WebM extension does not match its container")
    if suffix == ".mov" and "mov" not in format_name:
        raise MatteInputError("MOV extension does not match its container")
    return _VideoProbe(
        source_kind="transparent_webm" if suffix == ".webm" else "transparent_mov",
        source_codec=source_codec,
        source_pixel_format=source_pixel_format,
        alpha_signal=(
            f"stream_tag_alpha_mode={alpha_mode}"
            if has_webm_alpha
            else f"pixel_format={source_pixel_format}"
        ),
        alpha_bit_depth=8,
        rotation_degrees=rotation_degrees,
        sample_aspect_ratio=sample_aspect_ratio,
        sample_aspect_ratio_basis=sample_aspect_ratio_basis,
        presentation_timestamps=tuple(timestamp_tokens),
        probe_argv=argv,
        probe_json_sha256=_sha256_bytes(raw.encode("utf-8")),
        ffprobe_executable=ffprobe,
        ffprobe_version=_version_line(ffprobe),
    )


def _validate_decode_argv_template(
    argv: Sequence[str],
    *,
    probe: _VideoProbe,
) -> None:
    tokens = tuple(argv)
    forbidden_options = {
        "-filter:v",
        "-filter_complex",
        "-frames:v",
        "-r",
        "-s",
        "-vf",
    }
    if any(token in forbidden_options for token in tokens) or any(
        "scale=" in token or "fps=" in token for token in tokens
    ):
        raise MatteInputError(
            "transparent alpha decode must not normalize frames or geometry"
        )
    required_pairs = {
        ("-fps_mode", "passthrough"),
        ("-pix_fmt", "rgba"),
    }
    adjacent_pairs = set(zip(tokens, tokens[1:]))
    if (
        not required_pairs.issubset(adjacent_pairs)
        or "-noautorotate" not in tokens
        or tokens[-1] != "{output_directory}/decoded_%06d.png"
    ):
        raise MatteInputError(
            "transparent alpha decode recipe is not canonical"
        )
    if probe.source_kind == "transparent_webm":
        expected_decoder = (
            "libvpx-vp9" if probe.source_codec == "vp9" else "libvpx"
        )
        input_index = tokens.index("-i")
        decoder_pairs = set(zip(tokens[:input_index], tokens[1:input_index]))
        if ("-c:v", expected_decoder) not in decoder_pairs:
            raise MatteInputError(
                "transparent WebM decode must use the explicit libvpx decoder"
            )


def _decode_transparent_video(
    path: Path,
    output_directory: Path,
    *,
    probe: _VideoProbe,
    contract: MatteContract,
) -> _DecodedVideoPass:
    output_directory.mkdir(parents=True, exist_ok=False)
    ffmpeg = _executable("ffmpeg")
    decoder: tuple[str, ...] = ()
    if probe.source_kind == "transparent_webm":
        decoder_name = "libvpx-vp9" if probe.source_codec == "vp9" else "libvpx"
        decoder = ("-c:v", decoder_name)
    output_pattern = output_directory / "decoded_%06d.png"
    argv = (
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-xerror",
        *decoder,
        "-threads:v",
        "1",
        "-noautorotate",
        "-i",
        str(path),
        "-map",
        "0:v:0",
        "-an",
        "-sn",
        "-dn",
        "-fps_mode",
        "passthrough",
        "-c:v",
        "png",
        "-pix_fmt",
        "rgba",
        "-compression_level",
        "9",
        "-pred",
        "mixed",
        "-threads:v",
        "1",
        "-start_number",
        "0",
        "-f",
        "image2",
        "-n",
        str(output_pattern),
    )
    argv_template = tuple(
        "{output_directory}/decoded_%06d.png"
        if token == str(output_pattern)
        else token
        for token in argv
    )
    _validate_decode_argv_template(argv_template, probe=probe)
    _run(argv)
    expected = tuple(
        output_directory / f"decoded_{index:06d}.png"
        for index in range(contract.frame_count)
    )
    if tuple(sorted(output_directory.glob("*.png"))) != expected:
        raise MatteInputError(
            "transparent video decode did not produce the exact ordered sequence"
        )
    hashes: list[str] = []
    alpha_hashes: list[str] = []
    for frame_path in expected:
        rgba = _load_rgba(frame_path, contract)
        hashes.append(_pixel_sha256(rgba))
        alpha_hashes.append(_pixel_sha256(rgba[..., 3]))
    return _DecodedVideoPass(
        paths=expected,
        rgba_hashes=tuple(hashes),
        alpha_hashes=tuple(alpha_hashes),
        argv=argv,
        argv_template=argv_template,
        ffmpeg_executable=ffmpeg,
        ffmpeg_version=_version_line(ffmpeg),
    )


def _require_video_source_hash(
    path: Path,
    expected_sha256: str,
    *,
    stage: str,
    error_type: type[TemporalMatteError],
) -> None:
    if not path.is_file() or sha256_file(path) != expected_sha256:
        raise error_type(
            f"transparent video source changed during {stage}"
        )


def _fresh_video_evidence(
    path: Path,
    expected_sha256: str,
    *,
    contract: MatteContract,
    error_type: type[TemporalMatteError],
) -> _FreshVideoEvidence:
    try:
        _require_video_source_hash(
            path,
            expected_sha256,
            stage="fresh verification start",
            error_type=error_type,
        )
        probe = _probe_transparent_video(path, contract=contract)
        _require_video_source_hash(
            path,
            expected_sha256,
            stage="fresh probe",
            error_type=error_type,
        )
        with tempfile.TemporaryDirectory(
            prefix="framelock-alpha-reverify-"
        ) as raw:
            root = Path(raw)
            first = _decode_transparent_video(
                path,
                root / "pass-1",
                probe=probe,
                contract=contract,
            )
            _require_video_source_hash(
                path,
                expected_sha256,
                stage="fresh first decode",
                error_type=error_type,
            )
            second = _decode_transparent_video(
                path,
                root / "pass-2",
                probe=probe,
                contract=contract,
            )
            _require_video_source_hash(
                path,
                expected_sha256,
                stage="fresh second decode",
                error_type=error_type,
            )
            if (
                first.rgba_hashes != second.rgba_hashes
                or first.alpha_hashes != second.alpha_hashes
                or first.argv_template != second.argv_template
            ):
                raise error_type(
                    "fresh transparent video decode is not deterministic"
                )
        return _FreshVideoEvidence(probe=probe, decoded=first)
    except MatteInputError as error:
        if error_type is MatteInputError:
            raise
        raise error_type(
            f"fresh transparent video verification failed: {error}"
        ) from error


def _ingest_transparent_video(
    video_path: Path,
    output_directory: Path,
    *,
    contract: MatteContract,
    require_transport_compatibility: bool,
) -> TemporalMatteResult:
    path = Path(video_path).resolve()
    if not path.is_file():
        raise MatteInputError(f"transparent video is missing: {path}")
    initial_file_hash = sha256_file(path)
    probe = _probe_transparent_video(path, contract=contract)
    _require_video_source_hash(
        path,
        initial_file_hash,
        stage="probe",
        error_type=MatteInputError,
    )
    with tempfile.TemporaryDirectory(prefix="framelock-alpha-decode-") as raw:
        root = Path(raw)
        first = _decode_transparent_video(
            path,
            root / "pass-1",
            probe=probe,
            contract=contract,
        )
        _require_video_source_hash(
            path,
            initial_file_hash,
            stage="first decode",
            error_type=MatteInputError,
        )
        second = _decode_transparent_video(
            path,
            root / "pass-2",
            probe=probe,
            contract=contract,
        )
        _require_video_source_hash(
            path,
            initial_file_hash,
            stage="second decode",
            error_type=MatteInputError,
        )
        if (
            first.rgba_hashes != second.rgba_hashes
            or first.alpha_hashes != second.alpha_hashes
            or first.argv_template != second.argv_template
        ):
            raise MatteInputError(
                "transparent video alpha decode is not deterministic"
            )
        source_payload: dict[str, object] = {
            "alpha_signal": probe.alpha_signal,
            "alpha_bit_depth": probe.alpha_bit_depth,
            "decode_algorithm_id": TRANSPARENT_DECODE_ALGORITHM_ID,
            "decode_argv_template": list(first.argv_template),
            "decode_pass_count": 2,
            "deterministic_decode_passed": True,
            "ffmpeg_executable": first.ffmpeg_executable,
            "ffmpeg_version": first.ffmpeg_version,
            "ffprobe_executable": probe.ffprobe_executable,
            "ffprobe_version": probe.ffprobe_version,
            "kind": probe.source_kind,
            "normalization_operation": (
                "decode_rgba_without_resampling_then_extract_alpha"
            ),
            "presentation_timestamps_sha256": _sha256_bytes(
                "\n".join(probe.presentation_timestamps).encode("ascii")
            ),
            "probe_argv": list(probe.probe_argv),
            "probe_json_sha256": probe.probe_json_sha256,
            "rotation_degrees": probe.rotation_degrees,
            "sample_aspect_ratio": probe.sample_aspect_ratio,
            "sample_aspect_ratio_basis": probe.sample_aspect_ratio_basis,
            "source_codec": probe.source_codec,
            "source_file_sha256": initial_file_hash,
            "source_path": str(path),
            "source_pixel_format": probe.source_pixel_format,
        }
        result = _build_matte(
            decoded_rgba_paths=first.paths,
            source_paths=(path,) * contract.frame_count,
            source_file_hashes=(initial_file_hash,) * contract.frame_count,
            source_timestamps=probe.presentation_timestamps,
            source_payload=source_payload,
            output_directory=output_directory,
            contract=contract,
            require_transport_compatibility=require_transport_compatibility,
        )
        _require_video_source_hash(
            path,
            initial_file_hash,
            stage="sealed matte verification",
            error_type=MatteInputError,
        )
        return result


def ingest_transparent_video(
    video_path: Path,
    output_directory: Path,
) -> TemporalMatteResult:
    """Decode a canonical transparent WebM/MOV twice and freeze its alpha.

    MP4 is intentionally rejected because its ordinary H.264/H.265 transport
    does not provide a trustworthy alpha plane for this proof boundary.
    """
    return _ingest_transparent_video(
        video_path,
        output_directory,
        contract=CANONICAL_TEMPORAL_MATTE_CONTRACT,
        require_transport_compatibility=True,
    )


def _require_sha256(value: object, *, role: str) -> str:
    if not isinstance(value, str) or _HEX_SHA256.fullmatch(value) is None:
        raise MatteIntegrityError(f"{role} SHA-256 is malformed")
    return value


def _load_manifest(path: Path) -> dict[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise MatteIntegrityError("temporal matte manifest is unreadable") from error
    if (
        not isinstance(payload, dict)
        or set(payload) != _MANIFEST_KEYS
        or payload.get("schema_version") != 1
    ):
        raise MatteIntegrityError("temporal matte manifest schema is invalid")
    declared = _require_sha256(
        payload.get("digest_sha256"),
        role="manifest digest",
    )
    unsigned = dict(payload)
    unsigned.pop("digest_sha256", None)
    if declared != _sha256_bytes(_canonical_json_bytes(unsigned)):
        raise MatteIntegrityError("temporal matte manifest digest differs")
    return payload


def _verify_temporal_matte(
    manifest_path: Path,
    *,
    expected_contract: MatteContract,
    require_transport_compatibility: bool,
) -> TemporalMatteResult:
    path = Path(manifest_path)
    payload = _load_manifest(path)
    if payload.get("contract") != _contract_payload(expected_contract):
        raise MatteIntegrityError("temporal matte contract differs")
    root = path.parent.resolve()
    if payload.get("artifact_root") != str(root):
        raise MatteIntegrityError("temporal matte artifact root differs")
    if path.name != MANIFEST_NAME:
        raise MatteIntegrityError("temporal matte manifest name is noncanonical")
    expected_names = {MANIFEST_NAME}
    expected_names.update(
        f"{SOFT_MASK_STEM}_{index:06d}.png"
        for index in range(expected_contract.frame_count)
    )
    expected_names.update(
        f"{EDIT_MASK_STEM}_{index:06d}.png"
        for index in range(expected_contract.frame_count)
    )
    try:
        children = tuple(root.iterdir())
    except OSError as error:
        raise MatteIntegrityError(
            "temporal matte artifact root is unreadable"
        ) from error
    if (
        {child.name for child in children} != expected_names
        or any(not child.is_file() for child in children)
    ):
        raise MatteIntegrityError(
            "temporal matte artifact tree contains missing or unbound files"
        )
    raw_source = payload.get("source")
    raw_frames = payload.get("frames")
    raw_artifacts = payload.get("artifacts")
    if (
        not isinstance(raw_source, dict)
        or not isinstance(raw_frames, list)
        or not isinstance(raw_artifacts, dict)
        or len(raw_frames) != expected_contract.frame_count
    ):
        raise MatteIntegrityError("temporal matte manifest records are malformed")
    source_kind = raw_source.get("kind")
    if source_kind not in ACCEPTED_INPUT_TYPES:
        raise MatteIntegrityError("temporal matte source kind is unsupported")
    if set(raw_artifacts) != _ARTIFACT_KEYS:
        raise MatteIntegrityError("temporal matte artifact schema differs")
    video_source_path: str | None = None
    video_source_hash: str | None = None
    fresh_video: _FreshVideoEvidence | None = None
    if source_kind == "rgba_png_sequence":
        if (
            set(raw_source) != _SEQUENCE_SOURCE_KEYS
            or raw_source.get("decode_pass_count") != 0
            or raw_source.get("deterministic_decode_passed") is not True
            or raw_source.get("normalization_operation")
            != "extract_alpha_without_resampling"
            or raw_source.get("source_artifact_count")
            != expected_contract.frame_count
        ):
            raise MatteIntegrityError(
                "RGBA sequence source evidence is incomplete"
            )
    else:
        if set(raw_source) != _VIDEO_SOURCE_KEYS:
            raise MatteIntegrityError(
                "transparent video source schema differs"
            )
        video_source_path_value = raw_source.get("source_path")
        if not isinstance(video_source_path_value, str):
            raise MatteIntegrityError("video source path is malformed")
        video_source_path = str(Path(video_source_path_value).resolve())
        if video_source_path_value != video_source_path:
            raise MatteIntegrityError("video source path must be absolute")
        video_source_hash = _require_sha256(
            raw_source.get("source_file_sha256"),
            role="video source file",
        )
        probe_argv = raw_source.get("probe_argv")
        decode_argv_template = raw_source.get("decode_argv_template")
        expected_suffix = ".webm" if source_kind == "transparent_webm" else ".mov"
        if (
            raw_source.get("deterministic_decode_passed") is not True
            or raw_source.get("decode_pass_count") != 2
            or raw_source.get("decode_algorithm_id")
            != TRANSPARENT_DECODE_ALGORITHM_ID
            or raw_source.get("normalization_operation")
            != "decode_rgba_without_resampling_then_extract_alpha"
            or raw_source.get("alpha_bit_depth") != 8
            or raw_source.get("rotation_degrees") != 0
            or raw_source.get("sample_aspect_ratio") != "1/1"
            or raw_source.get("sample_aspect_ratio_basis")
            not in {"declared_square", "absent_treated_as_square"}
            or not raw_source.get("alpha_signal")
            or not isinstance(probe_argv, list)
            or not probe_argv
            or not all(isinstance(value, str) and value for value in probe_argv)
            or not isinstance(decode_argv_template, list)
            or not decode_argv_template
            or not all(
                isinstance(value, str) and value
                for value in decode_argv_template
            )
            or Path(video_source_path).suffix.lower() != expected_suffix
        ):
            raise MatteIntegrityError(
                "transparent video decode evidence is incomplete"
            )
        for field in (
            "ffmpeg_executable",
            "ffmpeg_version",
            "ffprobe_executable",
            "ffprobe_version",
            "source_codec",
            "source_pixel_format",
        ):
            if not isinstance(raw_source.get(field), str) or not raw_source[field]:
                raise MatteIntegrityError(
                    f"transparent video {field} evidence is missing"
                )
        _require_sha256(
            raw_source.get("presentation_timestamps_sha256"),
            role="video presentation timestamps",
        )
        _require_sha256(
            raw_source.get("probe_json_sha256"),
            role="video probe JSON",
        )
        fresh_video = _fresh_video_evidence(
            Path(video_source_path),
            video_source_hash,
            contract=expected_contract,
            error_type=MatteIntegrityError,
        )
        fresh_probe = fresh_video.probe
        presentation_timestamps_sha256 = _sha256_bytes(
            "\n".join(fresh_probe.presentation_timestamps).encode("ascii")
        )
        probe_bindings: dict[str, object] = {
            "alpha_bit_depth": fresh_probe.alpha_bit_depth,
            "alpha_signal": fresh_probe.alpha_signal,
            "ffprobe_executable": fresh_probe.ffprobe_executable,
            "ffprobe_version": fresh_probe.ffprobe_version,
            "kind": fresh_probe.source_kind,
            "presentation_timestamps_sha256": (
                presentation_timestamps_sha256
            ),
            "probe_argv": list(fresh_probe.probe_argv),
            "probe_json_sha256": fresh_probe.probe_json_sha256,
            "rotation_degrees": fresh_probe.rotation_degrees,
            "sample_aspect_ratio": fresh_probe.sample_aspect_ratio,
            "sample_aspect_ratio_basis": (
                fresh_probe.sample_aspect_ratio_basis
            ),
            "source_codec": fresh_probe.source_codec,
            "source_pixel_format": fresh_probe.source_pixel_format,
        }
        for field, expected in probe_bindings.items():
            if raw_source.get(field) != expected:
                raise MatteIntegrityError(
                    f"fresh transparent video probe differs: {field}"
                )
        decoded_bindings: dict[str, object] = {
            "decode_argv_template": list(
                fresh_video.decoded.argv_template
            ),
            "ffmpeg_executable": (
                fresh_video.decoded.ffmpeg_executable
            ),
            "ffmpeg_version": fresh_video.decoded.ffmpeg_version,
        }
        for field, expected in decoded_bindings.items():
            if raw_source.get(field) != expected:
                raise MatteIntegrityError(
                    f"fresh transparent video decode differs: {field}"
                )

    frames: list[dict[str, object]] = []
    metrics: list[_FrameMetric] = []
    previous_centroid: tuple[float, float] | None = None
    sequence_source_paths: list[Path] = []
    edit_paths: list[Path] = []
    soft_paths: list[Path] = []
    for index, raw_frame in enumerate(raw_frames):
        if (
            not isinstance(raw_frame, dict)
            or set(raw_frame) != _FRAME_KEYS
            or raw_frame.get("index") != index
        ):
            raise MatteIntegrityError(
                "temporal matte frame order or indices differ"
            )
        frame = dict(raw_frame)
        soft_path = root / f"{SOFT_MASK_STEM}_{index:06d}.png"
        edit_path = root / f"{EDIT_MASK_STEM}_{index:06d}.png"
        if frame.get("soft_mask_path") != str(soft_path):
            raise MatteIntegrityError("soft mask path sequence differs")
        if frame.get("edit_mask_path") != str(edit_path):
            raise MatteIntegrityError("edit mask path sequence differs")
        if not soft_path.is_file() or not edit_path.is_file():
            raise MatteIntegrityError("temporal matte artifact is missing")
        if sha256_file(soft_path) != _require_sha256(
            frame.get("soft_mask_file_sha256"),
            role="soft mask file",
        ):
            raise MatteIntegrityError("soft mask file hash differs")
        if sha256_file(edit_path) != _require_sha256(
            frame.get("edit_mask_file_sha256"),
            role="edit mask file",
        ):
            raise MatteIntegrityError("edit mask file hash differs")
        soft = _load_l_png(
            soft_path,
            contract=expected_contract,
            role="soft mask",
        )
        edit = _load_l_png(
            edit_path,
            contract=expected_contract,
            role="edit mask",
        )
        if _pixel_sha256(soft) != _require_sha256(
            frame.get("soft_mask_pixels_sha256"),
            role="soft mask pixels",
        ):
            raise MatteIntegrityError("soft mask pixel hash differs")
        if _pixel_sha256(edit) != _require_sha256(
            frame.get("edit_mask_pixels_sha256"),
            role="edit mask pixels",
        ):
            raise MatteIntegrityError("edit mask pixel hash differs")
        expected_edit = np.where(
            soft >= np.uint8(expected_contract.foreground_threshold),
            0,
            255,
        ).astype(np.uint8)
        if not np.array_equal(edit, expected_edit):
            raise MatteIntegrityError(
                "edit mask polarity no longer derives from the soft alpha"
            )
        if set(np.unique(edit).tolist()) != {0, 255}:
            raise MatteIntegrityError(
                "edit mask must contain both canonical binary values"
            )

        source_path_value = frame.get("source_path")
        if not isinstance(source_path_value, str):
            raise MatteIntegrityError("source frame path is malformed")
        source_path = Path(source_path_value)
        source_file_hash = _require_sha256(
            frame.get("source_file_sha256"),
            role="source file",
        )
        if source_kind == "rgba_png_sequence":
            if (
                not source_path.is_file()
                or sha256_file(source_path) != source_file_hash
            ):
                raise MatteIntegrityError("source artifact file hash differs")
            if frame.get("source_timestamp") is not None:
                raise MatteIntegrityError(
                    "RGBA sequence must not invent presentation timestamps"
                )
            sequence_source_paths.append(source_path)
            rgba = _load_rgba(source_path, expected_contract)
            if _pixel_sha256(rgba) != _require_sha256(
                frame.get("source_rgba_sha256"),
                role="source RGBA pixels",
            ):
                raise MatteIntegrityError("source RGBA pixel hash differs")
            source_alpha = np.ascontiguousarray(rgba[..., 3])
            if _pixel_sha256(source_alpha) != _require_sha256(
                frame.get("source_alpha_sha256"),
                role="source alpha pixels",
            ):
                raise MatteIntegrityError("source alpha pixel hash differs")
            if not np.array_equal(source_alpha, soft):
                raise MatteIntegrityError(
                    "soft mask no longer equals its source alpha"
                )
        else:
            if fresh_video is None:
                raise MatteIntegrityError(
                    "fresh transparent video evidence is missing"
                )
            if (
                frame.get("source_path") != video_source_path
                or source_file_hash != video_source_hash
            ):
                raise MatteIntegrityError(
                    "decoded video frame source binding differs"
                )
            source_rgba_sha256 = _require_sha256(
                frame.get("source_rgba_sha256"),
                role="decoded source RGBA pixels",
            )
            source_alpha_sha256 = _require_sha256(
                frame.get("source_alpha_sha256"),
                role="decoded source alpha pixels",
            )
            if (
                source_rgba_sha256
                != fresh_video.decoded.rgba_hashes[index]
            ):
                raise MatteIntegrityError(
                    f"fresh decoded RGBA differs on frame {index}"
                )
            if (
                source_alpha_sha256
                != fresh_video.decoded.alpha_hashes[index]
                or source_alpha_sha256 != _pixel_sha256(soft)
            ):
                raise MatteIntegrityError(
                    f"fresh decoded alpha differs from soft mask {index}"
                )
            if frame.get("source_timestamp") != (
                fresh_video.probe.presentation_timestamps[index]
            ):
                raise MatteIntegrityError(
                    f"fresh video timestamp differs on frame {index}"
                )

        metric = _frame_metric(
            soft,
            contract=expected_contract,
            previous_centroid=previous_centroid,
        )
        for key, value in _frame_metric_payload(metric).items():
            if frame.get(key) != value:
                raise MatteIntegrityError(
                    f"temporal matte frame {index} QA metric differs: {key}"
                )
        metrics.append(metric)
        previous_centroid = (metric.centroid_x, metric.centroid_y)
        edit_paths.append(edit_path)
        soft_paths.append(soft_path)
        frames.append(frame)

    if source_kind == "rgba_png_sequence":
        try:
            ordered_sources = _require_sequence_order(
                sequence_source_paths,
                contract=expected_contract,
            )
        except MatteInputError as error:
            raise MatteIntegrityError(
                "persisted source sequence order differs"
            ) from error
        if tuple(sequence_source_paths) != ordered_sources:
            raise MatteIntegrityError("persisted source sequence order differs")
    else:
        if video_source_path is None or video_source_hash is None:
            raise MatteIntegrityError("video source binding is incomplete")
        if (
            not Path(video_source_path).is_file()
            or sha256_file(Path(video_source_path)) != video_source_hash
        ):
            raise MatteIntegrityError("video source file hash differs")
        timestamps = [frame.get("source_timestamp") for frame in frames]
        if not all(isinstance(value, str) for value in timestamps):
            raise MatteIntegrityError("video frame timestamps are malformed")
        timestamp_digest = _sha256_bytes(
            "\n".join(str(value) for value in timestamps).encode("ascii")
        )
        if timestamp_digest != raw_source.get(
            "presentation_timestamps_sha256"
        ):
            raise MatteIntegrityError("video frame timestamp digest differs")
        try:
            exact_timestamps = [Fraction(str(value)) for value in timestamps]
        except (ValueError, ZeroDivisionError) as error:
            raise MatteIntegrityError("video frame timestamps are invalid") from error
        start = exact_timestamps[0]
        interval = Fraction(1, 1) / expected_contract.frame_rate
        if any(
            abs(float((timestamp - start) - index * interval))
            > CANONICAL_CONTRACT.max_pts_residual_seconds
            for index, timestamp in enumerate(exact_timestamps)
        ):
            raise MatteIntegrityError("video frame timestamp order differs")

    if raw_source.get("ordered_frame_digest_sha256") != (
        _ordered_source_digest(frames)
    ):
        raise MatteIntegrityError("ordered source frame digest differs")
    if raw_artifacts.get("soft_mask_ordered_digest_sha256") != (
        _ordered_mask_digest(frames, role="soft_mask")
    ):
        raise MatteIntegrityError("ordered soft mask digest differs")
    if raw_artifacts.get("edit_mask_ordered_digest_sha256") != (
        _ordered_mask_digest(frames, role="edit_mask")
    ):
        raise MatteIntegrityError("ordered edit mask digest differs")
    if payload.get("qa") != _qa_payload(metrics, contract=expected_contract):
        raise MatteIntegrityError("temporal matte aggregate QA differs")
    if require_transport_compatibility:
        if (
            raw_artifacts.get("vace_transport_compatible") is not True
            or raw_artifacts.get("vace_transport_validator")
            != (
                "framelock_media.ffmpeg_pipeline."
                "_validate_authoritative_masks"
            )
        ):
            raise MatteIntegrityError("VACE mask transport evidence is missing")
        try:
            _validate_authoritative_masks(edit_paths)
        except MaskTransportViolation as error:
            raise MatteIntegrityError(
                "VACE mask transport compatibility no longer passes"
            ) from error
    elif (
        raw_artifacts.get("vace_transport_compatible") is not False
        or raw_artifacts.get("vace_transport_validator") is not None
    ):
        raise MatteIntegrityError("noncanonical transport evidence is invalid")
    if video_source_path is not None and video_source_hash is not None:
        _require_video_source_hash(
            Path(video_source_path),
            video_source_hash,
            stage="final persisted matte verification",
            error_type=MatteIntegrityError,
        )

    return TemporalMatteResult(
        directory=root,
        soft_mask_paths=tuple(soft_paths),
        edit_mask_paths=tuple(edit_paths),
        manifest_path=path.resolve(),
        manifest_digest_sha256=_require_sha256(
            payload.get("digest_sha256"),
            role="manifest digest",
        ),
    )


def verify_temporal_matte(manifest_path: Path) -> TemporalMatteResult:
    """Reopen and fail closed on any canonical temporal matte divergence."""
    return _verify_temporal_matte(
        manifest_path,
        expected_contract=CANONICAL_TEMPORAL_MATTE_CONTRACT,
        require_transport_compatibility=True,
    )
