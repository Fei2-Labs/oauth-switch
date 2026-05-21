#!/usr/bin/env python3
"""Generate app icon PNGs for OAuthSwitch."""
import subprocess
import os

SIZES = [16, 32, 64, 128, 256, 512, 1024]
OUT_DIR = "OAuthSwitch/Resources/Assets.xcassets/AppIcon.appiconset"

SVG = """<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#6366f1"/>
      <stop offset="100%" style="stop-color:#8b5cf6"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="220" fill="url(#bg)"/>
  <g transform="translate(512,460)" fill="none" stroke="white" stroke-width="56" stroke-linecap="round">
    <path d="M -180,-100 A 200,200 0 1,1 180,-100"/>
    <polygon points="180,-100 130,-170 230,-140" fill="white" stroke="none"/>
    <path d="M 180,100 A 200,200 0 1,1 -180,100"/>
    <polygon points="-180,100 -130,170 -230,140" fill="white" stroke="none"/>
  </g>
  <g transform="translate(512,740)">
    <circle cx="0" cy="0" r="44" fill="none" stroke="white" stroke-width="36"/>
    <line x1="44" y1="0" x2="160" y2="0" stroke="white" stroke-width="36" stroke-linecap="round"/>
    <line x1="115" y1="0" x2="115" y2="40" stroke="white" stroke-width="28" stroke-linecap="round"/>
    <line x1="150" y1="0" x2="150" y2="40" stroke="white" stroke-width="28" stroke-linecap="round"/>
  </g>
</svg>"""

os.makedirs(OUT_DIR, exist_ok=True)

svg_path = "/tmp/oauth-switch-icon.svg"
with open(svg_path, "w") as f:
    f.write(SVG)

for size in SIZES:
    png_path = os.path.join(OUT_DIR, f"icon_{size}x{size}.png")
    subprocess.run([
        "cairosvg", svg_path, "-o", png_path,
        "-W", str(size), "-H", str(size)
    ], check=True)
    print(f"  Generated {png_path}")

print("Done.")
