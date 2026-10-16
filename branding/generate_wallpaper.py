"""Fondo de pantalla Moonriver: la luna-anillo del logo saliendo sobre un río oscuro.

Se dibuja al doble de resolución y se reduce, para tener bordes suaves.
"""
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).parent
W, H = 3840, 2160
SS = 2                                   # supersampling
SW, SH = W * SS, H * SS

MOON_X, MOON_Y = 0.66 * SW, 0.44 * SH   # a la derecha: la izquierda queda libre para los íconos
R_OUT = 0.165 * SH
R_IN = R_OUT * 66 / 90                   # misma proporción que el logo
HORIZON = MOON_Y + R_OUT * 24 / 90

BLACK = (5, 5, 6)
BORDO_HI = (190, 30, 66)
BORDO = (140, 19, 46)
BORDO_LO = (94, 11, 28)

random.seed(7)


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def vertical_gradient(size, stops):
    w, h = size
    img = Image.new("RGB", (1, h))
    px = img.load()
    for y in range(h):
        t = y / (h - 1)
        for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
            if t0 <= t <= t1:
                px[0, y] = lerp(c0, c1, (t - t0) / (t1 - t0))
                break
    return img.resize((w, h))


def stripe_points(yc, x0, x1, h, amp, wavelength, phase, steps=64):
    top, bottom = [], []
    for i in range(steps + 1):
        u = i / steps
        x = x0 + (x1 - x0) * u
        half = h / 2 * math.sin(math.pi * u) ** 0.22
        y = yc + amp * math.sin(2 * math.pi * x / wavelength + phase)
        top.append((x, y - half))
        bottom.append((x, y + half))
    return top + bottom[::-1]


# Mismas franjas que el logo (coordenadas del logo: centro 200,182 / radio 90)
LOGO_STRIPES = [
    (146, 240, 258, 4.5), (157, 224, 263, 5.5), (168, 208, 265, 6), (179, 190, 266, 6.5),
    (190, 172, 266, 7), (201, 152, 268, 7.5), (212, 106, 294, 8.5), (224, 114, 288, 8.5),
    (236, 124, 280, 8), (248, 136, 268, 7.5), (259, 150, 254, 7), (270, 166, 236, 6),
    (280, 184, 218, 5),
]


def logo_to_canvas(x, y):
    s = R_OUT / 90
    return MOON_X + (x - 200) * s, MOON_Y + (y - 182) * s


# ── 1. cielo y agua ──
base = vertical_gradient((SW, SH), [
    (0.0, (4, 4, 5)),
    (0.45, (9, 5, 7)),
    (HORIZON / SH, (24, 8, 13)),
    (HORIZON / SH + 0.02, (12, 5, 8)),
    (1.0, (4, 3, 4)),
]).convert("RGBA")

