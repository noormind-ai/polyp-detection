"""SQLite storage for clinical feedback captures.

One file, WAL mode, a connection per request. Same reasoning as the review
panel's app/db.py, which this follows deliberately: the load is a handful of
clinicians clicking through frames, so a database server would be
infrastructure to secure and back up for no benefit, and WAL already gives
concurrent readers alongside the single writer.

What this replaces, and why
---------------------------
Every capture and every review verdict used to live in one manifest.csv that
was rewritten whole on each edit -- truncate in place, no fsync, no atomic
rename, from handlers that did not hold the append lock. That is not a
theoretical hazard: it tore, left 16,458 NUL bytes where rows used to be, and
made 132 captured frames invisible to the app until they were recovered by
backend/scripts/recover_orphans.py. A review click also cost a ~40 ms
read-parse-rewrite of the entire file, growing for the life of the deployment,
and the in-process lock meant the backend could never run more than one worker.

Each of those is a property of the storage, not of the application, and each
one goes away here: writes are transactional and crash-safe, an edit touches
one row, and WAL coordinates across processes rather than across threads.

The images themselves stay on the filesystem under cases/{case_id}/. They are
written once and streamed out by FileResponse; putting them in here would bloat
every backup and buy nothing.

Review history is append-only
-----------------------------
`captures` holds the current state of a frame. `review_events` records the
human actions that produced it and is never updated or deleted. The CSV could
not answer "who labelled this, when, and did someone change it" -- reviewed_by
was overwritten in place, so re-reviewing a frame erased whoever said what
before. Training data whose provenance cannot be reconstructed is training data
you cannot defend.
"""

import os
import sqlite3
import time
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data" / "feedback"

# Column order here is the order MANIFEST_FIELDS declares and therefore the key
# order the API has always emitted (csv.DictReader yields header order, and
# FastAPI preserves dict order). Keeping it identical is what lets the frontend
# stay untouched across this migration.
SCHEMA = """
-- One row per captured frame. The image itself is at
-- cases/{case_id}/images/{filename}; this is everything we know ABOUT it.
--
-- (case_id, filename) is the natural key and the only identifier the HTTP API
-- has ever used, so it is the primary key rather than a surrogate id. A
-- duplicate capture is then a constraint violation instead of a silent second
-- row the queue would show twice.
CREATE TABLE IF NOT EXISTS captures (
  case_id       TEXT NOT NULL,
  filename      TEXT NOT NULL,
  -- Seconds, from the {unixts}_{uuid8} filename prefix _save_capture assigns.
  timestamp     INTEGER NOT NULL,
  -- 'auto'      the model detected something and the frontend filed it
  -- 'manual'    a nurse flagged a polyp the model missed
  -- 'recovered' reconstructed from the file tree after the CSV tore; its
  --             ai_detections are gone for good. Deliberately NOT constrained:
  --             a capture is worth more than its label, and a future source
  --             should not be rejected at the door.
  source        TEXT NOT NULL DEFAULT 'auto',
  -- Verdicts and frame labels share this column because that is what the CSV
  -- did and what the queue filters on. The three frame labels say what the
  -- frame IS; the four verdicts say whether the detection was right.
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                  'pending', 'confirmed', 'false_positive', 'dr_found',
                  'out_of_body', 'noisy', 'clean')),
  noticed_first TEXT NOT NULL DEFAULT '' CHECK (noticed_first IN ('dr', 'ai', '')),
  -- Morphology, not a verdict -- a flat lesion is still a confirmed polyp.
  morphology    TEXT NOT NULL DEFAULT '' CHECK (morphology IN ('', 'flat')),
  has_video     INTEGER NOT NULL DEFAULT 0,
  -- The user-drawn or AI-supplied box. Nullable as a set: absent means no box
  -- is known, which is different from a box at the origin.
  bbox_x1       REAL,
  bbox_y1       REAL,
  bbox_x2       REAL,
  bbox_y2       REAL,
  -- The model's own output for this exact frame, as JSON text. TEXT and not a
  -- parsed structure on purpose: it is handed to the browser as a string and
  -- JSON.parse()d there, so storing it any other way would mean re-serialising
  -- it on every read and risking a shape the frontend does not expect.
  ai_detections TEXT NOT NULL DEFAULT '',
  -- NULL until reviewed, then whether the saved box is the AI's own or one a
  -- nurse moved. Tri-state on purpose: "not yet reviewed" is not "not
  -- corrected", and collapsing them would overstate how often the AI box
  -- was accepted as-is.
  box_corrected INTEGER,
  -- Where this frame sits in the session recording, instead of storing a copy
  -- of the video with it.
  recording_id  TEXT NOT NULL DEFAULT '',
  video_offset_ms INTEGER,
  -- '' until a clip cut is attempted, then 'ready' or 'failed'.
  review_clip_status TEXT NOT NULL DEFAULT '',
  -- Best-effort attribution: the signed-in username at the time of the human
  -- action, or '' when nobody was. Not an audit guarantee -- review_events is.
  reviewed_by   TEXT NOT NULL DEFAULT '',
  -- 'first' or 'best' -- which of an appearance's two auto-captures this is.
  capture_kind  TEXT NOT NULL DEFAULT '',
  created_at    REAL NOT NULL,
  PRIMARY KEY (case_id, filename)
);

-- The review queue reads pending+dr_found oldest-first across every case; the
-- gallery reads one status newest-first. Both are this index.
CREATE INDEX IF NOT EXISTS ix_captures_status_ts ON captures(status, timestamp);
CREATE INDEX IF NOT EXISTS ix_captures_case ON captures(case_id, timestamp);
-- Serves list_pending_clip_sources, which runs once per finished recording and
-- would otherwise scan the table to find the handful of rows pointing at it.
CREATE INDEX IF NOT EXISTS ix_captures_recording
  ON captures(recording_id, review_clip_status);

-- Append-only. One row per human action on a capture; nothing here is ever
-- updated or deleted, including when the capture itself is deleted -- that a
-- frame was reviewed and then removed is exactly the kind of thing you want
-- still on record afterwards.
CREATE TABLE IF NOT EXISTS review_events (
  id            INTEGER PRIMARY KEY,
  case_id       TEXT NOT NULL,
  filename      TEXT NOT NULL,
  -- 'review' | 'label' | 'bbox_edit' | 'delete'
  action        TEXT NOT NULL,
  status        TEXT,
  noticed_first TEXT,
  morphology    TEXT,
  bbox          TEXT,
  box_corrected INTEGER,
  reviewed_by   TEXT NOT NULL DEFAULT '',
  created_at    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_review_events_capture
  ON review_events(case_id, filename, created_at);
"""

