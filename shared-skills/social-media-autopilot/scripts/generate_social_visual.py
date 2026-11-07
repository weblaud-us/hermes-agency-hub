#!/usr/bin/env python3
"""
Weblaud Autonomous Branded Visual Generator.
Generates a 1080x1080 social media post image:
1. Calls OpenAI/Fal/OpenRouter image generation API (if API key is configured) OR builds a procedural high-contrast studio canvas using Pillow.
2. Overlays the client's exact Brand Kit (Logo badge, category eyebrow, headline, offer/price pill, and footer CTA) so typography and branding are 100% crisp and never hallucinated.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import math
import os
import textwrap
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape as _xml_escape

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False


def _hex_to_rgb(hex_color: str, default: tuple[int, int, int] = (0, 245, 212)) -> tuple[int, int, int]:
    cleaned = (hex_color or "").strip().lstrip("#")
    if len(cleaned) == 6:
        try:
            return int(cleaned[0:2], 16), int(cleaned[2:4], 16), int(cleaned[4:6], 16)
        except ValueError:
            pass
    return default


def _fetch_ai_background(prompt: str, size: int = 1080) -> "Image.Image | None":
    """Attempts to generate a photorealistic background via OpenAI Images API if OPENAI_API_KEY is set."""
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key or not PIL_AVAILABLE:
        return None

    payload = json.dumps({
        "model": os.environ.get("WEBLAUD_IMAGE_MODEL", "dall-e-3"),
        "prompt": (
            f"Clean commercial studio photography for a modern business social media post. "
            f"{prompt}. No text, no letters, no watermarks, dramatic lighting, high contrast."
        ),
        "n": 1,
        "size": "1024x1024",
        "response_format": "b64_json",
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.openai.com/v1/images/generations",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            b64_data = body["data"][0]["b64_json"]
            raw_bytes = base64.b64decode(b64_data)
            img = Image.open(io.BytesIO(raw_bytes)).convert("RGBA")
            return img.resize((size, size), Image.Resampling.LANCZOS)
    except Exception:
        return None


def _build_studio_background(
    size: int,
    primary_rgb: tuple[int, int, int],
    accent_rgb: tuple[int, int, int],
) -> "Image.Image":
    """Creates a sleek dark obsidian + radial aurora studio canvas when offline or in fast mode."""
    base = Image.new("RGBA", (size, size), (7, 9, 14, 255))
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)

    # Top-right primary glow
    gdraw.ellipse((size * 0.35, -size * 0.15, size * 1.15, size * 0.65), fill=(*primary_rgb, 95))
    # Bottom-left accent glow
    gdraw.ellipse((-size * 0.2, size * 0.40, size * 0.60, size * 1.20), fill=(*accent_rgb, 85))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=95))
    base = Image.alpha_composite(base, glow)

    # Subtle perspective grid lines
    grid_overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grid_draw = ImageDraw.Draw(grid_overlay)
    step = 54
    for pos in range(0, size, step):
        grid_draw.line([(pos, 0), (pos, size)], fill=(255, 255, 255, 11), width=1)
        grid_draw.line([(0, pos), (size, pos)], fill=(255, 255, 255, 11), width=1)
    return Image.alpha_composite(base, grid_overlay)


def _load_font(size: int, bold: bool = False) -> "ImageFont.FreeTypeFont | ImageFont.ImageFont":
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size=size)
            except Exception:
                continue
    try:
        # Pillow 10.1+ ships a scalable fallback; without a size the bitmap default is tiny.
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def generate_branded_post(
    *,
    brand_name: str,
    business_mode: str,
    prompt: str,
    headline: str,
    subtext: str,
    cta_text: str,
    primary_hex: str = "#00F5D4",
    accent_hex: str = "#6366F1",
    output_path: Path,
) -> dict[str, Any]:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    size = 1080
    primary_rgb = _hex_to_rgb(primary_hex, (0, 245, 212))
    accent_rgb = _hex_to_rgb(accent_hex, (99, 102, 241))

    if not PIL_AVAILABLE:
        # Fallback SVG if Pillow is not installed in a minimal test environment.
        # Every value is client-supplied, so each one is escaped before it is placed in markup.
        svg_path = output_path.with_suffix(".svg")
        color = _xml_escape(f"#{primary_hex.strip().lstrip('#')}" if len(primary_hex.strip().lstrip("#")) == 6 else "#00F5D4")
        accent = _xml_escape(f"#{accent_hex.strip().lstrip('#')}" if len(accent_hex.strip().lstrip("#")) == 6 else "#6366F1")
        svg_content = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" width="1080" height="1080">
  <rect width="1080" height="1080" fill="#07090E"/>
  <circle cx="860" cy="220" r="340" fill="{color}" opacity="0.22"/>
  <circle cx="220" cy="880" r="320" fill="{accent}" opacity="0.22"/>
  <rect x="64" y="64" width="952" height="952" rx="36" fill="none" stroke="{color}" stroke-opacity="0.35" stroke-width="3"/>
  <text x="110" y="150" fill="{color}" font-family="sans-serif" font-size="28" font-weight="700">{_xml_escape(brand_name.upper())} • {_xml_escape(business_mode.upper())}</text>
  <text x="110" y="470" fill="#FFFFFF" font-family="sans-serif" font-size="64" font-weight="800">{_xml_escape(headline[:36])}</text>
  <text x="110" y="560" fill="#CBD5E1" font-family="sans-serif" font-size="36">{_xml_escape(subtext[:55])}</text>
  <rect x="110" y="850" width="520" height="82" rx="41" fill="{color}"/>
  <text x="370" y="902" text-anchor="middle" fill="#07090E" font-family="sans-serif" font-size="30" font-weight="700">{_xml_escape(cta_text[:34])}</text>
</svg>"""
        svg_path.write_text(svg_content, encoding="utf-8")
        return {"status": "ok", "engine": "svg_fallback", "output_path": str(svg_path)}

    bg = _fetch_ai_background(prompt, size=size)
    used_ai_bg = bg is not None
    if bg is None:
        bg = _build_studio_background(size=size, primary_rgb=primary_rgb, accent_rgb=accent_rgb)
    else:
        # Dark gradient scrim over AI photo so brand typography stays 100% legible
        scrim = Image.new("RGBA", (size, size), (6, 8, 14, 165))
        bg = Image.alpha_composite(bg, scrim)

    draw = ImageDraw.Draw(bg)

    # Outer specular card frame
    margin = 56
    draw.rounded_rectangle(
        (margin, margin, size - margin, size - margin),
        radius=36,
        outline=(*primary_rgb, 110),
        width=3,
    )

    # Top Brand Pill
    font_brand = _load_font(26, bold=True)
    font_eyebrow = _load_font(22, bold=True)
    font_headline = _load_font(62, bold=True)
    font_sub = _load_font(34, bold=False)
    font_cta = _load_font(28, bold=True)

    draw.rounded_rectangle((100, 104, 460, 166), radius=31, fill=(17, 24, 39, 220), outline=(*primary_rgb, 140), width=2)
    draw.text((128, 121), f"{brand_name.upper()}", fill=(255, 255, 255, 255), font=font_brand)

    mode_badge = "E-COMMERCE DROP" if business_mode == "ecommerce" else "GROWTH SPOTLIGHT"
    draw.text((100, 220), mode_badge, fill=(*primary_rgb, 255), font=font_eyebrow)

    # Wrapped Headline (Max 3 lines)
    wrapped_lines = textwrap.wrap(headline, width=20)[:3]
    y_cursor = 285
    for line in wrapped_lines:
        draw.text((100, y_cursor), line, fill=(255, 255, 255, 255), font=font_headline)
        y_cursor += 82

    # Subtext / Offer Highlight Card
    y_cursor += 28
    draw.rounded_rectangle(
        (100, y_cursor, size - 100, y_cursor + 120),
        radius=24,
        fill=(15, 23, 42, 210),
        outline=(255, 255, 255, 45),
        width=2,
    )
    draw.text((132, y_cursor + 40), subtext[:48], fill=(*primary_rgb, 255), font=font_sub)

    # Bottom CTA Button Bar
    cta_top = size - 190
    draw.rounded_rectangle(
        (100, cta_top, 640, cta_top + 84),
        radius=42,
        fill=(*primary_rgb, 255),
    )
    draw.text((144, cta_top + 26), cta_text[:34], fill=(7, 9, 14, 255), font=font_cta)

    bg.convert("RGB").save(output_path, format="PNG", optimize=True)
    return {
        "status": "ok",
        "engine": "openai_plus_brand_overlay" if used_ai_bg else "studio_canvas_overlay",
        "output_path": str(output_path),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate branded Weblaud social visual.")
    parser.add_argument("--brand", default="Weblaud Partner")
    parser.add_argument("--mode", default="general", choices=["general", "ecommerce"])
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--headline", required=True)
    parser.add_argument("--subtext", default="Book or Order Instantly via Message")
    parser.add_argument("--cta", default="DM 'START' FOR INSTANT REPLY ->")
    parser.add_argument("--primary-color", default="#00F5D4")
    parser.add_argument("--accent-color", default="#6366F1")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    result = generate_branded_post(
        brand_name=args.brand,
        business_mode=args.mode,
        prompt=args.prompt,
        headline=args.headline,
        subtext=args.subtext,
        cta_text=args.cta,
        primary_hex=args.primary_color,
        accent_hex=args.accent_color,
        output_path=Path(args.output),
    )
    print(json.dumps(result))


if __name__ == "__main__":
    main()
