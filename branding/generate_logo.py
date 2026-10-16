"""Genera los SVG del logo Moonriver: luna-anillo cuyo reflejo se disuelve en ondas de río."""
import math
from pathlib import Path

OUT = Path(__file__).parent

CX, CY = 200, 182          # centro del anillo
R_OUT, R_IN = 90, 66       # radios exterior / interior
HORIZON = 206              # debajo de esta línea el anillo se vuelve agua

# (y centro, x inicio, x fin, grosor) — primero el camino de luz dentro del anillo,
# después el reflejo que se abre más ancho que la luna y se va cerrando hacia abajo.
STRIPES = [
    (146, 240, 258, 4.5),
    (157, 224, 263, 5.5),
    (168, 208, 265, 6),
    (179, 190, 266, 6.5),
    (190, 172, 266, 7),
    (201, 152, 268, 7.5),
    (212, 106, 294, 8.5),
    (224, 114, 288, 8.5),
    (236, 124, 280, 8),
    (248, 136, 268, 7.5),
    (259, 150, 254, 7),
    (270, 166, 236, 6),
    (280, 184, 218, 5),
]


def stripe_path(yc, x0, x1, h, amp=0.9, wavelength=58.0, phase=0.0, steps=48):
    """Barra horizontal con bordes ondulados y puntas afinadas."""
    top, bottom = [], []
    for i in range(steps + 1):
        u = i / steps
        x = x0 + (x1 - x0) * u
        half = h / 2 * math.sin(math.pi * u) ** 0.22
        y = yc + amp * math.sin(2 * math.pi * x / wavelength + phase)
        top.append((x, y - half))
        bottom.append((x, y + half))
    pts = top + bottom[::-1]
    return "M" + " L".join(f"{x:.2f},{y:.2f}" for x, y in pts) + " Z"


def ring_path():
    """Anillo (exterior + interior con fill-rule evenodd)."""
    def circle(r):
        return (f"M{CX - r},{CY} a{r},{r} 0 1,0 {2 * r},0 a{r},{r} 0 1,0 {-2 * r},0 Z")
    return circle(R_OUT) + " " + circle(R_IN)


# Versión simplificada para tamaños chicos (barra de 16px): menos líneas y más gruesas.
SYMBOLIC_STRIPES = [
    (160, 222, 264, 14),
    (186, 180, 266, 14),
    (214, 104, 296, 16),
    (242, 128, 272, 15),
    (268, 164, 236, 13),
]


def mark(fill, scale=1.0, translate=(0, 0), stripes=STRIPES):
    stripes = "\n    ".join(
        f'<path d="{stripe_path(y, x0, x1, h, phase=i * 0.9)}"/>'
        for i, (y, x0, x1, h) in enumerate(stripes)
    )
    tx, ty = translate
    return f"""<g transform="translate({tx} {ty}) scale({scale})" fill="{fill}">
    <path clip-path="url(#sky)" fill-rule="evenodd" d="{ring_path()}"/>
    {stripes}
  </g>"""


def defs():
    return f"""<defs>
    <clipPath id="sky"><rect x="0" y="0" width="400" height="{HORIZON - 5}"/></clipPath>
    <linearGradient id="bordo" x1="0" y1="90" x2="0" y2="285" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#d42a52"/>
      <stop offset="0.55" stop-color="#9e1734"/>
      <stop offset="1" stop-color="#5e0b1c"/>
    </linearGradient>
    <radialGradient id="halo" cx="200" cy="190" r="190" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2a0a12"/>
      <stop offset="0.6" stop-color="#0b0607"/>
      <stop offset="1" stop-color="#050506"/>
    </radialGradient>
  </defs>"""


def write(name, body, size=400):
    (OUT / name).write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 400 400">\n'
        f"  {body}\n</svg>\n"
    )


# 1. Logo principal: disco negro con halo bordó y figura en degradé
write("moonriver-logo.svg", defs() + f"""
  <circle cx="200" cy="200" r="198" fill="url(#halo)"/>
  <circle cx="200" cy="200" r="197" fill="none" stroke="#3a0e18" stroke-width="2"/>
  {mark("url(#bordo)")}""")

# 2. Solo la marca, fondo transparente (para usar sobre negro)
write("moonriver-mark.svg", defs() + "\n  " + mark("url(#bordo)", 1.6, (-120, -99)))

# 3. Ícono simbólico para la barra (un solo color, GNOME lo tiñe vía CSS)
write("moonriver-symbolic.svg", defs() + "\n  " + mark("#bebebe", 1.6, (-120, -99), SYMBOLIC_STRIPES), size=16)
