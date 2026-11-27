#!/usr/bin/env python3
"""Compose store shot 1: the REAL-AI panel rewrite capture from the
24/24 evidence campaign (B-08b-panel-rewrite.png, 520x860) presented on
a neutral 1280x800 backdrop — the Chrome Web Store screenshot format.

All UI pixels are genuine product output; the backdrop is presentation
chrome only. Run: test-lab/.venv/bin/python test-lab/compose-shot1.py
"""
import os
from PIL import Image

ROOT = "/home/z/audit-repo"
SRC = os.path.join(ROOT, "test-evidence", "B-08b-panel-rewrite.png")
DST = os.path.join(ROOT, "test-evidence", "store", "store-1-sidepanel-rewrite.png")

W, H = 1280, 800
BG = (247, 246, 243)        # warm paper white
PANEL_H = 720
BORDER = (212, 212, 210)
SHADOW = (225, 224, 220)

panel = Image.open(SRC).convert("RGB")
pw = round(panel.width * PANEL_H / panel.height)
ph = PANEL_H
panel = panel.resize((pw, ph), Image.LANCZOS)

canvas = Image.new("RGB", (W, H), BG)
x = (W - pw) // 2
y = (H - ph) // 2

# soft shadow + border + panel
canvas.paste(Image.new("RGB", (pw, ph), SHADOW), (x + 5, y + 6))
canvas.paste(Image.new("RGB", (pw, ph), BORDER), (x - 1, y - 1))
canvas.paste(panel, (x, y))

os.makedirs(os.path.dirname(DST), exist_ok=True)
canvas.save(DST)
print(f"wrote {DST} ({canvas.width}x{canvas.height})")
