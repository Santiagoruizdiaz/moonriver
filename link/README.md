# Moonriver Link

Conecta el teléfono Android con la PC por wifi: archivos en ambos sentidos,
portapapeles, notificaciones del teléfono y links/texto.

## Piezas

- `desktop/moonriver-link-daemon.py`: servicio de la PC (systemd de usuario `moonriver-link.service`).
  - `41821/udp`: descubrimiento.
  - `41820/tcp`: API HTTPS con certificado propio, fijado por huella en el teléfono.
  - `41822/tcp`: descarga del `.apk`.
  - DBus `org.moonriver.Link`: conexión con el panel.
- `desktop/moonriver-link`: CLI (`send`, `text`, `status`). También aparece en Archivos → clic derecho → Scripts → «Enviar al teléfono».
- `../moonriver@moonriver.dev/phone.js`: integración en el panel de Moonriver.
- `android/`: app Kotlin + Compose (`com.moonriver.link`).

## Compilar la app de Android

Necesitás JDK 17–21 y el Android SDK (con Android Studio alcanza). Desde `link/android/`:

```bash
echo "sdk.dir=$HOME/Android/Sdk" > local.properties   # ruta de tu Android SDK
./gradlew assembleRelease
mkdir -p ~/.local/share/moonriver/link
cp app/build/outputs/apk/release/app-release.apk ~/.local/share/moonriver/link/moonriver-link.apk
```

Con el servicio corriendo, el teléfono puede descargar el `.apk` abriendo `http://IP-DE-LA-PC:41822` en el navegador.
La compilación `release` se firma con la clave de depuración, para instalarla directo; si la vas a publicar,
configurá tu propia firma en `app/build.gradle.kts`.

Los íconos se regeneran con `python3 android/tools/gen_icons.py`.

## Datos

- Vinculaciones y certificado: `~/.config/moonriver/link/`
- Archivos recibidos: `~/Descargas/Moonriver Link/`
