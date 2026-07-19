from __future__ import annotations

from dataclasses import dataclass
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .artifacts import save_rgb_png
from .contract import CANONICAL_CONTRACT
from .ffmpeg_pipeline import encode_source_fixture


@dataclass(frozen=True)
class FrameLockHeroFixture:
    source_mp4: Path
    foreground_mask: Path
    ownership_label: str = "FrameLock-owned synthetic fixture"


def _font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    names = (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
        if bold
        else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    )
    for name in names:
        try:
            return ImageFont.truetype(name, size=size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def _draw_centered_text(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    text: str,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    fill: tuple[int, int, int],
) -> None:
    bounds = draw.textbbox((0, 0), text, font=font)
    width = bounds[2] - bounds[0]
    height = bounds[3] - bounds[1]
    left, top, right, bottom = box
    position = (
        left + (right - left - width) / 2,
        top + (bottom - top - height) / 2 - bounds[1],
    )
    draw.text(position, text, font=font, fill=fill)


def _studio_frame(index: int) -> np.ndarray:
    width = CANONICAL_CONTRACT.width
    height = CANONICAL_CONTRACT.height
    x = np.linspace(0.0, 1.0, width, dtype=np.float32)[None, :]
    y = np.linspace(0.0, 1.0, height, dtype=np.float32)[:, None]
    phase = np.float32(index / CANONICAL_CONTRACT.frame_count * 2.0 * math.pi)

    red = 7.0 + 18.0 * x + 9.0 * y
    green = 12.0 + 14.0 * y + 5.0 * np.sin(x * 8.0 + phase)
    blue = 24.0 + 42.0 * x + 18.0 * np.cos(y * 7.0 - phase)
    frame = np.empty((height, width, 3), dtype=np.uint8)
    frame[..., 0] = np.clip(red, 0, 255).astype(np.uint8)
    frame[..., 1] = np.clip(green, 0, 255).astype(np.uint8)
    frame[..., 2] = np.clip(blue, 0, 255).astype(np.uint8)

    image = Image.fromarray(frame, mode="RGB")
    draw = ImageDraw.Draw(image)
    beam_x = int(110 + (index * 8) % 1_060)
    draw.polygon(
        [(beam_x - 150, 0), (beam_x + 20, 0), (beam_x + 260, 720), (beam_x + 40, 720)],
        fill=(19, 61, 82),
    )
    orbit = int(80 * math.sin(float(phase)))
    draw.ellipse((90 + orbit, 110, 230 + orbit, 250), outline=(63, 226, 255), width=5)
    draw.ellipse((1_030 - orbit, 460, 1_170 - orbit, 600), outline=(250, 78, 138), width=5)
    draw.line((0, 650, 1_280, 650), fill=(47, 72, 96), width=2)
    draw.text((42, 35), "CANONICAL SOURCE / SYNTHETIC", font=_font(20, bold=True), fill=(166, 190, 210))

    # Stationary approved product. Fine details make any generative drift obvious.
    product = (455, 105, 825, 615)
    draw.rounded_rectangle((475, 125, 845, 635), radius=30, fill=(0, 0, 0, 120))
    draw.rounded_rectangle(product, radius=28, fill=(239, 241, 232), outline=(33, 223, 235), width=8)
    draw.rounded_rectangle((475, 125, 805, 595), radius=20, outline=(18, 24, 31), width=3)

    draw.rectangle((475, 160, 805, 265), fill=(16, 23, 32))
    draw.line((475, 275, 805, 275), fill=(33, 223, 235), width=4)
    draw.line((475, 455, 805, 455), fill=(33, 223, 235), width=4)
    _draw_centered_text(
        draw,
        (475, 170, 805, 245),
        "FRAMELOCK",
        _font(45, bold=True),
        (239, 241, 232),
    )
    _draw_centered_text(
        draw,
        (480, 295, 800, 345),
        "VERIFIED GENERATIVE RESHOOTS",
        _font(18, bold=True),
        (17, 25, 33),
    )
    _draw_centered_text(
        draw,
        (480, 350, 800, 405),
        "CORE ID 24 / 121",
        _font(25, bold=True),
        (17, 25, 33),
    )
    _draw_centered_text(
        draw,
        (480, 405, 800, 448),
        "ZERO CHANGED SAMPLES",
        _font(17),
        (37, 71, 82),
    )

    for offset in range(0, 270, 12):
        bar_width = 3 if (offset // 12) % 3 else 6
        draw.rectangle((505 + offset, 488, 505 + offset + bar_width, 555), fill=(18, 24, 31))
    draw.text((500, 563), "FL-000121-RGB24", font=_font(16, bold=True), fill=(18, 24, 31))

    corner_color = (250, 78, 138)
    for px, py in ((485, 140), (795, 140), (485, 580), (795, 580)):
        draw.line((px - 9, py, px + 9, py), fill=corner_color, width=3)
        draw.line((px, py - 9, px, py + 9), fill=corner_color, width=3)
    return np.array(image, dtype=np.uint8, copy=True)


def _save_foreground_mask(path: Path) -> None:
    mask = Image.new(
        "L", (CANONICAL_CONTRACT.width, CANONICAL_CONTRACT.height), color=0
    )
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((455, 105, 825, 615), radius=28, fill=255)
    mask.save(path, format="PNG")


def create_framelock_hero_fixture(output_directory: Path) -> FrameLockHeroFixture:
    if output_directory.exists():
        raise FileExistsError(f"hero fixture directory exists: {output_directory}")
    frame_directory = output_directory / "source_frames"
    frame_directory.mkdir(parents=True)
    source_paths: list[Path] = []
    for index in range(CANONICAL_CONTRACT.frame_count):
        path = frame_directory / f"source_{index:06d}.png"
        save_rgb_png(path, _studio_frame(index))
        source_paths.append(path)
    foreground_mask = output_directory / "foreground.png"
    _save_foreground_mask(foreground_mask)
    source_mp4 = output_directory / "framelock-hero.mp4"
    encode_source_fixture(source_paths, source_mp4)
    return FrameLockHeroFixture(
        source_mp4=source_mp4,
        foreground_mask=foreground_mask,
    )
