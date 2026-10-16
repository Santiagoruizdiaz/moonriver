#!/usr/bin/env python3
"""Moonriver Link — servicio de la PC.

Conecta el teléfono (app Moonriver Link para Android) con la PC por wifi:
archivos en ambos sentidos, portapapeles, notificaciones del teléfono y links/texto.

Piezas:
  * Descubrimiento UDP (puerto 41821): el teléfono manda "MOONRIVER?" por broadcast
    y la PC le responde con nombre, puerto y huella del certificado.
  * API HTTPS (puerto 41820) con certificado propio; el teléfono lo fija al vincularse.
    Lo que la PC le manda al teléfono viaja por long-poll (GET /events).
  * DBus (org.moonriver.Link) para que el panel de Moonriver muestre el estado,
    las notificaciones y maneje el portapapeles (en Wayland solo el Shell puede).
  * HTTP simple (puerto 41822) que sirve el .apk para instalarlo desde el teléfono.
"""

import hashlib
import hmac
import json
import os
import secrets
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

# Se ejecuta con python3 -I (sin la carpeta del script en sys.path): agregarla a mano.
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import agents  # noqa: E402

API_PORT = 41820
DISCOVERY_PORT = 41821
APK_PORT = 41822
PROTOCOL = 1

CONFIG_DIR = os.path.join(GLib.get_user_config_dir(), "moonriver", "link")
DATA_DIR = os.path.join(GLib.get_user_data_dir(), "moonriver", "link")
APK_PATH = os.path.join(DATA_DIR, "moonriver-link.apk")
RECEIVED_DIR = os.path.join(
    GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) or os.path.expanduser("~/Descargas"),
    "Moonriver Link",
)

LONG_POLL_SECONDS = 25
ONLINE_GRACE_SECONDS = 45
PAIR_CODE_TTL = 180
PAIR_MAX_ATTEMPTS = 5
MAX_QUEUED_EVENTS = 200
CHUNK = 256 * 1024

DBUS_NAME = "org.moonriver.Link"
DBUS_PATH = "/org/moonriver/Link"
DBUS_XML = """
<node>
  <interface name="org.moonriver.Link">
    <method name="GetStatus"><arg type="s" name="json" direction="out"/></method>
    <method name="SendFiles"><arg type="as" name="paths" direction="in"/></method>
    <method name="SendText"><arg type="s" name="text" direction="in"/></method>
    <method name="SendClipboard"><arg type="s" name="text" direction="in"/></method>
    <method name="Unpair"><arg type="s" name="device_id" direction="in"/></method>
    <method name="CancelPairing"/>
    <method name="SetAgentControl"><arg type="b" name="enabled" direction="in"/></method>
    <signal name="StatusChanged"><arg type="s" name="json"/></signal>
    <signal name="PairRequest"><arg type="s" name="device_name"/><arg type="s" name="code"/></signal>
    <signal name="PhoneNotification">
      <arg type="s" name="app"/><arg type="s" name="title"/><arg type="s" name="text"/>
    </signal>
    <signal name="FileReceived"><arg type="s" name="path"/><arg type="s" name="device_name"/></signal>
    <signal name="TextReceived"><arg type="s" name="text"/><arg type="b" name="is_url"/></signal>
    <signal name="SetClipboard"><arg type="s" name="text"/></signal>
    <signal name="AgentCommand">
      <arg type="s" name="agent"/><arg type="s" name="conversation"/><arg type="s" name="text"/>
    </signal>
  </interface>
</node>
"""


def log(*args):
    print("[moonriver-link]", *args, file=sys.stderr, flush=True)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_filename(name: str) -> str:
    name = os.path.basename(name.replace("\\", "/")).strip().lstrip(".")
    name = "".join(c for c in name if c not in '\x00/:*?"<>|')
    return name[:200] or f"archivo-{int(time.time())}"


def unique_path(directory: str, name: str) -> str:
    base, ext = os.path.splitext(name)
    path = os.path.join(directory, name)
    n = 1
    while os.path.exists(path):
        path = os.path.join(directory, f"{base} ({n}){ext}")
        n += 1
    return path


