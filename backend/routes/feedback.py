"""Clinical feedback capture.

Everything is filed under a case (a random per-session study ID generated at
session start — see infer.session_start — never a patient name or MRN), so
review always happens per-procedure, not as one giant flat pool.

Two ways a frame gets captured:
  - auto     — the frontend calls this automatically (throttled) whenever the
               live model detects something, so a nurse can review it later
               without interrupting the procedure. Starts life as "pending".
  - dr_found — a nurse manually flags a polyp the doctor pointed out that the
               model did NOT detect (nothing to auto-capture from). Goes
               straight in as its own status, still shows the model's output
               for that same frame so review can catch "actually the model
               did agree, so it's not really a miss" cases.

A pending auto-capture is reviewed once, by a human, into one of:
  - confirmed        — yes, that's a real polyp (model was right)
  - false_positive    — no, that's not a polyp (model was wrong)
Review also records whether the doctor had already noticed it or the model
caught it first — together with the two statuses above this covers "both
agreed" and "AI caught what Dr missed" without a separate category each.

Every capture stores the plain camera frame only — never the AI overlay
burned in — plus a short rolling video clip around that moment when the
frontend has one available. The model's own detections for that exact frame
are kept separately as metadata (`ai_detections`), and a user-drawn/adjusted
box is kept separately too (`bbox_*`).

Storage: backend/data/feedback/cases/{case_id}/images/*.{jpg,webm} + a
single manifest.csv (with a case_id column, so a "review everything" view
can aggregate across cases). Not committed to git (`data/` is gitignored).
"""

import csv
import json
import logging
import re
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from backend.services import modal_client

log = logging.getLogger("feedback")

router = APIRouter()

DATA_DIR = Path(__file__).resolve().parents[2] / "backend" / "data" / "feedback"
CASES_DIR = DATA_DIR / "cases"
MANIFEST_PATH = DATA_DIR / "manifest.csv"
MANIFEST_FIELDS = [
    "case_id", "filename", "has_video", "timestamp", "source", "status", "noticed_first",
    "bbox_x1", "bbox_y1", "bbox_x2", "bbox_y2", "ai_detections",
]
STATUSES = {"pending", "confirmed", "false_positive", "dr_found"}
NOTICED_FIRST = {"dr", "ai", ""}
_SAFE_ID = re.compile(r"^[a-zA-Z0-9_-]+$")


def _check_id(value: str, label: str) -> None:
    if not value or not _SAFE_ID.match(value):
        raise HTTPException(status_code=400, detail=f"invalid {label}")


