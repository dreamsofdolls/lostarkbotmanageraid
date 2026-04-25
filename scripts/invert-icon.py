#!/usr/bin/env python3
"""
invert-icon.py

Invert RGB color of a class icon PNG while preserving alpha. Used to
turn black-on-transparent silhouettes (e.g. Inven AI vector exports) into
white-on-transparent (the format Discord application emoji needs to be
visible against dark mode chat backgrounds).

Usage:
    python scripts/invert-icon.py assets/class-icons/foo.png

In-place by default - the file is overwritten with the inverted version.
Pass `--out path` to write to a different destination instead.

Why this exists:
    - Lost Ark game UI icons (the version Fandom Wiki rips) are
      white-on-transparent, designed for dark UI overlay. They render
      correctly on Discord's dark mode without modification.
    - Community AI vector packs (Inven, Maxroll) ship as black-on-
      transparent because they're authored against white print/web
      backgrounds. Drop one into Discord dark mode and the silhouette
      vanishes into the background.
    - The two styles are visually identical after a color invert (RGB
      flipped, alpha untouched). One Pillow call, no per-icon redraw.

Requires Pillow:
    pip install Pillow
"""

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError:
    print("ERROR: Pillow not installed. Run: pip install Pillow", file=sys.stderr)
    sys.exit(1)


def invert_in_place(src: Path, dst: Path) -> None:
    img = Image.open(src).convert("RGBA")
    r, g, b, a = img.split()
    inverted_rgb = ImageOps.invert(Image.merge("RGB", (r, g, b)))
    out = Image.merge("RGBA", (*inverted_rgb.split(), a))
    out.save(dst)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("path", type=Path, help="PNG file to invert")
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Write inverted PNG here instead of overwriting input",
    )
    args = parser.parse_args()

    if not args.path.exists():
        print(f"ERROR: {args.path} not found", file=sys.stderr)
        return 1
    dst = args.out if args.out else args.path
    invert_in_place(args.path, dst)
    print(f"inverted: {args.path} -> {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
