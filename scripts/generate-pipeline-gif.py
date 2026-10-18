#!/usr/bin/env python3
"""Regenerate docs/pipeline.gif — the illustrative ingest-pipeline animation.

The GIF shows the four pipeline stages (Board → Geometry → Vision → Context)
plus the five MCP tools, including the connector-relation arrow and the
`## connections` block introduced with connector extraction and diff_board.

Usage:
    python3 scripts/generate-pipeline-gif.py

Requires: Python 3, Pillow (`pip install pillow`), DejaVu fonts
(Debian/Ubuntu: `apt install fonts-dejavu`; macOS: `brew install --cask font-dejavu`).
"""
import math
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "docs" / "pipeline.gif"

W, H = 900, 486
BG = "#0D1117"; PANEL = "#161B22"; BORDER = "#2D333A"; ACC = "#A371F7"; ACCDIM = "#8A63D2"
TXT = "#E6EDF3"; SUB = "#8B949E"; DIM = "#484F58"; MONO = "#949CA5"; DIVC = "#21262D"

FONT_DIRS = [
    "/usr/share/fonts/truetype/dejavu",          # Debian/Ubuntu
    "/usr/share/fonts/dejavu",                   # Fedora
    os.path.expanduser("~/Library/Fonts"),       # macOS (user)
    "/Library/Fonts",                            # macOS (system)
]


def F(name, size):
    for d in FONT_DIRS:
        p = os.path.join(d, f"{name}.ttf")
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    sys.exit(f"{name}.ttf not found — install the DejaVu fonts (see module docstring).")


f_title = F("DejaVuSans-Bold", 23); f_sub = F("DejaVuSans", 13); f_lbl = F("DejaVuSans-Bold", 13)
f_mcp = F("DejaVuSans-Bold", 11); f_chip = F("DejaVuSansMono", 11); f_card = F("DejaVuSans", 12)
f_badge = F("DejaVuSans-Bold", 9); f_mono = F("DejaVuSansMono", 11); f_rel = F("DejaVuSansMono", 9)

PX = [37, 254, 471, 688]; PW = 178; PY0, PY1 = 150, 300
STICK = [("#F2CC60", 53, 160, -8, True), ("#F778BA", 103, 153, 6, False), ("#F0873E", 156, 168, -5, False),
         ("#69C16C", 66, 199, 5, True), ("#6CB6FF", 128, 201, -7, True), ("#8957E5", 117, 242, 6, True)]
CHIPS = ["ingest_board", "get_board_context", "answer_from_board", "diff_board", "diagnose_llm_config"]
CTX = [("## board — 2 clusters", ACC), ("• User quotes [discover]", MONO),
       ("  exam-stress interviews,", MONO), ("  2 survey screenshots", MONO),
       ("• Problem framing [define]", MONO), ("  unclear reqs, late", MONO), ("  feedback", MONO),
       ("## connections", ACC), ("• quotes → framing", MONO)]


def sticky(im, cx, cy, size, color, rot, lines):
    s = Image.new("RGBA", (size + 12, size + 12), (0, 0, 0, 0))
    d = ImageDraw.Draw(s)
    d.rounded_rectangle([6, 6, 6 + size, 6 + size], radius=5, fill=color)
    if lines:
        dk = tuple(int(v * 0.45) for v in Image.new("RGB", (1, 1), color).getpixel((0, 0)))
        for i in range(2):
            y = 6 + size * 0.35 + i * size * 0.25
            d.line([6 + size * 0.2, y, 6 + size * 0.8, y], fill=dk, width=2)
    s = s.rotate(rot, expand=True, resample=Image.BICUBIC)
    im.paste(s, (int(cx - s.width / 2), int(cy - s.height / 2)), s)


