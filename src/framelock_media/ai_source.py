from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from typing import Mapping, cast

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps

from .artifacts import (
    load_rgb_png,
    save_core_mask_png,
    save_rgb_png,
    sha256_file,
)
from .contract import CANONICAL_CONTRACT, validate_media_facts
from .ffmpeg_pipeline import (
    decode_rgb24_frames_with_provenance,
    probe_media_facts,
)
from .masks import CORE_EROSION_RADIUS, derive_masks, load_core_mask


CANVAS_RGB = (32, 34, 38)
SAFE_BOX = (1024, 576)
CONTACT_SHEET_SIZE = (1920, 1080)
MASK_THRESHOLD = 128
CHROMA_ALGORITHM_ID = "framelock_rgb_euclidean_chroma_key"
# Version 1 remains the default so existing callers and content addresses do not
# silently change. Version 2 must be selected together with its safety claim.
CHROMA_ALGORITHM_VERSION = 1
CHROMA_OPAQUE_SAFE_ALGORITHM_VERSION = 2
CHROMA_SUPPORTED_ALGORITHM_VERSIONS = (
    CHROMA_ALGORITHM_VERSION,
    CHROMA_OPAQUE_SAFE_ALGORITHM_VERSION,
)
CHROMA_ALPHA_FORMULA = (
    "alpha8=floor(255*clamp((euclidean_rgb_distance-threshold)/softness,0,1)+0.5)"
)
CHROMA_DESPILL_FORMULA = (
    "dominant'=floor(dominant-spill*strength*(255-alpha8)/255+0.5)"
)
CHROMA_OPAQUE_SAFE_DESPILL_FORMULA = (
    "dominant'=floor(dominant-spill*strength+0.5)"
)
CHROMA_SPILL_FORMULA = "spill=max(0,dominant-max(other_1,other_2))"
CHROMA_V1_DESPILL_MODE = "alpha_weighted"
CHROMA_V2_DESPILL_MODE = "foreground_key_color_excluded"


class AiSourceError(ValueError):
    """Raised when a generated still cannot become a canonical source."""


@dataclass(frozen=True)
class PreparedAiSource:
    directory: Path
    original_path: Path
    source_record_path: Path
    normalized_plate_path: Path
    foreground_mask_path: Path
    protected_core_path: Path
    boundary_ring_path: Path
    source_mp4_path: Path
    canonical_decoded_frame_path: Path
    contact_sheet_path: Path
    bundle_manifest_path: Path
    bundle_manifest_sha256: str
    manifest_digest_sha256: str
    mask_method: str
    canonical_rgb_sha256: str
    decoded_frame_count: int
    unique_decoded_rgb_hash_count: int


@dataclass(frozen=True)
class PreparedChromaRgba:
    directory: Path
    original_path: Path
    prepared_rgba_path: Path
    derivation_manifest_path: Path
    derivation_manifest_sha256: str
    manifest_digest_sha256: str
    parameters: dict[str, object]
    algorithm_id: str
    algorithm_version: int
    despill_mode: str


@dataclass(frozen=True)
class _ChromaParameters:
    key_rgb: tuple[int, int, int]
    threshold: Decimal
    softness: Decimal
    despill_strength: Decimal
    dominant_channel: int

    def payload(self) -> dict[str, object]:
        return {
            "despill_strength": _decimal_text(self.despill_strength),
            "key_rgb": list(self.key_rgb),
            "softness_rgb_distance": _decimal_text(self.softness),
            "threshold_rgb_distance": _decimal_text(self.threshold),
        }


@dataclass(frozen=True)
class _LoadedImage:
    rgba: Image.Image
    format: str
    mode: str
    width: int
    height: int
    content_type: str
    has_alpha: bool


def _canonical_json_bytes(payload: object) -> bytes:
    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _rgb_sha256(rgb: np.ndarray) -> str:
    return hashlib.sha256(
        np.ascontiguousarray(rgb).tobytes(order="C")
    ).hexdigest()


