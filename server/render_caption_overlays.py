#!/usr/bin/env python3
"""Render transparent full-frame caption overlays for the local export worker."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


FONT_CANDIDATES = (
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
)


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in FONT_CANDIDATES:
        if os.path.isfile(candidate):
            try:
                return ImageFont.truetype(candidate, size=size, index=0)
            except OSError:
                continue
    return ImageFont.load_default(size=size)


def text_width(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont) -> float:
    if not text:
        return 0
    box = draw.textbbox((0, 0), text, font=font, stroke_width=0)
    return float(box[2] - box[0])


def wrap_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width: int) -> list[str]:
    clean = " ".join(str(text or "").replace("\r", "").split())
    if not clean:
        return []
    lines: list[str] = []
    current = ""
    for character in clean:
        candidate = current + character
        if current and text_width(draw, candidate, font) > max_width:
            lines.append(current.rstrip())
            current = character.lstrip()
        else:
            current = candidate
    if current:
        lines.append(current.rstrip())
    return lines[:3]


def render_caption(width: int, height: int, text: str, destination: Path) -> None:
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    font_size = max(24, min(64, round(height * 0.047)))
    font = load_font(font_size)
    max_text_width = round(width * 0.78)
    lines = wrap_text(draw, text, font, max_text_width)
    if not lines:
        image.save(destination, format="PNG", optimize=True)
        return

    stroke_width = max(2, round(font_size * 0.075))
    line_spacing = max(6, round(font_size * 0.20))
    boxes = [draw.textbbox((0, 0), line, font=font, stroke_width=stroke_width) for line in lines]
    line_heights = [box[3] - box[1] for box in boxes]
    content_height = sum(line_heights) + line_spacing * (len(lines) - 1)
    content_width = max(box[2] - box[0] for box in boxes)
    horizontal_padding = max(18, round(font_size * 0.55))
    vertical_padding = max(10, round(font_size * 0.30))
    panel_width = min(width - 32, content_width + horizontal_padding * 2)
    panel_height = content_height + vertical_padding * 2
    left = (width - panel_width) // 2
    bottom_margin = max(34, round(height * 0.065))
    top = max(14, height - bottom_margin - panel_height)
    radius = max(10, round(font_size * 0.28))
    draw.rounded_rectangle(
        (left, top, left + panel_width, top + panel_height),
        radius=radius,
        fill=(8, 10, 12, 154),
    )

    y = top + vertical_padding
    for line, box, line_height in zip(lines, boxes, line_heights):
        line_width = box[2] - box[0]
        x = (width - line_width) / 2
        draw.text(
            (x, y - box[1]),
            line,
            font=font,
            fill=(255, 255, 255, 255),
            stroke_width=stroke_width,
            stroke_fill=(0, 0, 0, 215),
        )
        y += line_height + line_spacing
    image.save(destination, format="PNG", optimize=True)


def render_pointer_assets(output_dir: Path, size: int, color: str = "#ef4444") -> list[str]:
    size = max(20, min(128, size))
    clean_color = color if len(color) == 7 and color.startswith("#") else "#ef4444"
    try:
        accent = tuple(int(clean_color[index:index + 2], 16) for index in (1, 3, 5))
    except ValueError:
        accent = (239, 68, 68)
    output_dir.mkdir(parents=True, exist_ok=True)
    cursor_path = output_dir / "cursor.png"
    click_path = output_dir / "click.png"

    cursor = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(cursor)
    unit = size / 64.0
    polygon = [(6, 4), (10, 49), (21, 38), (31, 59), (41, 54), (31, 35), (50, 34)]
    points = [(round(x * unit), round(y * unit)) for x, y in polygon]
    draw.polygon(points, fill=(250, 252, 255, 255))
    draw.line(points + [points[0]], fill=(8, 10, 13, 255), width=max(2, round(3 * unit)), joint="curve")
    cursor.save(cursor_path, format="PNG", optimize=True)

    ring_size = max(32, round(size * 1.65))
    ring = Image.new("RGBA", (ring_size, ring_size), (0, 0, 0, 0))
    ring_draw = ImageDraw.Draw(ring)
    inset = max(3, round(ring_size * 0.10))
    stroke = max(3, round(ring_size * 0.08))
    ring_draw.ellipse(
        (inset, inset, ring_size - inset, ring_size - inset),
        fill=(*accent, 34),
        outline=(*accent, 220),
        width=stroke,
    )
    ring.save(click_path, format="PNG", optimize=True)
    return [str(cursor_path), str(click_path)]


def main() -> int:
    if len(sys.argv) in (4, 5) and sys.argv[1] == "--pointer-assets":
        files = render_pointer_assets(
            Path(sys.argv[2]).resolve(),
            int(sys.argv[3]),
            sys.argv[4] if len(sys.argv) == 5 else "#ef4444",
        )
        print(json.dumps({"ok": True, "files": files}, ensure_ascii=False))
        return 0
    if len(sys.argv) != 5:
        print("usage: render_caption_overlays.py captions.json output_dir width height", file=sys.stderr)
        print("   or: render_caption_overlays.py --pointer-assets output_dir size", file=sys.stderr)
        return 2
    config_path = Path(sys.argv[1]).resolve()
    output_dir = Path(sys.argv[2]).resolve()
    width = int(sys.argv[3])
    height = int(sys.argv[4])
    if width < 2 or height < 2 or width > 7680 or height > 7680:
        raise ValueError("invalid caption canvas size")
    payload = json.loads(config_path.read_text(encoding="utf-8"))
    captions = payload.get("captions", []) if isinstance(payload, dict) else []
    if not isinstance(captions, list) or len(captions) > 500:
        raise ValueError("caption count exceeds export limit")
    output_dir.mkdir(parents=True, exist_ok=True)
    rendered: list[str] = []
    for index, caption in enumerate(captions):
        if not isinstance(caption, dict):
            continue
        text = str(caption.get("text", "")).strip()
        if not text:
            continue
        destination = output_dir / f"caption-{index + 1:04d}.png"
        render_caption(width, height, text[:4000], destination)
        rendered.append(str(destination))
    print(json.dumps({"ok": True, "files": rendered}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
