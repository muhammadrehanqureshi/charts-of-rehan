"""Derive every Charts of Rehan logo asset from the owner's logo.

One authority for the mark. The full logo is copied to ``assets/`` for the
README, and the emblem (the gold-ringed candles) is cropped to a square whose
centre is the emblem's own *measured* centre, so the Desktop tile, the browser
tab and the README cannot drift apart. The crop keeps the logo's black plate.

Run it again only when the mark changes:

    python maintenance/make_logo_assets.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]

# The uploaded logo first, the shipped brand image second: regenerating on a
# machine that does not carry the original upload still reproduces the assets.
CANDIDATES = [
    ROOT / ".cloud-attachments" /
    "236cfb18a261fe4401e24bfae98c98dd9d9013630e0eb778b34540726feb3f33.png",
    ROOT / "assets" / "charts-of-rehan.png",
]

# How much black plate to keep around the emblem. Enough for the ring's own
# glow at 16 px, little enough that the mark still fills a Desktop tile.
PADDING = 1.14

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# A pixel counts as part of the mark when it is brighter than the plate. The
# plate is pure black in this logo, so the threshold only has to clear JPEG-ish
# noise, not judge colour.
BRIGHTNESS = 60


def emblem_bounds(image: Image.Image) -> tuple[int, int, int, int]:
    """The bounding box of the emblem in the logo's upper area."""
    rgb = image.convert("RGB")
    width, height = rgb.size
    pixels = rgb.load()
    # The wordmark lives below the ring; measuring only the upper part keeps
    # the text from defining the emblem's box.
    limit = int(height * 0.62)
    min_x, min_y, max_x, max_y = width, limit, -1, -1
    for y in range(limit):
        for x in range(width):
            red, green, blue = pixels[x, y]
            if red + green + blue <= BRIGHTNESS:
                continue
            min_x = min(min_x, x)
            max_x = max(max_x, x)
            min_y = min(min_y, y)
            max_y = max(max_y, y)
    if max_x < 0 or max_y < 0:
        raise SystemExit("no emblem found: the logo's upper area is all plate")
    return min_x, min_y, max_x, max_y


def centred_crop(image: Image.Image) -> tuple[Image.Image, dict]:
    """A square around the emblem, with the emblem at its exact centre."""
    min_x, min_y, max_x, max_y = emblem_bounds(image)
    side = int(round(max(max_x - min_x + 1, max_y - min_y + 1) * PADDING))
    centre_x = (min_x + max_x + 1) / 2
    centre_y = (min_y + max_y + 1) / 2
    left = int(round(centre_x - side / 2))
    top = int(round(centre_y - side / 2))
    source = image.convert("RGBA")
    square = Image.new("RGBA", (side, side), (0, 0, 0, 255))
    # When the square runs off the image (a logo whose emblem sits near an
    # edge) the missing part is plate, not a different colour.
    from_x = max(0, left)
    from_y = max(0, top)
    to_x = min(source.width, left + side)
    to_y = min(source.height, top + side)
    if to_x > from_x and to_y > from_y:
        square.paste(source.crop((from_x, from_y, to_x, to_y)),
                     (from_x - left, from_y - top))
    # The whole point of this tool: the emblem's centre and the icon's centre
    # are the same point, to the pixel. A rounding half-pixel is the only
    # tolerance an integer canvas can offer.
    assert abs((left + side / 2) - centre_x) <= 0.75, "horizontal drift"
    assert abs((top + side / 2) - centre_y) <= 0.75, "vertical drift"
    return square, {
        "emblem": (min_x, min_y, max_x, max_y),
        "centre": (centre_x, centre_y),
        "crop": (left, top, side),
    }


def main() -> None:
    source = next((path for path in CANDIDATES if path.is_file()), None)
    if source is None:
        raise SystemExit("the logo source is missing: expected the uploaded "
                         "PNG in .cloud-attachments or assets/")
    full = Image.open(source).convert("RGBA")
    assets = ROOT / "assets"
    public = ROOT / "web" / "public"
    assets.mkdir(parents=True, exist_ok=True)
    public.mkdir(parents=True, exist_ok=True)

    full.save(assets / "charts-of-rehan.png")
    square, facts = centred_crop(full)

    square.resize((256, 256), Image.LANCZOS).save(public / "logo.png")
    square.resize((128, 128), Image.LANCZOS).save(
        assets / "charts-of-rehan-128.png")
    square.resize((256, 256), Image.LANCZOS).save(
        assets / "charts-of-rehan.ico", format="ICO",
        sizes=[(size, size) for size in ICO_SIZES])

    print(f"source {source}")
    print(f"emblem {facts['emblem']} centre {facts['centre']} "
          f"crop {facts['crop']} (centred)")
    for path in (assets / "charts-of-rehan.png",
                 assets / "charts-of-rehan-128.png",
                 assets / "charts-of-rehan.ico",
                 public / "logo.png"):
        print(f"{path.relative_to(ROOT)} {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
