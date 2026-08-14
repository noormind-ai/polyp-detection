"""Recording a whole live session to disk, and playing it back.

Distinct from feedback capture (backend/routes/feedback.py), which files short
moments — a still plus a few seconds of rolling clip — around a detection. This
records the entire procedure, start to stop, on demand.

What is recorded
----------------
The RAW capture stream, with no AI overlay burned in. Same rule the feedback
captures follow, and for the same reason: the overlay is a rendering of the
model's output at one moment, and baking it into the archive would make the
recording unusable as ground truth later. The model's detections for the
moments that mattered are already stored, separately, by feedback capture.

Why chunked upload instead of one POST at the end
-------------------------------------------------
A colonoscopy runs tens of minutes. Buffering all of that in the browser and
sending it once at the end means (a) hundreds of MB held in tab memory, and
(b) a crashed tab, closed laptop, or dropped connection loses the entire
procedure. So MediaRecorder is started with a timeslice and each slice is
appended to the file as it arrives: whatever reached the server is playable
even if the session ends badly.

Chunks MUST land in order — a WebM stream is only valid if its clusters are
concatenated in the order they were produced. The client uploads strictly
sequentially, and `seq` is checked against what the file already holds, so a
retry or an out-of-order request is rejected (409) rather than silently
corrupting a recording nobody will notice is broken until playback.

Metadata is a JSON sidecar per recording, NOT a shared manifest like
feedback's manifest.csv. That manifest is rewritten whole on every write, which
is fine at feedback's once-in-a-while rate; recordings write on start and stop
and would race two concurrent sessions into a lost row.

Access
------
Everything here requires a signed-in user. Live camera and screen share
themselves are deliberately open (see backend/auth.py), but a recording is
patient video written to this server's disk and served back — so both making
one and watching one need an account. Any signed-in user can see any recording;
there is no per-user ownership, because reviewing each other's procedures is
the point.

Storage: backend/data/recordings/{case_id}/{recording_id}.{webm,json}, under
the gitignored `data/` tree.
"""

import json
import logging
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, Form, HTTPException, Query, Request
from fastapi.responses import FileResponse

from backend.routes.auth import require_user

log = logging.getLogger("recordings")

router = APIRouter()

DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "recordings"

# A recording is capped so one forgotten "stop" cannot fill the disk. At the
# ~2.5 Mbps the frontend asks MediaRecorder for, the default works out to
# roughly three hours — longer than any procedure, short enough to survive.
MAX_RECORDING_MB = 3072
# Refuse to START a recording with less than this free. Chunks are still
# accepted for an in-flight one; cutting a procedure off mid-way to protect
# headroom would lose the part that matters most.
MIN_FREE_DISK_MB = 2048
# No chunk from a browser is anywhere near this. It exists so a malformed or
# hostile request can't stream unbounded bytes into a file.
MAX_CHUNK_MB = 32
# A recording still marked "recording" whose last chunk is older than this had
# its browser die on it. Reported as interrupted rather than in-progress.
STALE_AFTER_S = 120

ALLOWED_MIME_PREFIXES = ("video/webm", "video/mp4", "video/x-matroska")
SOURCES = {"camera", "screen"}

_SAFE_ID = re.compile(r"^[a-zA-Z0-9_-]+$")


def _check_id(value: str, label: str) -> None:
    if not value or len(value) > 64 or not _SAFE_ID.match(value):
        raise HTTPException(status_code=400, detail=f"invalid {label}")


def _case_dir(case_id: str) -> Path:
    _check_id(case_id, "case_id")
    return DATA_DIR / case_id


def _meta_path(case_id: str, recording_id: str) -> Path:
    _check_id(recording_id, "recording_id")
    return _case_dir(case_id) / f"{recording_id}.json"


def _read_meta(case_id: str, recording_id: str) -> dict:
    path = _meta_path(case_id, recording_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="no such recording")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise HTTPException(status_code=500, detail="recording metadata unreadable")


