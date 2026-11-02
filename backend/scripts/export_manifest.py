"""Regenerate manifest.csv from the database.

The app stopped writing a CSV when feedback storage moved to SQLite, but two
offline analysis scripts outside this repo still read one:

    ~/bench-infocolon/gate_feedback.py
    ~/noisebench/*.py

Rather than make them learn a new source, this writes the file they already
expect, with the identical 19-column header and identical value formatting --
the rows go through _row_to_api, the same renderer the HTTP API uses, so the
CSV and the JSON can never drift apart.

It is a one-way mirror. The app never reads this file; the database is the only
source of truth. gate_feedback.py can also drop its NUL-stripping workaround
now: the torn write that made that necessary is not reachable from here.

Written to a temp file and renamed into place, so a reader never catches it
half-written -- which is the failure this whole migration exists to end.

Usage:  python3 backend/scripts/export_manifest.py
        python3 backend/scripts/export_manifest.py --out /tmp/snapshot.csv
"""

import argparse
import csv
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend import db  # noqa: E402
from backend.routes.feedback import MANIFEST_FIELDS, MANIFEST_PATH, _row_to_api  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="Regenerate manifest.csv from the database.")
    ap.add_argument("--out", type=Path, default=MANIFEST_PATH)
    args = ap.parse_args()

    con = db.connect()
    try:
        rows = con.execute(
            "SELECT * FROM captures ORDER BY timestamp, case_id, filename").fetchall()
    finally:
        con.close()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    tmp = args.out.with_name("%s.tmp-%d" % (args.out.name, os.getpid()))
    try:
        with tmp.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=MANIFEST_FIELDS)
            w.writeheader()
            for r in rows:
                w.writerow(_row_to_api(r))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, args.out)
    finally:
        tmp.unlink(missing_ok=True)

    print("wrote %d rows to %s" % (len(rows), args.out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
