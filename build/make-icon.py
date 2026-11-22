"""Generates build/icon.icns, build/icon.png and build/icon.ico from the Cutalong mark.

The icon is the mark in white on a coral tile, the same as the assistant's
avatar in the app: a solid bar (the take) above a dashed bar (the line you cut
along), on macOS's icon grid (an 824 px tile with continuous corners on a
1024 px canvas, with a soft shadow beneath).

The mark is drawn from the same geometry as components/ui.tsx, on its 64 x 52
grid: the take is a 44 x 18 bar at (2, 4) with fully round ends; the cut line
is a 42 x 16 outline at (18, 30), 5 thick, dashed 7 on and 6 off with butt
ends, starting where an SVG rect's path starts. Every size is rendered from
that geometry rather than scaled from a bitmap, and the .icns is written here
with PNG entries, so this runs anywhere Python does: no sips, no iconutil.

Windows draws no shadow under an icon and fills more of its square, so the
.ico has the same tile and mark, near the square's edges and with no shadow,
at the sizes Windows asks for (16 to 256 px), as bitmaps up to 128 px and a
PNG at 256, which every Windows and the installer read.

    python3 build/make-icon.py           # all three
    python3 build/make-icon.py --ico     # the .ico alone
"""
import math
import os
import struct
import sys
import zlib

CORAL = (0xFF, 0x5A, 0x36)
WHITE = (0xFF, 0xFF, 0xFF)

# The mark's own grid, from components/ui.tsx.
TAKE = (2.0, 4.0, 44.0, 18.0)  # x, y, w, h; radius h/2
CUT = (18.0, 30.0, 42.0, 16.0)  # x, y, w, h of the outline's centre line; radius h/2
STROKE = 5.0
DASH_ON, DASH_OFF = 7.0, 6.0

# What the mark covers on its grid, strokes included, for centring.
BOUNDS = (2.0, 4.0, CUT[0] + CUT[2] + STROKE / 2, CUT[1] + CUT[3] + STROKE / 2)

# macOS icon grid at 1024: the tile, its corners, and how wide the mark sits.
TILE_FRAC = 824 / 1024
# Windows' grid: the tile fills the square but for a pixel's margin at 16 px.
WIN_TILE_FRAC = 15 / 16
CORNER_FRAC = 185.4 / 824
SQUIRCLE_N = 5.0
MARK_FRAC = 0.62  # the mark's drawn width as a share of the tile


def clamp(v, lo=0.0, hi=1.0):
    return lo if v < lo else hi if v > hi else v


def squircle(x, y, box, r, n):
    """Anti-aliased coverage of a rounded box with superelliptic corners."""
    left, top, right, bottom = box
    cx, cy = (left + right) / 2, (top + bottom) / 2
    hw, hh = (right - left) / 2, (bottom - top) / 2
    ax, ay = abs(x - cx), abs(y - cy)
    if ax > hw + 1 or ay > hh + 1:
        return 0.0
    dx = max(0.0, ax - (hw - r))
    dy = max(0.0, ay - (hh - r))
    if dx == 0 and dy == 0:
        return clamp(min(hw - ax, hh - ay) + 0.5)
    d = ((dx / r) ** n + (dy / r) ** n) ** (1 / n) * r
    return clamp(r - d + 0.5)


