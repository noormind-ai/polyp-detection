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

Storage: the frames stay on disk at
backend/data/feedback/cases/{case_id}/images/*.{jpg,webm}; everything known
ABOUT them lives in SQLite at backend/data/feedback/feedback.db (see
backend/db.py for the schema and for why it is no longer a CSV). Neither is
committed to git (`data/` is gitignored). backend/scripts/export_manifest.py
regenerates the old manifest.csv from the database for the offline analysis
scripts that still read it.
"""

import asyncio
import json
import logging
import re
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from backend import db
from backend.routes.auth import current_user, require_user

log = logging.getLogger("feedback")

router = APIRouter()

DATA_DIR = Path(__file__).resolve().parents[2] / "backend" / "data" / "feedback"
CASES_DIR = DATA_DIR / "cases"
MANIFEST_PATH = DATA_DIR / "manifest.csv"
MANIFEST_FIELDS = [
    "case_id", "filename", "has_video", "timestamp", "source", "status", "noticed_first",
    "bbox_x1", "bbox_y1", "bbox_x2", "bbox_y2", "ai_detections", "box_corrected",
    # Where this frame sits in the session recording, instead of shipping a copy
    # of the video with it. The clip upload cost ~250 KB per capture on a link
    # that measures ~100 KB/s; a recording id and an offset cost nothing and the
    # reviewer can seek to the exact moment in the full recording.
    "recording_id", "video_offset_ms",
    # "" until a recording covering this capture finishes and the server tries
    # cutting a short clip around video_offset_ms (see review_clips.py);
    # "ready" once it's servable, "failed" if ffmpeg couldn't produce one --
    # either way the reviewer still has the recording_id/offset text fallback.
    "review_clip_status",
    # Morphology, not a review verdict -- a flat lesion is still a confirmed
    # polyp, just noted as harder to spot/resect than the polypoid default.
    "morphology",
    # Who performed the human action on this row (dr-found capture, review
    # verdict, or frame label) -- the signed-in username, or "" when nobody
    # was signed in. Not enforced: these actions still work signed out, so
    # this is best-effort attribution, not an audit guarantee.
    "reviewed_by",
    # "first" or "best" -- which of an appearance's two auto-captures this row
    # is (see maybeAutoCapture in the players). "" on rows written before
    # 2026-10-11, when a single "best" capture per appearance was all there was,
    # and on manual doctor-found captures, which are neither.
    "capture_kind",
]
STATUSES = {"pending", "confirmed", "false_positive", "dr_found"}
NOTICED_FIRST = {"dr", "ai", ""}
MORPHOLOGY = {"", "flat"}
_SAFE_ID = re.compile(r"^[a-zA-Z0-9_-]+$")


def _check_id(value: str, label: str) -> None:
    if not value or not _SAFE_ID.match(value):
        raise HTTPException(status_code=400, detail=f"invalid {label}")


def _case_dir(case_id: str) -> Path:
    _check_id(case_id, "case_id")
    d = CASES_DIR / case_id / "images"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _images_dir(case_id: str) -> Path:
    """Where a case's frames are, WITHOUT creating anything.

    _case_dir() mkdir()s, which is right on the capture path and wrong on the
    read path: a 404 image request used to create an empty case directory as a
    side effect, which is how 242 case dirs came to exist for 200 cases that
    actually have captures.
    """
    _check_id(case_id, "case_id")
    return CASES_DIR / case_id / "images"


def _num(v) -> str:
    """A stored number as the CSV would have written it.

    Integral floats render without the ".0": the browser sends box coordinates
    as JSON integers, json.loads made them ints, and csv wrote "146". Coming
    back out of a REAL column they are 146.0, and str() would say "146.0" --
    a different string for the same number, which is exactly the kind of drift
    the baseline diff is there to catch.
    """
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _tri(v) -> str:
    """A nullable boolean as the CSV wrote it: "", "True" or "False"."""
    return "" if v is None else ("True" if v else "False")


def _row_to_api(r) -> dict:
    """Render a captures row in the exact shape the CSV-backed API emitted.

    Every value the manifest ever produced was a string, because it came out of
    csv.DictReader. The frontend's Entry interface types all of these as
    `string` and does its own parsing -- Number(timestamp), JSON.parse on
    ai_detections, truthiness checks against "" for the optional ones. Emitting
    real ints and nulls here would be tidier and would quietly break all of it.
    The storage is typed; the wire format stays bug-compatible, which is what
    lets this migration ship without touching the frontend.

    Key order matches MANIFEST_FIELDS because that is the order csv.DictReader
    yielded and therefore the order the JSON has always had.
    """
    return {
        "case_id": r["case_id"],
        "filename": r["filename"],
        "has_video": "True" if r["has_video"] else "False",
        "timestamp": str(r["timestamp"]),
        "source": r["source"],
        "status": r["status"],
        "noticed_first": r["noticed_first"],
        "bbox_x1": _num(r["bbox_x1"]),
        "bbox_y1": _num(r["bbox_y1"]),
        "bbox_x2": _num(r["bbox_x2"]),
        "bbox_y2": _num(r["bbox_y2"]),
        "ai_detections": r["ai_detections"],
        "box_corrected": _tri(r["box_corrected"]),
        "recording_id": r["recording_id"],
        "video_offset_ms": _num(r["video_offset_ms"]),
        "review_clip_status": r["review_clip_status"],
        "morphology": r["morphology"],
        "reviewed_by": r["reviewed_by"],
        "capture_kind": r["capture_kind"],
    }


# Columns that are numeric and nullable. The capture handlers pass "" for
# "not set" because that is what a form field with nothing in it sends, and ""
# is not a number.
_NULLABLE_NUM = ("bbox_x1", "bbox_y1", "bbox_x2", "bbox_y2", "video_offset_ms")


def _blank_to_none(extra: dict) -> dict:
    out = dict(extra)
    for k in _NULLABLE_NUM:
        if out.get(k) == "":
            out[k] = None
    return out


CLIPS_DIRNAME = "clips"


def _clip_path(case_id: str, filename_base: str) -> Path:
    _check_id(case_id, "case_id")
    _check_id(filename_base, "filename")
    d = CASES_DIR / case_id / CLIPS_DIRNAME
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{filename_base}.mp4"


def clip_output_path(case_id: str, filename: str) -> Path:
    """Where review_clips.py should write the clip for a given capture's
    `filename` (its image name, e.g. "170...abcd1234.jpg"). Public wrapper
    around _clip_path so recordings.py doesn't reach into a private name."""
    return _clip_path(case_id, filename.rsplit(".", 1)[0])


def list_pending_clip_sources(recording_id: str) -> list[dict]:
    """Captures that reference this recording and don't have a ready clip yet.
    Used once a recording finishes uploading to generate review clips for every
    capture filed against it while it was live.

    Shape is unchanged from the CSV version, so recordings.py needs no edit."""
    con = db.connect()
    try:
        rows = con.execute(
            "SELECT * FROM captures WHERE recording_id = ? AND video_offset_ms"
            " IS NOT NULL AND review_clip_status != 'ready'", (recording_id,)).fetchall()
    finally:
        con.close()
    return [_row_to_api(r) for r in rows]


def set_review_clip_status(case_id: str, filename: str, status: str) -> None:
    con = db.connect()
    try:
        con.execute("UPDATE captures SET review_clip_status = ? WHERE case_id = ?"
                    " AND filename = ?", (status, case_id, filename))
    finally:
        con.close()


def _insert_capture(row: dict) -> None:
    cols = [c for c in MANIFEST_FIELDS if c in row]
    con = db.connect()
    try:
        con.execute(
            "INSERT INTO captures (%s, created_at) VALUES (%s, ?)"
            % (", ".join(cols), ", ".join("?" * len(cols))),
            [row[c] for c in cols] + [time.time()])
    finally:
        con.close()


def _save_and_record(case_id: str, image: bytes, video: Optional[bytes],
                     extra: dict) -> str:
    """Write the frame, the clip and the database row. Blocking on purpose —
    callers hand it to a worker thread. Doing this inline on the event loop
    froze the inference websocket for the duration of the disk write, which is
    exactly the video stutter a clinician sees at the moment of capture."""
    filename, ts, has_video = _save_capture(case_id, image, video)
    row = {"case_id": case_id, "filename": filename, "has_video": has_video,
           "timestamp": ts}
    row.update(_blank_to_none(extra))
    _insert_capture(row)
    return filename


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


@router.post("/feedback/{case_id}/auto-capture")
async def auto_capture(
    case_id: str,
    file: UploadFile = File(...),
    ai_detections: str = Form(...),
    video: Optional[UploadFile] = File(default=None),
    recording_id: Optional[str] = Form(default=None),
    video_offset_ms: Optional[str] = Form(default=None),
    capture_kind: Optional[str] = Form(default=None),
):
    """Called automatically whenever the live model detects something. Lands as
    "pending" for a nurse to triage later.

    An appearance files two of these: "first" the moment it is detected, and
    "best" once the window closes. Anything else is recorded as "" rather than
    rejected -- a capture is worth more than its label."""
    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="empty image")
    video_bytes = await video.read() if video else None
    filename = await asyncio.to_thread(
        _save_and_record, case_id, image_bytes, video_bytes,
        {"source": "auto", "status": "pending", "ai_detections": ai_detections,
         "recording_id": recording_id or "", "video_offset_ms": video_offset_ms or "",
         "capture_kind": capture_kind if capture_kind in ("first", "best") else ""},
    )
    return {"filename": filename}


@router.post("/feedback/{case_id}/dr-found/capture")
async def dr_found_capture(
    case_id: str,
    file: UploadFile = File(...),
    bbox: Optional[str] = Form(default=None),
    ai_detections: Optional[str] = Form(default=None),
    video: Optional[UploadFile] = File(default=None),
    recording_id: Optional[str] = Form(default=None),
    video_offset_ms: Optional[str] = Form(default=None),
    user: Optional[str] = Depends(current_user),
):
    """Manual capture — a doctor pointed out a polyp the model didn't flag."""
    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="empty image")
    video_bytes = await video.read() if video else None

    x1 = y1 = x2 = y2 = ""
    if bbox:
        try:
            coords = json.loads(bbox)
            if len(coords) == 4:
                x1, y1, x2, y2 = coords
        except (ValueError, TypeError):
            log.warning("dr_found_capture: could not parse bbox %r", bbox)

    filename = await asyncio.to_thread(
        _save_and_record, case_id, image_bytes, video_bytes,
        {"source": "manual", "status": "dr_found", "noticed_first": "dr",
         "bbox_x1": x1, "bbox_y1": y1, "bbox_x2": x2, "bbox_y2": y2,
         "ai_detections": ai_detections or "",
         "recording_id": recording_id or "", "video_offset_ms": video_offset_ms or "",
         "reviewed_by": user or ""},
    )
    return {"filename": filename}


@router.get("/feedback/queue")
async def get_queue(case_id: Optional[str] = None, user: str = Depends(require_user)):
    """Pending auto-captures awaiting review, oldest first. Pass case_id to
    scope to one procedure, or omit for "Feedback mode" browsing across all."""
    # "dr_found" belongs here too. It was filed and then never surfaced: the
    # queue only listed "pending", so a doctor flagging something the model
    # missed saw the capture vanish — the one workflow this feature exists for.
    sql = ("SELECT * FROM captures WHERE status IN ('pending', 'dr_found')")
    params: list = []
    if case_id:
        _check_id(case_id, "case_id")
        sql += " AND case_id = ?"
        params.append(case_id)
    con = db.connect()
    try:
        # case_id, filename break ties. SQL has no implicit stable order, so
        # without them two captures sharing a timestamp -- which is common, the
        # resolution is one second and an appearance files two rows -- can swap
        # places between two requests for no reason.
        rows = con.execute(sql + " ORDER BY timestamp, case_id, filename",
                           params).fetchall()
    finally:
        con.close()
    return [_row_to_api(r) for r in rows]


@router.post("/feedback/{case_id}/{filename}/review")
async def review_capture(
    case_id: str,
    filename: str,
    correct: bool = Form(...),
    noticed_first: str = Form(...),
    bbox: Optional[str] = Form(default=None),
    box_corrected: bool = Form(default=False),
    morphology: str = Form(default=""),
    user: Optional[str] = Depends(current_user),
):
    """Nurse reviews a pending auto-capture: confirms it's a real polyp
    (optionally adjusting the box) or marks it a false positive, and records
    whether the doctor had already noticed it or the model caught it first.
    box_corrected flags whether the saved box is the AI's own detection as-is
    or one the nurse moved/redrew — lets later analysis separate "AI box was
    right" from "AI box needed a correction". morphology is separate from the
    confirm/reject verdict — "flat" still confirms the polyp, it just notes
    that it isn't the default polypoid shape."""
    _check_id(case_id, "case_id")
    _check_id(filename.split(".")[0], "filename")
    if noticed_first not in NOTICED_FIRST:
        raise HTTPException(status_code=400, detail="noticed_first must be 'dr' or 'ai'")
    if morphology not in MORPHOLOGY:
        raise HTTPException(status_code=400, detail=f"morphology must be one of {sorted(MORPHOLOGY)}")
    box = None
    if bbox:
        try:
            x1, y1, x2, y2 = json.loads(bbox)
            box = (x1, y1, x2, y2)
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="invalid bbox")

    status = "confirmed" if correct else "false_positive"
    sets = ["status = ?", "noticed_first = ?", "box_corrected = ?", "morphology = ?",
            # COALESCE so signing out doesn't blank an existing attribution:
            # reviewed_by is only overwritten when we actually know who it was.
            "reviewed_by = COALESCE(NULLIF(?, ''), reviewed_by)"]
    params: list = [status, noticed_first, int(box_corrected),
                    morphology if correct else "", user or ""]
    if box is not None:
        sets += ["bbox_x1 = ?", "bbox_y1 = ?", "bbox_x2 = ?", "bbox_y2 = ?"]
        params += list(box)

    con = db.connect()
    try:
        with con:
            cur = con.execute(
                "UPDATE captures SET %s WHERE case_id = ? AND filename = ?"
                % ", ".join(sets), params + [case_id, filename])
            if not cur.rowcount:
                raise HTTPException(status_code=404, detail="not found")
            db.log_event(con, case_id, filename, "review", status=status,
                         noticed_first=noticed_first,
                         morphology=morphology if correct else "", bbox=bbox,
                         box_corrected=box_corrected, reviewed_by=user or "")
    finally:
        con.close()
    return {"filename": filename, "status": status}


# What a frame IS, as opposed to whether its detection was right. Kept separate
# from the review verdicts because they answer different questions and are not
# alternatives -- an out-of-body frame has no polyp verdict to give.
# `clean` exists so a noise experiment can record a negative. Without it
# the only evidence a reviewer leaves is what they flagged, and "not
# flagged" cannot be told apart from "not looked at".
FRAME_LABELS = {"out_of_body", "noisy", "clean"}


@router.post("/feedback/{case_id}/{filename}/label")
async def label_capture(case_id: str, filename: str, label: str = Form(...),
                        user: Optional[str] = Depends(current_user)):
    """Label a capture by what the frame is: out-of-body, or too noisy.

    These are the ground truth the out-of-body and quality gates have never had.
    Every threshold in them so far was fitted against labels inferred from the
    gates' own features, which is circular; this records a human judgement about
    frames from the real capture setup instead."""
    _check_id(case_id, "case_id")
    _check_id(filename.split(".")[0], "filename")
    if label not in FRAME_LABELS:
        raise HTTPException(
            status_code=400, detail=f"label must be one of {sorted(FRAME_LABELS)}")
    con = db.connect()
    try:
        with con:
            cur = con.execute(
                "UPDATE captures SET status = ?,"
                " reviewed_by = COALESCE(NULLIF(?, ''), reviewed_by)"
                " WHERE case_id = ? AND filename = ?",
                (label, user or "", case_id, filename))
            if not cur.rowcount:
                raise HTTPException(status_code=404, detail="not found")
            db.log_event(con, case_id, filename, "label", status=label,
                         reviewed_by=user or "")
    finally:
        con.close()
    return {"filename": filename, "status": label}


@router.get("/feedback/list")
async def list_captures(status: Optional[str] = None, case_id: Optional[str] = None,
                        user: str = Depends(require_user)):
    """Reviewed/submitted history — optionally filtered by status
    (confirmed | false_positive | dr_found) and/or case. Newest first.
    This is what "Feedback mode" browses when no case is selected."""
    params: list = []
    if status:
        if status not in STATUSES:
            raise HTTPException(status_code=400, detail=f"unknown status '{status}'")
        sql = "SELECT * FROM captures WHERE status = ?"
        params.append(status)
    else:
        sql = "SELECT * FROM captures WHERE status != 'pending'"
    if case_id:
        _check_id(case_id, "case_id")
        sql += " AND case_id = ?"
        params.append(case_id)
    con = db.connect()
    try:
        # case_id, filename break ties. SQL has no implicit stable order, so
        # without them two captures sharing a timestamp -- which is common, the
        # resolution is one second and an appearance files two rows -- can swap
        # places between two requests for no reason.
        rows = con.execute(sql + " ORDER BY timestamp DESC, case_id, filename",
                           params).fetchall()
    finally:
        con.close()
    return [_row_to_api(r) for r in rows]


@router.get("/feedback/{case_id}/image/{filename}")
async def get_image(case_id: str, filename: str, user: str = Depends(require_user)):
    images_dir = _images_dir(case_id)
    _check_id(filename.split(".")[0], "filename")
    path = images_dir / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(path, media_type="image/jpeg")


@router.get("/feedback/{case_id}/video/{filename}")
async def get_video(case_id: str, filename: str, user: str = Depends(require_user)):
    images_dir = _images_dir(case_id)
    base = filename.rsplit(".", 1)[0]
    _check_id(base, "filename")
    path = images_dir / f"{base}.webm"
    if not path.exists():
        raise HTTPException(status_code=404, detail="no video for this capture")
    return FileResponse(path, media_type="video/webm")


@router.get("/feedback/{case_id}/clip/{filename}")
async def get_review_clip(case_id: str, filename: str, user: str = Depends(require_user)):
    """The server-cut short clip around this capture's moment in the full
    session recording (see review_clips.py), if one has been generated.
    404 until then -- the caller falls back to the plain-text offset label."""
    base = filename.rsplit(".", 1)[0]
    path = _clip_path(case_id, base)
    if not path.exists():
        raise HTTPException(status_code=404, detail="clip not generated (yet)")
    return FileResponse(path, media_type="video/mp4", content_disposition_type="inline")


@router.delete("/feedback/{case_id}/{filename}")
async def delete_capture(case_id: str, filename: str, user: str = Depends(require_user)):
    _check_id(case_id, "case_id")
    base = filename.rsplit(".", 1)[0]
    _check_id(base, "filename")
    con = db.connect()
    try:
        with con:
            cur = con.execute("DELETE FROM captures WHERE case_id = ? AND filename = ?",
                              (case_id, filename))
            if not cur.rowcount:
                raise HTTPException(status_code=404, detail="not found")
            # review_events deliberately keeps its rows for a deleted capture:
            # that a frame was reviewed and then removed is exactly the sort of
            # thing you want still on record afterwards.
            db.log_event(con, case_id, filename, "delete", reviewed_by=user or "")
    finally:
        con.close()
    images_dir = _images_dir(case_id)
    (images_dir / filename).unlink(missing_ok=True)
    (images_dir / f"{base}.webm").unlink(missing_ok=True)
    _clip_path(case_id, base).unlink(missing_ok=True)
    return {"deleted": filename}


@router.patch("/feedback/{case_id}/{filename}")
async def update_capture(case_id: str, filename: str, bbox: Optional[str] = Form(default=None),
                         user: str = Depends(require_user)):
    """Edit (or clear) a reviewed capture's bounding box after the fact."""
    _check_id(case_id, "case_id")
    if bbox:
        try:
            x1, y1, x2, y2 = json.loads(bbox)
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="invalid bbox")
    else:
        x1 = y1 = x2 = y2 = None
    con = db.connect()
    try:
        with con:
            cur = con.execute(
                "UPDATE captures SET bbox_x1 = ?, bbox_y1 = ?, bbox_x2 = ?, bbox_y2 = ?"
                " WHERE case_id = ? AND filename = ?",
                (x1, y1, x2, y2, case_id, filename))
            if not cur.rowcount:
                raise HTTPException(status_code=404, detail="not found")
            db.log_event(con, case_id, filename, "bbox_edit", bbox=bbox,
                         reviewed_by=user or "")
    finally:
        con.close()
    return {"updated": filename}
