#!/usr/bin/env python3
"""Regenerate packaging/image-overrides from the pristine Folia web dist.

The packaged artifact ships Folia's illustration/avatar PNGs and the preview
cover JPGs verbatim from `poc/webview/dist/dist`. Re-encoding them losslessly
does nothing (they are already deflated), but they are flat-shaded anime
illustrations, so a 256-colour palette PNG keeps the look at ~1/4 of the bytes
and a q88 progressive JPEG halves the cover photos.

The override files keep their original file names and formats, so no staged
JavaScript/CSS has to be rewritten (dynamic `new URL(...)` fallbacks keep
working) -- `packaging/tools/apply-image-overrides.mjs` just copies these files
over the freshly staged `packaging/web/` tree.

Requires Pillow (the DSH bundled Python has it):

  python packaging/tools/make-image-overrides.py

Run this only when the upstream Folia web bundle changes; commit the resulting
files together with this script.
"""

from __future__ import annotations

import io
import re
import sys
from pathlib import Path

try:
    from PIL import Image
except ModuleNotFoundError:  # pragma: no cover - documented environment requirement
    sys.exit("Pillow is required: run this with the DSH bundled Python (Pillow is vendored there)")

ROOT = Path(__file__).resolve().parents[2]
DIST_ASSETS = ROOT / "poc" / "webview" / "dist" / "dist" / "assets"
OUT = ROOT / "packaging" / "image-overrides"

PNG_COLORS = 256
JPEG_QUALITY = 88

PNG_RE = re.compile(r"\.png$", re.IGNORECASE)
JPG_RE = re.compile(r"\.jpe?g$", re.IGNORECASE)
COVER_BASE_RE = re.compile(r"^placeholder_cover-(?!2-).*\.jpg$", re.IGNORECASE)
COVER_RESERVED_RE = re.compile(r"^placeholder_cover-2-.*\.jpg$", re.IGNORECASE)


def optimize_png(data: bytes) -> bytes:
    im = Image.open(io.BytesIO(data))
    if im.mode not in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
    quantized = im.convert("RGBA").quantize(colors=PNG_COLORS, method=Image.Quantize.FASTOCTREE)
    buf = io.BytesIO()
    quantized.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def optimize_jpeg(data: bytes) -> bytes:
    im = Image.open(io.BytesIO(data)).convert("RGB")
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
    return buf.getvalue()


def main() -> None:
    if not DIST_ASSETS.is_dir():
        sys.exit(f"missing source dir: {DIST_ASSETS}")

    out_assets = OUT / "assets"
    out_preview = OUT / "preview"
    out_assets.mkdir(parents=True, exist_ok=True)
    out_preview.mkdir(parents=True, exist_ok=True)

    total_before = 0
    total_after = 0
    written = 0
    cover_base = None
    cover_reserved = None

    for path in sorted(DIST_ASSETS.iterdir()):
        if not path.is_file():
            continue
        data = path.read_bytes()
        if PNG_RE.search(path.name):
            optimized = optimize_png(data)
        elif JPG_RE.search(path.name):
            optimized = optimize_jpeg(data)
        else:
            continue
        (out_assets / path.name).write_bytes(optimized)
        total_before += len(data)
        total_after += len(optimized)
        written += 1
        if COVER_RESERVED_RE.match(path.name):
            cover_reserved = (path.name, optimized)
        elif COVER_BASE_RE.match(path.name):
            cover_base = (path.name, optimized)

    for name, optimized in (("placeholder_cover.jpg", cover_base), ("placeholder_cover-2.jpg", cover_reserved)):
        if optimized is None:
            continue
        source_name, source_bytes = optimized
        (out_preview / name).write_bytes(source_bytes)
        total_after += len(source_bytes)
        total_before += len(source_bytes)
        written += 1
        print(f"preview cover: {name} <- assets/{source_name}")

    saved = total_before - total_after
    print(
        f"wrote {written} override file(s) to {OUT}: "
        f"{total_before / 1048576:.2f} MB -> {total_after / 1048576:.2f} MB "
        f"(saved {saved / 1048576:.2f} MB, {saved / max(total_before, 1):.1%})"
    )


if __name__ == "__main__":
    main()
