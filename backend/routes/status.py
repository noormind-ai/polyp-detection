"""/status — one place that says which component is broken, and why.

GET /api/status       one row per component: ok / warn / fail / off, a one-line
                      summary, and a detail dict. Each check runs in isolation
                      with its own timeout, so one hung or crashing check shows
                      up as its own red row instead of taking the page down.
GET /api/status/logs  the app's own log (logs/backend.log), parsed into
                      entries (time, level, component, message, traceback) and
                      filterable by level / component / text / time window.

States, per component (a row on the page, not the whole system):
    ok    working as expected
    warn  working, but something needs a look (disk filling, recent errors)
    fail  broken — this is probably the component causing the problem
    off   not configured on this deployment (e.g. no TURN secret) — not an error

Read-only: nothing here changes state. Behind require_user like the rest of
the app — log lines carry usernames and case ids.
"""

import asyncio
import os
import re
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, Query

from backend.routes.auth import require_user

router = APIRouter()

REPO_ROOT = Path(__file__).resolve().parents[2]
# main.py's file handler writes here. Relative to the process cwd on purpose —
# that is where main.py has always written it (the repo root under systemd).
LOG_FILE = Path(os.getenv("POLYP_LOG_FILE", "logs/backend.log"))
FRONTEND_URL = os.getenv("POLYP_FRONTEND_URL", "http://127.0.0.1:19001/")
SERVICES = ("polyp-frontend", "coturn", "nginx")
STARTED_AT = time.time()

# Only the tail is read: the file rotates at 5 MB, and the page asks about the
# last hour, not the last week.
TAIL_BYTES = 3 * 1024 * 1024
CHECK_TIMEOUT_S = 6.0

DISK_WARN_GB = 10
DISK_FAIL_GB = 3

LEVELS = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40, "CRITICAL": 50}

# "2026-11-24 08:34:26,500 INFO    infer — frame 2 | ..."
_LINE = re.compile(
    r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),\d+ (DEBUG|INFO|WARNING|ERROR|CRITICAL)\s+(\S+) — ?(.*)$"
)
_INFER_MS = re.compile(r"\binfer=(\d+)ms")


# ---------------------------------------------------------------------------
# pure helpers (unit-tested in backend/tests/test_status.py)
# ---------------------------------------------------------------------------
def parse_log_lines(lines: list[str]) -> list[dict]:
    """Log text -> entries. Lines that don't start a new entry (a traceback,
    a multi-line message) are attached to the entry above them as `extra`."""
    entries: list[dict] = []
    for raw in lines:
        line = raw.rstrip("\n")
        m = _LINE.match(line)
        if m:
            entries.append({
                "time": m.group(1),
                "level": m.group(2),
                "component": m.group(3),
                "message": m.group(4),
                "extra": "",
            })
        elif entries and line.strip():
            e = entries[-1]
            e["extra"] = (e["extra"] + "\n" + line) if e["extra"] else line
    return entries


def entry_time(entry: dict) -> datetime:
    return datetime.strptime(entry["time"], "%Y-%m-%d %H:%M:%S")


def filter_entries(entries: list[dict], *, since: datetime | None = None,
                   min_level: str = "DEBUG", component: str | None = None,
                   query: str | None = None) -> list[dict]:
    floor = LEVELS.get(min_level.upper(), 0)
    q = (query or "").lower()
    out = []
    for e in entries:
        if LEVELS[e["level"]] < floor:
            continue
        if component and e["component"] != component:
            continue
        if since and entry_time(e) < since:
            continue
        if q and q not in (e["message"] + " " + e["extra"]).lower():
            continue
        out.append(e)
    return out


def summarize_problems(entries: list[dict], now: datetime,
                       window: timedelta = timedelta(hours=1)) -> dict:
    """Errors and warnings in the window, counted per component — the answer
    to "which part is complaining?". `state` is fail if any ERROR is from the
    last 10 minutes (it's happening now), warn if older or warnings only."""
    recent = filter_entries(entries, since=now - window, min_level="WARNING")
    errors = Counter(e["component"] for e in recent if LEVELS[e["level"]] >= 40)
    warnings = Counter(e["component"] for e in recent if e["level"] == "WARNING")
    fresh_error = any(LEVELS[e["level"]] >= 40 and entry_time(e) >= now - timedelta(minutes=10)
                      for e in recent)
    if fresh_error:
        state = "fail"
    elif errors or warnings:
        state = "warn"
    else:
        state = "ok"
    return {
        "state": state,
        "errors": dict(errors.most_common()),
        "warnings": dict(warnings.most_common()),
        "last": recent[-1] if recent else None,
    }


