"""Capture-card diagnostics filed from clinic visits.

The 2026-10 video-quality investigation needs measurements that can only be
made on the machine the capture card is plugged into: what the card actually
delivers, whether its driver exposes proc-amp controls, what each pipeline
stage costs on that CPU, and what the link to this server can carry.  The
/clinic-test page runs those measurements in the browser and files the result
here — one directory per run — so runs from different machines (the clinic's
own computer, our PC, a laptop) can be compared side by side afterwards.

Sibling of recordings/ and feedback/ in both layout and idiom: a JSON sidecar
per report (write-then-replace), opaque server-generated ids, raw-body
streaming for blobs, and the whole router behind require_user — the raw
frames carry whatever was on the endoscope screen, burnt-in overlay included,
so this is patient-adjacent data exactly like a feedback capture.
"""

import asyncio
import json
import logging
import os
import re
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse

from backend.routes.auth import require_user

log = logging.getLogger("uvicorn.error")
router = APIRouter()

DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "diagnostics"

_SAFE_ID = re.compile(r"^[a-zA-Z0-9_-]+$")

# Set-membership checked, never sanitized — same stance as recordings.SOURCES.
MACHINE_TYPES = {"clinic-computer", "our-pc", "laptop", "other"}
# The physical plug feeding the card. The digitized signal cannot reveal this,
# so it is answered by a human looking at the cable; "unknown" is honest data.
CONNECTIONS = {"composite", "s-video", "unknown"}

MAX_REPORT_BYTES = 2 * 1024 * 1024
MAX_FRAME_BYTES = 16 * 1024 * 1024
# Nine survey frames, two overlay crops, and room for a lossless burst: a
# second of consecutive frames is the only way to study interlacing and
# motion offline, and it cannot be reconstructed from anything else.
MAX_FRAMES = 64
MAX_CLIP_MB = 512
MAX_NET_TEST_BYTES = 8 * 1024 * 1024
MAX_LABEL_LEN = 200
MAX_HWID_LEN = 300


def _check_id(value: str, label: str) -> None:
    if not value or len(value) > 64 or not _SAFE_ID.match(value):
        raise HTTPException(status_code=400, detail=f"invalid {label}")


def _report_dir(report_id: str) -> Path:
    _check_id(report_id, "report id")
    return DATA_DIR / report_id


@router.get("/diagnostics/ping")
async def ping(user: str = Depends(require_user)):
    """RTT target for the network step. Gated like everything else here so
    the router has one access rule, not two."""
    return {"t": time.time()}


@router.post("/diagnostics/net-test")
async def net_test(request: Request, user: str = Depends(require_user)):
    """Timed-upload sink. Raw body, streamed, counted, discarded: the payload
    is random bytes that exist purely to time the wire, and multipart would
    buffer and parse them, polluting the measurement with server-side work."""
    t0 = time.perf_counter()
    size = 0
    async for block in request.stream():
        size += len(block)
        if size > MAX_NET_TEST_BYTES:
            raise HTTPException(status_code=413, detail="net-test payload too large")
    return {"bytes": size, "server_ms": int((time.perf_counter() - t0) * 1000)}


@router.post("/diagnostics/reports")
async def create_report(request: Request, user: str = Depends(require_user)):
    # Body read raw first so the size cap is enforced before any parsing.
    body = await request.body()
    if len(body) > MAX_REPORT_BYTES:
        raise HTTPException(status_code=413, detail="report too large")
    try:
        report = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="report is not valid JSON")
    if not isinstance(report, dict):
        raise HTTPException(status_code=400, detail="report must be a JSON object")

    if report.get("machine_type") not in MACHINE_TYPES:
        raise HTTPException(status_code=400, detail="invalid machine_type")
    if report.get("connection", "unknown") not in CONNECTIONS:
        raise HTTPException(status_code=400, detail="invalid connection")
    label = str(report.get("label") or "").strip()
    if not label:
        raise HTTPException(status_code=400, detail="label is required")
    report["label"] = label[:MAX_LABEL_LEN]
    report["hardware_id"] = str(report.get("hardware_id") or "").strip()[:MAX_HWID_LEN]

    # Server-stamped, never trusted from the client.
    report["id"] = uuid.uuid4().hex[:12]
    report["created_at"] = int(time.time())
    report["user"] = user

    def _write() -> None:
        d = _report_dir(report["id"])
        (d / "frames").mkdir(parents=True, exist_ok=True)
        path = d / "report.json"
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(report, indent=1), encoding="utf-8")
        tmp.replace(path)

    # Off the event loop: an inline disk write here stalls the inference
    # websocket for its duration — the lesson feedback.py already learned.
    await asyncio.to_thread(_write)
    return {"id": report["id"]}