# ── 2. resplandor detrás de la luna ──
glow = Image.new("RGBA", (SW // 8, SH // 8), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gx, gy, gr = MOON_X / 8, MOON_Y / 8, R_OUT / 8
for i in range(40, 0, -1):
    r = gr * (0.6 + i * 0.09)
    a = int(70 * (1 - i / 40) ** 2.2)
    gd.ellipse((gx - r * 1.5, gy - r, gx + r * 1.5, gy + r), fill=(125, 17, 40, a))
glow = glow.filter(ImageFilter.GaussianBlur(18)).resize((SW, SH), Image.BICUBIC)
base = Image.alpha_composite(base, glow)

# Línea de horizonte muy tenue
hz = Image.new("RGBA", (SW, SH), (0, 0, 0, 0))
hd = ImageDraw.Draw(hz)
for x0 in range(0, SW, 4):
    d = abs(x0 - MOON_X) / SW
    a = int(55 * math.exp(-(d / 0.28) ** 2))
    hd.line((x0, HORIZON, x0 + 4, HORIZON), fill=(196, 35, 74, a), width=3 * SS)
base = Image.alpha_composite(base, hz.filter(ImageFilter.GaussianBlur(3 * SS)))

# Estrellas muy tenues, más densas lejos de la luna
stars = Image.new("RGBA", (SW, SH), (0, 0, 0, 0))
sd = ImageDraw.Draw(stars)
for _ in range(260):
    sx, sy = random.uniform(0, SW), random.uniform(0, HORIZON * 0.92)
    if math.hypot(sx - MOON_X, sy - MOON_Y) < R_OUT * 2.2:
        continue
    r = random.choice([1.2, 1.5, 1.8, 2.4]) * SS
    a = int(random.uniform(25, 110) * (1 - sy / HORIZON) ** 0.6)
    tint = random.choice([(255, 236, 240), (255, 214, 222), (230, 210, 255)])
    sd.ellipse((sx - r, sy - r, sx + r, sy + r), fill=(*tint, a))
base = Image.alpha_composite(base, stars.filter(ImageFilter.GaussianBlur(0.5 * SS)))

# ── 3. ondas del río en todo el ancho ──
water = Image.new("RGBA", (SW, SH), (0, 0, 0, 0))
wd = ImageDraw.Draw(water)
y = HORIZON + 14 * SS
row = 0
while y < SH:
    depth = (y - HORIZON) / (SH - HORIZON)
    gap = 10 * SS + depth * 46 * SS
    x = random.uniform(-200, 0) * SS
    while x < SW:
        length = random.uniform(80, 420) * SS * (0.6 + depth)
        center = x + length / 2
        dist = abs(center - MOON_X) / SW
        near = math.exp(-(dist / (0.10 + depth * 0.25)) ** 2)
        alpha = int((14 + 120 * near) * (1 - depth) ** 1.4)
        if alpha > 4:
            thick = (2 + 4 * near) * SS * (0.7 + depth)
            pts = stripe_points(y, x, x + length, thick, 1.2 * SS, 140 * SS, row)
            col = lerp(BORDO_LO, BORDO, near)
            wd.polygon(pts, fill=(*col, alpha))
        x += length + random.uniform(30, 260) * SS
    y += gap
    row += 1
base = Image.alpha_composite(base, water.filter(ImageFilter.GaussianBlur(0.6 * SS)))

# ── 4. la luna (anillo + camino de luz + reflejo), con degradé bordó ──
mask = Image.new("L", (SW, SH), 0)
md = ImageDraw.Draw(mask)
md.ellipse((MOON_X - R_OUT, MOON_Y - R_OUT, MOON_X + R_OUT, MOON_Y + R_OUT), fill=255)
md.ellipse((MOON_X - R_IN, MOON_Y - R_IN, MOON_X + R_IN, MOON_Y + R_IN), fill=0)
md.rectangle((0, HORIZON - 5 * R_OUT / 90, SW, SH), fill=0)
for i, (yc, x0, x1, h) in enumerate(LOGO_STRIPES):
    pts = stripe_points(yc, x0, x1, h, 0.9, 58.0, i * 0.9)
    md.polygon([logo_to_canvas(px, py) for px, py in pts], fill=255)

top, bottom = MOON_Y - R_OUT, MOON_Y + R_OUT * 1.1
moon_fill = vertical_gradient((SW, SH), [
    (0.0, BORDO_HI), (max(0.001, top / SH), BORDO_HI),
    (MOON_Y / SH, BORDO), (min(0.999, bottom / SH), BORDO_LO), (1.0, BORDO_LO),
]).convert("RGBA")

# halo suave pegado a la figura
halo = Image.new("RGBA", (SW, SH), (196, 35, 74, 0))
halo.putalpha(mask.filter(ImageFilter.GaussianBlur(28 * SS)).point(lambda v: int(v * 0.55)))
base = Image.alpha_composite(base, halo)
base.paste(moon_fill, (0, 0), mask)

# ── 5. grano fino para que el negro no se vea plano ──
img = base.convert("RGB").resize((W, H), Image.LANCZOS)
noise = Image.effect_noise((W, H), 22).convert("RGB")
img = Image.blend(img, noise, 0.018)

img.save(OUT / "moonriver-wallpaper.png", optimize=True)
img.resize((1920, 1080), Image.LANCZOS).save(OUT / "moonriver-wallpaper-preview.jpg", quality=88)
print("ok")
