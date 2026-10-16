"""Control de agentes (Claude Code y Antigravity) para Moonriver Link.

Claude Code: lee las sesiones de ~/.claude/projects y continúa una sesión con
`claude -p --resume <id>` (modo no interactivo oficial), transmitiendo la salida.

Antigravity: habla con su language server local (API Connect/JSON) usando el puerto y el
token CSRF que la propia app le pasa por línea de comandos. Solo funciona con la app abierta.
"""

import glob
import json
import os
import secrets
import shutil
import ssl
import subprocess
import threading
import time
import urllib.request

HOME = os.path.expanduser("~")
CLAUDE_PROJECTS = os.path.join(HOME, ".claude", "projects")
RECENT_LIMIT = 3
TRANSCRIPT_LIMIT = 40
MAX_TEXT = 4000
PERMISSION_MODES = {"plan", "acceptEdits", "auto"}


def _short(text, limit=MAX_TEXT):
    text = (text or "").strip()
    return text if len(text) <= limit else text[:limit] + "…"


def _pretty_path(path):
    if not path:
        return ""
    if "/scratch-workspaces/" in path:
        return "scratch"
    return "~" + path[len(HOME):] if path.startswith(HOME) else path


def _claude_processes():
    """cwd de cada proceso `claude` vivo (para marcar sesiones activas)."""
    cwds = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/comm") as f:
                if f.read().strip() != "claude":
                    continue
            cwds.append(os.readlink(f"/proc/{pid}/cwd"))
        except OSError:
            continue
    return cwds


# ─────────────────────────── Claude Code ───────────────────────────

