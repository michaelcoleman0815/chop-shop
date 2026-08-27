"""Generates build/icon.icns: a dark rounded tile with an orange chop slash."""
import math, os, struct, subprocess, zlib

S = 1024
BG = (23, 20, 19)
ACCENT = (255, 106, 61)
INSET = 90.0
RADIUS = 210.0


def rounded_alpha(x, y):
    left, top = INSET, INSET
    right, bottom = S - INSET, S - INSET
    cx = min(max(x, left + RADIUS), right - RADIUS)
    cy = min(max(y, top + RADIUS), bottom - RADIUS)
    d = math.hypot(x - cx, y - cy)
    return max(0.0, min(1.0, RADIUS + 0.5 - d))


def slash_alpha(x, y):
    # Two parallel diagonal bands, the wider one cutting through the tile.
    def band(offset, half):
        d = abs((x + y) - offset) / math.sqrt(2)
        return max(0.0, min(1.0, half + 0.5 - d))

    return max(band(S * 0.86, 62), band(S * 1.28, 26))


rows = []
for y in range(S):
    row = bytearray([0])
    for x in range(S):
        a = rounded_alpha(x + 0.5, y + 0.5)
        s = slash_alpha(x + 0.5, y + 0.5) * a
        r = int(BG[0] * (1 - s) + ACCENT[0] * s)
        g = int(BG[1] * (1 - s) + ACCENT[1] * s)
        b = int(BG[2] * (1 - s) + ACCENT[2] * s)
        row += bytes((r, g, b, int(a * 255)))
    rows.append(bytes(row))

raw = b"".join(rows)


def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))


png = (
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(raw, 9))
    + chunk(b"IEND", b"")
)

here = os.path.dirname(os.path.abspath(__file__))
src = os.path.join(here, "icon.png")
with open(src, "wb") as f:
    f.write(png)

iconset = os.path.join(here, "icon.iconset")
os.makedirs(iconset, exist_ok=True)
for size in (16, 32, 64, 128, 256, 512, 1024):
    for scale, name in ((1, f"icon_{size}x{size}.png"), (2, f"icon_{size // 2}x{size // 2}@2x.png")):
        if scale == 2 and size < 32:
            continue
        subprocess.run(
            ["sips", "-z", str(size), str(size), src, "--out", os.path.join(iconset, name)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(here, "icon.icns")], check=True)
print("wrote build/icon.icns")