# Columns added after the first deployment. CREATE TABLE IF NOT EXISTS will not
# add a column to a table that already exists, so they are applied explicitly.
# Same mechanism as the review panel's db.py.
MIGRATIONS: list[tuple[str, str, str]] = []


def db_path() -> Path:
    return Path(os.environ.get("POLYP_FEEDBACK_DB", DATA_DIR / "feedback.db"))


def connect() -> sqlite3.Connection:
    # check_same_thread=False because a request's dependency and its endpoint
    # can land on different threadpool threads, and sqlite3 otherwise refuses
    # the handover. Safe here: a connection is opened per unit of work and
    # never shared between concurrent ones.
    con = sqlite3.connect(db_path(), timeout=15, isolation_level=None,
                          check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=15000")
    # Durability over throughput. NORMAL would let a power loss drop the last
    # few commits; these are clinical review verdicts a human typed once, and
    # the write rate is a handful per minute, so there is nothing to buy by
    # trading them away.
    con.execute("PRAGMA synchronous=FULL")
    return con


def init() -> None:
    db_path().parent.mkdir(parents=True, exist_ok=True)
    con = connect()
    try:
        con.executescript(SCHEMA)
        for table, column, decl in MIGRATIONS:
            cols = [r[1] for r in con.execute("PRAGMA table_info(%s)" % table).fetchall()]
            if column not in cols:
                con.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, column, decl))
    finally:
        con.close()


def log_event(con: sqlite3.Connection, case_id: str, filename: str, action: str,
              status: str = None, noticed_first: str = None, morphology: str = None,
              bbox: str = None, box_corrected: bool = None,
              reviewed_by: str = "") -> None:
    con.execute(
        "INSERT INTO review_events (case_id, filename, action, status, noticed_first,"
        " morphology, bbox, box_corrected, reviewed_by, created_at)"
        " VALUES (?,?,?,?,?,?,?,?,?,?)",
        (case_id, filename, action, status, noticed_first, morphology, bbox,
         None if box_corrected is None else int(box_corrected),
         reviewed_by or "", time.time()))
