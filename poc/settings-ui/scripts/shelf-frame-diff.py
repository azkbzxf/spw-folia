#!/usr/bin/env python
"""Crop the same rectangle out of two PNGs and report how much they differ.

The shelf's live pictures are proven to *move* by pixel change, not by a marker alone: the host
takes two screenshots while a tile runs, this crops both to that tile's on-screen rect and compares.

    python shelf-frame-diff.py a.png b.png <left> <top> <width> <height>

Prints one JSON object:
    {"size": [w, h], "pixels": n, "changed": m, "changedRatio": m/n, "maxDelta": d, "moving": bool}

A static JPEG rendered twice gives changedRatio 0 and maxDelta 0; a running style gives a ratio well
above the threshold. Thresholds live here so the JS side has no magic numbers of its own.
"""
import json
import sys

from PIL import Image, ImageChops

# A pixel counts as changed when any channel differs by more than this (JPEG noise stays below it).
PIXEL_DELTA = 8
# The share of the rect that has to change for the tile to count as moving.
MOVING_RATIO = 0.005
# Room for CSS-px rounding when cropping.
PAD = 2


def main() -> int:
    first_path, second_path, left, top, width, height = sys.argv[1:7]
    left, top, width, height = (int(float(value)) for value in (left, top, width, height))

    first = Image.open(first_path).convert("RGB")
    second = Image.open(second_path).convert("RGB")
    if first.size != second.size:
        print(json.dumps({"error": "size mismatch", "sizes": [list(first.size), list(second.size)]}))
        return 1

    box = (
        max(0, left - PAD),
        max(0, top - PAD),
        min(first.width, left + width + PAD),
        min(first.height, top + height + PAD),
    )
    a = first.crop(box)
    b = second.crop(box)

    diff = ImageChops.difference(a, b)
    grey = diff.convert("L")
    pixels = a.width * a.height
    # max channel delta over the whole crop
    max_delta = max(channel.getextrema()[1] for channel in diff.split())
    changed = sum(1 for value in grey.getdata() if value > PIXEL_DELTA)
    ratio = changed / pixels if pixels else 0.0

    print(json.dumps({
        "size": [a.width, a.height],
        "pixels": pixels,
        "changed": changed,
        "changedRatio": round(ratio, 5),
        "maxDelta": max_delta,
        "moving": ratio >= MOVING_RATIO,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
