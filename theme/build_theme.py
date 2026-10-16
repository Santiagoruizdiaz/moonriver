"""Tema Moonriver para apps GTK4/libadwaita (Archivos, Configuración, etc.).

Genera e instala en la carpeta del usuario:
  * ~/.config/gtk-4.0/gtk.css     colores negro + bordó de libadwaita
  * ~/.local/share/icons/Moonriver  carpetas bordó e íconos de apps del sistema
                                    (hereda todo lo demás de Adwaita)
y activa el tema de íconos. Para deshacer: python3 build_theme.py --uninstall
"""
import shutil
import subprocess
import sys
from pathlib import Path

from build_icons import build_app_icons

HERE = Path(__file__).parent
HOME = Path.home()
GTK_CSS = HOME / ".config/gtk-4.0/gtk.css"
ICONS = HOME / ".local/share/icons/Moonriver"
ADWAITA_PLACES = Path("/usr/share/icons/Adwaita/scalable/places")
MARK = "/* moonriver-theme */"

# Azules de las carpetas de Adwaita -> bordó
FOLDER_COLORS = {
    "#a4caee": "#a3183a",   # frente de la carpeta
    "#62a0ea": "#7d1128",   # canto inferior
    "#438de6": "#5a0a1b",   # parte de atrás / solapa
    "#afd4ff": "#e0405f",   # brillo del canto
    "#c0d5ea": "#c4234a",   # reflejo del canto
}


def gsettings(*args):
    return subprocess.run(["gsettings", *args], capture_output=True, text=True).stdout.strip()


def install():
    # 1. CSS de libadwaita
    GTK_CSS.parent.mkdir(parents=True, exist_ok=True)
    css = (HERE / "gtk4-moonriver.css").read_text()
    if GTK_CSS.exists() and MARK not in GTK_CSS.read_text():
        backup = GTK_CSS.with_suffix(".css.antes-de-moonriver")
        shutil.copy2(GTK_CSS, backup)
        print("Guardé tu gtk.css anterior en", backup)
    GTK_CSS.write_text(f"{MARK}\n{css}")

    # 2. Tema de íconos: carpetas recoloreadas
    places = ICONS / "scalable/places"
    places.mkdir(parents=True, exist_ok=True)
    for svg in ADWAITA_PLACES.glob("*.svg"):
        text = svg.read_text()
        if not any(c in text.lower() for c in FOLDER_COLORS):
            continue
        for old, new in FOLDER_COLORS.items():
            text = text.replace(old, new).replace(old.upper(), new)
        (places / svg.name).write_text(text)

    # 3. Íconos de apps del sistema: azulejo negro con glifo bordó
    made, skipped = build_app_icons(ICONS / "scalable/apps", places)
    print(f"{len(made)} íconos de apps generados", f"(sin glifo: {', '.join(skipped)})" if skipped else "")

    (ICONS / "index.theme").write_text("""[Icon Theme]
Name=Moonriver
Comment=Adwaita con carpetas bordó e íconos de apps propios
Inherits=Adwaita,hicolor
Directories=scalable/places,scalable/apps

[scalable/places]
Context=Places
Size=128
MinSize=8
MaxSize=512
Type=Scalable

[scalable/apps]
Context=Applications
Size=128
MinSize=8
MaxSize=512
Type=Scalable
""")
    subprocess.run(["gtk4-update-icon-cache", "-f", "-t", str(ICONS)], capture_output=True)

    if gsettings("get", "org.gnome.desktop.interface", "icon-theme") != "'Moonriver'":
        (ICONS / ".previous-icon-theme").write_text(gsettings("get", "org.gnome.desktop.interface", "icon-theme"))
    subprocess.run(["gsettings", "set", "org.gnome.desktop.interface", "icon-theme", "Moonriver"])
    print("Tema Moonriver instalado. Cerrá y volvé a abrir Archivos y Configuración.")


def uninstall():
    if GTK_CSS.exists() and MARK in GTK_CSS.read_text():
        backup = GTK_CSS.with_suffix(".css.antes-de-moonriver")
        if backup.exists():
            shutil.move(backup, GTK_CSS)
        else:
            GTK_CSS.unlink()
    previous = ICONS / ".previous-icon-theme"
    theme = previous.read_text().strip("'") if previous.exists() else "Adwaita"
    subprocess.run(["gsettings", "set", "org.gnome.desktop.interface", "icon-theme", theme])
    shutil.rmtree(ICONS, ignore_errors=True)
    print("Tema Moonriver quitado.")


if __name__ == "__main__":
    uninstall() if "--uninstall" in sys.argv else install()