# ─────────────────────────── certificado ───────────────────────────

def ensure_certificate():
    os.makedirs(CONFIG_DIR, exist_ok=True)
    cert = os.path.join(CONFIG_DIR, "cert.pem")
    key = os.path.join(CONFIG_DIR, "key.pem")
    if not (os.path.exists(cert) and os.path.exists(key)):
        log("generando certificado")
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
             "-days", "3650", "-nodes", "-subj", f"/CN=moonriver-link-{socket.gethostname()}",
             "-keyout", key, "-out", cert],
            check=True, capture_output=True,
        )
        os.chmod(key, 0o600)
    with open(cert) as f:
        fingerprint = sha256(ssl.PEM_cert_to_DER_cert(f.read()))
    return cert, key, fingerprint


# ─────────────────────────── estado compartido ───────────────────────────

class State:
    def __init__(self, fingerprint):
        self.lock = threading.Condition()
        self.fingerprint = fingerprint
        self.pc_name = socket.gethostname().split(".")[0]
        self.devices_file = os.path.join(CONFIG_DIR, "devices.json")
        self.identity_file = os.path.join(CONFIG_DIR, "identity.json")
        self.settings_file = os.path.join(CONFIG_DIR, "settings.json")
        self.settings = {"agent_control": True, **self._load(self.settings_file, {})}
        self.devices = self._load(self.devices_file, {})
        identity = self._load(self.identity_file, {})
        if "id" not in identity:
            identity = {"id": secrets.token_hex(8)}
            self._save(self.identity_file, identity)
        self.pc_id = identity["id"]

        self.pending = {}          # device_id -> {name, code, expires, attempts}
        self.online = {}           # device_id -> {last_seen, battery, charging}
        self.events = {}           # device_id -> [event]
        self.seq = 0
        self.outgoing = {}         # file_id -> path
        self.last_clipboard_from_phone = None
        self.on_change = lambda: None

    @staticmethod
    def _load(path, default):
        try:
            with open(path) as f:
                return json.load(f)
        except (OSError, ValueError):
            return default

    @staticmethod
    def _save(path, data):
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f, indent=1)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)

    # vinculación
    def start_pairing(self, device_id, name):
        code = f"{secrets.randbelow(1_000_000):06d}"
        with self.lock:
            self.pending[device_id] = {"name": name, "code": code,
                                       "expires": time.time() + PAIR_CODE_TTL, "attempts": 0}
        return code

    def confirm_pairing(self, device_id, code):
        with self.lock:
            p = self.pending.get(device_id)
            if not p or time.time() > p["expires"]:
                self.pending.pop(device_id, None)
                return None, "expired"
            p["attempts"] += 1
            if not hmac.compare_digest(p["code"], code):
                if p["attempts"] >= PAIR_MAX_ATTEMPTS:
                    self.pending.pop(device_id, None)
                    return None, "too_many_attempts"
                return None, "wrong_code"
            token = secrets.token_urlsafe(32)
            self.devices[device_id] = {"name": p["name"], "token": sha256(token.encode()),
                                       "paired_at": int(time.time())}
            self._save(self.devices_file, self.devices)
            self.pending.pop(device_id, None)
        self.on_change()
        return token, None

    def cancel_pairing(self):
        with self.lock:
            self.pending.clear()

    def set_agent_control(self, enabled):
        with self.lock:
            self.settings["agent_control"] = bool(enabled)
            self._save(self.settings_file, self.settings)
        self.on_change()

    def unpair(self, device_id):
        with self.lock:
            self.devices.pop(device_id, None)
            self.online.pop(device_id, None)
            self.events.pop(device_id, None)
            self._save(self.devices_file, self.devices)
        self.on_change()

    def authenticate(self, device_id, token):
        dev = self.devices.get(device_id or "")
        return bool(dev and token and hmac.compare_digest(dev["token"], sha256(token.encode())))

    # presencia
    def touch(self, device_id, **status):
        changed = False
        with self.lock:
            entry = self.online.get(device_id)
            if entry is None or time.time() - entry["last_seen"] > ONLINE_GRACE_SECONDS:
                changed = True
                entry = {"battery": None, "charging": False}
                self.online[device_id] = entry
            entry["last_seen"] = time.time()
            for k, v in status.items():
                if entry.get(k) != v:
                    entry[k] = v
                    changed = True
        if changed:
            self.on_change()

    def status(self):
        now = time.time()
        with self.lock:
            devices = []
            for dev_id, dev in self.devices.items():
                on = self.online.get(dev_id)
                connected = bool(on and now - on["last_seen"] < ONLINE_GRACE_SECONDS)
                devices.append({
                    "id": dev_id, "name": dev["name"], "connected": connected,
                    "battery": on.get("battery") if connected else None,
                    "charging": on.get("charging", False) if connected else False,
                })
            return {"pc_name": self.pc_name, "devices": devices,
                    "received_dir": RECEIVED_DIR, "apk_available": os.path.exists(APK_PATH),
                    "apk_port": APK_PORT, "agent_control": self.settings["agent_control"]}

    # eventos PC -> teléfono
    def push(self, event, only_latest_of_type=False):
        with self.lock:
            for dev_id in self.devices:
                queue = self.events.setdefault(dev_id, [])
                if only_latest_of_type:
                    queue[:] = [e for e in queue if e["type"] != event["type"]]
                self.seq += 1
                queue.append(dict(event, seq=self.seq))
                del queue[:-MAX_QUEUED_EVENTS]
            self.lock.notify_all()

    def wait_events(self, device_id, since):
        deadline = time.time() + LONG_POLL_SECONDS
        with self.lock:
            while True:
                queue = self.events.get(device_id, [])
                fresh = [e for e in queue if e["seq"] > since]
                remaining = deadline - time.time()
                if fresh or remaining <= 0:
                    # Lo ya entregado se descarta
                    self.events[device_id] = fresh
                    return fresh, self.seq
                self.lock.wait(remaining)


