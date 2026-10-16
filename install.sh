#!/bin/bash
# Instalador de Moonriver para GNOME.
#   ./install.sh               pregunta qué partes instalar
#   ./install.sh --all         instala todo lo que no necesita sudo
#   ./install.sh --uninstall   quita Moonriver y vuelve a GNOME normal
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
UUID="moonriver@moonriver.dev"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
WALLPAPER="$HOME/.local/share/backgrounds/moonriver-wallpaper.png"
STATE="$HOME/.config/moonriver/install-state"
REPO="Santiagoruizdiaz/moonriver"
APK_URL="https://github.com/$REPO/releases/latest/download/moonriver-link.apk"
APK_PATH="$HOME/.local/share/moonriver/link/moonriver-link.apk"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
bordo() { printf '\033[38;2;196;35;74m%s\033[0m\n' "$*"; }
ask() {   # ask "pregunta" -> 0 si sí (por defecto sí)
    [ "${ALL:-0}" = 1 ] && return 0
    read -r -p "$1 [S/n] " r
    [[ -z "$r" || "$r" =~ ^[sSyY] ]]
}
have() { command -v "$1" >/dev/null 2>&1; }

enabled_extensions() { gsettings get org.gnome.shell enabled-extensions; }
set_extension_enabled() {   # set_extension_enabled true|false
    python3 - "$1" "$UUID" "$(enabled_extensions)" <<'EOF'
import ast, subprocess, sys
enable, uuid, current = sys.argv[1] == "true", sys.argv[2], sys.argv[3]
items = [] if current.startswith("@") else ast.literal_eval(current)
if enable and uuid not in items:
    items.append(uuid)
if not enable:
    items = [i for i in items if i != uuid]
subprocess.run(["gsettings", "set", "org.gnome.shell", "enabled-extensions", str(items)], check=True)
EOF
}