def classify_disk(free_gb: float) -> str:
    if free_gb < DISK_FAIL_GB:
        return "fail"
    if free_gb < DISK_WARN_GB:
        return "warn"
    return "ok"


def ago(seconds: float) -> str:
    seconds = max(0, int(seconds))
    if seconds < 60:
        return f"{seconds}s ago"
    if seconds < 3600:
        return f"{seconds // 60} min ago"
    if seconds < 86400:
        return f"{seconds // 3600}h {seconds % 3600 // 60}m ago"
    return f"{seconds // 86400}d ago"


def _row(state: str, summary: str, **detail) -> dict:
    return {"state": state, "summary": summary, "detail": detail}


# ---------------------------------------------------------------------------
# log reading
# ---------------------------------------------------------------------------
def read_log_entries(path: Path = None) -> list[dict]:
    path = path or LOG_FILE
    if not path.exists():
        return []
    with open(path, "rb") as fh:
        size = fh.seek(0, os.SEEK_END)
        fh.seek(max(0, size - TAIL_BYTES))
        data = fh.read().decode("utf-8", errors="replace")
    lines = data.splitlines()
    if size > TAIL_BYTES and lines:
        lines = lines[1:]  # first line is probably cut in half
    return parse_log_lines(lines)


# ---------------------------------------------------------------------------
# component checks — each returns a _row(); exceptions are caught by the caller
# ---------------------------------------------------------------------------
def _run(cmd: list[str], timeout: float = 3) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def check_backend(entries: list[dict]) -> dict:
    try:
        commit = _run(["git", "-C", str(REPO_ROOT), "log", "-1", "--format=%h %s (%cr)"]).stdout.strip()
    except Exception:
        commit = "unknown"
    up = time.time() - STARTED_AT
    return _row("ok", f"running, up {ago(up).replace(' ago', '')}",
                pid=os.getpid(), deployed_commit=commit or "unknown")