def _write_meta(meta: dict) -> None:
    path = _meta_path(meta["case_id"], meta["id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write-then-replace: a crash mid-write leaves the previous metadata intact
    # rather than a truncated file that makes the recording unlistable.
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(meta, indent=1), encoding="utf-8")
    tmp.replace(path)


def _video_path(meta: dict) -> Path:
    return _case_dir(meta["case_id"]) / f"{meta['id']}{meta['ext']}"


def _ext_for(mime: str) -> str:
    if mime.startswith("video/mp4"):
        return ".mp4"
    if mime.startswith("video/x-matroska"):
        return ".mkv"
    return ".webm"


def _decorate(meta: dict) -> dict:
    """Fill in what a client needs but isn't worth storing: the on-disk size as
    it stands right now, and whether an unfinished recording is still being
    written to or was abandoned by a browser that never came back."""
    out = dict(meta)
    path = _video_path(meta)
    out["bytes"] = path.stat().st_size if path.exists() else 0
    if meta.get("status") == "recording" and time.time() - meta.get("updated_at", 0) > STALE_AFTER_S:
        out["status"] = "interrupted"
    return out


@router.post("/recordings/{case_id}/start")
async def start_recording(
    case_id: str,
    source: str = Form(default="camera"),
    mime: str = Form(default="video/webm"),
    width: int = Form(default=0),
    height: int = Form(default=0),
    user: str = Depends(require_user),
):
    """Open a recording and return its id. The client then streams chunks to
    /chunk in order and calls /stop when the operator stops it."""
    _check_id(case_id, "case_id")
    if source not in SOURCES:
        raise HTTPException(status_code=400, detail=f"source must be one of {sorted(SOURCES)}")
    if not mime.startswith(ALLOWED_MIME_PREFIXES):
        raise HTTPException(status_code=400, detail=f"unsupported recording type '{mime}'")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    free_mb = shutil.disk_usage(DATA_DIR).free / (1024 * 1024)
    if free_mb < MIN_FREE_DISK_MB:
        raise HTTPException(
            status_code=507,
            detail="فضای دیسک سرور برای ضبط کافی نیست. Not enough free disk space on the server to record.",
        )

    now = int(time.time())
    meta = {
        "id": uuid.uuid4().hex[:12],
        "case_id": case_id,
        "user": user,
        "source": source,
        "mime": mime,
        "ext": _ext_for(mime),
        "width": width,
        "height": height,
        "started_at": now,
        "updated_at": now,
        "ended_at": None,
        "duration_ms": 0,
        "chunks": 0,
        "status": "recording",
    }
    _write_meta(meta)
    # Create the file up front so a recording that receives no chunk at all is
    # still a (zero-byte) recording rather than a metadata row pointing at nothing.
    _video_path(meta).touch()
    log.info("recording %s started by %s (case %s, %s)", meta["id"], user, case_id, source)
    return {"recording_id": meta["id"], "max_mb": MAX_RECORDING_MB}


@router.put("/recordings/{case_id}/{recording_id}/chunk")
async def append_chunk(
    case_id: str,
    recording_id: str,
    request: Request,
    seq: int = Query(...),
    user: str = Depends(require_user),
):
    """Append one MediaRecorder slice. `seq` is the 0-based index of this chunk
    in the stream; it must equal the number of chunks already stored, so a
    duplicate or out-of-order upload is refused instead of corrupting the file."""
    meta = _read_meta(case_id, recording_id)
    if meta["status"] not in ("recording",):
        raise HTTPException(status_code=409, detail="recording already stopped")
    if seq != meta["chunks"]:
        # 409, not 400: the client can resolve this (it knows which chunk the
        # server wants) whereas a 400 reads as "never retry this".
        raise HTTPException(
            status_code=409,
            detail=f"expected chunk {meta['chunks']}, got {seq}",
        )

    path = _video_path(meta)
    written = path.stat().st_size if path.exists() else 0
    limit = MAX_RECORDING_MB * 1024 * 1024
    if written >= limit:
        meta["status"] = "truncated"
        meta["ended_at"] = int(time.time())
        _write_meta(meta)
        raise HTTPException(status_code=413, detail="recording hit its size limit and was closed")

    # Stream to disk rather than reading the whole body: chunks are small, but
    # this keeps a hostile Content-Length from being believed.
    chunk_limit = MAX_CHUNK_MB * 1024 * 1024
    size = 0
    with path.open("ab") as f:
        async for block in request.stream():
            size += len(block)
            if size > chunk_limit:
                raise HTTPException(status_code=413, detail="chunk too large")
            f.write(block)

    meta["chunks"] = seq + 1
    meta["updated_at"] = int(time.time())
    if written + size >= limit:
        meta["status"] = "truncated"
        meta["ended_at"] = meta["updated_at"]
        log.warning("recording %s hit the %d MB cap and was closed", recording_id, MAX_RECORDING_MB)
    _write_meta(meta)
    return {"chunks": meta["chunks"], "bytes": written + size, "status": meta["status"]}


@router.post("/recordings/{case_id}/{recording_id}/stop")
async def stop_recording(
    case_id: str,
    recording_id: str,
    duration_ms: int = Form(default=0),
    user: str = Depends(require_user),
):
    """Close the recording. `duration_ms` is measured by the client, because a
    WebM written in streaming mode carries no duration in its header — without
    this the player would show an unknown length. Idempotent: stopping an
    already-stopped recording is not an error, so a retry after a flaky
    response can't strand it in "recording" forever."""
    meta = _read_meta(case_id, recording_id)
    if meta["status"] == "recording":
        meta["status"] = "complete"
        meta["ended_at"] = int(time.time())
        meta["updated_at"] = meta["ended_at"]
    # A later, longer measurement wins — a duplicate stop from a retry must not
    # shorten a duration that was already recorded correctly.
    meta["duration_ms"] = max(int(meta.get("duration_ms") or 0), max(duration_ms, 0))
    _write_meta(meta)
    log.info("recording %s stopped by %s (%d chunks, %s)",
             recording_id, user, meta["chunks"], meta["status"])
    return _decorate(meta)


@router.get("/recordings")
async def list_recordings(
    case_id: Optional[str] = None,
    user: str = Depends(require_user),
):
    """Every recording on this server, newest first. Pass case_id to scope it
    to one procedure — that's what the panel inside the live player uses."""
    if case_id:
        _check_id(case_id, "case_id")
        dirs = [_case_dir(case_id)]
    else:
        dirs = sorted(p for p in DATA_DIR.glob("*") if p.is_dir()) if DATA_DIR.exists() else []

    out = []
    for d in dirs:
        for meta_file in d.glob("*.json"):
            try:
                out.append(_decorate(json.loads(meta_file.read_text(encoding="utf-8"))))
            except (OSError, ValueError, KeyError):
                log.warning("skipping unreadable recording metadata %s", meta_file)
    out.sort(key=lambda m: m.get("started_at", 0), reverse=True)
    return out


@router.get("/recordings/{case_id}/{recording_id}/video")
async def get_recording(
    case_id: str,
    recording_id: str,
    user: str = Depends(require_user),
):
    """The video itself. FileResponse answers Range requests, which is what
    makes scrubbing work instead of forcing a full download before playback."""
    meta = _read_meta(case_id, recording_id)
    path = _video_path(meta)
    if not path.exists() or path.stat().st_size == 0:
        raise HTTPException(status_code=404, detail="recording has no video data")
    return FileResponse(
        path,
        media_type=meta.get("mime", "video/webm").split(";")[0],
        filename=f"{meta['case_id']}-{meta['id']}{meta['ext']}",
        content_disposition_type="inline",
    )


@router.delete("/recordings/{case_id}/{recording_id}")
async def delete_recording(
    case_id: str,
    recording_id: str,
    user: str = Depends(require_user),
):
    meta = _read_meta(case_id, recording_id)
    _video_path(meta).unlink(missing_ok=True)
    _meta_path(case_id, recording_id).unlink(missing_ok=True)
    log.info("recording %s deleted by %s", recording_id, user)
    return {"deleted": recording_id}
