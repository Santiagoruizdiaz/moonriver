"""Logo horizontal "luna + Moonriver" para el arranque (Plymouth) y la pantalla de login (GDM)."""
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent / "boot"
OUT.mkdir(exist_ok=True)
MARK_SVG = Path(__file__).parent / "moonriver-mark.svg"

FONT = subprocess.run(["fc-match", "-f", "%{file}", "Montserrat:light"], capture_output=True, text=True).stdout.strip()
TEXT = "MOONRIVER"
TRACKING = 0.10      # espacio extra entre letras, relativo al alto
TEXT_COLOR = (243, 236, 237, 255)


def render_mark(height):
    png = OUT / f".mark-{height}.png"
    subprocess.run(["magick", "-background", "none", "-density", "600", str(MARK_SVG),
                    "-trim", "-resize", f"x{height}", str(png)], check=True)
    img = Image.open(png).convert("RGBA")
    png.unlink()
    return img


def make(height, path, aspect=None):
    """height = alto de la marca. Con aspect, se agrega margen arriba/abajo para que la imagen
    tenga esa proporción (GDM la escala a 48 px de alto: así se ve del tamaño del logo de Fedora)."""
    mark = render_mark(height)
    font = ImageFont.truetype(FONT, int(height * 0.58))
    tracking = height * TRACKING
    gap = int(height * 0.34)
    advances = [font.getlength(ch) for ch in TEXT]
    text_w = sum(advances) + tracking * (len(TEXT) - 1)
    width = int(mark.width + gap + text_w + 4)

    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    img.alpha_composite(mark, (0, 0))
    draw = ImageDraw.Draw(img)
    cap_top, cap_bottom = font.getbbox("M")[1], font.getbbox("M")[3]
    y = (height - (cap_bottom - cap_top)) / 2 - cap_top
    x = mark.width + gap
    for ch, adv in zip(TEXT, advances):
        draw.text((x, y), ch, font=font, fill=TEXT_COLOR)
        x += adv + tracking
    if aspect:
        canvas_h = max(height, round(width / aspect))
        padded = Image.new("RGBA", (width, canvas_h), (0, 0, 0, 0))
        padded.alpha_composite(img, (0, (canvas_h - height) // 2))
        img = padded
    img.save(path, optimize=True)
    print(path, img.size)


FEDORA_ASPECT = 149 / 43   # proporción del logo original de Fedora
make(28, OUT / "watermark.png")                                 # Plymouth: tamaño real (Fedora: 149×43)
make(96, OUT / "moonriver-gdm-logo.png", aspect=FEDORA_ASPECT)  # GDM: escalado a 48 px de alto