def check_model(entries: list[dict]) -> dict:
    from backend.services import engine
    av = engine.availability()
    default = av["default"]
    detail = {"default_engine": default, "device": av.get("cpu"),
              "models_on_disk": [m["name"] for m in av.get("cpu_models", [])]}

    # Last inference, straight from the log: proves frames are really flowing.
    infer_ms = [int(m.group(1)) for e in entries[-400:] if e["component"] == "infer"
                for m in [_INFER_MS.search(e["message"])] if m]
    last_infer = next((e for e in reversed(entries) if e["component"] == "infer"
                       and _INFER_MS.search(e["message"])), None)
    if infer_ms:
        detail["recent_infer_ms_median"] = sorted(infer_ms)[len(infer_ms) // 2]
    if last_infer:
        detail["last_frame"] = ago((datetime.now() - entry_time(last_infer)).total_seconds())

    if engine.is_cpu(default):
        from backend.services import local_cpu
        name = default.split(":", 1)[1] if ":" in default else local_cpu.DEFAULT_MODEL
        if name not in local_cpu.MODELS:
            return _row("fail", f"default model '{name}' is not a known model", **detail)
        path = local_cpu.model_path(name)
        if not path.exists():
            return _row("fail", f"model file missing: {path.name}", **detail)
        sess = local_cpu._sessions.get(name)
        if sess is None:
            return _row("ok", f"{name}: on disk, loads on first frame", **detail)
        providers = sess.get_providers()
        detail["providers"] = providers
        if name in local_cpu.GPU_MODELS and "CUDAExecutionProvider" not in providers:
            return _row("warn", f"{name}: loaded but running on CPU, not GPU (slow)", **detail)
        where = "GPU" if "CUDAExecutionProvider" in providers else "CPU"
        extra = f", ~{detail['recent_infer_ms_median']}ms/frame" if infer_ms else ""
        return _row("ok", f"{name}: loaded on {where}{extra}", **detail)

    if default == "modal" and not av["available"]["modal"]:
        return _row("fail", "default engine is Modal, but Modal isn't available here", **detail)
    return _row("ok", f"engine: {default}", **detail)


def check_gpu(entries: list[dict]) -> dict:
    if not shutil.which("nvidia-smi"):
        return _row("off", "no NVIDIA driver on this machine")
    r = _run(["nvidia-smi", "--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu",
              "--format=csv,noheader,nounits"])
    if r.returncode != 0 or not r.stdout.strip():
        return _row("fail", "nvidia-smi failed — driver problem?", error=(r.stderr or r.stdout).strip()[:300])
    name, used, total, util, temp = [x.strip() for x in r.stdout.strip().splitlines()[0].split(",")]
    used, total, util, temp = int(used), int(total), int(util), int(temp)
    detail = dict(name=name, memory_mb=f"{used} / {total}", utilization_pct=util, temperature_c=temp)
    if temp >= 85 or used / total > 0.95:
        return _row("warn", f"{name}: hot or memory nearly full", **detail)
    return _row("ok", f"{name}, {used / 1024:.1f}/{total / 1024:.1f} GB, {util}% busy, {temp}°C", **detail)


def check_database(entries: list[dict]) -> dict:
    from backend import db
    con = db.connect()
    try:
        tables = con.execute("SELECT count(*) FROM sqlite_master WHERE type='table'").fetchone()[0]
    finally:
        con.close()
    size_mb = db.db_path().stat().st_size / 1e6
    return _row("ok", f"readable, {tables} tables, {size_mb:.1f} MB",
                path=str(db.db_path()))


def check_disk(entries: list[dict]) -> dict:
    u = shutil.disk_usage(REPO_ROOT)
    free_gb = u.free / 1e9
    return _row(classify_disk(free_gb), f"{free_gb:.0f} GB free of {u.total / 1e9:.0f} GB",
                warn_below_gb=DISK_WARN_GB, fail_below_gb=DISK_FAIL_GB)


def check_memory_cpu(entries: list[dict]) -> dict:
    detail = {}
    state = "ok"
    parts = []
    try:
        info = {}
        with open("/proc/meminfo") as fh:
            for line in fh:
                k, v = line.split(":", 1)
                info[k] = int(v.split()[0])  # kB
        avail, total = info["MemAvailable"] / 1e6, info["MemTotal"] / 1e6
        detail["ram_available_gb"] = round(avail, 1)
        parts.append(f"RAM {avail:.0f}/{total:.0f} GB free")
        if avail / total < 0.1:
            state = "warn"
    except OSError:
        pass
    if hasattr(os, "getloadavg"):
        load = os.getloadavg()[0]
        cpus = os.cpu_count() or 1
        detail["load_1min"] = round(load, 2)
        detail["cpu_cores"] = cpus
        parts.append(f"CPU load {load:.1f} on {cpus} cores")
        if load > cpus * 1.5:
            state = "warn"
    return _row(state, ", ".join(parts) or "not measurable here", **detail)


def check_services(entries: list[dict]) -> dict:
    if not shutil.which("systemctl"):
        return _row("off", "no systemd here (local dev?)")
    states = {}
    for s in SERVICES:
        states[s] = _run(["systemctl", "is-active", s]).stdout.strip() or "unknown"
    down = [s for s, st in states.items() if st != "active"]
    if down:
        return _row("fail", "not running: " + ", ".join(f"{s} ({states[s]})" for s in down), **states)
    return _row("ok", "all running: " + ", ".join(SERVICES), **states)


def check_frontend(entries: list[dict]) -> dict:
    t0 = time.time()
    try:
        with urllib.request.urlopen(FRONTEND_URL, timeout=3) as r:
            code = r.status
    except urllib.error.HTTPError as e:
        code = e.code
    except (urllib.error.URLError, OSError) as e:
        return _row("fail", "website not answering — is polyp-frontend running?",
                    url=FRONTEND_URL, error=str(getattr(e, "reason", e)))
    ms = int((time.time() - t0) * 1000)
    if code >= 500:
        return _row("fail", f"web server answered {code}", url=FRONTEND_URL, ms=ms)
    return _row("ok", f"answers in {ms} ms", url=FRONTEND_URL, http_status=code)


def check_webrtc(entries: list[dict]) -> dict:
    from backend.services import turn_credentials
    if not turn_credentials.turn_available():
        return _row("off", "TURN relay not configured (TURN_SHARED_SECRET unset)")
    host = os.environ.get("TURN_HOST_INTERNAL", "192.168.158.12")
    try:
        with socket.create_connection((host, 3478), timeout=2):
            pass
    except OSError as e:
        return _row("fail", f"TURN relay {host}:3478 unreachable", error=str(e))
    try:
        import aiortc  # noqa: F401
    except ImportError:
        return _row("fail", "aiortc not installed — WebRTC mode cannot work")
    return _row("ok", f"TURN relay {host}:3478 reachable, aiortc installed")


def check_sessions(entries: list[dict]) -> dict:
    from backend.services import spectate_bus
    rooms = spectate_bus.list_active_rooms()
    if not rooms:
        return _row("ok", "no live session right now")
    return _row("ok", f"{len(rooms)} live session(s) running",
                cases=[r.get("case_id") for r in rooms])


def check_recordings(entries: list[dict]) -> dict:
    from backend.routes import recordings
    d = recordings.DATA_DIR
    if not d.exists():
        return _row("ok", "no recordings yet")
    newest = max((p.stat().st_mtime for p in d.iterdir()), default=None)
    if newest is None:
        return _row("ok", "no recordings yet")
    return _row("ok", f"last written {ago(time.time() - newest)}", folder=str(d))


def check_errors(entries: list[dict]) -> dict:
    s = summarize_problems(entries, datetime.now())
    if s["state"] == "ok":
        return _row("ok", "no errors or warnings in the last hour")
    parts = []
    if s["errors"]:
        parts.append("errors: " + ", ".join(f"{c} ×{n}" for c, n in s["errors"].items()))
    if s["warnings"]:
        parts.append("warnings: " + ", ".join(f"{c} ×{n}" for c, n in s["warnings"].items()))
    return _row(s["state"], "; ".join(parts), errors=s["errors"], warnings=s["warnings"])


CHECKS = [
    ("backend", "Backend (API)", check_backend),
    ("errors", "Errors, last hour", check_errors),
    ("model", "AI model", check_model),
    ("gpu", "GPU", check_gpu),
    ("webrtc", "WebRTC / TURN relay", check_webrtc),
    ("frontend", "Frontend (website)", check_frontend),
    ("services", "System services", check_services),
    ("database", "Feedback database", check_database),
    ("disk", "Disk", check_disk),
    ("memory", "RAM / CPU", check_memory_cpu),
    ("sessions", "Live sessions", check_sessions),
    ("recordings", "Recordings", check_recordings),
]


async def _one(key: str, label: str, fn, entries: list[dict]) -> dict:
    t0 = time.time()
    try:
        row = await asyncio.wait_for(asyncio.to_thread(fn, entries), CHECK_TIMEOUT_S)
    except asyncio.TimeoutError:
        row = _row("fail", f"check timed out after {CHECK_TIMEOUT_S:.0f}s")
    except Exception as e:  # a crashing check is itself a finding
        row = _row("fail", f"check crashed: {type(e).__name__}: {e}"[:300])
    return {"key": key, "label": label, "ms": int((time.time() - t0) * 1000), **row}


@router.get("/status")
async def status(user: str = Depends(require_user)):
    entries = await asyncio.to_thread(read_log_entries)
    rows = await asyncio.gather(*(_one(k, lbl, fn, entries) for k, lbl, fn in CHECKS))
    worst = "ok"
    for r in rows:
        if r["state"] == "fail":
            worst = "fail"
            break
        if r["state"] == "warn":
            worst = "warn"
    return {"overall": worst, "checked_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "components": rows}


@router.get("/status/logs")
async def status_logs(user: str = Depends(require_user),
                      minutes: int = Query(60, ge=1, le=60 * 24 * 7),
                      level: str = Query("INFO"),
                      component: str | None = None,
                      q: str | None = None,
                      limit: int = Query(300, ge=1, le=2000)):
    entries = await asyncio.to_thread(read_log_entries)
    since = datetime.now() - timedelta(minutes=minutes)
    in_window = filter_entries(entries, since=since)
    components = Counter(e["component"] for e in in_window)
    hits = filter_entries(in_window, min_level=level, component=component, query=q)
    return {
        "log_file": str(LOG_FILE.resolve()),
        "components": dict(components.most_common()),
        "total": len(hits),
        "entries": list(reversed(hits[-limit:])),  # newest first
    }
