"""Derive every Charts of Rehan logo asset from the owner's supplied image.

One authority for the mark. The owner's full rounded-square logo is copied to
``assets/`` and scaled only; no emblem crop or redraw is allowed, so the
Desktop tile, the browser tab, the README and the shortcut cannot drift apart.

Run it again only when the mark changes:

    python maintenance/make_logo_assets.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]

#: The owner's official image. This is the only source; it is never replaced
#: by an older upload or a cropped derivative.
SOURCE = ROOT / "assets" / "charts-of-rehan.png"

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def main() -> None:
    if not SOURCE.is_file():
        raise SystemExit(
            "the official logo is missing: expected assets/charts-of-rehan.png"
        )
    full = Image.open(SOURCE).convert("RGBA")
    assets = ROOT / "assets"
    public = ROOT / "web" / "public"
    public.mkdir(parents=True, exist_ok=True)

    # Keep the owner's full mark for the README and the shortcut. The PNG
    # itself is the canonical source; only the derived sizes are written.
    full.resize((256, 256), Image.LANCZOS).save(public / "logo.png")
    full.resize((128, 128), Image.LANCZOS).save(
        assets / "charts-of-rehan-128.png")
    full.resize((256, 256), Image.LANCZOS).save(
        assets / "charts-of-rehan.ico", format="ICO",
        sizes=[(size, size) for size in ICO_SIZES])

    print(f"source {SOURCE} {full.width}x{full.height}")
    for path in (SOURCE,
                 assets / "charts-of-rehan-128.png",
                 assets / "charts-of-rehan.ico",
                 public / "logo.png"):
        print(f"{path.relative_to(ROOT)} {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
