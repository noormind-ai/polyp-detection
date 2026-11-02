#!/bin/sh
# Nightly snapshot of the clinical feedback database, plus the CSV mirror.
#
# Modelled on panel-src/clinical-validation/deploy/backup.sh, for the same
# reasons it gives:
#
#   * sqlite3's backup API rather than cp -- the database runs in WAL mode, so
#     a plain file copy can catch it mid-write and restore as corrupt. The
#     backup API takes a consistent snapshot of a live database, with no need
#     to stop the backend.
#   * driven through the venv's Python rather than the sqlite3 CLI, which is
#     not installed on this box and would be a system package to add and
#     maintain for one call.
#
# The frames under cases/ are NOT backed up here: they are ~1 GB of write-once
# JPEGs. The verdicts and review history are what is irreplaceable, and what
# this protects. That also means this is NOT disaster recovery -- it survives
# corruption and mistakes, not the loss of the machine. An off-box copy is
# still owed.
set -eu

ROOT=/home/fati/noormind/polyp-detection
DIR=$ROOT/backend/data/feedback
OUT=$DIR/backups
KEEP=30

mkdir -p "$OUT"
chmod 700 "$OUT"
STAMP=$(date +%Y%m%d-%H%M%S)

"$ROOT/venv/bin/python" - "$DIR/feedback.db" "$OUT/feedback-$STAMP.db" <<'PY'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
s = sqlite3.connect('file:%s?mode=ro' % src, uri=True)
d = sqlite3.connect(dst)
with d:
    s.backup(d)
d.close(); s.close()
PY

gzip -f "$OUT/feedback-$STAMP.db"
chmod 600 "$OUT/feedback-$STAMP.db.gz"

# Refresh the CSV the offline analysis scripts still read.
"$ROOT/venv/bin/python" "$ROOT/backend/scripts/export_manifest.py"

# Keep the most recent KEEP snapshots.
ls -1t "$OUT"/feedback-*.db.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r f; do
    rm -f "$f"
done
