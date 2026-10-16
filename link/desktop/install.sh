#!/bin/sh
# Instala el servicio de Moonriver Link para el usuario actual.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
DATA="$HOME/.local/share/moonriver/link"

mkdir -p "$DATA" "$HOME/.local/bin" "$HOME/.config/systemd/user" "$HOME/.local/share/nautilus/scripts"

ln -sf "$HERE/moonriver-link-daemon.py" "$DATA/moonriver-link-daemon.py"
ln -sf "$HERE/moonriver-link" "$HOME/.local/bin/moonriver-link"
chmod +x "$HERE/moonriver-link" "$HERE/moonriver-link-daemon.py"
cp "$HERE/moonriver-link.service" "$HOME/.config/systemd/user/moonriver-link.service"

# "Enviar al teléfono" en el menú de clic derecho de Archivos (Scripts)
cat > "$HOME/.local/share/nautilus/scripts/Enviar al teléfono" <<'EOF'
#!/bin/sh
exec "$HOME/.local/bin/moonriver-link" send "$@"
EOF
chmod +x "$HOME/.local/share/nautilus/scripts/Enviar al teléfono"

systemctl --user daemon-reload
systemctl --user enable --now moonriver-link.service
systemctl --user restart moonriver-link.service
echo "Moonriver Link instalado."
