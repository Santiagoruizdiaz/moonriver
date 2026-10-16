"""Logo Moonriver para terminal (fastfetch): la luna con medios bloques ▀▄█.

Cada carácter representa 2 píxeles verticales. Los colores $1/$2/$3 (bordó claro, medio
y hondo) se asignan por altura, igual que el degradé del logo.
"""
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

HERE = Path(__file__).parent
OUT = HERE.parent / "terminal" / "moonriver.txt"
COLS = 34          # ancho en caracteres
THRESHOLD = 110    # alfa mínimo para considerar un píxel "lleno"

with tempfile.TemporaryDirectory() as tmp:
    png = Path(tmp) / "mark.png"
    subprocess.run(["magick", "-background", "none", "-density", "600", str(HERE / "moonriver-symbolic.svg"),
                    "-trim", "-resize", f"{COLS}x", str(png)], check=True)
    img = Image.open(png).convert("RGBA")

w, h = img.size
if h % 2:
    canvas = Image.new("RGBA", (w, h + 1))
    canvas.paste(img)
    img, h = canvas, h + 1
alpha = img.getchannel("A").load()


def color_for(row, rows):
    t = row / max(rows - 1, 1)
    return "$1" if t < 0.4 else "$2" if t < 0.72 else "$3"


lines = []
rows = h // 2
for r in range(rows):
    line, current = "", None
    for x in range(w):
        top = alpha[x, 2 * r] > THRESHOLD
        bottom = alpha[x, 2 * r + 1] > THRESHOLD
        ch = "█" if top and bottom else "▀" if top else "▄" if bottom else " "
        if ch != " ":
            c = color_for(r, rows)
            if c != current:
                line += c
                current = c
        line += ch
    lines.append(line.rstrip())

while lines and not lines[-1].strip():
    lines.pop()
OUT.parent.mkdir(exist_ok=True)
OUT.write_text("\n".join(lines) + "\n")
print(OUT)
print("\n".join(l.replace("$1", "").replace("$2", "").replace("$3", "") for l in lines))
