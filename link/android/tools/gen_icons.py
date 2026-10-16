"""Genera los íconos vectoriales de Android a partir de la geometría del logo Moonriver."""
import math
from pathlib import Path

RES = Path(__file__).resolve().parent.parent / "app/src/main/res/drawable"

CX, CY, R_OUT, R_IN, HORIZON = 200, 182, 90, 66, 206
STRIPES = [
    (146, 240, 258, 4.5), (157, 224, 263, 5.5), (168, 208, 265, 6), (179, 190, 266, 6.5),
    (190, 172, 266, 7), (201, 152, 268, 7.5), (212, 106, 294, 8.5), (224, 114, 288, 8.5),
    (236, 124, 280, 8), (248, 136, 268, 7.5), (259, 150, 254, 7), (270, 166, 236, 6),
    (280, 184, 218, 5),
]
# Versión gruesa para íconos chicos (notificación / ajustes rápidos)
SMALL_STRIPES = [
    (160, 222, 264, 14), (186, 180, 266, 14), (214, 104, 296, 16), (242, 128, 272, 15), (268, 164, 236, 13),
]


def stripe(yc, x0, x1, h, phase, amp=0.9, wavelength=58.0, steps=24):
    top, bottom = [], []
    for i in range(steps + 1):
        u = i / steps
        x = x0 + (x1 - x0) * u
        half = h / 2 * math.sin(math.pi * u) ** 0.22
        y = yc + amp * math.sin(2 * math.pi * x / wavelength + phase)
        top.append((x, y - half))
        bottom.append((x, y + half))
    pts = top + bottom[::-1]
    return "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in pts) + " Z"


def ring():
    def circle(r):
        return f"M{CX - r},{CY} a{r},{r} 0 1,0 {2 * r},0 a{r},{r} 0 1,0 {-2 * r},0 Z"
    return circle(R_OUT) + " " + circle(R_IN)


def vector(size_dp, viewport, scale, fill, stripes, gradient=False):
    cx, cy = 200, 187
    tx, ty = viewport / 2 - cx * scale, viewport / 2 - cy * scale
    if gradient:
        fill_attr = ""
        fill_el = """
            <aapt:attr name="android:fillColor">
                <gradient android:type="linear" android:startX="0" android:startY="90"
                    android:endX="0" android:endY="285">
                    <item android:offset="0" android:color="#FFD42A52" />
                    <item android:offset="0.55" android:color="#FF9E1734" />
                    <item android:offset="1" android:color="#FF5E0B1C" />
                </gradient>
            </aapt:attr>"""
    else:
        fill_attr = f' android:fillColor="{fill}"'
        fill_el = ""

    def path(d, evenodd=False):
        rule = ' android:fillType="evenOdd"' if evenodd else ""
        if fill_el:
            return f'        <path android:pathData="{d}"{rule}>{fill_el}\n        </path>'
        return f'        <path android:pathData="{d}"{rule}{fill_attr} />'

    stripes_xml = "\n".join(path(stripe(y, x0, x1, h, i * 0.9)) for i, (y, x0, x1, h) in enumerate(stripes))
    return f"""<?xml version="1.0" encoding="utf-8"?>
<!-- Generado por tools/gen_icons.py — no editar a mano -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="{size_dp}dp" android:height="{size_dp}dp"
    android:viewportWidth="{viewport}" android:viewportHeight="{viewport}">
    <group android:scaleX="{scale}" android:scaleY="{scale}"
        android:translateX="{tx:.3f}" android:translateY="{ty:.3f}">
        <group>
            <clip-path android:pathData="M0,0 H400 V{HORIZON - 5} H0 Z" />
    {path(ring(), evenodd=True)}
        </group>
{stripes_xml}
    </group>
</vector>
"""


RES.mkdir(parents=True, exist_ok=True)
# Adaptive icon: 108dp, la marca dentro de la zona segura (~60dp)
(RES / "ic_launcher_foreground.xml").write_text(vector(108, 108, 0.30, None, STRIPES, gradient=True))
# Notificaciones y ajustes rápidos: blanco sólido, 24dp
(RES / "ic_stat_link.xml").write_text(vector(24, 24, 0.105, "#FFFFFFFF", SMALL_STRIPES))
print("íconos generados en", RES)
