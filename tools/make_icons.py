"""生成 PWA 图标：橙色渐变底 + 白色罗盘"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'prototype', 'icons')
os.makedirs(OUT, exist_ok=True)

TOP = (255, 139, 76)
BOTTOM = (255, 87, 34)
ORANGE = (255, 107, 44, 255)


def gradient(size):
    img = Image.new('RGB', (1, size))
    for y in range(size):
        t = y / max(size - 1, 1)
        img.putpixel((0, y), tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)))
    return img.resize((size, size))


def rounded_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def draw_icon(size, rounded=True, scale=1.0):
    S = size * 4
    icon = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    mask = rounded_mask(S, int(S * 0.22)) if rounded else Image.new('L', (S, S), 255)
    icon.paste(gradient(S), (0, 0), mask)

    d = ImageDraw.Draw(icon)
    cx = cy = S / 2
    r = S * 0.30 * scale
    ring_w = max(2, int(S * 0.042 * scale))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 255, 255, 255), width=ring_w)

    k = r * 0.80
    d.polygon([(cx, cy - k), (cx + k * 0.30, cy), (cx, cy + k), (cx - k * 0.30, cy)], fill=(255, 255, 255, 255))
    d.line([(cx - k * 0.30, cy), (cx + k * 0.30, cy)], fill=ORANGE, width=max(2, int(S * 0.012)))

    dr = max(2, int(S * 0.026 * scale))
    d.ellipse([cx - dr, cy - dr, cx + dr, cy + dr], fill=ORANGE)

    return icon.resize((size, size), Image.LANCZOS)


targets = [
    ('icon-192.png', 192, True, 1.0),
    ('icon-512.png', 512, True, 1.0),
    ('icon-maskable-512.png', 512, True, 0.82),   # 安全区内留白，适配 Android 圆形裁切
    ('apple-touch-icon.png', 180, False, 0.92),   # iOS 自己裁圆角，给满幅方图
]

for name, size, rounded, scale in targets:
    img = draw_icon(size, rounded, scale)
    path = os.path.join(OUT, name)
    img.save(path, 'PNG', optimize=True)
    print(f'{name:26} {size}x{size}  {os.path.getsize(path)} bytes')
