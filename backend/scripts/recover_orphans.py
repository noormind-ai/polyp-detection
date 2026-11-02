"""Repair feedback/manifest.csv and bring back the captures it lost.

Why this exists
---------------
manifest.csv was rewritten by truncating it in place -- no temp file, no fsync,
no atomic rename -- from four handlers that did not hold _MANIFEST_LOCK while a
capture thread appended to the same file. Interrupted partway, that leaves the
file at its new length with nothing written back for the blocks ext4 had already
allocated: a run of NUL bytes where rows used to be.

It happened. 16,458 NUL bytes sat at offset 210, and roughly 130 rows went with
them. The JPGs those rows described are all still on disk -- nothing ever
deleted them -- but with no manifest row they are invisible to every queue and
gallery in the app, and the live API was serving 16 KB of NUL characters as the
first queue row's case_id. Downstream, bench-infocolon/gate_feedback.py strips
NULs on read to work around it rather than fixing it.

The write path is fixed separately (see _write_manifest in routes/feedback.py).
This script repairs the damage that was already done.

What it recovers, and what is gone for good
-------------------------------------------
Recoverable from the file tree alone: case_id (it IS the directory name),
filename, timestamp (the {unixts}_{uuid8} filename prefix), and has_video (a
sibling .webm). Those rows come back as pending, ready to review.

NOT recoverable: ai_detections, the model's boxes for that frame. They existed
only in the destroyed rows. So a recovered capture shows the frame with no AI
box overlay. They are marked source="recovered" rather than "auto" so this is
visible in the data instead of being quietly indistinguishable from a capture
whose model genuinely found nothing -- and so any analysis can exclude them.

Nothing is deleted. The pre-repair manifest is copied to manifest.csv.bak-<ts>
before anything is written, and a row whose image is missing from disk is
reported but KEPT by default: a dead row is a smaller loss than a human verdict.

Usage:  python3 backend/scripts/recover_orphans.py            # dry run, prints the plan
        python3 backend/scripts/recover_orphans.py --apply    # write the repaired manifest
        python3 backend/scripts/recover_orphans.py --apply --drop-dangling
"""

import argparse
import csv
import io
import re
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.routes.feedback import (  # noqa: E402
    CASES_DIR, MANIFEST_FIELDS, MANIFEST_PATH, _ROW_DEFAULTS, _write_manifest,
)

NUL = bytes([0])
# {unixts}_{uuid4hex[:8]}.jpg -- what _save_capture names every frame.
CAPTURE_NAME = re.compile(r"^(\d{9,11})_([0-9a-f]{8})\.jpg$")


def read_rows_stripping_nuls(path: Path) -> tuple[list[dict], int]:
    """Parse the manifest with NUL bytes removed.

    Stripping rather than discarding the affected line, on purpose: the NUL run
    here is a prefix of what is otherwise an intact row, so removing the NULs
    restores a real capture that would otherwise be thrown away along with the
    corruption.
    """
    raw = path.read_bytes()
    n_nul = raw.count(NUL)
    text = raw.replace(NUL, b"").decode("utf-8", "replace")
    return list(csv.DictReader(io.StringIO(text))), n_nul


def scan_disk() -> dict:
    """Every capture JPG on disk -> whether it has a sibling .webm."""
    found = {}
    for images in sorted(CASES_DIR.glob("*/images")):
        case_id = images.parent.name
        for jpg in images.glob("*.jpg"):
            found[(case_id, jpg.name)] = jpg.with_suffix(".webm").exists()
    return found


def main() -> int:
    ap = argparse.ArgumentParser(description="Repair manifest.csv and recover orphaned captures.")
    ap.add_argument("--apply", action="store_true", help="write the repaired manifest")
    ap.add_argument("--drop-dangling", action="store_true",
                    help="also remove rows whose image is missing from disk")
    args = ap.parse_args()

    rows, n_nul = read_rows_stripping_nuls(MANIFEST_PATH)
    on_disk = scan_disk()
    in_manifest = set((r["case_id"], r["filename"]) for r in rows)

    orphans = sorted(set(on_disk) - in_manifest)
    dangling = sorted(in_manifest - set(on_disk))
    odd = [k for k in orphans if not CAPTURE_NAME.match(k[1])]

    print("manifest:        %s" % MANIFEST_PATH)
    print("  NUL bytes:     %d" % n_nul)
    print("  rows parsed:   %d" % len(rows))
    print("  JPGs on disk:  %d" % len(on_disk))
    print("  orphans:       %d  (on disk, no row -- invisible in the app)" % len(orphans))
    print("  dangling:      %d  (row, no image on disk)" % len(dangling))
    if odd:
        print("  UNPARSEABLE NAMES: %d -- no timestamp recoverable, skipped" % len(odd))
        for k in odd[:5]:
            print("      %s/%s" % k)
    verdict = " -- WILL BE DROPPED" if args.drop_dangling else " -- kept"
    for k in dangling:
        print("      dangling row: %s/%s%s" % (k[0], k[1], verdict))

    recovered = []
    for case_id, filename in orphans:
        m = CAPTURE_NAME.match(filename)
        if not m:
            continue
        row = dict(_ROW_DEFAULTS)
        row.update(case_id=case_id, filename=filename, timestamp=int(m.group(1)),
                   has_video=on_disk[(case_id, filename)], source="recovered",
                   status="pending")
        recovered.append(row)

    by_case = {}
    for r in recovered:
        by_case[r["case_id"]] = by_case.get(r["case_id"], 0) + 1
    print("")
    print("recoverable:     %d rows across %d cases" % (len(recovered), len(by_case)))
    for case_id, n in sorted(by_case.items(), key=lambda kv: -kv[1])[:8]:
        print("      %s: %d" % (case_id, n))
    with_video = sum(1 for r in recovered if r["has_video"])
    print("      of which %d also have a .webm clip on disk" % with_video)

    out = list(rows)
    if args.drop_dangling:
        out = [r for r in out if (r["case_id"], r["filename"]) in on_disk]
    out.extend(recovered)
    out.sort(key=lambda r: (int(r.get("timestamp") or 0), r["case_id"], r["filename"]))

    # Older rows predate later columns; restval="" in the writer covers that.
    # But a row carrying an UNKNOWN key would be silently dropped by
    # extrasaction="ignore", so check rather than trust.
    extra = set(k for r in out for k in r if k not in MANIFEST_FIELDS)
    if extra:
        print("")
        print("ABORT: rows carry unknown columns %s" % sorted(extra))
        return 1

    print("")
    print("result:          %d -> %d rows, 0 NUL bytes" % (len(rows), len(out)))
    if not args.apply:
        print("")
        print("(dry run -- nothing written. Re-run with --apply.)")
        return 0

    backup = MANIFEST_PATH.with_name("%s.bak-%d" % (MANIFEST_PATH.name, int(time.time())))
    shutil.copy2(MANIFEST_PATH, backup)
    print("backed up to:    %s" % backup)
    _write_manifest(out)
    print("wrote:           %s" % MANIFEST_PATH)

    check, _ = read_rows_stripping_nuls(MANIFEST_PATH)
    raw_nul = MANIFEST_PATH.read_bytes().count(NUL)
    print("verify:          %d rows re-read, %d NUL bytes" % (len(check), raw_nul))
    return 0 if (len(check) == len(out) and raw_nul == 0) else 1


if __name__ == "__main__":
    raise SystemExit(main())
