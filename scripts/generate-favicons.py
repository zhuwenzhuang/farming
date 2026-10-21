#!/usr/bin/env python3
"""Rebuild browser favicons from the brand master: python3 scripts/generate-favicons.py.

Requires Pillow. Installed-app artwork keeps its original paper background.
"""

import base64
import json
from pathlib import Path
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "public/farming-2"
SIZES = (16, 32, 48, 64)
CRT_ICON = ROOT / "frontend/skins/crt/assets/branding/farming-crt-icon.svg"


def browser_artwork():
    artwork = Image.open(ASSETS / "app-icon-v2-master.png").convert("RGBA")
    # Select paper by its light, low-chroma color, then remove only regions
    # connected to the perimeter. Skin, shirt highlights and other enclosed
    # pale details must stay opaque. These thresholds belong to this master.
    paper = Image.new("L", artwork.size)
    rgb = artwork.convert("RGB").tobytes()
    paper.putdata([
        0 if r >= 220 and g >= 210 and b >= 185 and r - g <= 22 and g - b <= 38 else 255
        for r, g, b in zip(rgb[::3], rgb[1::3], rgb[2::3])
    ])
    width, height = paper.size
    for x in range(width):
        for y in (0, height - 1):
            if paper.getpixel((x, y)) == 0:
                ImageDraw.floodfill(paper, (x, y), 128)
    for y in range(height):
        for x in (0, width - 1):
            if paper.getpixel((x, y)) == 0:
                ImageDraw.floodfill(paper, (x, y), 128)
    alpha = paper.point(lambda value: 0 if value == 128 else 255)
    # Soften at source resolution before alpha-aware downsampling; never
    # flatten onto a light matte, which would reintroduce a halo on dark tabs.
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.6))
    artwork.putalpha(alpha)
    # Keep the established close portrait framing: the face must remain
    # readable at 16px instead of shrinking to fit the whole garden.
    return artwork.crop((175, 170, 1085, 1080))


def main():
    artwork = browser_artwork()
    for size in SIZES:
        artwork.resize((size, size), Image.Resampling.LANCZOS).save(
            ASSETS / f"favicon-v3-{size}.png", optimize=True
        )
    artwork.save(ASSETS / "favicon-v3.ico", sizes=[(size, size) for size in SIZES])
    # One self-contained SVG follows the browser color scheme without an app
    # theme listener or external image requests from the favicon context.
    ET.register_namespace("", "http://www.w3.org/2000/svg")
    crt = ET.parse(CRT_ICON).getroot()
    crt_art = "\n".join(ET.tostring(child, encoding="unicode") for child in crt
                        if child.tag != "{http://www.w3.org/2000/svg}title")
    farmer = base64.b64encode((ASSETS / "favicon-v3-64.png").read_bytes()).decode("ascii")
    themes = json.loads((ROOT / "shared/appearance-themes.json").read_text())
    light_dot = themes["light"]["css"]["--code-unread-dot"]
    dark_dot = themes["dark"]["css"]["--code-unread-dot"]
    for unread in (False, True):
        cutout = '''<defs><mask id="badge-space"><rect width="64" height="64" fill="white"/>
    <circle cx="54" cy="10" r="10" fill="black"/></mask></defs>''' if unread else ""
        mask = ' mask="url(#badge-space)"' if unread else ""
        dot = '<circle class="unread" cx="54" cy="10" r="8"/>' if unread else ""
        svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <title>Farming</title>
  <style>
    .crt {{ display: none; }}
    .unread {{ fill: {light_dot}; }}
    @media (prefers-color-scheme: dark) {{
      .farmer {{ display: none; }}
      .crt {{ display: inline; }}
      .unread {{ fill: {dark_dot}; }}
    }}
  </style>
  {cutout}
  <g{mask}>
    <image class="farmer" width="64" height="64" href="data:image/png;base64,{farmer}"/>
    <g class="crt">{crt_art}</g>
  </g>
  {dot}
</svg>
'''
        (ASSETS / f"favicon-v4{'-unread' if unread else ''}.svg").write_text(
            "\n".join(line.rstrip() for line in svg.splitlines()) + "\n", encoding="utf-8"
        )
    print("Generated transparent PNG/ICO and adaptive farmer/CRT SVGs with shared blue unread dots.")


if __name__ == "__main__":
    main()