def _write_new_bytes(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as handle:
        handle.write(value)


def _write_new_json(path: Path, payload: object) -> None:
    _write_new_bytes(
        path,
        (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8"),
    )


def _save_l_png(path: Path, grayscale: np.ndarray) -> None:
    if grayscale.dtype != np.uint8 or grayscale.ndim != 2:
        raise AiSourceError("grayscale artifact must be a 2D uint8 array")
    if path.exists():
        raise FileExistsError(f"artifact already exists: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.ascontiguousarray(grayscale), mode="L").save(
        path,
        format="PNG",
    )


def _save_rgba_png(path: Path, rgba: np.ndarray) -> None:
    if (
        rgba.dtype != np.uint8
        or rgba.ndim != 3
        or rgba.shape[2] != 4
    ):
        raise AiSourceError("RGBA artifact must be an HxWx4 uint8 array")
    if path.exists():
        raise FileExistsError(f"artifact already exists: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.ascontiguousarray(rgba), mode="RGBA").save(
        path,
        format="PNG",
        compress_level=9,
        optimize=False,
    )


def _require_timestamp(created_at: str) -> str:
    token = created_at.strip()
    if not token:
        raise AiSourceError("creation timestamp must be nonempty")
    try:
        parsed = datetime.fromisoformat(token.replace("Z", "+00:00"))
    except ValueError as error:
        raise AiSourceError("creation timestamp must be ISO 8601") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise AiSourceError("creation timestamp must include an offset")
    return token


def _decimal(value: str | int | float | Decimal, *, role: str) -> Decimal:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError) as error:
        raise AiSourceError(f"chroma {role} must be a finite decimal") from error
    if not parsed.is_finite():
        raise AiSourceError(f"chroma {role} must be a finite decimal")
    return parsed


def _decimal_text(value: Decimal) -> str:
    if value == 0:
        return "0"
    return format(value.normalize(), "f")


def _chroma_parameters(
    *,
    key_rgb: tuple[int, int, int],
    threshold: str | int | float | Decimal,
    softness: str | int | float | Decimal,
    despill_strength: str | int | float | Decimal,
) -> _ChromaParameters:
    if (
        len(key_rgb) != 3
        or any(
            isinstance(value, bool) or not isinstance(value, int)
            for value in key_rgb
        )
        or any(value < 0 or value > 255 for value in key_rgb)
    ):
        raise AiSourceError(
            "chroma key RGB must contain three integers from 0 to 255"
        )
    threshold_value = _decimal(threshold, role="threshold")
    softness_value = _decimal(softness, role="softness")
    despill_value = _decimal(despill_strength, role="despill strength")
    if threshold_value < 0:
        raise AiSourceError("chroma threshold must be nonnegative")
    if softness_value <= 0:
        raise AiSourceError("chroma softness must be greater than zero")
    if not Decimal(0) <= despill_value <= Decimal(1):
        raise AiSourceError("chroma despill strength must be from zero to one")

    maximum = max(key_rgb)
    dominant_channels = [
        index for index, value in enumerate(key_rgb) if value == maximum
    ]
    if len(dominant_channels) != 1:
        raise AiSourceError("chroma key must have one dominant color channel")
    dominant = dominant_channels[0]
    other_maximum = max(
        value for index, value in enumerate(key_rgb) if index != dominant
    )
    if key_rgb[dominant] - other_maximum < 32:
        raise AiSourceError(
            "chroma key dominant channel must exceed the other channels by at least 32"
        )
    maximum_distance = Decimal(
        str(
            float(
                np.sqrt(
                    sum(max(value, 255 - value) ** 2 for value in key_rgb)
                )
            )
        )
    )
    if threshold_value + softness_value > maximum_distance:
        raise AiSourceError(
            "chroma threshold plus softness exceeds reachable RGB distance"
        )
    return _ChromaParameters(
        key_rgb=key_rgb,
        threshold=threshold_value,
        softness=softness_value,
        despill_strength=despill_value,
        dominant_channel=dominant,
    )


def _require_chroma_algorithm_version(
    algorithm_version: int,
    *,
    foreground_excludes_key_color: bool,
) -> None:
    if not isinstance(foreground_excludes_key_color, bool):
        raise AiSourceError(
            "foreground key-color exclusion declaration must be boolean"
        )
    if (
        isinstance(algorithm_version, bool)
        or algorithm_version not in CHROMA_SUPPORTED_ALGORITHM_VERSIONS
    ):
        raise AiSourceError(
            f"unsupported chroma algorithm version: {algorithm_version}"
        )
    if (
        algorithm_version == CHROMA_OPAQUE_SAFE_ALGORITHM_VERSION
        and not foreground_excludes_key_color
    ):
        raise AiSourceError(
            "chroma algorithm version 2 requires callers to explicitly declare "
            "that the foreground excludes the dominant key color"
        )
    if (
        algorithm_version == CHROMA_ALGORITHM_VERSION
        and foreground_excludes_key_color
    ):
        raise AiSourceError(
            "foreground key-color exclusion is only valid with chroma "
            "algorithm version 2"
        )


def _chroma_algorithm(
    parameters: _ChromaParameters,
    *,
    algorithm_version: int,
) -> dict[str, object]:
    channel_names = ("red", "green", "blue")
    algorithm: dict[str, object] = {
        "alpha_formula": CHROMA_ALPHA_FORMULA,
        "despill_formula": CHROMA_DESPILL_FORMULA,
        "distance_formula": "sqrt((r-key_r)^2+(g-key_g)^2+(b-key_b)^2)",
        "dominant_key_channel": channel_names[parameters.dominant_channel],
        "id": CHROMA_ALGORITHM_ID,
        "parameters": parameters.payload(),
        "rounding": "floor(value+0.5)",
        "spill_formula": CHROMA_SPILL_FORMULA,
        "version": algorithm_version,
    }
    if algorithm_version == CHROMA_OPAQUE_SAFE_ALGORITHM_VERSION:
        algorithm.update(
            {
                "despill_formula": CHROMA_OPAQUE_SAFE_DESPILL_FORMULA,
                "despill_mode": CHROMA_V2_DESPILL_MODE,
                "foreground_excludes_dominant_key_color": True,
            }
        )
    return algorithm


def _canonical_metadata(
    metadata: Mapping[str, object] | None,
) -> dict[str, object] | None:
    if metadata is None:
        return None
    try:
        encoded = _canonical_json_bytes(dict(metadata))
        decoded = json.loads(encoded)
    except (TypeError, ValueError) as error:
        raise AiSourceError("generator metadata must be a JSON object") from error
    if not isinstance(decoded, dict):
        raise AiSourceError("generator metadata must be a JSON object")
    return decoded


def _load_single_frame_image(value: bytes, *, role: str) -> _LoadedImage:
    try:
        with Image.open(BytesIO(value)) as image:
            if bool(getattr(image, "is_animated", False)) or image.n_frames != 1:
                raise AiSourceError(f"{role} must be a single-frame still image")
            orientation = image.getexif().get(274)
            if orientation not in {None, 1}:
                raise AiSourceError(
                    f"{role} must not rely on EXIF orientation metadata"
                )
            image_format = image.format
            if not isinstance(image_format, str) or not image_format:
                raise AiSourceError(f"{role} has no recognized image format")
            mode = image.mode
            width, height = image.size
            if width <= 0 or height <= 0:
                raise AiSourceError(f"{role} has invalid dimensions")
            has_alpha = "A" in image.getbands() or "transparency" in image.info
            rgba = image.convert("RGBA").copy()
    except AiSourceError:
        raise
    except Exception as error:
        raise AiSourceError(f"{role} is not a readable still image") from error
    return _LoadedImage(
        rgba=rgba,
        format=image_format,
        mode=mode,
        width=width,
        height=height,
        content_type=Image.MIME.get(image_format, "application/octet-stream"),
        has_alpha=has_alpha,
    )


def _load_explicit_mask(path: Path, expected_size: tuple[int, int]) -> tuple[bytes, np.ndarray]:
    value = path.read_bytes()
    try:
        with Image.open(BytesIO(value)) as image:
            if image.format != "PNG" or image.mode != "L":
                raise AiSourceError(
                    "explicit mask candidate must be an L-mode PNG"
                )
            if bool(getattr(image, "is_animated", False)) or image.n_frames != 1:
                raise AiSourceError(
                    "explicit mask candidate must be a single-frame PNG"
                )
            if image.size != expected_size:
                raise AiSourceError(
                    "explicit mask candidate geometry must match the original image"
                )
            grayscale = np.array(image, dtype=np.uint8, copy=True)
    except AiSourceError:
        raise
    except Exception as error:
        raise AiSourceError("explicit mask candidate is not readable") from error
    return value, grayscale


def _load_prepared_rgba(
    path: Path,
    expected_size: tuple[int, int],
) -> tuple[bytes, Image.Image, np.ndarray]:
    value = path.read_bytes()
    try:
        with Image.open(BytesIO(value)) as image:
            if image.format != "PNG" or image.mode != "RGBA":
                raise AiSourceError("prepared working image must be an RGBA PNG")
            if bool(getattr(image, "is_animated", False)) or image.n_frames != 1:
                raise AiSourceError(
                    "prepared working image must be a single-frame PNG"
                )
            if image.size != expected_size:
                raise AiSourceError(
                    "prepared working image geometry must match the original image"
                )
            rgba = image.copy()
            alpha = np.array(image.getchannel("A"), dtype=np.uint8, copy=True)
    except AiSourceError:
        raise
    except Exception as error:
        raise AiSourceError("prepared working image is not readable") from error
    return value, rgba, alpha


def _require_mask_domain(candidate: np.ndarray) -> None:
    declared = candidate >= np.uint8(MASK_THRESHOLD)
    if not np.any(declared):
        raise AiSourceError("mask candidate has no declared foreground")
    if np.all(declared):
        raise AiSourceError("mask candidate leaves no editable exterior")


def _crop_box(candidate: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(candidate >= np.uint8(MASK_THRESHOLD))
    if len(xs) == 0 or len(ys) == 0:
        raise AiSourceError("mask candidate has no declared foreground")
    left = int(xs.min())
    top = int(ys.min())
    right = int(xs.max()) + 1
    bottom = int(ys.max()) + 1
    width = right - left
    height = bottom - top
    pad_x = max(1, (width + 19) // 20)
    pad_y = max(1, (height + 19) // 20)
    return (
        max(0, left - pad_x),
        max(0, top - pad_y),
        min(candidate.shape[1], right + pad_x),
        min(candidate.shape[0], bottom + pad_y),
    )


def _fit_dimensions(width: int, height: int) -> tuple[int, int]:
    maximum_width, maximum_height = SAFE_BOX
    if width * maximum_height >= height * maximum_width:
        fitted_width = maximum_width
        fitted_height = max(1, height * maximum_width // width)
    else:
        fitted_height = maximum_height
        fitted_width = max(1, width * maximum_height // height)
    return fitted_width, fitted_height


def _normalize(
    working_rgba: Image.Image,
    candidate: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, dict[str, object]]:
    crop_box = _crop_box(candidate)
    crop_width = crop_box[2] - crop_box[0]
    crop_height = crop_box[3] - crop_box[1]
    fitted_size = _fit_dimensions(crop_width, crop_height)
    candidate_image = Image.fromarray(candidate, mode="L")
    resized_candidate = candidate_image.crop(crop_box).resize(
        fitted_size,
        resample=Image.Resampling.LANCZOS,
    )
    resized_working = working_rgba.crop(crop_box).resize(
        fitted_size,
        resample=Image.Resampling.LANCZOS,
    )
    resized_working.putalpha(resized_candidate)
    left = (CANONICAL_CONTRACT.width - fitted_size[0]) // 2
    top = (CANONICAL_CONTRACT.height - fitted_size[1]) // 2

    canvas = Image.new(
        "RGBA",
        (CANONICAL_CONTRACT.width, CANONICAL_CONTRACT.height),
        (*CANVAS_RGB, 255),
    )
    canvas.alpha_composite(resized_working, dest=(left, top))
    candidate_canvas = Image.new(
        "L",
        (CANONICAL_CONTRACT.width, CANONICAL_CONTRACT.height),
        0,
    )
    candidate_canvas.paste(resized_candidate, (left, top))
    normalized_candidate = np.array(
        candidate_canvas,
        dtype=np.uint8,
        copy=True,
    )
    plate = np.array(canvas.convert("RGB"), dtype=np.uint8, copy=True)
    return plate, normalized_candidate, {
        "background_rgb": list(CANVAS_RGB),
        "canvas_height": CANONICAL_CONTRACT.height,
        "canvas_width": CANONICAL_CONTRACT.width,
        "crop_box_left_top_right_bottom": list(crop_box),
        "fitted_height": fitted_size[1],
        "fitted_width": fitted_size[0],
        "interpolation": "pillow_lanczos",
        "placement_left": left,
        "placement_top": top,
        "safe_box_height": SAFE_BOX[1],
        "safe_box_width": SAFE_BOX[0],
        "stretching": False,
    }


def _audio_stream_count(path: Path) -> int:
    ffprobe = shutil.which("ffprobe")
    if ffprobe is None:
        raise AiSourceError("ffprobe is required to prove a silent source")
    try:
        completed = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-select_streams",
                "a",
                "-show_entries",
                "stream=index",
                "-of",
                "json",
                str(path),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        payload = json.loads(completed.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        raise AiSourceError("could not prove source audio absence") from error
    streams = payload.get("streams")
    if not isinstance(streams, list):
        raise AiSourceError("ffprobe omitted the source audio stream list")
    return len(streams)


def _encode_stationary_source(
    source_directory: Path,
    output_path: Path,
) -> None:
    """Encode every stationary frame independently to prevent temporal drift."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise AiSourceError("ffmpeg is required to encode a stationary source")
    if output_path.exists():
        raise FileExistsError(f"artifact already exists: {output_path}")
    argv = [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-xerror",
        "-framerate",
        "24",
        "-start_number",
        "0",
        "-pattern_type",
        "sequence",
        "-i",
        str(source_directory / "source_%06d.png"),
        "-map",
        "0:v:0",
        "-frames:v",
        str(CANONICAL_CONTRACT.frame_count),
        "-vf",
        (
            "scale=w=1280:h=720:in_range=pc:out_range=tv:"
            "out_color_matrix=bt709:flags=lanczos+accurate_rnd+"
            "full_chroma_int,format=yuv420p,setsar=1"
        ),
        "-fps_mode",
        "passthrough",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-qp",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-threads:v",
        "1",
        "-x264-params",
        (
            "keyint=1:min-keyint=1:scenecut=0:bframes=0:colorprim=bt709:"
            "transfer=bt709:colormatrix=bt709:fullrange=off"
        ),
        "-video_track_timescale",
        "24000",
        "-tag:v",
        "avc1",
        "-an",
        "-sn",
        "-dn",
        "-map_metadata",
        "-1",
        "-fflags",
        "+bitexact",
        "-movflags",
        "+faststart",
        "-n",
        str(output_path),
    ]
    try:
        subprocess.run(
            argv,
            check=True,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as error:
        output_path.unlink(missing_ok=True)
        raise AiSourceError("stationary source encoding failed") from error
    facts = probe_media_facts(output_path)
    if (
        facts.width != CANONICAL_CONTRACT.width
        or facts.height != CANONICAL_CONTRACT.height
        or facts.frame_count != CANONICAL_CONTRACT.frame_count
        or facts.frame_rate != CANONICAL_CONTRACT.frame_rate
        or facts.file_size_bytes > CANONICAL_CONTRACT.max_file_size_bytes
    ):
        output_path.unlink(missing_ok=True)
        raise AiSourceError("stationary source encoding violated the media contract")


def _checkerboard(size: tuple[int, int]) -> Image.Image:
    canvas = Image.new("RGB", size, (202, 205, 210))
    draw = ImageDraw.Draw(canvas)
    square = 32
    for top in range(0, size[1], square):
        for left in range(0, size[0], square):
            if (left // square + top // square) % 2:
                draw.rectangle(
                    (left, top, left + square - 1, top + square - 1),
                    fill=(154, 158, 164),
                )
    return canvas


def _visible_original(image: Image.Image) -> Image.Image:
    checkerboard = _checkerboard(image.size).convert("RGBA")
    checkerboard.alpha_composite(image)
    return checkerboard.convert("RGB")


def _render_contact_sheet(
    *,
    original: Image.Image,
    normalized_plate: np.ndarray,
    foreground: np.ndarray,
    core: np.ndarray,
    boundary: np.ndarray,
    canonical_decoded_frame: np.ndarray,
) -> np.ndarray:
    sheet = Image.new("RGB", CONTACT_SHEET_SIZE, (15, 17, 21))
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=24)
    entries = (
        ("Generated original", _visible_original(original)),
        ("Normalized plate", Image.fromarray(normalized_plate, mode="RGB")),
        (
            "Foreground mask / white protects",
            Image.fromarray(
                np.where(foreground, 255, 0).astype(np.uint8),
                mode="L",
            ).convert("RGB"),
        ),
        (
            "Protected core / 4 px erosion",
            Image.fromarray(np.where(core, 255, 0).astype(np.uint8), mode="L").convert("RGB"),
        ),
        (
            "Boundary ring",
            Image.fromarray(np.where(boundary, 255, 0).astype(np.uint8), mode="L").convert("RGB"),
        ),
        (
            "Canonical decoded source frame",
            Image.fromarray(canonical_decoded_frame, mode="RGB"),
        ),
    )
    cell_width = CONTACT_SHEET_SIZE[0] // 3
    cell_height = CONTACT_SHEET_SIZE[1] // 2
    for index, (label, image) in enumerate(entries):
        column = index % 3
        row = index // 3
        cell_left = column * cell_width
        cell_top = row * cell_height
        draw.text((cell_left + 16, cell_top + 16), label, font=font, fill=(238, 241, 245))
        maximum = (cell_width - 32, cell_height - 80)
        contained = ImageOps.contain(
            image.convert("RGB"),
            maximum,
            method=Image.Resampling.LANCZOS,
        )
        paste_left = cell_left + (cell_width - contained.width) // 2
        paste_top = cell_top + 64 + (maximum[1] - contained.height) // 2
        sheet.paste(contained, (paste_left, paste_top))
    return np.array(sheet, dtype=np.uint8, copy=True)


def _artifact(path: Path, root: Path) -> dict[str, str]:
    return {
        "path": path.relative_to(root).as_posix(),
        "sha256": sha256_file(path),
    }


def _bundle_digest(payload: Mapping[str, object]) -> str:
    unsigned = dict(payload)
    unsigned.pop("manifest_digest_sha256", None)
    return _sha256_bytes(_canonical_json_bytes(unsigned))


def _stored_extension(image_format: str) -> str:
    return {
        "JPEG": ".jpg",
        "PNG": ".png",
        "WEBP": ".webp",
    }.get(image_format.upper(), ".img")


def _apply_chroma_key(
    source: Image.Image,
    parameters: _ChromaParameters,
    *,
    algorithm_version: int,
) -> np.ndarray:
    """Apply the manifest-selected FrameLock chroma algorithm exactly."""
    rgb_u8 = np.array(source.convert("RGB"), dtype=np.uint8, copy=True)
    rgb = rgb_u8.astype(np.float64)
    key = np.array(parameters.key_rgb, dtype=np.float64)
    distance = np.sqrt(np.sum(np.square(rgb - key), axis=2))
    alpha_unit = np.clip(
        (distance - float(parameters.threshold)) / float(parameters.softness),
        0.0,
        1.0,
    )
    alpha = np.floor(alpha_unit * 255.0 + 0.5).astype(np.uint8)

    dominant = parameters.dominant_channel
    other_channels = tuple(index for index in range(3) if index != dominant)
    reference = np.maximum(
        rgb[..., other_channels[0]],
        rgb[..., other_channels[1]],
    )
    spill = np.maximum(0.0, rgb[..., dominant] - reference)
    if algorithm_version == CHROMA_ALGORITHM_VERSION:
        despill_weight: float | np.ndarray = (
            255.0 - alpha.astype(np.float64)
        ) / 255.0
    elif algorithm_version == CHROMA_OPAQUE_SAFE_ALGORITHM_VERSION:
        despill_weight = 1.0
    else:  # Internal callers validate before reaching pixel processing.
        raise AiSourceError(
            f"unsupported chroma algorithm version: {algorithm_version}"
        )
    adjusted = np.floor(
        rgb[..., dominant]
        - spill
        * float(parameters.despill_strength)
        * despill_weight
        + 0.5
    )
    output_rgb = rgb_u8.copy()
    output_rgb[..., dominant] = np.clip(adjusted, 0.0, 255.0).astype(np.uint8)
    return np.ascontiguousarray(np.dstack((output_rgb, alpha)))


def prepare_chroma_rgba(
    image_path: Path,
    output_root: Path,
    *,
    key_rgb: tuple[int, int, int],
    threshold: str | int | float | Decimal,
    softness: str | int | float | Decimal,
    despill_strength: str | int | float | Decimal,
    algorithm_version: int = CHROMA_ALGORITHM_VERSION,
    foreground_excludes_key_color: bool = False,
) -> PreparedChromaRgba:
    """Create a reproducible local RGBA derivative with a versioned chroma key.

    Alpha is the rounded, softened Euclidean RGB distance from the explicit key.
    Version 1 weights despill by inverse alpha. Version 2 applies despill to all
    pixels, including opaque foreground, and therefore requires the caller to
    declare that the foreground contains no intended dominant key color.
    """
    _require_chroma_algorithm_version(
        algorithm_version,
        foreground_excludes_key_color=foreground_excludes_key_color,
    )
    parameters = _chroma_parameters(
        key_rgb=key_rgb,
        threshold=threshold,
        softness=softness,
        despill_strength=despill_strength,
    )
    original_bytes = image_path.read_bytes()
    original_sha256 = _sha256_bytes(original_bytes)
    original = _load_single_frame_image(original_bytes, role="chroma source")
    original_alpha = np.array(
        original.rgba.getchannel("A"),
        dtype=np.uint8,
        copy=True,
    )
    if original.has_alpha and np.any(original_alpha != np.uint8(255)):
        raise AiSourceError(
            "chroma source must be opaque; existing transparency is ambiguous"
        )
    prepared_rgba = _apply_chroma_key(
        original.rgba,
        parameters,
        algorithm_version=algorithm_version,
    )
    _require_mask_domain(prepared_rgba[..., 3])

    algorithm = _chroma_algorithm(
        parameters,
        algorithm_version=algorithm_version,
    )
    algorithm_digest = _sha256_bytes(_canonical_json_bytes(algorithm))
    output_directory = (
        output_root / "sha256" / original_sha256 / algorithm_digest
    )
    if output_directory.exists():
        raise FileExistsError(
            f"content-addressed chroma preparation already exists: {output_directory}"
        )
    output_directory.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(
        tempfile.mkdtemp(
            prefix=f".{algorithm_digest}.tmp-",
            dir=str(output_directory.parent),
        )
    )
    try:
        original_path = temporary / "original" / (
            "generated" + _stored_extension(original.format)
        )
        _write_new_bytes(original_path, original_bytes)
        prepared_path = temporary / "prepared_rgba.png"
        _save_rgba_png(prepared_path, prepared_rgba)
        manifest: dict[str, object] = {
            "algorithm": algorithm,
            "claim": None,
            "original": {
                **_artifact(original_path, temporary),
                "byte_size": len(original_bytes),
                "content_type": original.content_type,
                "filename": image_path.name,
                "format": original.format,
                "height": original.height,
                "mode": original.mode,
                "width": original.width,
            },
            "prepared_rgba": _artifact(prepared_path, temporary),
            "provenance_label": "local_deterministic_chroma_preparation",
            "schema_version": 1,
            "state": "prepared",
        }
        manifest["manifest_digest_sha256"] = _bundle_digest(manifest)
        manifest_path = temporary / "chroma_derivation.json"
        _write_new_json(manifest_path, manifest)
        if output_directory.exists():
            raise FileExistsError(
                f"content-addressed chroma preparation already exists: {output_directory}"
            )
        os.replace(temporary, output_directory)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise

    verified = verify_chroma_preparation(output_directory)
    verified_algorithm = verified.get("algorithm")
    if not isinstance(verified_algorithm, dict):
        raise AiSourceError("verified chroma algorithm is malformed")
    verified_parameters = verified_algorithm.get("parameters")
    if not isinstance(verified_parameters, dict):
        raise AiSourceError("verified chroma parameters are malformed")
    final_manifest_path = output_directory / "chroma_derivation.json"
    return PreparedChromaRgba(
        directory=output_directory,
        original_path=output_directory / original_path.relative_to(temporary),
        prepared_rgba_path=output_directory / "prepared_rgba.png",
        derivation_manifest_path=final_manifest_path,
        derivation_manifest_sha256=sha256_file(final_manifest_path),
        manifest_digest_sha256=str(verified["manifest_digest_sha256"]),
        parameters=verified_parameters,
        algorithm_id=CHROMA_ALGORITHM_ID,
        algorithm_version=algorithm_version,
        despill_mode=(
            CHROMA_V1_DESPILL_MODE
            if algorithm_version == CHROMA_ALGORITHM_VERSION
            else CHROMA_V2_DESPILL_MODE
        ),
    )


def prepare_ai_source(
    image_path: Path,
    output_root: Path,
    *,
    prompt: str,
    generator: str,
    created_at: str,
    generator_metadata: Mapping[str, object] | None = None,
    explicit_mask_path: Path | None = None,
    prepared_rgba_path: Path | None = None,
    prepared_rgba_derivation: str | None = None,
) -> PreparedAiSource:
    """Prepare one generated still as write-once canonical FrameLock inputs."""
    if not prompt or not prompt.strip():
        raise AiSourceError("image-generation prompt must be nonempty")
    generator_identity = generator.strip()
    if not generator_identity:
        raise AiSourceError("generator identity must be nonempty")
    timestamp = _require_timestamp(created_at)
    metadata = _canonical_metadata(generator_metadata)
    if prepared_rgba_path is not None and explicit_mask_path is not None:
        raise AiSourceError(
            "prepared RGBA and explicit mask candidate are mutually exclusive"
        )
    if prepared_rgba_path is None and prepared_rgba_derivation is not None:
        raise AiSourceError("prepared RGBA derivation requires a prepared image")

    original_bytes = image_path.read_bytes()
    original_sha256 = _sha256_bytes(original_bytes)
    original = _load_single_frame_image(original_bytes, role="generated source")
    working_rgba = original.rgba.copy()
    working_bytes: bytes | None = None
    working_derivation: str | None = None

    if prepared_rgba_path is not None:
        derivation = (prepared_rgba_derivation or "").strip()
        if not derivation:
            raise AiSourceError(
                "prepared RGBA requires a nonempty local derivation note"
            )
        working_bytes, working_rgba, candidate = _load_prepared_rgba(
            prepared_rgba_path,
            (original.width, original.height),
        )
        working_derivation = derivation
        mask_method = "prepared_rgba_alpha"
        candidate_bytes: bytes | None = None
    else:
        alpha = np.array(
            original.rgba.getchannel("A"),
            dtype=np.uint8,
            copy=True,
        )
        alpha_is_meaningful = bool(
            original.has_alpha
            and np.any(alpha >= np.uint8(MASK_THRESHOLD))
            and np.any(alpha < np.uint8(MASK_THRESHOLD))
        )
        if original.has_alpha and not np.any(alpha):
            raise AiSourceError("generated source alpha is entirely transparent")
        if alpha_is_meaningful:
            candidate = alpha
            candidate_bytes = None
            mask_method = "source_alpha"
        elif explicit_mask_path is not None:
            candidate_bytes, candidate = _load_explicit_mask(
                explicit_mask_path,
                (original.width, original.height),
            )
            mask_method = "explicit_local_mask"
        else:
            raise AiSourceError(
                "generated source has no usable alpha; an explicit mask candidate is required"
            )
    _require_mask_domain(candidate)

    plate, normalized_candidate, normalization = _normalize(
        working_rgba,
        candidate,
    )
    confirmed_foreground = np.ascontiguousarray(
        normalized_candidate >= np.uint8(MASK_THRESHOLD)
    )
    confirmed_binary = np.where(confirmed_foreground, 255, 0).astype(np.uint8)
    masks = derive_masks(confirmed_binary)

    output_directory = output_root / "sha256" / original_sha256
    if output_directory.exists():
        raise FileExistsError(
            f"content-addressed AI source already exists: {output_directory}"
        )
    digest_root = output_directory.parent
    digest_root.mkdir(parents=True, exist_ok=True)
    temporary = Path(
        tempfile.mkdtemp(
            prefix=f".{original_sha256}.tmp-",
            dir=str(digest_root),
        )
    )
    try:
        original_path = temporary / "original" / (
            "generated" + _stored_extension(original.format)
        )
        _write_new_bytes(original_path, original_bytes)
        working_path: Path | None = None
        if working_bytes is not None:
            working_path = temporary / "prepared_working_rgba.png"
            _write_new_bytes(working_path, working_bytes)

        candidate_original_path = temporary / "mask_candidate_original.png"
        if candidate_bytes is None:
            _save_l_png(candidate_original_path, candidate)
        else:
            _write_new_bytes(candidate_original_path, candidate_bytes)
        candidate_normalized_path = temporary / "mask_candidate_normalized.png"
        _save_l_png(candidate_normalized_path, normalized_candidate)
        normalized_plate_path = temporary / "normalized_plate.png"
        save_rgb_png(normalized_plate_path, plate)
        foreground_path = temporary / "foreground.png"
        save_core_mask_png(foreground_path, masks.foreground)
        protected_core_path = temporary / "protected_core.png"
        save_core_mask_png(protected_core_path, masks.core)
        boundary_ring_path = temporary / "boundary_ring.png"
        save_core_mask_png(boundary_ring_path, masks.edge)

        source_frames_directory = temporary / ".source_frames"
        source_frames_directory.mkdir()
        for index in range(CANONICAL_CONTRACT.frame_count):
            frame_path = source_frames_directory / f"source_{index:06d}.png"
            shutil.copyfile(normalized_plate_path, frame_path)
        source_mp4_path = temporary / "source.mp4"
        _encode_stationary_source(source_frames_directory, source_mp4_path)
        audio_stream_count = _audio_stream_count(source_mp4_path)
        if audio_stream_count != 0:
            raise AiSourceError("canonical source MP4 must be silent")

        decoded_directory = temporary / ".decoded_frames"
        decoded = decode_rgb24_frames_with_provenance(
            source_mp4_path,
            decoded_directory,
        )
        decoded_rgb_hashes = tuple(
            _rgb_sha256(load_rgb_png(path)) for path in decoded.paths
        )
        unique_rgb_hashes = set(decoded_rgb_hashes)
        if len(decoded_rgb_hashes) != CANONICAL_CONTRACT.frame_count:
            raise AiSourceError("canonical source did not decode to exactly 121 frames")
        if len(unique_rgb_hashes) != 1:
            raise AiSourceError(
                "stationary source frames differ after canonical RGB decode: "
                f"{len(unique_rgb_hashes)} unique hashes"
            )
        canonical_rgb_sha256 = next(iter(unique_rgb_hashes))
        canonical_decoded_path = temporary / "canonical_decoded_frame.png"
        shutil.copyfile(decoded.paths[0], canonical_decoded_path)

        contact_sheet_path = temporary / "contact_sheet.png"
        save_rgb_png(
            contact_sheet_path,
            _render_contact_sheet(
                original=original.rgba,
                normalized_plate=plate,
                foreground=masks.foreground,
                core=masks.core,
                boundary=masks.edge,
                canonical_decoded_frame=load_rgb_png(canonical_decoded_path),
            ),
        )

        source_record_path = temporary / "source_record.json"
        generator_record: dict[str, object] = {
            "created_at": timestamp,
            "identity": generator_identity,
            "prompt": prompt,
        }
        if metadata is not None:
            generator_record["metadata"] = metadata
        source_record = {
            "generator": generator_record,
            "original": {
                "byte_size": len(original_bytes),
                "content_type": original.content_type,
                "filename": image_path.name,
                "format": original.format,
                "height": original.height,
                "mode": original.mode,
                "sha256": original_sha256,
                "stored_path": original_path.relative_to(temporary).as_posix(),
                "width": original.width,
            },
            "provenance_label": "ai_generated_source",
            "schema_version": 1,
        }
        _write_new_json(source_record_path, source_record)

        facts = probe_media_facts(source_mp4_path)
        working_record = (
            {
                "derivation": working_derivation,
                **_artifact(working_path, temporary),
            }
            if working_path is not None
            else None
        )
        bundle_manifest: dict[str, object] = {
            "claim": None,
            "contact_sheet": {
                **_artifact(contact_sheet_path, temporary),
                "height": CONTACT_SHEET_SIZE[1],
                "width": CONTACT_SHEET_SIZE[0],
            },
            "mask": {
                "boundary_ring": _artifact(boundary_ring_path, temporary),
                "confirmed_foreground": _artifact(foreground_path, temporary),
                "erosion_radius": CORE_EROSION_RADIUS,
                "method": mask_method,
                "normalized_candidate": _artifact(
                    candidate_normalized_path,
                    temporary,
                ),
                "original_candidate": _artifact(
                    candidate_original_path,
                    temporary,
                ),
                "protected_core": _artifact(protected_core_path, temporary),
                "protected_core_pixels": int(np.count_nonzero(masks.core)),
                "threshold": MASK_THRESHOLD,
            },
            "next_step": "visual_mask_approval_and_application_intake",
            "normalization": {
                **normalization,
                "normalized_plate": _artifact(normalized_plate_path, temporary),
            },
            "provenance_label": "ai_generated_source",
            "schema_version": 1,
            "source_record": _artifact(source_record_path, temporary),
            "source_video": {
                "audio_stream_count": audio_stream_count,
                "canonical_decoded_frame": _artifact(
                    canonical_decoded_path,
                    temporary,
                ),
                "canonical_rgb_sha256": canonical_rgb_sha256,
                "decoded_frame_count": len(decoded.paths),
                "ffmpeg_version": decoded.provenance.ffmpeg_version,
                "ffprobe_version": decoded.provenance.ffprobe_version,
                "frame_rate_denominator": facts.frame_rate.denominator,
                "frame_rate_numerator": facts.frame_rate.numerator,
                "height": facts.height,
                "max_pts_residual_microseconds": (
                    decoded.provenance.max_pts_residual_microseconds
                ),
                "path": source_mp4_path.relative_to(temporary).as_posix(),
                "sha256": sha256_file(source_mp4_path),
                "unique_decoded_rgb_hash_count": len(unique_rgb_hashes),
                "width": facts.width,
            },
            "state": "prepared",
            "working_image": working_record,
        }
        bundle_manifest["manifest_digest_sha256"] = _bundle_digest(
            bundle_manifest
        )
        bundle_manifest_path = temporary / "source_bundle.json"
        _write_new_json(bundle_manifest_path, bundle_manifest)

        shutil.rmtree(source_frames_directory)
        shutil.rmtree(decoded_directory)
        if output_directory.exists():
            raise FileExistsError(
                f"content-addressed AI source already exists: {output_directory}"
            )
        os.replace(temporary, output_directory)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise

    final_manifest_path = output_directory / "source_bundle.json"
    verified = verify_ai_source_bundle(output_directory)
    source_video = verified["source_video"]
    assert isinstance(source_video, dict)
    return PreparedAiSource(
        directory=output_directory,
        original_path=output_directory / original_path.relative_to(temporary),
        source_record_path=output_directory / "source_record.json",
        normalized_plate_path=output_directory / "normalized_plate.png",
        foreground_mask_path=output_directory / "foreground.png",
        protected_core_path=output_directory / "protected_core.png",
        boundary_ring_path=output_directory / "boundary_ring.png",
        source_mp4_path=output_directory / "source.mp4",
        canonical_decoded_frame_path=(
            output_directory / "canonical_decoded_frame.png"
        ),
        contact_sheet_path=output_directory / "contact_sheet.png",
        bundle_manifest_path=final_manifest_path,
        bundle_manifest_sha256=sha256_file(final_manifest_path),
        manifest_digest_sha256=str(verified["manifest_digest_sha256"]),
        mask_method=mask_method,
        canonical_rgb_sha256=str(source_video["canonical_rgb_sha256"]),
        decoded_frame_count=int(source_video["decoded_frame_count"]),
        unique_decoded_rgb_hash_count=int(
            source_video["unique_decoded_rgb_hash_count"]
        ),
    )


def _expect_artifact(root: Path, value: object, *, role: str) -> Path:
    if not isinstance(value, dict):
        raise AiSourceError(f"source bundle {role} is malformed")
    relative = value.get("path")
    expected_sha256 = value.get("sha256")
    if not isinstance(relative, str) or not isinstance(expected_sha256, str):
        raise AiSourceError(f"source bundle {role} is malformed")
    path = (root / relative).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError as error:
        raise AiSourceError(f"source bundle {role} escapes its root") from error
    if not path.is_file() or sha256_file(path) != expected_sha256:
        raise AiSourceError(f"source bundle {role} hash differs")
    return path


def verify_chroma_preparation(directory: Path) -> dict[str, object]:
    """Recompute a chroma derivative from its immutable original and manifest."""
    manifest_path = directory / "chroma_derivation.json"
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AiSourceError("chroma derivation manifest is unreadable") from error
    if not isinstance(payload, dict):
        raise AiSourceError("chroma derivation manifest must be an object")
    if payload.get("manifest_digest_sha256") != _bundle_digest(payload):
        raise AiSourceError("chroma derivation manifest digest differs")
    if (
        payload.get("schema_version") != 1
        or payload.get("state") != "prepared"
        or payload.get("claim") is not None
        or payload.get("provenance_label")
        != "local_deterministic_chroma_preparation"
    ):
        raise AiSourceError("chroma derivation manifest contract differs")
    algorithm = payload.get("algorithm")
    if not isinstance(algorithm, dict):
        raise AiSourceError("chroma derivation algorithm is malformed")
    raw_algorithm_version = algorithm.get("version")
    if isinstance(raw_algorithm_version, bool) or not isinstance(
        raw_algorithm_version,
        int,
    ):
        raise AiSourceError(
            f"unsupported chroma algorithm version: {raw_algorithm_version}"
        )
    algorithm_version = raw_algorithm_version
    _require_chroma_algorithm_version(
        algorithm_version,
        foreground_excludes_key_color=(
            algorithm.get("foreground_excludes_dominant_key_color") is True
        ),
    )
    raw_parameters = algorithm.get("parameters")
    if not isinstance(raw_parameters, dict):
        raise AiSourceError("chroma derivation parameters are malformed")
    raw_key = raw_parameters.get("key_rgb")
    if (
        not isinstance(raw_key, list)
        or len(raw_key) != 3
        or any(
            isinstance(value, bool) or not isinstance(value, int)
            for value in raw_key
        )
    ):
        raise AiSourceError("chroma derivation key is malformed")
    parameters = _chroma_parameters(
        key_rgb=cast(tuple[int, int, int], tuple(raw_key)),
        threshold=str(raw_parameters.get("threshold_rgb_distance")),
        softness=str(raw_parameters.get("softness_rgb_distance")),
        despill_strength=str(raw_parameters.get("despill_strength")),
    )
    if raw_parameters != parameters.payload():
        raise AiSourceError("chroma derivation parameter encoding differs")
    expected_algorithm = _chroma_algorithm(
        parameters,
        algorithm_version=algorithm_version,
    )
    if algorithm != expected_algorithm:
        raise AiSourceError("chroma derivation algorithm differs")
    algorithm_digest = _sha256_bytes(_canonical_json_bytes(algorithm))

    original_record = payload.get("original")
    original_path = _expect_artifact(
        directory,
        original_record,
        role="chroma original",
    )
    original_sha256 = sha256_file(original_path)
    if (
        directory.name != algorithm_digest
        or directory.parent.name != original_sha256
        or directory.parent.parent.name != "sha256"
    ):
        raise AiSourceError("chroma preparation is not content-addressed")
    original = _load_single_frame_image(
        original_path.read_bytes(),
        role="chroma original",
    )
    original_alpha = np.array(
        original.rgba.getchannel("A"),
        dtype=np.uint8,
        copy=True,
    )
    if original.has_alpha and np.any(original_alpha != np.uint8(255)):
        raise AiSourceError("chroma original transparency differs")
    prepared_path = _expect_artifact(
        directory,
        payload.get("prepared_rgba"),
        role="prepared RGBA",
    )
    prepared_bytes, prepared_image, prepared_alpha = _load_prepared_rgba(
        prepared_path,
        (original.width, original.height),
    )
    del prepared_bytes
    expected = _apply_chroma_key(
        original.rgba,
        parameters,
        algorithm_version=algorithm_version,
    )
    actual = np.array(prepared_image, dtype=np.uint8, copy=True)
    if not np.array_equal(actual, expected):
        raise AiSourceError("prepared RGBA differs from chroma algorithm")
    _require_mask_domain(prepared_alpha)
    return payload


def _load_verification_l_png(path: Path, *, role: str) -> np.ndarray:
    try:
        with Image.open(path) as image:
            if image.format != "PNG" or image.mode != "L":
                raise AiSourceError(f"source bundle {role} must be an L-mode PNG")
            if bool(getattr(image, "is_animated", False)) or image.n_frames != 1:
                raise AiSourceError(f"source bundle {role} must be static")
            grayscale = np.array(image, dtype=np.uint8, copy=True)
    except AiSourceError:
        raise
    except Exception as error:
        raise AiSourceError(f"source bundle {role} is unreadable") from error
    if grayscale.shape != (
        CANONICAL_CONTRACT.height,
        CANONICAL_CONTRACT.width,
    ):
        raise AiSourceError(f"source bundle {role} geometry differs")
    return grayscale


def verify_ai_source_bundle(directory: Path) -> dict[str, object]:
    """Re-probe media and rederive masks instead of trusting manifest claims."""
    manifest_path = directory / "source_bundle.json"
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AiSourceError("source bundle manifest is unreadable") from error
    if not isinstance(payload, dict):
        raise AiSourceError("source bundle manifest must be an object")
    digest = payload.get("manifest_digest_sha256")
    if not isinstance(digest, str) or digest != _bundle_digest(payload):
        raise AiSourceError("source bundle manifest digest differs")
    if (
        payload.get("schema_version") != 1
        or payload.get("state") != "prepared"
        or payload.get("claim") is not None
        or payload.get("provenance_label") != "ai_generated_source"
    ):
        raise AiSourceError("source bundle manifest contract differs")

    source_record_path = _expect_artifact(
        directory,
        payload.get("source_record"),
        role="source record",
    )
    try:
        source_record = json.loads(source_record_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise AiSourceError("source record is malformed") from error
    if not isinstance(source_record, dict):
        raise AiSourceError("source record must be an object")
    original = source_record.get("original")
    if not isinstance(original, dict):
        raise AiSourceError("source record original is malformed")
    original_path = _expect_artifact(
        directory,
        {
            "path": original.get("stored_path"),
            "sha256": original.get("sha256"),
        },
        role="original",
    )
    original_sha256 = sha256_file(original_path)
    if directory.name != original_sha256 or directory.parent.name != "sha256":
        raise AiSourceError("source bundle is not content-addressed by original hash")
    original_image = _load_single_frame_image(
        original_path.read_bytes(),
        role="source bundle original",
    )
    expected_original_facts = {
        "byte_size": original_path.stat().st_size,
        "content_type": original_image.content_type,
        "format": original_image.format,
        "height": original_image.height,
        "mode": original_image.mode,
        "width": original_image.width,
    }
    if any(
        original.get(key) != value
        for key, value in expected_original_facts.items()
    ):
        raise AiSourceError("source record original facts differ")

    working = payload.get("working_image")
    working_path: Path | None = None
    if working is not None:
        working_path = _expect_artifact(directory, working, role="working image")
        if not isinstance(working, dict) or not isinstance(
            working.get("derivation"), str
        ) or not str(working["derivation"]).strip():
            raise AiSourceError("source bundle working derivation is malformed")
    normalization = payload.get("normalization")
    mask = payload.get("mask")
    source_video = payload.get("source_video")
    if not isinstance(normalization, dict) or not isinstance(mask, dict):
        raise AiSourceError("source bundle normalization or mask is malformed")
    if not isinstance(source_video, dict):
        raise AiSourceError("source bundle video is malformed")
    normalized_plate_path = _expect_artifact(
        directory,
        normalization.get("normalized_plate"),
        role="normalized plate",
    )
    normalized_plate = load_rgb_png(normalized_plate_path)
    if normalized_plate.shape != (
        CANONICAL_CONTRACT.height,
        CANONICAL_CONTRACT.width,
        3,
    ):
        raise AiSourceError("source bundle normalized plate geometry differs")

    original_candidate_path = _expect_artifact(
        directory,
        mask.get("original_candidate"),
        role="original mask candidate",
    )
    normalized_candidate_path = _expect_artifact(
        directory,
        mask.get("normalized_candidate"),
        role="normalized mask candidate",
    )
    foreground_path = _expect_artifact(
        directory,
        mask.get("confirmed_foreground"),
        role="confirmed foreground",
    )
    protected_core_path = _expect_artifact(
        directory,
        mask.get("protected_core"),
        role="protected core",
    )
    boundary_ring_path = _expect_artifact(
        directory,
        mask.get("boundary_ring"),
        role="boundary ring",
    )
    normalized_candidate = _load_verification_l_png(
        normalized_candidate_path,
        role="normalized mask candidate",
    )
    try:
        foreground = load_core_mask(foreground_path)
        protected_core = load_core_mask(protected_core_path)
        boundary_ring = load_core_mask(boundary_ring_path)
        derived = derive_masks(normalized_candidate)
    except Exception as error:
        raise AiSourceError("source bundle mask domain differs") from error
    expected_shape = (
        CANONICAL_CONTRACT.height,
        CANONICAL_CONTRACT.width,
    )
    if any(
        value.shape != expected_shape
        for value in (foreground, protected_core, boundary_ring)
    ):
        raise AiSourceError("source bundle mask geometry differs")
    if not np.array_equal(foreground, derived.foreground):
        raise AiSourceError("source bundle confirmed foreground differs")
    if not np.array_equal(protected_core, derived.core):
        raise AiSourceError("source bundle protected core differs")
    if not np.array_equal(boundary_ring, derived.edge):
        raise AiSourceError("source bundle boundary ring differs")
    if (
        mask.get("threshold") != MASK_THRESHOLD
        or mask.get("erosion_radius") != CORE_EROSION_RADIUS
        or mask.get("protected_core_pixels")
        != int(np.count_nonzero(derived.core))
    ):
        raise AiSourceError("source bundle mask evidence differs")

    mask_method = mask.get("method")
    if mask_method not in {
        "source_alpha",
        "explicit_local_mask",
        "prepared_rgba_alpha",
    }:
        raise AiSourceError("source bundle mask method differs")
    try:
        with Image.open(original_candidate_path) as candidate_image:
            if candidate_image.format != "PNG" or candidate_image.mode != "L":
                raise AiSourceError("source bundle original mask candidate differs")
            if (
                bool(getattr(candidate_image, "is_animated", False))
                or candidate_image.n_frames != 1
            ):
                raise AiSourceError("source bundle original mask candidate differs")
            original_candidate = np.array(
                candidate_image,
                dtype=np.uint8,
                copy=True,
            )
    except AiSourceError:
        raise
    except Exception as error:
        raise AiSourceError("source bundle original mask candidate differs") from error
    if original_candidate.shape != (original_image.height, original_image.width):
        raise AiSourceError("source bundle original mask candidate geometry differs")
    if mask_method == "source_alpha":
        source_alpha = np.array(
            original_image.rgba.getchannel("A"),
            dtype=np.uint8,
            copy=True,
        )
        if (
            working_path is not None
            or not original_image.has_alpha
            or not np.array_equal(original_candidate, source_alpha)
        ):
            raise AiSourceError("source bundle source-alpha evidence differs")
        semantic_working = original_image.rgba
    elif mask_method == "prepared_rgba_alpha":
        if working_path is None:
            raise AiSourceError("source bundle prepared RGBA evidence is missing")
        _, semantic_working, working_alpha = _load_prepared_rgba(
            working_path,
            (original_image.width, original_image.height),
        )
        if not np.array_equal(original_candidate, working_alpha):
            raise AiSourceError("source bundle prepared RGBA alpha differs")
    else:
        if working_path is not None:
            raise AiSourceError("source bundle explicit mask has a working RGBA")
        semantic_working = original_image.rgba

    expected_plate, expected_candidate, expected_normalization = _normalize(
        semantic_working,
        original_candidate,
    )
    if not np.array_equal(normalized_plate, expected_plate):
        raise AiSourceError("source bundle normalized plate differs")
    if not np.array_equal(normalized_candidate, expected_candidate):
        raise AiSourceError("source bundle normalized mask candidate differs")
    expected_normalization_keys = set(expected_normalization) | {
        "normalized_plate"
    }
    if set(normalization) != expected_normalization_keys or any(
        normalization.get(key) != value
        for key, value in expected_normalization.items()
    ):
        raise AiSourceError("source bundle normalization evidence differs")

    source_video_path = _expect_artifact(
        directory,
        source_video,
        role="source video",
    )
    canonical_frame_path = _expect_artifact(
        directory,
        source_video.get("canonical_decoded_frame"),
        role="canonical decoded frame",
    )
    try:
        facts = probe_media_facts(source_video_path)
        validated = validate_media_facts(facts)
    except Exception as error:
        raise AiSourceError("source bundle video contract differs") from error
    if _audio_stream_count(source_video_path) != 0:
        raise AiSourceError("source bundle video is not silent")
    with tempfile.TemporaryDirectory(prefix="framelock-source-verify-") as temp:
        try:
            decoded = decode_rgb24_frames_with_provenance(
                source_video_path,
                Path(temp) / "frames",
            )
            decoded_hashes = tuple(
                _rgb_sha256(load_rgb_png(path)) for path in decoded.paths
            )
        except Exception as error:
            raise AiSourceError("source bundle canonical decode failed") from error
    unique_hashes = set(decoded_hashes)
    if len(decoded_hashes) != CANONICAL_CONTRACT.frame_count:
        raise AiSourceError("source bundle decoded frame count differs")
    if len(unique_hashes) != 1:
        raise AiSourceError(
            "source bundle video is not stationary after canonical RGB decode"
        )
    canonical_rgb_sha256 = next(iter(unique_hashes))
    canonical_frame = load_rgb_png(canonical_frame_path)
    if _rgb_sha256(canonical_frame) != canonical_rgb_sha256:
        raise AiSourceError("source bundle canonical decoded frame differs")
    actual_video_evidence = {
        "audio_stream_count": 0,
        "canonical_rgb_sha256": canonical_rgb_sha256,
        "decoded_frame_count": len(decoded_hashes),
        "ffmpeg_version": decoded.provenance.ffmpeg_version,
        "ffprobe_version": decoded.provenance.ffprobe_version,
        "frame_rate_denominator": facts.frame_rate.denominator,
        "frame_rate_numerator": facts.frame_rate.numerator,
        "height": facts.height,
        "max_pts_residual_microseconds": round(
            validated.max_pts_residual_seconds * 1_000_000
        ),
        "unique_decoded_rgb_hash_count": len(unique_hashes),
        "width": facts.width,
    }
    if any(
        source_video.get(key) != value
        for key, value in actual_video_evidence.items()
    ):
        raise AiSourceError("source bundle video evidence differs")

    contact_sheet_path = _expect_artifact(
        directory,
        payload.get("contact_sheet"),
        role="contact sheet",
    )
    contact_sheet = payload.get("contact_sheet")
    if not isinstance(contact_sheet, dict):
        raise AiSourceError("source bundle contact sheet is malformed")
    try:
        with Image.open(contact_sheet_path) as image:
            if (
                image.format != "PNG"
                or image.mode != "RGB"
                or image.size != CONTACT_SHEET_SIZE
                or bool(getattr(image, "is_animated", False))
                or image.n_frames != 1
            ):
                raise AiSourceError("source bundle contact sheet differs")
    except AiSourceError:
        raise
    except Exception as error:
        raise AiSourceError("source bundle contact sheet is unreadable") from error
    if (
        contact_sheet.get("width") != CONTACT_SHEET_SIZE[0]
        or contact_sheet.get("height") != CONTACT_SHEET_SIZE[1]
    ):
        raise AiSourceError("source bundle contact sheet evidence differs")
    return payload
