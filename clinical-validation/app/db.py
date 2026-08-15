"""SQLite storage for the review panel.

One file, WAL mode, a connection per request. The load is a handful of
clinicians clicking through images -- a database server would be infrastructure
to secure and back up for no benefit, and WAL already gives concurrent readers
alongside the single writer.

Annotations are append-only. A reader who revises an answer writes a new row
pointing at the old one through `revision_of`; nothing is ever updated in place,
so the record of what a reader said, and when, survives the revision. Training
data whose provenance cannot be reconstructed is training data you cannot defend.
"""
import os, sqlite3, time

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL CHECK (role IN ('admin','reader')),
  pw_hash       TEXT NOT NULL,
  must_change_pw INTEGER NOT NULL DEFAULT 1,
  totp_secret   TEXT,
  totp_enabled  INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  locked_until  REAL,
  pw_changed_at REAL,
  last_login_at REAL,
  created_at    REAL NOT NULL,
  created_by    INTEGER
);

-- Cookie value is never stored: `id` is its SHA-256. A leaked database backup
-- therefore does not hand over live sessions.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  csrf       TEXT NOT NULL,
  created_at REAL NOT NULL,
  last_seen  REAL NOT NULL,
  expires_at REAL NOT NULL,
  revoked_at REAL,
  ip         TEXT,
  ua         TEXT
);
CREATE INDEX IF NOT EXISTS ix_auth_user ON auth_sessions(user_id);

-- One row per patient study. Items reference it rather than carrying a copy of
-- the whole frame list, which matters because the escalation views show every
-- frame of a study and an FN study can run to 70 of them.
CREATE TABLE IF NOT EXISTS studies (
  case_label       TEXT PRIMARY KEY,
  model_verdict    TEXT,
  report_polyp     INTEGER,
  report_scrubbed  TEXT,
  finding          TEXT,
  polyp_max_mm     TEXT,
  polyp_morphology TEXT,
  polyp_location   TEXT,
  frames           TEXT NOT NULL,
  n_frames         INTEGER NOT NULL,
  created_at       REAL NOT NULL
);

-- Every reviewable unit is a single frame. There is no contact-sheet task: a
-- reader picking from a grid is comparing images against each other, which is
-- a different and easier judgement than the one the model has to make, and it
-- yields no per-frame negative labels for the frames they skipped over.
CREATE TABLE IF NOT EXISTS items (
  id           TEXT PRIMARY KEY,
  bucket       TEXT NOT NULL CHECK (bucket IN ('tp','fp','fn','tn')),
  case_label   TEXT NOT NULL REFERENCES studies(case_label),
  frame_index  INTEGER NOT NULL,
  image        TEXT NOT NULL,
  w            INTEGER,
  h            INTEGER,
  ai_conf      REAL,
  ai_boxes     TEXT,
  -- Inverse of the fraction of its population that was sampled. FP, TP and FN
  -- frames are taken whole (1.0); quiet controls are a small sample of 4302, so
  -- any frame-level rate computed from them has to be reweighted or it will
  -- overstate how much of the archive looks like the reviewed controls.
  sampling_weight REAL NOT NULL DEFAULT 1.0,
  -- A fixed subset every reader is steered towards, so inter-reader agreement
  -- is measured on a common set rather than on whatever incidentally overlapped.
  in_overlap   INTEGER NOT NULL DEFAULT 0,
  -- Created on demand when a reader labels an image from the patient view that
  -- was never in the sampling frame. Useful as training data, useless for any
  -- rate: it was chosen because someone was looking at it. Never served as a
  -- blind question and excluded from coverage and composition.
  ad_hoc       INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_items_bucket ON items(bucket, is_active, in_overlap);
CREATE INDEX IF NOT EXISTS ix_items_case ON items(case_label);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  requested_n INTEGER NOT NULL,
  mix         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  started_at  REAL NOT NULL,
  finished_at REAL
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id, status);

-- task='frame'       item_id set: one image, one question.
-- task='fn_debrief'  case_label set: appended when a reader has cleared every
--                    frame of a report-positive study the model also missed.
--                    Cannot be drawn up front -- whether it is owed depends on
--                    how that reader answered.
CREATE TABLE IF NOT EXISTS worklist (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  task       TEXT NOT NULL DEFAULT 'frame',
  item_id    TEXT REFERENCES items(id),
  case_label TEXT,
  position   INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  served_at  REAL,
  UNIQUE (session_id, position)
);
CREATE INDEX IF NOT EXISTS ix_worklist_item ON worklist(item_id);
CREATE INDEX IF NOT EXISTS ix_worklist_session ON worklist(session_id, status);

