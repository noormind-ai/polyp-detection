"""Load manifest.csv into the SQLite captures table, once.

Run AFTER backend/scripts/recover_orphans.py, so the rows lost to the torn
write are already back in the CSV and come across with everything else.

Idempotent: INSERT OR IGNORE on the (case_id, filename) primary key, so a
re-run after a partial load finishes the job instead of duplicating it. It
never touches manifest.csv -- that file plus reverting routes/feedback.py is
the whole rollback path if this goes wrong.

The typing is the interesting part. Every CSV value is a string, including the
ones that mean "not set", and "" is not a number. Mapping them:

    ""            -> NULL   for the nullable numerics (bbox_*, video_offset_ms)
                            and for box_corrected, which is genuinely
                            tri-state: unreviewed is not the same as reviewed
                            and not corrected.
    "True"/"False" -> 1/0   has_video, box_corrected
    digits         -> int   timestamp, video_offset_ms
    numeric        -> float bbox_*

created_at is set to the capture timestamp rather than now(): the row is not
new, and stamping the import time over it would destroy the only ordering
information these rows have.

Usage:  python3 backend/scripts/migrate_manifest_to_sqlite.py           # dry run
        python3 backend/scripts/migrate_manifest_to_sqlite.py --apply
"""

import argparse
import collections
import csv
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend import db  # noqa: E402
from backend.routes.feedback import MANIFEST_FIELDS, MANIFEST_PATH  # noqa: E402

NUL = bytes([0])
NULLABLE_NUM = ("bbox_x1", "bbox_y1", "bbox_x2", "bbox_y2", "video_offset_ms")
BOOLS = ("has_video", "box_corrected")


def to_bool(v):
    if v in ("", None):
        return None
    return 1 if v == "True" else 0


def to_num(v):
    if v in ("", None):
        return None
    f = float(v)
    return int(f) if f.is_integer() else f


def convert(r: dict) -> dict:
    out = {k: (r.get(k) or "") for k in MANIFEST_FIELDS}
    out["timestamp"] = int(r.get("timestamp") or 0)
    for k in BOOLS:
        out[k] = to_bool(r.get(k))
    out["has_video"] = out["has_video"] or 0   # NOT NULL; "" meant False
    for k in NULLABLE_NUM:
        out[k] = to_num(r.get(k))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Load manifest.csv into SQLite.")
    ap.add_argument("--apply", action="store_true", help="actually write rows")
    args = ap.parse_args()

    raw = MANIFEST_PATH.read_bytes()
    if NUL in raw:
        print("ABORT: manifest still contains %d NUL bytes. Run recover_orphans.py first."
              % raw.count(NUL))
        return 1
    rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8"))))
    print("manifest rows:   %d" % len(rows))

    seen = collections.Counter((r["case_id"], r["filename"]) for r in rows)
    dupes = [k for k, n in seen.items() if n > 1]
    if dupes:
        print("  duplicate keys: %d (only the first of each will load)" % len(dupes))
        for k in dupes[:5]:
            print("      %s/%s" % k)

    by_status = collections.Counter(r["status"] for r in rows)
    print("  by status:     %s" % dict(by_status))

    bad = [r for r in rows if r["status"] not in (
        "pending", "confirmed", "false_positive", "dr_found",
        "out_of_body", "noisy", "clean")]
    if bad:
        print("ABORT: %d rows have a status the schema CHECK will reject: %s"
              % (len(bad), sorted(set(r["status"] for r in bad))))
        return 1

    converted = [convert(r) for r in rows]

    db.init()
    con = db.connect()
    try:
        existing = con.execute("SELECT COUNT(*) FROM captures").fetchone()[0]
        print("  already in db: %d" % existing)
        if not args.apply:
            print("")
            print("(dry run -- nothing written. Re-run with --apply.)")
            return 0

        cols = list(MANIFEST_FIELDS)
        sql = ("INSERT OR IGNORE INTO captures (%s, created_at) VALUES (%s, ?)"
               % (", ".join(cols), ", ".join("?" * len(cols))))
        with con:
            for r in converted:
                con.execute(sql, [r[c] for c in cols] + [r["timestamp"]])
        total = con.execute("SELECT COUNT(*) FROM captures").fetchone()[0]
    finally:
        con.close()

    expected = len(set(seen))
    print("")
    print("captures rows:   %d  (expected %d distinct keys)" % (total, expected))
    if total != expected:
        print("MISMATCH -- investigate before trusting this database.")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
