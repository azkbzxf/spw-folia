"""Re-subset assets/fonts/serif.woff2 to exactly the characters the site renders.

This is the maintenance script for the site's only webfont. Run it after
editing site/index.html, site/style.css or site/main.js so display type keeps
rendering with the shipped serif instead of falling back to a system face.

    python site/tools/make-font.py

Needs fontTools + brotli (pip install fonttools brotli) and the upstream
Noto Serif SC variable font. If either is missing the site still works — it
just falls back to the system serif stack declared in style.css.
"""
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

SITE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # site/
SRC_CANDIDATES = [
    os.environ.get("SERIF_SRC", ""),
    r"C:\Windows\Fonts\NotoSerifSC-VF.ttf",
    r"C:\Windows\Fonts\NotoSerifSC-Regular.otf",
]
OUT = os.path.join(SITE, "assets", "fonts", "serif.woff2")

# Everything the browser can render text from. Tools and docs are deliberately
# excluded: their prose never reaches the page.
SOURCES = ["index.html", "style.css", "main.js"]

EXTRA = (
    "　、。〃〈〉《》「」『』【】〔〕〖〗！＂＃＄％＆＇（）＊＋，－．／：；＜＝＞？＠［＼］＾＿｀｛｜｝～"
    "…—–·‘’“”•→←↑↓✦✕✓×≤≥"
    "〇一二三四五六七八九十百千万亿"
)


def collect():
    chars = set()
    for name in SOURCES:
        path = os.path.join(SITE, name)
        if not os.path.exists(path):
            sys.exit(f"missing {path} — run this from the repo root")
        with open(path, encoding="utf-8") as handle:
            chars.update(handle.read())
    chars.update(chr(c) for c in range(0x20, 0x7F))
    chars.update(EXTRA)
    return "".join(sorted(c for c in chars if c.isprintable() or c == " "))


def main():
    source = next((p for p in SRC_CANDIDATES if p and os.path.exists(p)), None)
    if not source:
        sys.exit(
            "source font not found — set SERIF_SRC to NotoSerifSC-VF.ttf "
            "(without it the site falls back to a system serif)"
        )

    text = collect()
    sys.stderr.write(f"unique chars: {len(text)}\n")

    options = subset.Options()
    options.flavor = "woff2"
    options.desubroutinize = True
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    options.recalc_bounds = True
    options.drop_tables += ["DSIG"]

    font = subset.load_font(source, options)
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text=text)
    subsetter.subset(font)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    subset.save_font(font, OUT, options)
    sys.stderr.write(
        f"{OUT}: {os.path.getsize(OUT) / 1024:.0f} KB "
        f"(from {os.path.getsize(source) / 1048576:.1f} MB)\n"
    )

    cmap = TTFont(OUT).getBestCmap()
    missing = sorted({c for c in text if c not in cmap and not c.isspace()})
    if missing:
        sys.stderr.write(f"missing glyphs ({len(missing)}): {''.join(missing)}\n")
        sys.stderr.write("这些字会退回系统衬线栈，正文无影响。\n")
    else:
        sys.stderr.write("missing glyphs: none\n")


if __name__ == "__main__":
    main()
