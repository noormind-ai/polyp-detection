"""Finalize recordings whose browser never sent the closing /stop, and give
live-written WebM files the duration/index they were born without.

Why this exists
---------------
A recording is only listable once POST /api/recordings/{case}/{id}/stop has run:
that is the single call that writes status="complete" and duration_ms. The
client sends it from finalize() in frontend/src/lib/useSessionRecorder.ts, and
it sends it LAST -- after awaiting uploadPending(), whose chunks each wait
behind waitUntilInferenceIdle() so the drain yields to the next procedure's
live inference. So the closing mark queues behind an unbounded, deliberately
slow upload, and anything that kills the tab in that window loses it.

It happened on 2026-10-21 (29 Mehr). Five sessions ran; the picker showed one.
Three recordings sat at status="recording", duration_ms=0 -- including 9m42s /
418 MB of clinic footage. Every chunk had arrived with a 200; journalctl shows
the last one landing at 11:32:46, the same second the browser closed, with the
stop call next in line. 513 MB of video, invisible because of a missing flag.
The first run of this script found 2026-10-14 had lost three more the same way:
29.5 minutes of clinic footage across two days.

The client ordering is fixed separately. This is the backstop: nothing else in
the system ever heals these. STALE_AFTER_S in routes/recordings.py only
relabels status to "interrupted" inside _decorate() at read time -- it never
persists anything and never derives a duration, so a stuck recording stays
stuck forever and stays filtered out of every picker.

What the finalize phase writes
------------------------------
status="interrupted" -- NOT "complete". These really were cut off mid-procedure
and the distinction is worth keeping; RecordingsPanel.tsx already renders an
amber badge for it. What makes them usable again is duration_ms, because the
pickers gate on that rather than on status.

duration_ms comes from the video itself (last packet PTS, via real_seconds from
triage_recordings.py) -- not from the browser's wall-clock measurement, which
counts the paused out-of-body stretches and overstates real footage by ~10%.

What the remux phase (--remux) does
-----------------------------------
Rebuilds the container with `ffmpeg -c copy`. These WebMs are written by
appending MediaRecorder chunks, so they carry no duration or cue index:
DetectionReplay.tsx has to set currentTime=1e101 to force the browser to scan
the whole file before it will seek. A remux adds both, costs ~2.4s for 418 MB,
and re-encodes nothing -- so "Play from here" seeks directly instead.

Deliberately a SEPARATE pass from finalizing, keyed on "header declares no
duration" rather than on status: a recording finalized by an earlier run still
needs its index, and a recording that stopped cleanly never had one either.
Idempotent -- a file that already has a duration is skipped.

Never destructive without verifying first: the replacement is written to a temp
file beside the original and must report a finite duration AND an unchanged
decoded frame count before it is swapped in. The original is kept under
.bak-<ts> until a post-swap re-check passes, and restored if it does not.

Usage:  python3 backend/scripts/finalize_stale_recordings.py                # dry run
        python3 backend/scripts/finalize_stale_recordings.py --apply
        python3 backend/scripts/finalize_stale_recordings.py --apply --remux
        python3 backend/scripts/finalize_stale_recordings.py --stale-after 300
"""

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from triage_recordings import real_seconds  # noqa: E402

REC = Path(__file__).resolve().parents[1] / "data" / "recordings"

# How long a recording must have been silent before the sweep claims it. Well
# clear of a legitimate slow drain: the 2026-10-21 case trickled for 11m48s
# while still perfectly healthy, so anything under ~15min risks finalizing a
# recording that is still being written to. STALE_AFTER_S in routes is 120s,
# which is right for *displaying* "interrupted" but far too eager for writing.
DEFAULT_STALE_AFTER_S = 20 * 60

# Statuses that mean "a browser may still be appending to this". Anything in
# here that has gone quiet past the threshold is what the finalize phase claims;
# anything in here that is still fresh is left strictly alone by both phases.
LIVE_STATUSES = ("recording", "closing")


