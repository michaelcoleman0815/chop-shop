"""Draws the phone app's icons from the Mac app's mark (build/make-icon.py).

The mark is the Mac icon's: the take, a solid bar, above the dashed line you
cut along, in white on coral, drawn from the same geometry at every size
rather than scaled from a bitmap. Each store and launcher gets the shape it
masks for itself:

- iOS: one 1024 px square, edge to edge and opaque (the App Store turns an
  icon with an alpha channel away); iOS rounds the corners, and Xcode makes
  every smaller size from it. ios/App/App/Assets.xcassets/AppIcon.appiconset.
- Android 8 and later: an adaptive icon, the coral as its background colour
  and the mark on a transparent 108 dp foreground, inside the 66 dp circle
  every launcher's mask keeps; the same foreground is the monochrome layer
  Android 13 tints for themed icons. mipmap-*/ic_launcher_foreground.png.
- Android 7: the coral tile with rounded corners, and a round one for
  launchers that ask for it, at 48 dp. mipmap-*/ic_launcher(_round).png.
- Google Play: the 512 px square the Play Console asks for, edge to edge (Play
  rounds it), written only when asked for: python3 scripts/make-icons.py
  --play out.png.

    python3 scripts/make-icons.py      # from mobile/
"""
import importlib.util
import math
import os
import struct
import sys
import zlib

# Reading the Mac's icon maker leaves no bytecode beside it.
sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
MOBILE = os.path.dirname(HERE)

# The mark's geometry and colours, from the Mac's icon maker, so the two never drift apart.
_spec = importlib.util.spec_from_file_location("mac_icon", os.path.join(MOBILE, "..", "build", "make-icon.py"))
mac = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mac)

CORAL, WHITE = mac.CORAL, mac.WHITE
TAKE, CUT, STROKE, DASH_ON, DASH_OFF, BOUNDS = mac.TAKE, mac.CUT, mac.STROKE, mac.DASH_ON, mac.DASH_OFF, mac.BOUNDS
clamp = mac.clamp

# Android's densities, by how many pixels a dp is.
DENSITIES = {"mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0}


def mark_at(u, v, px_unit):
    """How much of the mark covers the point (u, v) of its grid, anti-aliased over a pixel of px_unit."""
    tx, ty, tw, th = TAKE
    take_r = th / 2
    take_y = ty + take_r
    cx0, cy0, cw, ch = CUT
    cut_r = ch / 2
    cut_a, cut_b, cut_y = cx0 + cut_r, cx0 + cw - cut_r, cy0 + cut_r
    straight = cut_b - cut_a
    period = DASH_ON + DASH_OFF

    # The take: a filled bar with round ends.
    d = math.hypot(u - clamp(u, tx + take_r, tx + tw - take_r), v - take_y)
    mark = clamp((take_r - d) / px_unit + 0.5)

    # The cut line: a dashed outline along a stadium's centre line, dashed from where an SVG rect's path starts.
    near = clamp(u, cut_a, cut_b)
    dist = math.hypot(u - near, v - cut_y)
    band = clamp((STROKE / 2 - abs(dist - cut_r)) / px_unit + 0.5)
    if band > 0:
        if cut_a <= u <= cut_b:
            s = (u - cut_a) if v < cut_y else (straight + math.pi * cut_r + (cut_b - u))
        elif u > cut_b:
            s = straight + cut_r * (math.atan2(v - cut_y, u - cut_b) + math.pi / 2)
        else:
            phi = math.atan2(v - cut_y, u - cut_a)
            s = 2 * straight + math.pi * cut_r + cut_r * ((phi - math.pi / 2) % (2 * math.pi))
        pos = s % period
        if pos < DASH_ON:
            on = clamp(min(pos, DASH_ON - pos) / px_unit + 0.5)
        else:
            on = clamp(0.5 - min(pos - DASH_ON, period - pos) / px_unit)
        mark = max(mark, band * on)
    return mark


def draw(size, tile, mark_width, alpha=True, background=True):
    """
    Rows of pixels: `tile(x, y)` is how much of the coral shape covers a pixel's centre (1 everywhere for
    a full square), and the mark is centred, `mark_width` pixels wide. Without `background` the mark is
    white on transparent; without `alpha` the rows are RGB.
    """
    k = mark_width / (BOUNDS[2] - BOUNDS[0])
    gx = (BOUNDS[0] + BOUNDS[2]) / 2
    gy = (BOUNDS[1] + BOUNDS[3]) / 2
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            x, y = px + 0.5, py + 0.5
            mark = mark_at((x - size / 2) / k + gx, (y - size / 2) / k + gy, 1 / k)
            if background:
                fill = tile(x, y)
                r, g, b = (c * (1 - mark) + w * mark for c, w in zip(CORAL, WHITE))
                a = fill
            else:
                r, g, b = WHITE
                a = mark
            pixel = (int(r + 0.5), int(g + 0.5), int(b + 0.5))
            row += bytes(pixel + ((int(a * 255 + 0.5),) if alpha else ()))
        rows.append(bytes(row))
    return rows


def png(size, rows, alpha=True):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6 if alpha else 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
        + chunk(b"IEND", b"")
    )


def full(_x, _y):
    return 1.0


def rounded(size, inset, corner):
    box = (inset, inset, size - inset, size - inset)
    return lambda x, y: mac.squircle(x, y, box, corner, 2.0)


def circle(size, inset):
    r = size / 2 - inset
    return lambda x, y: clamp(r - math.hypot(x - size / 2, y - size / 2) + 0.5)


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    print(f"wrote {os.path.relpath(path, MOBILE)}")


# The mark is as wide on each shape as on the Mac's tile: MARK_FRAC of the shape it sits on.
MARK = mac.MARK_FRAC


def square(size):
    """Edge to edge and opaque, for a store that rounds it itself: the App Store's and Play's."""
    return png(size, draw(size, full, size * MARK, alpha=False), alpha=False)


def main():
    if "--play" in sys.argv:
        out = sys.argv[sys.argv.index("--play") + 1]
        write(os.path.abspath(out), square(512))
        return

    appicon = os.path.join(MOBILE, "ios", "App", "App", "Assets.xcassets", "AppIcon.appiconset")
    write(os.path.join(appicon, "AppIcon-1024.png"), square(1024))

    res = os.path.join(MOBILE, "android", "app", "src", "main", "res")
    for name, dp in DENSITIES.items():
        legacy = round(48 * dp)
        # A 48 dp icon keeps a dp of margin, as Android 7's launcher icons do; the round one is a circle.
        inset = 2 * dp
        tile = legacy - 2 * inset
        write(
            os.path.join(res, f"mipmap-{name}", "ic_launcher.png"),
            png(legacy, draw(legacy, rounded(legacy, inset, tile * 0.18), tile * MARK)),
        )
        write(
            os.path.join(res, f"mipmap-{name}", "ic_launcher_round.png"),
            png(legacy, draw(legacy, circle(legacy, inset), tile * MARK)),
        )
        # 108 dp, of which a launcher shows the middle 72 dp: the mark as wide on those 72 as on a tile.
        layer = round(108 * dp)
        write(
            os.path.join(res, f"mipmap-{name}", "ic_launcher_foreground.png"),
            png(layer, draw(layer, full, 72 * dp * MARK, background=False)),
        )


if __name__ == "__main__":
    main()