@router.put("/diagnostics/reports/{report_id}/frames/{seq}")
async def put_frame(report_id: str, seq: int, request: Request,
                    user: str = Depends(require_user)):
    """One raw PNG per request, streamed to disk (recordings-chunk pattern).
    Frames are independent files, so unlike recording chunks there is no
    ordering contract and no 409 path — any subset arriving is useful."""
    d = _report_dir(report_id)
    if not (d / "report.json").is_file():
        raise HTTPException(status_code=404, detail="no such report")
    if seq < 0 or seq >= MAX_FRAMES:
        raise HTTPException(status_code=400, detail="frame seq out of range")

    path = d / "frames" / f"{seq:02d}.png"
    tmp = path.with_suffix(".png.tmp")
    size = 0
    try:
        with tmp.open("wb") as f:
            async for block in request.stream():
                size += len(block)
                if size > MAX_FRAME_BYTES:
                    raise HTTPException(status_code=413, detail="frame too large")
                f.write(block)
        if size == 0:
            raise HTTPException(status_code=400, detail="empty frame")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)
    return {"seq": seq, "bytes": size}


@router.put("/diagnostics/reports/{report_id}/clip")
async def put_clip(report_id: str, request: Request, user: str = Depends(require_user)):
    """A short sample of the real signal, recorded at a near-transparent
    bitrate. The survey frames answer "what are the levels"; this answers
    "what does the motion look like", which no still can."""
    d = _report_dir(report_id)
    if not (d / "report.json").is_file():
        raise HTTPException(status_code=404, detail="no such report")
    path = d / "clip.webm"
    tmp = path.with_suffix(".webm.tmp")
    limit = MAX_CLIP_MB * 1024 * 1024
    size = 0
    try:
        with tmp.open("wb") as f:
            async for block in request.stream():
                size += len(block)
                if size > limit:
                    raise HTTPException(status_code=413, detail="clip too large")
                f.write(block)
        if size == 0:
            raise HTTPException(status_code=400, detail="empty clip")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)
    return {"bytes": size}


@router.get("/diagnostics/reports/{report_id}/clip")
async def get_clip(report_id: str, user: str = Depends(require_user)):
    path = _report_dir(report_id) / "clip.webm"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="no clip")
    return FileResponse(path, media_type="video/webm",
                        content_disposition_type="inline")


@router.get("/diagnostics/reports")
async def list_reports(user: str = Depends(require_user)):
    """Summary list for the comparison picker. Corrupt sidecars are skipped
    with a log line, never a 500 — one bad report must not hide the rest."""

    def _scan():
        out = []
        if not DATA_DIR.is_dir():
            return out
        for d in DATA_DIR.iterdir():
            p = d / "report.json"
            if not p.is_file():
                continue
            try:
                r = json.loads(p.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                log.warning("diagnostics: unreadable report %s", p)
                continue
            frames_dir = d / "frames"
            n_frames = sum(1 for _ in frames_dir.glob("*.png")) if frames_dir.is_dir() else 0
            out.append({
                "id": r.get("id", d.name),
                "label": r.get("label", ""),
                "machine_type": r.get("machine_type", ""),
                "connection": r.get("connection", "unknown"),
                "created_at": r.get("created_at", 0),
                "user": r.get("user", ""),
                "device_label": (r.get("device") or {}).get("label", ""),
                "frames": n_frames,
                "clip_bytes": (d / "clip.webm").stat().st_size if (d / "clip.webm").is_file() else 0,
            })
        out.sort(key=lambda m: m.get("created_at", 0), reverse=True)
        return out

    return await asyncio.to_thread(_scan)


@router.get("/diagnostics/reports/{report_id}")
async def get_report(report_id: str, user: str = Depends(require_user)):
    path = _report_dir(report_id) / "report.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="no such report")
    return FileResponse(path, media_type="application/json")


@router.get("/diagnostics/reports/{report_id}/frames/{seq}")
async def get_frame(report_id: str, seq: int, user: str = Depends(require_user)):
    if seq < 0 or seq >= MAX_FRAMES:
        raise HTTPException(status_code=400, detail="frame seq out of range")
    path = _report_dir(report_id) / "frames" / f"{seq:02d}.png"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="no such frame")
    return FileResponse(path, media_type="image/png",
                        filename=f"{report_id}-frame-{seq:02d}.png",
                        content_disposition_type="inline")