def dashed_rrect(d, box, r=8, dash=6, gap=5, color=ACC, w=2):
    x0, y0, x1, y1 = box
    segs = [((x0 + r, y0), (x1 - r, y0)), ((x1, y0 + r), (x1, y1 - r)),
            ((x1 - r, y1), (x0 + r, y1)), ((x0, y1 - r), (x0, y0 + r))]
    for (ax, ay), (bx, by) in segs:
        L = math.hypot(bx - ax, by - ay); ux, uy = (bx - ax) / L, (by - ay) / L
        n = max(1, int(L // (dash + gap)))
        for i in range(n + 1):
            t0 = i * (dash + gap); t1 = min(t0 + dash, L)
            if t0 >= L:
                break
            d.line([ax + ux * t0, ay + uy * t0, ax + ux * t1, ay + uy * t1], fill=color, width=w)
    for cx, cy, st in [(x0 + r, y0 + r, 180), (x1 - r, y0 + r, 270), (x1 - r, y1 - r, 0), (x0 + r, y1 - r, 90)]:
        d.arc([cx - r, cy - r, cx + r, cy + r], st, st + 90, fill=color, width=w)


def arrow(d, x0, y, x1, color=ACC, w=2):
    d.line([x0, y, x1 - 6, y], fill=color, width=w)
    d.polygon([(x1, y), (x1 - 8, y - 5), (x1 - 8, y + 5)], fill=color)


def varrow(d, x, y0, y1, color=ACC, w=2):
    d.line([x, y0, x, y1 - 5], fill=color, width=w)
    d.polygon([(x, y1), (x - 5, y1 - 8), (x + 5, y1 - 8)], fill=color)


def ctr(d, text, font, cx, y, fill):
    wt = d.textlength(text, font=font); d.text((cx - wt / 2, y), text, font=font, fill=fill)


def card(im, d, idx, badge=False):
    y0 = 163 if idx == 0 else 243; x0, x1 = 487, 630
    d.rounded_rectangle([x0, y0, x1, y0 + 55], radius=8, fill="#1A2029", outline=ACCDIM, width=1)
    cols = ([("#F2CC60", True), ("#F778BA", False), ("#69C16C", True)] if idx == 0
            else [("#6CB6FF", True), ("#F0873E", False), ("#8957E5", True)])
    for i, (c, ln) in enumerate(cols):
        sticky(im, x0 + 21 + i * 22, y0 + 17, 15, c, (-6, 5, -4)[i], ln)
    d.text((x0 + 13, y0 + 33), ("User quotes" if idx == 0 else "Problem framing"), font=f_card, fill=TXT)
    if badge:
        by = y0 + 57; t = "discover" if idx == 0 else "define"
        wt = ImageDraw.Draw(Image.new("RGB", (1, 1))).textlength(t, font=f_badge)
        d.rounded_rectangle([x0 + 10, by, x0 + 10 + wt + 16, by + 14], radius=7, fill="#3D2A5E")
        d.text((x0 + 18, by + 2), t, font=f_badge, fill="#C9A8FF")


def frame(st):
    im = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(im)
    d.text((32, 24), "figjam-context-mcp", font=f_title, fill=TXT)
    d.text((32, 59), "A FigJam board, read via the Figma API and turned into LLM-ready context",
           font=f_sub, fill=SUB)
    for i, lbl in enumerate(["1 · Board", "2 · Geometry", "3 · Vision", "4 · Context"]):
        ctr(d, lbl, f_lbl, PX[i] + PW / 2, 313, TXT if st["stage"] >= i + 1 else DIM)
    d.line([40, 341, 860, 341], fill=DIVC, width=1)
    x = 450 - ((ImageDraw.Draw(Image.new("RGB", (1, 1))).textlength("MCP TOOLS", font=f_mcp)) + 8 * 1.5) / 2
    for ch in "MCP TOOLS":
        d.text((x, 352), ch, font=f_mcp, fill=SUB); x += d.textlength(ch, font=f_mcp) + 1.5
    widths = [d.textlength(t, font=f_chip) + 22 for t in CHIPS]
    cx = (W - (sum(widths) + 4 * 14)) / 2
    for t, wd in zip(CHIPS, widths):
        if st["hl"]:
            d.rounded_rectangle([cx, 385, cx + wd, 414], radius=6, fill="#1A1828", outline=ACC, width=1)
        else:
            d.rounded_rectangle([cx, 385, cx + wd, 414], radius=6, outline="#30363D", width=1)
        d.text((cx + 11, 392), t, font=f_chip, fill="#CDCFD6" if st["hl"] else "#7C858E"); cx += wd + 14
    d.rounded_rectangle([PX[0], PY0, PX[0] + PW, PY1], radius=12, fill=PANEL, outline=BORDER, width=1)
    for i in range(st["stick"]):
        c, sx, sy, r, ln = STICK[i]; sticky(im, PX[0] + sx - 37 + 13, sy + 13, 26, c, r, ln)
    if st["stage"] >= 2:
        arrow(d, PX[0] + PW + 8, 225, PX[1] - 8)
        d.rounded_rectangle([PX[1], PY0, PX[1] + PW, PY1], radius=12, fill=PANEL, outline=BORDER, width=1)
        for c, sx, sy, r, ln in STICK:
            sticky(im, PX[1] + sx - 37 + 13, sy + 13, 26, c, r, ln)
        if st["box"] >= 1:
            dashed_rrect(d, (PX[1] + 10, 156, PX[1] + 96, 234))
        if st["box"] >= 2:
            dashed_rrect(d, (PX[1] + 78, 160, PX[1] + 156, 282))
    if st["stage"] >= 3:
        arrow(d, PX[1] + PW + 8, 225, PX[2] - 8)
        d.rounded_rectangle([PX[2], PY0, PX[2] + PW, PY1], radius=12, fill=PANEL, outline=BORDER, width=1)
        if st["card"] >= 1:
            card(im, d, 0, badge=st["badge"] >= 1)
        if st["card"] >= 2:
            card(im, d, 1, badge=st["badge"] >= 2)
        if st["rel"]:
            varrow(d, 612, 222, 241)
            d.text((560, 224), "informs", font=f_rel, fill=SUB)
    if st["stage"] >= 4:
        arrow(d, PX[2] + PW + 8, 225, PX[3] - 8)
        d.rounded_rectangle([PX[3], PY0, PX[3] + PW, PY1], radius=12, fill=PANEL, outline=BORDER, width=1)
        for i in range(st["lines"]):
            t, c = CTX[i]; d.text((PX[3] + 13, 162 + i * 15), t, font=f_mono, fill=c)
    return im


def S(**kw):
    base = dict(stage=1, stick=0, box=0, card=0, badge=0, rel=False, lines=0, hl=False)
    base.update(kw)
    return base


states = [(S(), 640)]
for i in range(1, 7):
    states.append((S(stick=i), 90))
states.append((S(stick=6, stage=2), 90))
states.append((S(stick=6, stage=2, box=1), 90))
states.append((S(stick=6, stage=2, box=2), 90))
states.append((S(stick=6, stage=2, box=2), 90))
g = dict(stick=6, box=2)
states.append((S(stage=3, **g), 90))
states.append((S(stage=3, card=1, **g), 90))
states.append((S(stage=3, card=1, badge=1, **g), 90))
states.append((S(stage=3, card=2, badge=1, **g), 90))
states.append((S(stage=3, card=2, badge=2, **g), 90))
states.append((S(stage=3, card=2, badge=2, rel=True, **g), 90))
states.append((S(stage=3, card=2, badge=2, rel=True, **g), 90))
v = dict(stick=6, box=2, card=2, badge=2, rel=True)
states.append((S(stage=4, **v), 90))
for i in range(1, 10):
    states.append((S(stage=4, lines=i, **v), 90))
states.append((S(stage=4, lines=9, hl=True, **v), 190))
states.append((S(stage=4, lines=9, hl=True, **v), 2110))

frames = [frame(st) for st, _ in states]
durs = [dur for _, dur in states]
q = [f.quantize(colors=128, method=Image.MEDIANCUT, dither=Image.NONE) for f in frames]
q[0].save(OUT, save_all=True, append_images=q[1:], duration=durs, loop=0, optimize=True)
print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB, {len(frames)} frames, {sum(durs)} ms)")
