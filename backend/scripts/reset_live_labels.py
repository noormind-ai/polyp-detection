"""Void every label applied to a live-mode capture, back to unreviewed.

Why
---
Nothing in this database was ever reviewed as ground truth. The verdicts on it
were clicked during clinic sessions while the capture workflow itself was being
tested, so "confirmed" here means somebody pressed confirm to see what would
happen, not that a clinician judged a lesion. Treating them as labels would put
test clicks into training data and into any sensitivity number computed later.

This does NOT touch the clinical review panel
(panel-src/clinical-validation/data/panel.db), which is a different
application with a different database and the only place real blind review has
happened.

What is cleared, and what is kept
---------------------------------
Cleared -- everything a human asserted after the fact:
    status -> pending, noticed_first, morphology, box_corrected, reviewed_by

Kept -- everything recorded at capture time, which is still true:
    source, ai_detections (the model's own output), recording_id,
    video_offset_ms, capture_kind, has_video, and the image itself.

The box is the one judgement call. On an auto-capture the bbox columns are only
ever populated by a reviewer, so they are cleared with the rest. On a manual
"doctor found it" capture the box was drawn at capture time and is the only
localisation that frame will ever have -- clearing it would destroy the capture
rather than its label -- so it is kept as a starting point for whoever reviews
it properly.

Reversible
----------
Every prior label is written to review_events (action='reset') BEFORE it is
overwritten, so nothing is actually destroyed: the old status, who it was
attributed to, and the old box can all be read back out and replayed. Combined
with the nightly snapshot that is two independent ways to undo this.

Usage:  python3 backend/scripts/reset_live_labels.py           # dry run
        python3 backend/scripts/reset_live_labels.py --apply
"""

import argparse
import collections
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend import db  # noqa: E402

# Everything that is not the unreviewed default. Includes dr_found: a manual
# capture is still a frame somebody flagged while testing, and it goes back in
# the queue to be judged properly. source='manual' keeps that provenance.
LABELLED = ("confirmed", "false_positive", "dr_found", "out_of_body", "noisy", "clean")


def main() -> int:
    ap = argparse.ArgumentParser(description="Reset live-mode capture labels to pending.")
    ap.add_argument("--apply", action="store_true", help="actually write the reset")
    ap.add_argument("--by", default="label-reset", help="attribution for the audit rows")
    args = ap.parse_args()

    con = db.connect()
    try:
        rows = con.execute(
            "SELECT * FROM captures WHERE status != 'pending' ORDER BY timestamp"
        ).fetchall()

        total = con.execute("SELECT COUNT(*) FROM captures").fetchone()[0]
        print("captures total:      %d" % total)
        print("labelled (to reset): %d" % len(rows))
        by_status = collections.Counter(r["status"] for r in rows)
        for s, n in by_status.most_common():
            print("    %-16s %4d" % (s, n))

        by_source = collections.Counter(r["source"] for r in rows)
        print("  by source:         %s" % dict(by_source))
        keep_box = [r for r in rows if r["source"] == "manual" and r["bbox_x1"] is not None]
        drop_box = [r for r in rows if r["source"] != "manual" and r["bbox_x1"] is not None]
        print("  boxes kept (manual capture-time):   %d" % len(keep_box))
        print("  boxes cleared (reviewer-drawn):     %d" % len(drop_box))
        print("  attributions cleared:               %d"
              % sum(1 for r in rows if r["reviewed_by"]))

        print("")
        print("after this, pending would be: %d  (every capture in the database)"
              % total)

        if not args.apply:
            print("")
            print("(dry run -- nothing written. Re-run with --apply.)")
            return 0

        now = time.time()
        with con:
            for r in rows:
                # Record what it was BEFORE overwriting it. This is the undo.
                bbox = None
                if r["bbox_x1"] is not None:
                    bbox = json.dumps([r["bbox_x1"], r["bbox_y1"],
                                       r["bbox_x2"], r["bbox_y2"]])
                con.execute(
                    "INSERT INTO review_events (case_id, filename, action, status,"
                    " noticed_first, morphology, bbox, box_corrected, reviewed_by,"
                    " created_at) VALUES (?,?,'reset',?,?,?,?,?,?,?)",
                    (r["case_id"], r["filename"], r["status"], r["noticed_first"],
                     r["morphology"], bbox, r["box_corrected"],
                     r["reviewed_by"] or args.by, now))

                keep = r["source"] == "manual"
                con.execute(
                    "UPDATE captures SET status='pending', noticed_first='',"
                    " morphology='', box_corrected=NULL, reviewed_by=''"
                    + ("" if keep else ", bbox_x1=NULL, bbox_y1=NULL,"
                                       " bbox_x2=NULL, bbox_y2=NULL")
                    + " WHERE case_id=? AND filename=?",
                    (r["case_id"], r["filename"]))

        left = con.execute("SELECT COUNT(*) FROM captures WHERE status != 'pending'").fetchone()[0]
        pend = con.execute("SELECT COUNT(*) FROM captures WHERE status = 'pending'").fetchone()[0]
        ev = con.execute("SELECT COUNT(*) FROM review_events WHERE action='reset'").fetchone()[0]
        after = con.execute("SELECT COUNT(*) FROM captures").fetchone()[0]
    finally:
        con.close()

    print("")
    print("still labelled:   %d  (expected 0)" % left)
    print("pending:          %d" % pend)
    print("captures total:   %d  (expected %d -- nothing deleted)" % (after, total))
    print("undo rows logged: %d" % ev)
    ok = left == 0 and after == total and ev >= len(rows)
    print("OK" if ok else "MISMATCH -- investigate")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