# ─────────────────────────── API HTTPS ───────────────────────────

def make_handler(state: State, ssl_ctx: ssl.SSLContext, bus):
    claude = agents.ClaudeAgent()
    antigravity = agents.AntigravityAgent()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "MoonriverLink/1"

        def setup(self):
            # Handshake TLS en el hilo de cada conexión (no bloquea al resto).
            self.request.settimeout(LONG_POLL_SECONDS + 35)
            self.request = ssl_ctx.wrap_socket(self.request, server_side=True)
            super().setup()

        def log_message(self, fmt, *args):
            pass

        # utilidades
        def _json(self, code, data):
            body = json.dumps(data).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _read_body(self, limit=1 << 20):
            if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                data = b"".join(self._iter_chunked())
            else:
                length = int(self.headers.get("Content-Length") or 0)
                if length > limit:
                    raise ValueError("body too large")
                data = self.rfile.read(length)
            return json.loads(data or b"{}")

        def _iter_chunked(self):
            while True:
                size = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    self.rfile.readline()
                    return
                yield self.rfile.read(size)
                self.rfile.readline()

        def _device(self):
            device_id = self.headers.get("X-Device-Id", "")
            auth = self.headers.get("Authorization", "")
            token = auth[7:] if auth.startswith("Bearer ") else ""
            if state.authenticate(device_id, token):
                return device_id
            self._json(401, {"error": "unauthorized"})
            return None

        def _path(self):
            parsed = urllib.parse.urlparse(self.path)
            return parsed.path, urllib.parse.parse_qs(parsed.query)

        # rutas
        def do_GET(self):
            path, query = self._path()
            if path == "/hello":
                return self._json(200, {"protocol": PROTOCOL, "id": state.pc_id,
                                        "name": state.pc_name, "fingerprint": state.fingerprint})
            device = self._device()
            if not device:
                return
            state.touch(device)
            if path == "/events":
                since = int((query.get("since") or ["0"])[0])
                events, seq = state.wait_events(device, since)
                state.touch(device)
                return self._json(200, {"seq": seq, "events": events})
            if path.startswith("/files/"):
                return self._send_file(path[len("/files/"):])
            if path.startswith("/agents"):
                return self._agents_get(path, query)
            self._json(404, {"error": "not_found"})

        # ── agentes ──
        def _agents_get(self, path, query):
            parts = path.strip("/").split("/")          # agents[/kind/id]
            try:
                if parts == ["agents"]:
                    data = {"control": state.settings["agent_control"],
                            "claude": {"available": claude.available, "sessions": []},
                            "antigravity": {"running": antigravity.running, "sessions": []}}
                    if claude.available:
                        data["claude"]["sessions"] = claude.recent()
                    if data["antigravity"]["running"]:
                        try:
                            data["antigravity"]["sessions"] = antigravity.recent()
                        except Exception as e:  # noqa: BLE001
                            data["antigravity"]["error"] = str(e)
                    return self._json(200, data)
                if len(parts) == 3 and parts[1] == "job":
                    since = int((query.get("since") or ["0"])[0])
                    job = claude.job(parts[2], since)
                    return self._json(200, job) if job else self._json(404, {"error": "not_found"})
                if len(parts) == 3 and parts[1] in ("claude", "antigravity"):
                    agent = claude if parts[1] == "claude" else antigravity
                    messages = agent.transcript(parts[2])
                    if messages is None:
                        return self._json(404, {"error": "not_found"})
                    return self._json(200, {"messages": messages})
            except Exception as e:  # noqa: BLE001
                return self._json(502, {"error": "agent_error", "message": str(e)})
            self._json(404, {"error": "not_found"})

        def _agents_post(self, path, body, dev_name):
            if not state.settings["agent_control"]:
                return self._json(403, {"error": "agent_control_disabled",
                                        "message": "El control de agentes está desactivado en la PC"})
            parts = path.strip("/").split("/")          # agents/kind/id/action
            if len(parts) != 4:
                return self._json(404, {"error": "not_found"})
            _, kind, item, action = parts
            text = str(body.get("text", "")).strip()[:20000]
            try:
                if kind == "claude" and action == "run":
                    if not text:
                        return self._json(400, {"error": "empty"})
                    job = claude.run(item, text, str(body.get("mode", "acceptEdits")))
                    bus.emit("AgentCommand", GLib.Variant("(sss)", ("Claude Code", str(body.get("title", "")), text)))
                    return self._json(200, {"job": job})
                if kind == "job" and action == "cancel":
                    claude.cancel(item)
                    return self._json(200, {"ok": True})
                if kind == "antigravity" and action == "send":
                    if not text:
                        return self._json(400, {"error": "empty"})
                    antigravity.send(item, text)
                    bus.emit("AgentCommand", GLib.Variant("(sss)", ("Antigravity", str(body.get("title", "")), text)))
                    return self._json(200, {"ok": True})
                if kind == "antigravity" and action == "cancel":
                    antigravity.cancel(item)
                    return self._json(200, {"ok": True})
            except Exception as e:  # noqa: BLE001
                return self._json(502, {"error": "agent_error", "message": str(e)})
            self._json(404, {"error": "not_found"})

        def do_POST(self):
            path, _ = self._path()
            try:
                body = self._read_body()
            except ValueError:
                return self._json(400, {"error": "bad_request"})

            if path == "/pair/request":
                device_id, name = str(body.get("device_id", ""))[:64], str(body.get("name", "Teléfono"))[:60]
                if not device_id:
                    return self._json(400, {"error": "bad_request"})
                code = state.start_pairing(device_id, name)
                bus.emit("PairRequest", GLib.Variant("(ss)", (name, code)))
                return self._json(200, {"ok": True, "pc_name": state.pc_name})
            if path == "/pair/confirm":
                token, err = state.confirm_pairing(str(body.get("device_id", "")), str(body.get("code", "")))
                if err:
                    return self._json(403, {"error": err})
                return self._json(200, {"token": token, "pc_name": state.pc_name, "pc_id": state.pc_id})

            device = self._device()
            if not device:
                return
            dev_name = state.devices[device]["name"]

            if path == "/status":
                battery = body.get("battery")
                state.touch(device, battery=int(battery) if battery is not None else None,
                            charging=bool(body.get("charging")))
                return self._json(200, {"ok": True})
            state.touch(device)
            if path == "/clipboard":
                text = str(body.get("text", ""))
                if text:
                    state.last_clipboard_from_phone = text
                    bus.emit("SetClipboard", GLib.Variant("(s)", (text,)))
                return self._json(200, {"ok": True})
            if path == "/share":
                text = str(body.get("text", "")).strip()
                is_url = text.startswith(("http://", "https://")) and " " not in text
                bus.emit("TextReceived", GLib.Variant("(sb)", (text, is_url)))
                return self._json(200, {"ok": True})
            if path == "/notification":
                bus.emit("PhoneNotification", GLib.Variant("(sss)", (
                    str(body.get("app", ""))[:80], str(body.get("title", ""))[:200],
                    str(body.get("text", ""))[:1000])))
                return self._json(200, {"ok": True})
            if path.startswith("/agents/"):
                return self._agents_post(path, body, dev_name)
            self._json(404, {"error": "not_found"})

        def do_PUT(self):
            path, query = self._path()
            device = self._device()
            if not device:
                return
            if path != "/upload":
                return self._json(404, {"error": "not_found"})
            state.touch(device)
            name = safe_filename((query.get("name") or [""])[0])
            os.makedirs(RECEIVED_DIR, exist_ok=True)
            dest = unique_path(RECEIVED_DIR, name)
            tmp = dest + ".part"
            try:
                with open(tmp, "wb") as f:
                    if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                        for chunk in self._iter_chunked():
                            f.write(chunk)
                    else:
                        remaining = int(self.headers.get("Content-Length") or 0)
                        while remaining > 0:
                            chunk = self.rfile.read(min(CHUNK, remaining))
                            if not chunk:
                                raise ConnectionError("upload interrupted")
                            f.write(chunk)
                            remaining -= len(chunk)
                os.replace(tmp, dest)
            except Exception as e:  # noqa: BLE001
                log("upload falló:", e)
                try:
                    os.remove(tmp)
                except OSError:
                    pass
                return self._json(500, {"error": "upload_failed"})
            bus.emit("FileReceived", GLib.Variant("(ss)", (dest, state.devices[device]["name"])))
            self._json(200, {"ok": True, "name": os.path.basename(dest)})

        def _send_file(self, file_id):
            path = state.outgoing.get(file_id)
            if not path or not os.path.isfile(path):
                return self._json(404, {"error": "not_found"})
            size = os.path.getsize(path)
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition",
                             "attachment; filename*=UTF-8''" + urllib.parse.quote(os.path.basename(path)))
            self.end_headers()
            with open(path, "rb") as f:
                while chunk := f.read(CHUNK):
                    self.wfile.write(chunk)

    return Handler


