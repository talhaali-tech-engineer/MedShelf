"""Draws the PNG app icons to match icons/icon.svg. Standard library only.

Run from the repository root:  python scripts/make_icons.py
"""

import struct
import zlib
from pathlib import Path

# (x, y, width, height, corner radius, RGB) in the SVG's 64-unit space, bottom first.
SHAPES = [
    (0, 0, 64, 64, 14, (0x0F, 0x76, 0x6E)),
    (27, 11, 10, 28, 2, (0xFF, 0xFF, 0xFF)),
    (18, 20, 28, 10, 2, (0xFF, 0xFF, 0xFF)),
    (12, 45, 40, 6, 3, (0x99, 0xF6, 0xE4)),
]
SAMPLES = 3  # per axis, for smooth edges


def inside(px, py, x, y, w, h, r):
    if not (x <= px <= x + w and y <= py <= y + h):
        return False
    cx = min(max(px, x + r), x + w - r)
    cy = min(max(py, y + r), y + h - r)
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r


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
                    for x, y, w, h, r, rgb in SHAPES:
                        if inside(px, py, x, y, w, h, r):
                            colour = rgb
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
