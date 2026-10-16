"""Íconos de apps Moonriver: solo el dibujo de la app, en bordó.

Cada app del sistema (paquetes de Fedora) trae un ícono simbólico monocromo;
lo usamos como máscara sobre un degradé bordó, con un resplandor suave, igual
que los íconos del menú de Moonriver. Las apps de terceros (Flatpak, paquetes
sin firma de Fedora, lanzadores propios) no se tocan.

Uso desde build_theme.py:  build_app_icons(destino)  ->  lista de nombres generados
Vista previa:              python3 build_icons.py --preview salida.png
"""
import math
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

SVG_NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG_NS)
ET.register_namespace("xlink", "http://www.w3.org/1999/xlink")

APPLICATIONS = Path("/usr/share/applications")
SYMBOLIC_DIRS = [
    Path("/usr/share/icons/hicolor/symbolic/apps"),
    Path("/usr/share/icons/hicolor/scalable/apps"),
    Path("/usr/share/icons/Adwaita/symbolic"),
]

# Apps sin ícono simbólico propio (o con uno que se repite): glifo de Adwaita
# que mejor las representa
FALLBACK_GLYPHS = {
    "org.gnome.Decibels": "audio-x-generic",   # el suyo es el mismo "play" que Showtime
    "alacarte": "open-menu",
    "org.fedoraproject.MediaWriter": "media-removable",
    "gnome-color-manager": "preferences-color",
    "rygel": "folder-publicshare",
}

# Íconos que no son de apps pero se ven en el dock
EXTRA_ICONS = {
    "user-trash": "user-trash",
    "user-trash-full": "user-trash-full",
}

# Paleta (la misma del resto de Moonriver: el bordó de los íconos del menú)
GLYPH_STOPS = [(0, "#ff6d8c"), (0.5, "#e0405f"), (1, "#a3183a")]
BLOOM = "#c4234a"

SIZE = 128
GLYPH = 96           # el dibujo ocupa casi todo el lienzo, como un ícono de app


def system_apps():
    """(id del ícono) de cada app visible instalada por un paquete de Fedora."""
    icons = set()
    for desktop in sorted(APPLICATIONS.glob("*.desktop")):
        text = desktop.read_text(errors="ignore")
        entry = text.split("[Desktop Entry]", 1)[-1].split("\n[", 1)[0]
        if re.search(r"^NoDisplay=true", entry, re.M):
            continue
        icon = re.search(r"^Icon=(.+)$", entry, re.M)
        if not icon or "/" in icon.group(1):
            continue
        if is_system_app(desktop):
            icons.add(icon.group(1).strip())
    return sorted(icons)


def is_system_app(desktop):
    """En Fedora, solo las apps empaquetadas por Fedora; en otras distros (sin rpm), todas las de /usr."""
    try:
        vendor = subprocess.run(["rpm", "-qf", "--qf", "%{VENDOR}", str(desktop)],
                                capture_output=True, text=True).stdout.strip()
    except FileNotFoundError:
        return True
    return vendor == "Fedora Project"


def find_symbolic(name):
    for base in SYMBOLIC_DIRS:
        hit = next(base.rglob(f"{name}-symbolic.svg"), None)
        if hit:
            return hit
    return None


def glyph_svg(path):
    """El SVG simbólico listo para anidar: sin metadatos y ubicado en el centro."""
    root = ET.parse(path).getroot()
    for child in list(root):
        tag = child.tag.split("}")[-1]
        if tag in ("metadata", "namedview", "title"):
            root.remove(child)
    if "viewBox" not in root.attrib:
        w = float(re.sub(r"[^\d.]", "", root.get("width", "16")))
        h = float(re.sub(r"[^\d.]", "", root.get("height", "16")))
        root.set("viewBox", f"0 0 {w} {h}")
    offset = (SIZE - GLYPH) / 2
    root.attrib.update({"x": f"{offset}", "y": f"{offset}", "width": f"{GLYPH}", "height": f"{GLYPH}"})
    for attr in list(root.attrib):
        if attr not in ("x", "y", "width", "height", "viewBox"):
            del root.attrib[attr]
    return ET.tostring(root, encoding="unicode")