# ─────────────────────────── descubrimiento UDP ───────────────────────────

def discovery_loop(state: State):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("", DISCOVERY_PORT))
    while True:
        try:
            data, addr = sock.recvfrom(2048)
        except OSError:
            continue
        if not data.startswith(b"MOONRIVER?"):
            continue
        reply = json.dumps({"moonriver": PROTOCOL, "id": state.pc_id, "name": state.pc_name,
                            "port": API_PORT, "fingerprint": state.fingerprint}).encode()
        try:
            sock.sendto(reply, addr)
        except OSError:
            pass


# ─────────────────────────── servidor del .apk ───────────────────────────

class ApkHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        if not os.path.exists(APK_PATH):
            self.send_error(404)
            return
        size = os.path.getsize(APK_PATH)
        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.android.package-archive")
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", 'attachment; filename="moonriver-link.apk"')
        self.end_headers()
        with open(APK_PATH, "rb") as f:
            while chunk := f.read(CHUNK):
                self.wfile.write(chunk)


# ─────────────────────────── DBus ───────────────────────────

class Bus:
    def __init__(self, state: State):
        self.state = state
        self.conn = None
        self.node = Gio.DBusNodeInfo.new_for_xml(DBUS_XML)
        self._last_status = None

    def own(self):
        Gio.bus_own_name(Gio.BusType.SESSION, DBUS_NAME, Gio.BusNameOwnerFlags.NONE,
                         self._on_bus, None, lambda *_: (log("nombre DBus perdido"), os._exit(1)))

    def _on_bus(self, conn, _name):
        self.conn = conn
        conn.register_object_with_closures2(DBUS_PATH, self.node.interfaces[0], self._on_call, None, None)

    def emit(self, signal, params):
        # Puede llamarse desde los hilos HTTP: se despacha en el hilo principal.
        def do():
            if self.conn:
                self.conn.emit_signal(None, DBUS_PATH, DBUS_NAME, signal, params)
            return GLib.SOURCE_REMOVE
        GLib.idle_add(do)

    def emit_status_if_changed(self):
        status = json.dumps(self.state.status())
        if status != self._last_status:
            self._last_status = status
            self.emit("StatusChanged", GLib.Variant("(s)", (status,)))
        return GLib.SOURCE_CONTINUE

    def _on_call(self, _conn, _sender, _path, _iface, method, params, invocation):
        args = params.unpack()
        try:
            if method == "GetStatus":
                invocation.return_value(GLib.Variant("(s)", (json.dumps(self.state.status()),)))
                return
            if method == "SendFiles":
                for path in args[0]:
                    if os.path.isfile(path):
                        file_id = secrets.token_urlsafe(12)
                        self.state.outgoing[file_id] = path
                        self.state.push({"type": "file", "id": file_id, "name": os.path.basename(path),
                                         "size": os.path.getsize(path)})
            elif method == "SendText":
                text = args[0].strip()
                kind = "url" if text.startswith(("http://", "https://")) and " " not in text else "text"
                self.state.push({"type": kind, "text": text})
            elif method == "SendClipboard":
                text = args[0]
                if text and text != self.state.last_clipboard_from_phone:
                    self.state.push({"type": "clipboard", "text": text}, only_latest_of_type=True)
            elif method == "Unpair":
                self.state.unpair(args[0])
            elif method == "CancelPairing":
                self.state.cancel_pairing()
            elif method == "SetAgentControl":
                self.state.set_agent_control(args[0])
            invocation.return_value(None)
        except Exception as e:  # noqa: BLE001
            invocation.return_dbus_error("org.moonriver.Link.Error", str(e))


# ─────────────────────────── main ───────────────────────────

def main():
    cert, key, fingerprint = ensure_certificate()
    state = State(fingerprint)
    bus = Bus(state)
    state.on_change = lambda: GLib.idle_add(lambda: bus.emit_status_if_changed() and False)
    bus.own()

    ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ssl_ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ssl_ctx.load_cert_chain(cert, key)

    api = ThreadingHTTPServer(("0.0.0.0", API_PORT), make_handler(state, ssl_ctx, bus))
    api.daemon_threads = True
    threading.Thread(target=api.serve_forever, daemon=True).start()
    threading.Thread(target=discovery_loop, args=(state,), daemon=True).start()

    apk = ThreadingHTTPServer(("0.0.0.0", APK_PORT), ApkHandler)
    apk.daemon_threads = True
    threading.Thread(target=apk.serve_forever, daemon=True).start()

    # Detecta teléfonos que se desconectan (dejan de hacer long-poll)
    GLib.timeout_add_seconds(5, bus.emit_status_if_changed)

    log(f"escuchando en :{API_PORT} (huella {fingerprint[:16]}…)")
    GLib.MainLoop().run()


if __name__ == "__main__":
    main()