class ClaudeAgent:
    def __init__(self):
        self.binary = shutil.which("claude") or os.path.join(HOME, ".local", "bin", "claude")
        self.jobs = {}
        self.lock = threading.Lock()

    @property
    def available(self):
        return os.path.exists(self.binary)

    def _session_files(self):
        files = [f for f in glob.glob(os.path.join(CLAUDE_PROJECTS, "*", "*.jsonl"))
                 if "/subagents/" not in f]
        return sorted(files, key=os.path.getmtime, reverse=True)

    def _file_for(self, session_id):
        if not session_id or "/" in session_id or ".." in session_id:
            return None
        matches = glob.glob(os.path.join(CLAUDE_PROJECTS, "*", f"{session_id}.jsonl"))
        return matches[0] if matches else None

    @staticmethod
    def _read_meta(path):
        title, cwd, first_prompt, last_text = None, None, None, None
        with open(path, errors="replace") as f:
            for line in f:
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                t = o.get("type")
                if t == "custom-title" and o.get("customTitle"):
                    title = o["customTitle"]
                elif t == "agent-name" and o.get("agentName") and not title:
                    title = o["agentName"]
                if not cwd and o.get("cwd"):
                    cwd = o["cwd"]
                if t == "user" and not o.get("isSidechain") and first_prompt is None:
                    first_prompt = _message_text(o.get("message"), user=True)
                if t == "assistant" and not o.get("isSidechain"):
                    text = _message_text(o.get("message"))
                    if text:
                        last_text = text
        return {
            "title": title or _short(first_prompt or "Sin título", 60),
            "cwd": cwd,
            "preview": _short(last_text or "", 140),
        }

    def recent(self, limit=RECENT_LIMIT):
        live = set(_claude_processes())
        out = []
        for path in self._session_files():
            meta = self._read_meta(path)
            if not meta["cwd"]:
                continue
            session_id = os.path.basename(path)[:-6]
            out.append({
                "id": session_id,
                "title": meta["title"],
                "project": _pretty_path(meta["cwd"]),
                "preview": meta["preview"],
                "updated": int(os.path.getmtime(path)),
                "running": meta["cwd"] in live,
                "busy": self._busy(session_id),
            })
            if len(out) >= limit:
                break
        return out

    def transcript(self, session_id, limit=TRANSCRIPT_LIMIT):
        path = self._file_for(session_id)
        if not path:
            return None
        messages = []
        with open(path, errors="replace") as f:
            for line in f:
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                if o.get("isSidechain") or o.get("type") not in ("user", "assistant"):
                    continue
                msg = o.get("message") or {}
                if o["type"] == "user":
                    text = _message_text(msg, user=True)
                    if text:
                        messages.append({"role": "user", "text": _short(text)})
                else:
                    for block in msg.get("content") or []:
                        if block.get("type") == "text" and block.get("text", "").strip():
                            messages.append({"role": "assistant", "text": _short(block["text"])})
                        elif block.get("type") == "tool_use":
                            messages.append({"role": "tool", "text": _tool_summary(block)})
        return messages[-limit:]

    # ── ejecutar órdenes ──
    def _busy(self, session_id):
        with self.lock:
            return any(j["session"] == session_id and not j["done"] for j in self.jobs.values())

    def run(self, session_id, prompt, mode):
        path = self._file_for(session_id)
        if not path:
            raise ValueError("Sesión no encontrada")
        if mode not in PERMISSION_MODES:
            mode = "acceptEdits"
        if self._busy(session_id):
            raise ValueError("Claude ya está trabajando en esta sesión")
        cwd = self._read_meta(path)["cwd"]
        if not cwd or not os.path.isdir(cwd):
            raise ValueError("La carpeta del proyecto ya no existe")

        job_id = secrets.token_urlsafe(9)
        job = {"session": session_id, "events": [], "done": False, "proc": None, "started": time.time()}
        with self.lock:
            self.jobs[job_id] = job
            # Limpiar trabajos viejos
            for jid in [k for k, v in self.jobs.items() if v["done"] and time.time() - v["started"] > 3600]:
                del self.jobs[jid]

        cmd = [self.binary, "-p", prompt, "--resume", session_id,
               "--output-format", "stream-json", "--verbose", "--permission-mode", mode]
        proc = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                stdin=subprocess.DEVNULL, text=True, bufsize=1)
        job["proc"] = proc
        threading.Thread(target=self._pump, args=(job, proc), daemon=True).start()
        return job_id

    def _emit(self, job, kind, text):
        with self.lock:
            job["events"].append({"i": len(job["events"]), "kind": kind, "text": _short(text)})

    def _pump(self, job, proc):
        for line in proc.stdout:
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if o.get("type") == "assistant":
                for block in (o.get("message") or {}).get("content") or []:
                    if block.get("type") == "text" and block.get("text", "").strip():
                        self._emit(job, "text", block["text"])
                    elif block.get("type") == "tool_use":
                        self._emit(job, "tool", _tool_summary(block))
            elif o.get("type") == "result":
                if o.get("is_error"):
                    self._emit(job, "error", o.get("result") or "Error")
                cost = o.get("total_cost_usd")
                secs = (o.get("duration_ms") or 0) / 1000
                self._emit(job, "done", f"Listo en {secs:.0f} s" + (f" · US$ {cost:.3f}" if cost else ""))
        code = proc.wait()
        err = proc.stderr.read().strip()
        if code != 0 and not any(e["kind"] in ("done", "error") for e in job["events"]):
            self._emit(job, "error", err or f"Claude terminó con código {code}")
        with self.lock:
            job["done"] = True

    def job(self, job_id, since=0):
        with self.lock:
            j = self.jobs.get(job_id)
            if not j:
                return None
            return {"done": j["done"], "events": [e for e in j["events"] if e["i"] >= since]}

    def cancel(self, job_id):
        j = self.jobs.get(job_id)
        if j and j["proc"] and not j["done"]:
            j["proc"].terminate()
            self._emit(j, "error", "Cancelado desde el teléfono")


def _message_text(message, user=False):
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        text = "\n".join(b.get("text", "") for b in content if b.get("type") == "text")
    else:
        text = ""
    text = text.strip()
    # Mensajes internos que Claude Code guarda como "user" (comandos, recordatorios)
    if user and (text.startswith("<") or text.startswith("Caveat:")):
        return ""
    return text


def _tool_summary(block):
    name = block.get("name", "herramienta")
    args = block.get("input") or {}
    detail = (args.get("file_path") or args.get("path") or args.get("command") or args.get("pattern")
              or args.get("description") or args.get("url") or "")
    if isinstance(detail, str) and detail.startswith(HOME):
        detail = "~" + detail[len(HOME):]
    return f"{name} · {_short(str(detail), 90)}" if detail else name