def glyph_icon_svg(glyph_path):
    top, bottom = (SIZE - GLYPH) / 2, (SIZE + GLYPH) / 2
    stops = "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in GLYPH_STOPS)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{SIZE}" height="{SIZE}" viewBox="0 0 {SIZE} {SIZE}">
  <defs>
    <linearGradient id="mr-glyph" x1="0" y1="{top}" x2="0" y2="{bottom}" gradientUnits="userSpaceOnUse">
      {stops}
    </linearGradient>
    <filter id="mr-bloom" x="-25%" y="-25%" width="150%" height="150%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="4" result="blur"/>
      <feFlood flood-color="{BLOOM}" flood-opacity="0.35"/>
      <feComposite in2="blur" operator="in" result="glow"/>
      <feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <mask id="mr-glyph-mask" mask-type="alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="{SIZE}" height="{SIZE}">
      {glyph_svg(glyph_path)}
    </mask>
  </defs>
  <g filter="url(#mr-bloom)">
    <rect width="{SIZE}" height="{SIZE}" fill="url(#mr-glyph)" mask="url(#mr-glyph-mask)"/>
  </g>
</svg>
"""


def build_app_icons(apps_dir, places_dir):
    """Escribe los íconos y devuelve (generados, salteados)."""
    apps_dir.mkdir(parents=True, exist_ok=True)
    places_dir.mkdir(parents=True, exist_ok=True)
    made, skipped = [], []
    for name in system_apps():
        glyph = find_symbolic(FALLBACK_GLYPHS.get(name, name))
        if not glyph:
            skipped.append(name)
            continue
        (apps_dir / f"{name}.svg").write_text(glyph_icon_svg(glyph))
        made.append(name)
    for name, symbol in EXTRA_ICONS.items():
        glyph = find_symbolic(symbol)
        if glyph:
            (places_dir / f"{name}.svg").write_text(glyph_icon_svg(glyph))
            made.append(name)
    return made, skipped


def preview(out):
    """Hoja de contacto con todos los íconos sobre el fondo de la barra."""
    import tempfile
    import gi
    gi.require_version("Rsvg", "2.0")
    from gi.repository import Rsvg
    import cairo

    tmp = Path(tempfile.mkdtemp())
    made, skipped = build_app_icons(tmp / "apps", tmp / "places")
    files = sorted((tmp / "apps").glob("*.svg")) + sorted((tmp / "places").glob("*.svg"))
    cell, cols = 104, 8
    rows = math.ceil(len(files) / cols)
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, cols * cell + 24, rows * (cell + 18) + 24)
    ctx = cairo.Context(surface)
    ctx.set_source_rgb(0.03, 0.03, 0.035)
    ctx.paint()
    for i, f in enumerate(files):
        handle = Rsvg.Handle.new_from_file(str(f))
        x, y = 12 + (i % cols) * cell, 12 + (i // cols) * (cell + 18)
        rect = Rsvg.Rectangle()
        rect.x, rect.y, rect.width, rect.height = x + 12, y, 80, 80
        handle.render_document(ctx, rect)
        ctx.set_source_rgb(0.64, 0.58, 0.6)
        ctx.set_font_size(9)
        label = f.stem.split(".")[-1][:16]
        ctx.move_to(x + 52 - ctx.text_extents(label).width / 2, y + 96)
        ctx.show_text(label)
    surface.write_to_png(out)
    print(f"{len(made)} íconos; sin glifo: {skipped or 'ninguno'}")


if __name__ == "__main__":
    if "--preview" in sys.argv:
        preview(sys.argv[sys.argv.index("--preview") + 1])
