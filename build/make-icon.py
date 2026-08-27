"""Generates build/icon.icns from the Chop Shop brand construction.

Per the brand guidelines, the app icon inverts the mark: accent field, ink slab
on top, paper slab below. Slab geometry is 78 x 33 with gap 9, offset 24 and
radius 8, so every dimension here is derived from the slab height rather than
guessed. The offset always runs right.
"""
import math, os, struct, subprocess, zlib

S = 1024

INK = (0x16, 0x15, 0x1A)
PAPER = (0xF2, 0xF1, 0xEE)
CHOP_RED = (0xEF, 0x3A, 0x5C)

# Brand construction, normalised against slab height.
SLAB_W = 78 / 33
GAP = 9 / 33
OFFSET = 24 / 33
RADIUS = 8 / 33

MARK_W_FRAC = 0.69           # mark width as a share of the canvas
FIELD_RADIUS = 0.2295 * S    # Apple's continuous-corner ratio
SQUIRCLE_N = 4.5             # >2 gives the macOS squircle rather than a circle

slab_h = (MARK_W_FRAC * S) / (SLAB_W + OFFSET)
slab_w = SLAB_W * slab_h
gap = GAP * slab_h
offset = OFFSET * slab_h
radius = RADIUS * slab_h

mark_w = slab_w + offset
mark_h = 2 * slab_h + gap
x0 = (S - mark_w) / 2
y0 = (S - mark_h) / 2

TOP = (x0, y0, x0 + slab_w, y0 + slab_h)
BOTTOM = (x0 + offset, y0 + slab_h + gap, x0 + offset + slab_w, y0 + mark_h)


def coverage(x, y, box, r, n=2.0):
    """Anti-aliased inside test for a rounded box, superelliptic when n > 2."""
    left, top, right, bottom = box
    cx, cy = (left + right) / 2, (top + bottom) / 2
    hw, hh = (right - left) / 2, (bottom - top) / 2
    dx = max(0.0, abs(x - cx) - (hw - r))
    dy = max(0.0, abs(y - cy) - (hh - r))
    if abs(x - cx) > hw or abs(y - cy) > hh:
        outside = max(abs(x - cx) - hw, abs(y - cy) - hh)
        if outside > 0.5:
            return 0.0
    if dx == 0 and dy == 0:
        inner = min(hw - abs(x - cx), hh - abs(y - cy))
        return max(0.0, min(1.0, inner + 0.5))
    d = ((dx / r) ** n + (dy / r) ** n) ** (1 / n) * r
    return max(0.0, min(1.0, r - d + 0.5))


rows = []
for py in range(S):
    row = bytearray([0])
    y = py + 0.5
    for px in range(S):
        x = px + 0.5
        a = coverage(x, y, (0, 0, S, S), FIELD_RADIUS, SQUIRCLE_N)
        r, g, b = CHOP_RED
        for box, colour in ((TOP, INK), (BOTTOM, PAPER)):
            c = coverage(x, y, box, radius)
            if c > 0:
                r = r * (1 - c) + colour[0] * c
                g = g * (1 - c) + colour[1] * c
                b = b * (1 - c) + colour[2] * c
        row += bytes((int(r), int(g), int(b), int(a * 255)))
    rows.append(bytes(row))


def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))


png = (
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
    + chunk(b"IEND", b"")
)

here = os.path.dirname(os.path.abspath(__file__))
src = os.path.join(here, "icon.png")
with open(src, "wb") as f:
    f.write(png)

iconset = os.path.join(here, "icon.iconset")
os.makedirs(iconset, exist_ok=True)
for size in (16, 32, 64, 128, 256, 512, 1024):
    targets = [(size, f"icon_{size}x{size}.png")]
    if size >= 32:
        targets.append((size, f"icon_{size // 2}x{size // 2}@2x.png"))
    for dim, name in targets:
        subprocess.run(
            ["sips", "-z", str(dim), str(dim), src, "--out", os.path.join(iconset, name)],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(here, "icon.icns")], check=True)
print(f"slab {slab_w:.0f}x{slab_h:.0f}  gap {gap:.0f}  offset {offset:.0f}  radius {radius:.0f}")
print("wrote build/icon.icns")
