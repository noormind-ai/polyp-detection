#!/bin/sh
# Nightly snapshot of the annotation database.
#
# Uses sqlite3's backup API rather than cp: the panel runs in WAL mode, so a
# plain file copy can catch the database mid-write and restore as corrupt. The
# backup API takes a consistent snapshot of a live database.
#
# Driven through the venv's Python rather than the sqlite3 CLI, which is not
# installed on this box and would be a system package to add and maintain for
# one call.
#
# The images are reproducible from build_pool.py on the machine holding the
# originals; the annotations are not reproducible from anything, so they are
# what gets backed up.
set -eu

ROOT=/home/fati/noormind/clinical-validation
DIR=$ROOT/data
OUT=$DIR/backups
KEEP=30

mkdir -p "$OUT"
chmod 700 "$OUT"
STAMP=$(date +%Y%m%d-%H%M%S)

"$ROOT/venv/bin/python" - "$DIR/panel.db" "$OUT/panel-$STAMP.db" <<'PY'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
s = sqlite3.connect('file:%s?mode=ro' % src, uri=True)
d = sqlite3.connect(dst)
with d:
    s.backup(d)
d.close(); s.close()
PY

gzip -f "$OUT/panel-$STAMP.db"
chmod 600 "$OUT/panel-$STAMP.db.gz"

# Keep the most recent KEEP snapshots.
ls -1t "$OUT"/panel-*.db.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r f; do
    rm -f "$f"
done