def frame_count(path: Path) -> int:
    """Decoded frame count. Used only to prove a remux changed nothing."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
         "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True).stdout.strip()
    try:
        return int(out.splitlines()[0])
    except (ValueError, IndexError):
        return -1


def header_duration(path: Path) -> float:
    """Duration as declared in the container header, 0.0 if absent.

    This is the test for "needs a remux". It is NOT real_seconds(): that walks
    every packet and so answers even for a header with nothing in it, which is
    the whole problem being fixed here.
    """
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)], capture_output=True, text=True).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return 0.0


def remux(video: Path) -> tuple[str, str]:
    """Rebuild the container with duration + cues. Verify, then swap in.

    Returns (outcome, note) where outcome is "ok", "skip" or "error".
    """
    before = frame_count(video)
    if before <= 0:
        return "skip", "no decodable frames, left alone"

    # The temp file keeps the real extension: ffmpeg picks its output format
    # from the suffix, and a bare ".tmp" makes it give up with "Unable to
    # choose an output format". That is exactly how the first run of this
    # script failed on all six files.
    tmp = video.with_name(video.stem + ".remux-tmp" + video.suffix)
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(video), "-c", "copy", "-y", str(tmp)],
        capture_output=True, text=True)
    if not tmp.exists() or tmp.stat().st_size == 0:
        tmp.unlink(missing_ok=True)
        return "error", "remux FAILED (%s)" % (proc.stderr.strip()[:120] or "no output")

    after = frame_count(tmp)
    dur = header_duration(tmp)
    if after != before or dur <= 0:
        tmp.unlink(missing_ok=True)
        return "error", "remux REJECTED (frames %d->%d, duration %.1f)" % (before, after, dur)

    backup = video.with_name(video.name + ".bak-%d" % int(time.time()))
    video.replace(backup)
    tmp.replace(video)
    if frame_count(video) == before and header_duration(video) > 0:
        backup.unlink()
        return "ok", "remuxed: duration %.1fs, %d frames intact, index added" % (dur, after)
    video.unlink(missing_ok=True)
    backup.replace(video)
    return "error", "remux ROLLED BACK (post-swap verify failed), original restored"


def load_all() -> list[tuple[Path, Path, dict]]:
    """Every readable recording in the tree, as (meta_file, video, meta)."""
    out = []
    for meta_file in sorted(REC.glob("*/*.json")):
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            print("  unreadable, skipped: %s" % meta_file)
            continue
        out.append((meta_file, meta_file.with_suffix(meta.get("ext", ".webm")), meta))
    return out


def has_video(video: Path) -> bool:
    return video.exists() and video.stat().st_size > 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Finalize recordings stranded without a closing /stop.")
    ap.add_argument("--apply", action="store_true", help="write metadata / swap files")
    ap.add_argument("--remux", action="store_true",
                    help="also rebuild containers that declare no duration")
    ap.add_argument("--stale-after", type=int, default=DEFAULT_STALE_AFTER_S,
                    metavar="S", help="seconds of silence before claiming")
    args = ap.parse_args()

    now = time.time()
    rc = 0
    print("recordings tree:   %s" % REC)
    print("stale threshold:   %d s" % args.stale_after)

    records = load_all()

    def still_live(meta: dict) -> bool:
        return (meta.get("status") in LIVE_STATUSES
                and now - float(meta.get("updated_at") or 0) < args.stale_after)

    # ---- phase 1: finalize anything stranded without its closing /stop ----
    claim = [(f, v, m) for f, v, m in records
             if m.get("status") in LIVE_STATUSES and not still_live(m) and has_video(v)]
    protected = [m for _, _, m in records if still_live(m)]
    novideo = [m for _, v, m in records
               if m.get("status") in LIVE_STATUSES and not still_live(m) and not has_video(v)]

    print("")
    for m in protected:
        print("  still live, left alone: %s/%s" % (m["case_id"], m["id"]))
    for m in novideo:
        print("  no video data, left alone: %s/%s" % (m["case_id"], m["id"]))

    print("")
    print("FINALIZE: %d recording(s)" % len(claim))
    for meta_file, video, meta in claim:
        secs = real_seconds(video)
        print("  %s/%s  %s" % (meta["case_id"], meta["id"], meta.get("user", "?")))
        print("      status %s -> interrupted, duration %s -> %d, %.1f MB"
              % (meta["status"], meta.get("duration_ms", 0), int(secs * 1000),
                 video.stat().st_size / 1e6))
        if not args.apply:
            continue
        meta["status"] = "interrupted"
        meta["stop_reason"] = "stale-sweep"
        meta["duration_ms"] = max(int(meta.get("duration_ms") or 0), int(secs * 1000))
        meta["ended_at"] = int(meta.get("updated_at") or now)
        tmp = meta_file.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(meta, indent=1), encoding="utf-8")
        tmp.replace(meta_file)
        print("      written: %s" % meta_file.name)

    # ---- phase 2: give every settled recording a real duration/index ----
    if args.remux:
        todo = []
        for meta_file, video, meta in records:
            if still_live(meta) or not has_video(video):
                continue
            if header_duration(video) > 0:
                continue
            todo.append((video, meta))
        print("")
        print("REMUX: %d file(s) declare no duration" % len(todo))
        for video, meta in todo:
            print("  %s/%s  %.1f MB" % (meta["case_id"], meta["id"],
                                        video.stat().st_size / 1e6))
            if not args.apply:
                continue
            outcome, note = remux(video)
            print("      %s" % note)
            if outcome == "error":
                rc = 1

    if not args.apply:
        print("")
        print("(dry run -- nothing written. Re-run with --apply, or --apply --remux.)")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