def render(size, windows=False):
    """RGBA rows for one icon size: on macOS's grid, or for Windows, near the edges and with no shadow."""
    tile = size * (WIN_TILE_FRAC if windows else TILE_FRAC)
    t0 = (size - tile) / 2
    tile_box = (t0, t0, t0 + tile, t0 + tile)
    corner = tile * CORNER_FRAC
    # A soft shadow, a little below the tile, as macOS icons carry.
    shadow_off = size * 0.012
    shadow_soft = max(1.0, size * 0.02)

    # Grid units to pixels, with the mark centred on the tile.
    k = tile * MARK_FRAC / (BOUNDS[2] - BOUNDS[0])
    gx = (BOUNDS[0] + BOUNDS[2]) / 2
    gy = (BOUNDS[1] + BOUNDS[3]) / 2

    tx, ty, tw, th = TAKE
    take_r = th / 2
    take_y = ty + take_r
    cx0, cy0, cw, ch = CUT
    cut_r = ch / 2
    cut_a, cut_b, cut_y = cx0 + cut_r, cx0 + cw - cut_r, cy0 + cut_r
    straight = cut_b - cut_a
    period = DASH_ON + DASH_OFF

    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            x, y = px + 0.5, py + 0.5
            fill = squircle(x, y, tile_box, corner, SQUIRCLE_N)
            if fill < 1 and not windows:
                # Shadow under the transparent part of the canvas only.
                sh_box = (t0, t0 + shadow_off, t0 + tile, t0 + tile + shadow_off)
                left, top, right, bottom = sh_box
                ax = max(0.0, abs(x - (left + right) / 2) - (right - left) / 2 + corner)
                ay = max(0.0, abs(y - (top + bottom) / 2) - (bottom - top) / 2 + corner)
                outside = math.hypot(ax, ay) - corner
                shadow = 0.28 * clamp(0.5 - outside / shadow_soft) if outside > -shadow_soft else 0.28
            else:
                shadow = 0.0

            r, g, b = CORAL
            # Back to the mark's grid.
            u = (x - size / 2) / k + gx
            v = (y - size / 2) / k + gy
            px_unit = 1 / k  # one pixel, in grid units, for anti-aliasing

            # The take: a filled bar with round ends.
            d = math.hypot(u - clamp(u, tx + take_r, tx + tw - take_r), v - take_y)
            mark = clamp((take_r - d) / px_unit + 0.5)

            # The cut line: a dashed outline along a stadium's centre line.
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

            r = r * (1 - mark) + WHITE[0] * mark
            g = g * (1 - mark) + WHITE[1] * mark
            b = b * (1 - mark) + WHITE[2] * mark
            # Composite the tile over its shadow.
            alpha = fill + shadow * (1 - fill)
            if alpha > 0 and fill < 1:
                # Shadow is black: premultiply, then un-premultiply.
                r, g, b = (r * fill / alpha, g * fill / alpha, b * fill / alpha)
            row += bytes((int(r + 0.5), int(g + 0.5), int(b + 0.5), int(alpha * 255 + 0.5)))
        rows.append(bytes(row))
    return rows


def png(size, rows):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
        + chunk(b"IEND", b"")
    )


# Apple's icon types that hold PNG data, by pixel size.
ICNS_TYPES = [
    (b"icp4", 16),
    (b"icp5", 32),
    (b"ic11", 32),
    (b"icp6", 64),
    (b"ic12", 64),
    (b"ic07", 128),
    (b"ic08", 256),
    (b"ic13", 256),
    (b"ic09", 512),
    (b"ic14", 512),
    (b"ic10", 1024),
]


# The sizes Windows shows an icon at, from a list's 16 px to a tile's 256.
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]


def dib(size, rows):
    """One .ico bitmap entry: BGRA rows bottom up, then the 1-bit mask (all shown; alpha decides)."""
    header = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    pixels = bytearray()
    for row in reversed(rows):
        for x in range(size):
            r, g, b, a = row[1 + 4 * x : 5 + 4 * x]
            pixels += bytes((b, g, r, a))
    mask_row = ((size + 31) // 32) * 4
    return header + bytes(pixels) + bytes(mask_row * size)


def ico():
    """The .ico: bitmaps up to 128 px and a PNG at 256."""
    entries = []
    for size in ICO_SIZES:
        rows = render(size, windows=True)
        entries.append((size, png(size, rows) if size >= 256 else dib(size, rows)))
    head = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    table = b""
    body = b""
    for size, data in entries:
        side = 0 if size >= 256 else size
        table += struct.pack("<BBBBHHII", side, side, 0, 0, 1, 32, len(data), offset + len(body))
        body += data
    return head + table + body


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "icon.ico"), "wb") as f:
        f.write(ico())
    if "--ico" in sys.argv:
        print("wrote build/icon.ico")
        return
    pngs = {}
    for _, size in ICNS_TYPES:
        if size not in pngs:
            pngs[size] = png(size, render(size))
    body = b"".join(tag + struct.pack(">I", len(pngs[size]) + 8) + pngs[size] for tag, size in ICNS_TYPES)
    with open(os.path.join(here, "icon.icns"), "wb") as f:
        f.write(b"icns" + struct.pack(">I", len(body) + 8) + body)
    with open(os.path.join(here, "icon.png"), "wb") as f:
        f.write(pngs[1024])
    print("wrote build/icon.icns, build/icon.png and build/icon.ico")


if __name__ == "__main__":
    main()