-- stage='blind'    the reader's answer on the image alone. The only stage that
--                  is a clean, unprompted per-frame label.
-- stage='confirm'  after the report was revealed. Recorded separately and never
--                  overwriting the blind answer.
-- stage='debrief'  the study-level explanation for an all-negative FN study.
-- stage='open'     labelled from the patient view, with the report and the rest
--                  of the patient already in front of the reader. Good training
--                  data, but NOT a blind label -- it never supersedes one, and
--                  it must stay out of any sensitivity or specificity estimate.
CREATE TABLE IF NOT EXISTS annotations (
  id           INTEGER PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  worklist_id  INTEGER REFERENCES worklist(id),
  item_id      TEXT REFERENCES items(id),
  case_label   TEXT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  stage        TEXT NOT NULL,
  verdict      TEXT,
  confidence   INTEGER,
  boxes        TEXT,
  frames       TEXT,
  reason       TEXT,
  position     INTEGER,
  ai_shown     INTEGER NOT NULL DEFAULT 0,
  report_shown INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  ms_on_item   INTEGER,
  -- Whether the reader was told, after answering, which group this image came
  -- from. Recorded so the cost of that reveal is measurable: if it shifts how
  -- they answer over a session, the drift is in the data rather than hidden.
  explained    INTEGER NOT NULL DEFAULT 0,
  -- Set when the reader went back and changed this answer. The row stays --
  -- nothing is ever deleted, so what they first said and when is still on
  -- record -- but every query that asks "what is their answer" filters it out.
  superseded   INTEGER NOT NULL DEFAULT 0,
  created_at   REAL NOT NULL,
  revision_of  INTEGER REFERENCES annotations(id)
);
CREATE INDEX IF NOT EXISTS ix_ann_item ON annotations(item_id);
CREATE INDEX IF NOT EXISTS ix_ann_user ON annotations(user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_ann_session ON annotations(session_id);

CREATE TABLE IF NOT EXISTS audit (
  id      INTEGER PRIMARY KEY,
  ts      REAL NOT NULL,
  user_id INTEGER,
  action  TEXT NOT NULL,
  object  TEXT,
  ip      TEXT,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit_ts ON audit(ts);
"""


def db_path():
    return os.environ.get('CV_DB', os.path.join(data_dir(), 'panel.db'))


def data_dir():
    return os.environ.get(
        'CV_DATA', os.path.join(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))), 'data'))


def images_dir():
    return os.environ.get('CV_IMAGES', os.path.join(data_dir(), 'images'))


def connect():
    # check_same_thread=False because a request's dependency and its endpoint
    # can be scheduled onto different threadpool threads, and sqlite3 otherwise
    # refuses the handover. Safe here: connect() is called once per request and
    # the connection is never shared between concurrent requests.
    con = sqlite3.connect(db_path(), timeout=15, isolation_level=None,
                          check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA journal_mode=WAL')
    con.execute('PRAGMA foreign_keys=ON')
    con.execute('PRAGMA busy_timeout=15000')
    return con


# Columns added after the first deployment. CREATE TABLE IF NOT EXISTS will not
# add a column to a table that already exists, so they are applied explicitly.
MIGRATIONS = [
    ('annotations', 'explained', 'INTEGER NOT NULL DEFAULT 0'),
    ('annotations', 'superseded', 'INTEGER NOT NULL DEFAULT 0'),
    ('items', 'ad_hoc', 'INTEGER NOT NULL DEFAULT 0'),
]


def init():
    os.makedirs(data_dir(), exist_ok=True)
    con = connect()
    try:
        con.executescript(SCHEMA)
        for table, column, decl in MIGRATIONS:
            cols = [r[1] for r in con.execute(
                'PRAGMA table_info(%s)' % table).fetchall()]
            if column not in cols:
                con.execute('ALTER TABLE %s ADD COLUMN %s %s'
                            % (table, column, decl))
    finally:
        con.close()


def audit(con, user_id, action, object=None, ip=None, detail=None):
    con.execute(
        'INSERT INTO audit (ts, user_id, action, object, ip, detail)'
        ' VALUES (?,?,?,?,?,?)',
        (time.time(), user_id, action, object, ip, detail))
