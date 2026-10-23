"""Draws the PNG app icons to match icons/icon.svg. Standard library only.

Run from the repository root:  python scripts/make_icons.py
"""

import math
import struct
import zlib
from pathlib import Path

SAMPLES = 3  # per axis, for smooth edges
GRADIENT = ((0x43, 0x38, 0xCA), (0x63, 0x66, 0xF1))  # top-left to bottom-right


def background(px, py):
    t = (px + py) / 128
    return tuple(round(a + (b - a) * t) for a, b in zip(*GRADIENT))


def rounded_rect(x, y, w, h, r):
    def test(px, py):
        if not (x <= px <= x + w and y <= py <= y + h):
            return False
        cx = min(max(px, x + r), x + w - r)
        cy = min(max(py, y + r), y + h - r)
        return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
    return test


def rotated(test, degrees, cx, cy):
    """The shape `test`, turned like SVG's rotate(degrees cx cy)."""
    a = math.radians(-degrees)
    ca, sa = math.cos(a), math.sin(a)

    def turned(px, py):
        dx, dy = px - cx, py - cy
        return test(cx + dx * ca - dy * sa, cy + dx * sa + dy * ca)
    return turned


def right_of(test, x0):
    return lambda px, py: px >= x0 and test(px, py)


CAPSULE = rounded_rect(15, 20, 34, 14, 7)

# (inside test, RGB or a function of the point) in the SVG's 64-unit space, bottom first.
SHAPES = [
    (rounded_rect(0, 0, 64, 64, 14), background),
    (rotated(CAPSULE, -35, 32, 27), (0xFF, 0xFF, 0xFF)),
    (rotated(right_of(CAPSULE, 32), -35, 32, 27), (0xA5, 0xB4, 0xFC)),
    (rounded_rect(12, 45, 40, 5, 2.5), (0xE0, 0xE7, 0xFF)),
]


def render(size):
    scale = 64 / size
    rows = bytearray()
    for j in range(size):
        rows.append(0)
        for i in range(size):
            total = [0, 0, 0, 0]
            for sj in range(SAMPLES):
                for si in range(SAMPLES):
                    px = (i + (si + 0.5) / SAMPLES) * scale
                    py = (j + (sj + 0.5) / SAMPLES) * scale
                    colour = None
                    for inside, fill in SHAPES:
                        if inside(px, py):
                            colour = fill(px, py) if callable(fill) else fill
                    if colour:
                        total[0] += colour[0]
                        total[1] += colour[1]
                        total[2] += colour[2]
                        total[3] += 1
            hits = total[3]
            if hits:
                rows += bytes((total[0] // hits, total[1] // hits, total[2] // hits, 255 * hits // SAMPLES**2))
            else:
                rows += b"\0\0\0\0"
    return bytes(rows)


def png(size):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(render(size), 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent / "icons"
    for size in (192, 512):
        (out / f"icon-{size}.png").write_bytes(png(size))
        print(f"wrote icons/icon-{size}.png")