# ─────────────────────────── Antigravity ───────────────────────────

class AntigravityAgent:
    SERVICE = "exa.language_server_pb.LanguageServerService"

    def __init__(self):
        self._ssl = ssl.create_default_context()
        self._ssl.check_hostname = False
        self._ssl.verify_mode = ssl.CERT_NONE   # servidor local de la propia app (127.0.0.1)

    def _server(self):
        """Puerto y token del language server de Antigravity, leídos de su línea de comandos."""
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            try:
                with open(f"/proc/{pid}/cmdline", "rb") as f:
                    args = f.read().decode(errors="replace").split("\0")
            except OSError:
                continue
            if not args or not args[0].endswith("language_server") or "--csrf_token" not in args:
                continue
            try:
                port = int(args[args.index("--https_server_port") + 1])
                csrf = args[args.index("--csrf_token") + 1]
            except (ValueError, IndexError):
                continue
            return port, csrf
        return None

    @property
    def running(self):
        return self._server() is not None

    def _rpc(self, method, body):
        server = self._server()
        if not server:
            raise ValueError("Antigravity no está abierto")
        port, csrf = server
        req = urllib.request.Request(
            f"https://127.0.0.1:{port}/{self.SERVICE}/{method}",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "Connect-Protocol-Version": "1",
                     "x-codeium-csrf-token": csrf},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, context=self._ssl, timeout=15) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            try:
                detail = json.loads(detail).get("message", detail)
            except ValueError:
                pass
            raise ValueError(f"Antigravity respondió {e.code}: {_short(detail, 200)}") from None

    def recent(self, limit=RECENT_LIMIT):
        data = self._rpc("GetAllCascadeTrajectories", {})
        summaries = data.get("trajectorySummaries") or {}
        items = summaries.items() if isinstance(summaries, dict) else ((s.get("trajectoryId"), s) for s in summaries)
        out = []
        for cid, s in items:
            workspaces = s.get("workspaces") or []
            ws = ""
            if workspaces:
                uri = (workspaces[0].get("workspaceFolderAbsoluteUri") or workspaces[0].get("uri") or "")
                ws = _pretty_path(uri.replace("file://", ""))
            out.append({
                "id": cid,
                "title": _short(s.get("summary") or "Conversación", 60),
                "project": ws,
                "status": (s.get("status") or "").replace("CASCADE_RUN_STATUS_", "").lower(),
                "updated": s.get("lastModifiedTime") or "",
                "running": True,
                "busy": "RUNNING" in (s.get("status") or ""),
                "preview": "",
            })
        out.sort(key=lambda x: x["updated"], reverse=True)
        return out[:limit]

    def transcript(self, cascade_id, limit=TRANSCRIPT_LIMIT):
        data = self._rpc("GetCascadeTrajectorySteps", {"cascadeId": cascade_id})
        messages = []
        for step in data.get("steps") or []:
            user = step.get("userInput")
            planner = step.get("plannerResponse")
            notify = step.get("notifyUser")
            if user:
                text = " ".join(i.get("text", "") for i in user.get("items") or []) or user.get("userResponse", "")
                if text.strip():
                    messages.append({"role": "user", "text": _short(text)})
            elif planner:
                text = planner.get("modifiedResponse") or planner.get("response") or ""
                if text.strip():
                    messages.append({"role": "assistant", "text": _short(text)})
                for call in planner.get("toolCalls") or []:
                    messages.append({"role": "tool", "text": call.get("name", "herramienta")})
            elif notify and notify.get("notificationContent"):
                messages.append({"role": "assistant", "text": _short(notify["notificationContent"])})
        return messages[-limit:]

    def send(self, cascade_id, text):
        self._rpc("SendUserCascadeMessage", {"cascadeId": cascade_id, "items": [{"text": text}]})

    def cancel(self, cascade_id):
        self._rpc("CancelCascadeInvocation", {"cascadeId": cascade_id})