def _case_dir(case_id: str) -> Path:
    _check_id(case_id, "case_id")
    d = CASES_DIR / case_id / "images"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _read_manifest() -> list[dict]:
    if not MANIFEST_PATH.exists():
        return []
    with MANIFEST_PATH.open("r", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _write_manifest(rows: list[dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with MANIFEST_PATH.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=MANIFEST_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def _save_capture(case_id: str, image: bytes, video: Optional[bytes]) -> tuple[str, int, bool]:
    images_dir = _case_dir(case_id)
    ts = int(time.time())
    base = f"{ts}_{uuid.uuid4().hex[:8]}"
    (images_dir / f"{base}.jpg").write_bytes(image)
    has_video = False
    if video:
        (images_dir / f"{base}.webm").write_bytes(video)
        has_video = True
    return f"{base}.jpg", ts, has_video


@router.post("/feedback/check-frame")
async def check_frame(file: UploadFile = File(...)):
    """One-off inference on a single frame — used by the manual dr-found
    capture flow to show what the model currently thinks of that exact
    frame, without needing the continuous WebSocket loop for it."""
    content = await file.read()
    try:
        detections, _timing = await modal_client.infer_frame(content)
        return {"detections": detections}
    except Exception as e:
        return {"detections": [], "error": str(e)[:200]}


@router.post("/feedback/{case_id}/auto-capture")
async def auto_capture(
    case_id: str,
    file: UploadFile = File(...),
    ai_detections: str = Form(...),
    video: Optional[UploadFile] = File(default=None),
):
    """Called automatically (client-side throttled) whenever the live model
    detects something. Lands as "pending" for a nurse to triage later."""
    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="empty image")
    video_bytes = await video.read() if video else None
    filename, ts, has_video = _save_capture(case_id, image_bytes, video_bytes)

    rows = _read_manifest()
    rows.append({
        "case_id": case_id, "filename": filename, "has_video": has_video,
        "timestamp": ts, "source": "auto", "status": "pending", "noticed_first": "",
        "bbox_x1": "", "bbox_y1": "", "bbox_x2": "", "bbox_y2": "",
        "ai_detections": ai_detections,
    })
    _write_manifest(rows)
    return {"filename": filename}


@router.post("/feedback/{case_id}/dr-found/capture")
async def dr_found_capture(
    case_id: str,
    file: UploadFile = File(...),
    bbox: Optional[str] = Form(default=None),
    ai_detections: Optional[str] = Form(default=None),
    video: Optional[UploadFile] = File(default=None),
):
    """Manual capture — a doctor pointed out a polyp the model didn't flag."""
    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="empty image")
    video_bytes = await video.read() if video else None
    filename, ts, has_video = _save_capture(case_id, image_bytes, video_bytes)

    x1 = y1 = x2 = y2 = ""
    if bbox:
        try:
            coords = json.loads(bbox)
            if len(coords) == 4:
                x1, y1, x2, y2 = coords
        except (ValueError, TypeError):
            log.warning("dr_found_capture: could not parse bbox %r", bbox)

    rows = _read_manifest()
    rows.append({
        "case_id": case_id, "filename": filename, "has_video": has_video,
        "timestamp": ts, "source": "manual", "status": "dr_found", "noticed_first": "dr",
        "bbox_x1": x1, "bbox_y1": y1, "bbox_x2": x2, "bbox_y2": y2,
        "ai_detections": ai_detections or "",
    })
    _write_manifest(rows)
    return {"filename": filename}


@router.get("/feedback/queue")
async def get_queue(case_id: Optional[str] = None):
    """Pending auto-captures awaiting review, oldest first. Pass case_id to
    scope to one procedure, or omit for "Feedback mode" browsing across all."""
    rows = [r for r in _read_manifest() if r["status"] == "pending"]
    if case_id:
        _check_id(case_id, "case_id")
        rows = [r for r in rows if r["case_id"] == case_id]
    rows.sort(key=lambda r: int(r.get("timestamp", 0)))
    return rows


@router.post("/feedback/{case_id}/{filename}/review")
async def review_capture(
    case_id: str,
    filename: str,
    correct: bool = Form(...),
    noticed_first: str = Form(...),
    bbox: Optional[str] = Form(default=None),
):
    """Nurse reviews a pending auto-capture: confirms it's a real polyp
    (optionally adjusting the box) or marks it a false positive, and records
    whether the doctor had already noticed it or the model caught it first."""
    _check_id(case_id, "case_id")
    _check_id(filename.split(".")[0], "filename")
    if noticed_first not in NOTICED_FIRST:
        raise HTTPException(status_code=400, detail="noticed_first must be 'dr' or 'ai'")
    rows = _read_manifest()
    for r in rows:
        if r["case_id"] == case_id and r["filename"] == filename:
            r["status"] = "confirmed" if correct else "false_positive"
            r["noticed_first"] = noticed_first
            if bbox:
                try:
                    x1, y1, x2, y2 = json.loads(bbox)
                    r["bbox_x1"], r["bbox_y1"], r["bbox_x2"], r["bbox_y2"] = x1, y1, x2, y2
                except (ValueError, TypeError):
                    raise HTTPException(status_code=400, detail="invalid bbox")
            _write_manifest(rows)
            return {"filename": filename, "status": r["status"]}
    raise HTTPException(status_code=404, detail="not found")


@router.get("/feedback/list")
async def list_captures(status: Optional[str] = None, case_id: Optional[str] = None):
    """Reviewed/submitted history — optionally filtered by status
    (confirmed | false_positive | dr_found) and/or case. Newest first.
    This is what "Feedback mode" browses when no case is selected."""
    rows = _read_manifest()
    if status:
        if status not in STATUSES:
            raise HTTPException(status_code=400, detail=f"unknown status '{status}'")
        rows = [r for r in rows if r["status"] == status]
    else:
        rows = [r for r in rows if r["status"] != "pending"]
    if case_id:
        _check_id(case_id, "case_id")
        rows = [r for r in rows if r["case_id"] == case_id]
    rows.sort(key=lambda r: int(r.get("timestamp", 0)), reverse=True)
    return rows


@router.get("/feedback/{case_id}/image/{filename}")
async def get_image(case_id: str, filename: str):
    images_dir = _case_dir(case_id)
    _check_id(filename.split(".")[0], "filename")
    path = images_dir / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(path, media_type="image/jpeg")


@router.get("/feedback/{case_id}/video/{filename}")
async def get_video(case_id: str, filename: str):
    images_dir = _case_dir(case_id)
    base = filename.rsplit(".", 1)[0]
    _check_id(base, "filename")
    path = images_dir / f"{base}.webm"
    if not path.exists():
        raise HTTPException(status_code=404, detail="no video for this capture")
    return FileResponse(path, media_type="video/webm")


@router.delete("/feedback/{case_id}/{filename}")
async def delete_capture(case_id: str, filename: str):
    _check_id(case_id, "case_id")
    base = filename.rsplit(".", 1)[0]
    _check_id(base, "filename")
    rows = _read_manifest()
    new_rows = [r for r in rows if not (r["case_id"] == case_id and r["filename"] == filename)]
    if len(new_rows) == len(rows):
        raise HTTPException(status_code=404, detail="not found")
    _write_manifest(new_rows)
    images_dir = CASES_DIR / case_id / "images"
    (images_dir / filename).unlink(missing_ok=True)
    (images_dir / f"{base}.webm").unlink(missing_ok=True)
    return {"deleted": filename}


@router.patch("/feedback/{case_id}/{filename}")
async def update_capture(case_id: str, filename: str, bbox: Optional[str] = Form(default=None)):
    """Edit (or clear) a reviewed capture's bounding box after the fact."""
    _check_id(case_id, "case_id")
    rows = _read_manifest()
    for r in rows:
        if r["case_id"] == case_id and r["filename"] == filename:
            if bbox:
                try:
                    x1, y1, x2, y2 = json.loads(bbox)
                    r["bbox_x1"], r["bbox_y1"], r["bbox_x2"], r["bbox_y2"] = x1, y1, x2, y2
                except (ValueError, TypeError):
                    raise HTTPException(status_code=400, detail="invalid bbox")
            else:
                r["bbox_x1"] = r["bbox_y1"] = r["bbox_x2"] = r["bbox_y2"] = ""
            _write_manifest(rows)
            return {"updated": filename}
    raise HTTPException(status_code=404, detail="not found")
