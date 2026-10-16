#!/bin/bash
# Marca Moonriver en el arranque (Plymouth) y en la pantalla de login (GDM).
#   sudo ./install-boot-branding.sh            instala
#   sudo ./install-boot-branding.sh --uninstall vuelve a lo de Fedora
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
THEME_DIR=/usr/share/plymouth/themes/moonriver
GDM_LOGO=/usr/share/pixmaps/moonriver-gdm-logo.png
OVERRIDE=/usr/share/glib-2.0/schemas/zz-moonriver.gschema.override

if [ "$(id -u)" -ne 0 ]; then
    echo "Correlo con sudo: sudo $0 $*" >&2
    exit 1
fi

if [ "${1:-}" = "--uninstall" ]; then
    rm -f "$OVERRIDE" "$GDM_LOGO"
    glib-compile-schemas /usr/share/glib-2.0/schemas
    echo "Volviendo al arranque de Fedora (reconstruye el initramfs, tarda un minuto)…"
    plymouth-set-default-theme -R bgrt
    rm -rf "$THEME_DIR"
    echo "Listo: arranque y login de Fedora restaurados."
    exit 0
fi

if [ ! -f /usr/share/plymouth/themes/bgrt/bgrt.plymouth ] || ! command -v plymouth-set-default-theme >/dev/null; then
    echo "Esta parte está hecha para Fedora (tema de arranque «bgrt» de Plymouth) y no se encontró en este sistema." >&2
    echo "El resto de Moonriver funciona igual; solo se saltea el logo de arranque y de login." >&2
    exit 2
fi

# ── Plymouth: copia del tema de Fedora (logo del fabricante + spinner) con la marca Moonriver abajo ──
echo "Instalando tema de arranque Moonriver…"
rm -rf "$THEME_DIR"
mkdir -p "$THEME_DIR"
cp -a /usr/share/plymouth/themes/spinner/. "$THEME_DIR/"
install -m 644 "$HERE/watermark.png" "$THEME_DIR/watermark.png"
sed -e "s|^Name=.*|Name=Moonriver|" \
    -e "/^Name\[/d" \
    -e "s|^Description=.*|Description=Moonriver: logo del equipo, spinner y marca Moonriver|" \
    -e "s|^ImageDir=.*|ImageDir=$THEME_DIR|" \
    -e "s|^BackgroundStartColor=.*|BackgroundStartColor=0x050506|" \
    -e "s|^BackgroundEndColor=.*|BackgroundEndColor=0x050506|" \
    -e "s|^ProgressBarForegroundColor=.*|ProgressBarForegroundColor=0xa3183a|" \
    -e "s|^ProgressBarBackgroundColor=.*|ProgressBarBackgroundColor=0x2a2226|" \
    /usr/share/plymouth/themes/bgrt/bgrt.plymouth > "$THEME_DIR/moonriver.plymouth"
rm -f "$THEME_DIR/spinner.plymouth"

# ── GDM: logo de abajo en la pantalla de login ──
echo "Configurando el logo de la pantalla de login…"
install -m 644 "$HERE/moonriver-gdm-logo.png" "$GDM_LOGO"
cat > "$OVERRIDE" <<EOF
[org.gnome.login-screen]
logo='$GDM_LOGO'
EOF
glib-compile-schemas /usr/share/glib-2.0/schemas

echo "Activando el tema de arranque (reconstruye el initramfs, tarda un minuto)…"
plymouth-set-default-theme -R moonriver

echo
echo "Listo. Reiniciá para ver Moonriver al encender y en el login."
echo "Para deshacer: sudo $0 --uninstall"