check_dependencies() {
    local missing=()
    have gnome-shell || { echo "Moonriver necesita GNOME Shell." >&2; exit 1; }
    have python3 || missing+=("python3")
    python3 -c "import gi; gi.require_version('Gio', '2.0')" 2>/dev/null || missing+=("python3-gobject (python3-gi en Ubuntu)")
    have openssl || missing+=("openssl")
    have zenity || missing+=("zenity (opcional: para elegir archivos al enviar al teléfono)")
    have fastfetch || missing+=("fastfetch (opcional: logo en la terminal)")
    python3 -c "import PIL" 2>/dev/null || missing+=("python3-pillow (opcional: solo para regenerar imágenes)")

    local version
    version=$(gnome-shell --version | grep -oE '[0-9]+' | head -1)
    if [ "$version" != "50" ]; then
        bordo "Aviso: Moonriver está probado en GNOME 50 y tenés GNOME $version. Puede que algo no funcione."
    fi
    if [ ${#missing[@]} -gt 0 ]; then
        bordo "Faltan algunas cosas:"
        printf '  - %s\n' "${missing[@]}"
        echo "  Fedora:  sudo dnf install python3-gobject openssl zenity fastfetch python3-pillow"
        echo "  Ubuntu:  sudo apt install python3-gi openssl zenity fastfetch python3-pil"
        echo
    fi
}

install_extension() {
    bold "→ Extensión de GNOME Shell"
    mkdir -p "$(dirname "$EXT_DIR")"
    ln -sfn "$ROOT/$UUID" "$EXT_DIR"
    set_extension_enabled true
    echo "  Instalada y activada. Se carga al cerrar sesión y volver a entrar."
}

install_wallpaper() {
    bold "→ Fondo de pantalla y modo oscuro"
    mkdir -p "$HOME/.config/moonriver" "$(dirname "$WALLPAPER")"
    # Guardar lo anterior para poder volver
    {
        echo "picture-uri=$(gsettings get org.gnome.desktop.background picture-uri)"
        echo "picture-uri-dark=$(gsettings get org.gnome.desktop.background picture-uri-dark)"
        echo "color-scheme=$(gsettings get org.gnome.desktop.interface color-scheme)"
    } > "$STATE"
    cp "$ROOT/branding/moonriver-wallpaper.png" "$WALLPAPER"
    local uri="file://$WALLPAPER"
    gsettings set org.gnome.desktop.background picture-uri "$uri"
    gsettings set org.gnome.desktop.background picture-uri-dark "$uri"
    gsettings set org.gnome.desktop.background picture-options zoom
    gsettings set org.gnome.desktop.screensaver picture-uri "$uri"
    gsettings set org.gnome.desktop.interface color-scheme prefer-dark
}

install_theme() {
    bold "→ Tema negro y bordó para las apps (Archivos, Configuración…) y carpetas bordó"
    python3 "$ROOT/theme/build_theme.py"
}

install_terminal() {
    bold "→ fastfetch / neofetch con el logo de Moonriver"
    mkdir -p "$HOME/.config/fastfetch" "$HOME/.local/bin"
    if [ -e "$HOME/.config/fastfetch/config.jsonc" ] && [ ! -L "$HOME/.config/fastfetch/config.jsonc" ]; then
        mv "$HOME/.config/fastfetch/config.jsonc" "$HOME/.config/fastfetch/config.jsonc.antes-de-moonriver"
    fi
    ln -sf "$ROOT/terminal/fastfetch.jsonc" "$HOME/.config/fastfetch/config.jsonc"
    ln -sf "$ROOT/terminal/moonriver.txt" "$HOME/.config/fastfetch/moonriver.txt"
    have neofetch || ln -sf "$ROOT/terminal/neofetch" "$HOME/.local/bin/neofetch"
}

install_link() {
    bold "→ Moonriver Link (conexión con el teléfono)"
    sh "$ROOT/link/desktop/install.sh"
    mkdir -p "$(dirname "$APK_PATH")"
    if [ -f "$ROOT/dist/moonriver-link.apk" ]; then
        cp "$ROOT/dist/moonriver-link.apk" "$APK_PATH"           # compilada localmente
    elif have curl && curl -fsSL --retry 2 -o "$APK_PATH.part" "$APK_URL"; then
        mv "$APK_PATH.part" "$APK_PATH"
        echo "  App de Android descargada de github.com/$REPO."
    else
        rm -f "$APK_PATH.part"
        echo "  No se pudo descargar la app de Android. Bajala de https://github.com/$REPO/releases"
        echo "  y copiala a $APK_PATH"
    fi
    local ip
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    if [ -f "$APK_PATH" ] && [ -n "$ip" ]; then
        echo "  Para instalarla, abrí en el navegador del teléfono:  http://$ip:41822"
    fi
}

uninstall() {
    bold "Quitando Moonriver…"
    set_extension_enabled false || true
    rm -f "$EXT_DIR"

    if [ -f "$STATE" ]; then
        while IFS='=' read -r key value; do
            case "$key" in
                picture-uri|picture-uri-dark) gsettings set org.gnome.desktop.background "$key" "$value" ;;
                color-scheme) gsettings set org.gnome.desktop.interface color-scheme "$value" ;;
            esac
        done < "$STATE"
        rm -f "$STATE"
    fi
    rm -f "$WALLPAPER" "$APK_PATH"

    [ -f "$HOME/.local/share/icons/Moonriver/index.theme" ] && python3 "$ROOT/theme/build_theme.py" --uninstall

    if [ -L "$HOME/.config/fastfetch/config.jsonc" ]; then
        rm -f "$HOME/.config/fastfetch/config.jsonc" "$HOME/.config/fastfetch/moonriver.txt"
        [ -f "$HOME/.config/fastfetch/config.jsonc.antes-de-moonriver" ] && \
            mv "$HOME/.config/fastfetch/config.jsonc.antes-de-moonriver" "$HOME/.config/fastfetch/config.jsonc"
    fi
    [ -L "$HOME/.local/bin/neofetch" ] && rm -f "$HOME/.local/bin/neofetch"

    if systemctl --user list-unit-files moonriver-link.service >/dev/null 2>&1; then
        systemctl --user disable --now moonriver-link.service 2>/dev/null || true
        rm -f "$HOME/.config/systemd/user/moonriver-link.service" "$HOME/.local/bin/moonriver-link" \
              "$HOME/.local/share/nautilus/scripts/Enviar al teléfono"
        systemctl --user daemon-reload
    fi
    echo
    echo "Listo. Cerrá sesión y volvé a entrar para terminar."
    echo "Tus vinculaciones del teléfono quedaron en ~/.config/moonriver/link (borralas si no las querés)."
    echo "Si instalaste el logo de arranque: sudo $ROOT/branding/boot/install-boot-branding.sh --uninstall"
}

main() {
    bordo "   MOONRIVER"
    echo "   Escritorio negro y bordó para GNOME"
    echo

    case "${1:-}" in
        --uninstall) uninstall; exit 0 ;;
        --all) ALL=1 ;;
        "") ;;
        *) echo "Uso: $0 [--all | --uninstall]" >&2; exit 1 ;;
    esac

    check_dependencies
    if ask "¿Instalar Moonriver (extensión de escritorio + Moonriver Link para el teléfono)?"; then
        install_extension
        install_link
    fi
    ask "¿Poner el fondo de pantalla Moonriver y el modo oscuro?" && install_wallpaper
    ask "¿Aplicar el tema bordó a Archivos, Configuración y las carpetas?" && install_theme
    have fastfetch && ask "¿Configurar fastfetch/neofetch con el logo?" && install_terminal

    echo
    bold "Listo."
    echo "Cerrá sesión y volvé a entrar para ver Moonriver."
    echo "Opcional (Fedora, pide contraseña): logo Moonriver al encender y en el login:"
    echo "  sudo $ROOT/branding/boot/install-boot-branding.sh"
}

main "$@"
