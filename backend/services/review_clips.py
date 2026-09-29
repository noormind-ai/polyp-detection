"""Cuts a short review clip around a feedback capture's moment in a full
session recording, so a reviewer gets a watchable clip instead of having to
manually find the recording and scrub to a timestamp.

Uses ffmpeg directly via subprocess, not backend/services/video.py's cv2
helpers: those decode/re-encode frame-by-frame in Python, which is far
slower for cutting one short clip out of a 30-60 minute file, and the
live-written WebM recordings carry no duration/cue header (they're built by
appending raw MediaRecorder chunks — see backend/routes/recordings.py),
which makes cv2.VideoCapture's frame-count-based seeking unreliable on them.
ffmpeg's coarse-seek-before-input + fine-seek-after-input trick seeks
accurately without decoding from frame 0 every time.

Best-effort throughout: a failed cut is never fatal to anything else, it
just means the reviewer falls back to the plain timestamp label that already
existed before this file did.
"""

import logging
import shutil
import subprocess
import uuid
from pathlib import Path

log = logging.getLogger("review_clips")

FFMPEG = shutil.which("ffmpeg") or "/usr/bin/ffmpeg"

PAD_BEFORE_S = 5.0
PAD_AFTER_S = 5.0
# Generous but bounded -- a hung/runaway ffmpeg process must not pile up
# behind a live procedure's background task queue.
TIMEOUT_S = 60


def cut_clip(source: Path, offset_ms: int, out_path: Path,
             pad_before: float = PAD_BEFORE_S, pad_after: float = PAD_AFTER_S) -> bool:
    """Cuts `[offset - pad_before, offset + pad_after]` from `source` into
    `out_path` as a small H.264 MP4. Returns True on success, False on any
    failure -- never raises, since a bad clip is not worth stopping anything
    else over (a running recording, a case's whole manifest write, etc.)."""
    if not source.exists() or source.stat().st_size == 0:
        return False

    offset_s = max(0.0, offset_ms / 1000.0)
    start = max(0.0, offset_s - pad_before)
    duration = pad_before + pad_after

    # Two-stage seek: a coarse -ss before -i lets ffmpeg jump near the target
    # via keyframes without decoding the whole file from the start; a small
    # fine -ss after -i (re-encoding anyway, so frame-accurate) lands exactly
    # on the requested instant. 2s of coarse margin is comfortably more than
    # one GOP at MediaRecorder's default keyframe interval.
    coarse = max(0.0, start - 2.0)
    fine = start - coarse

    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_path.with_name(f".{out_path.name}.{uuid.uuid4().hex[:8]}.tmp.mp4")

    cmd = [
        FFMPEG, "-y",
        "-ss", f"{coarse:.3f}",
        "-i", str(source),
        "-ss", f"{fine:.3f}",
        "-t", f"{duration:.3f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-an",
        "-movflags", "+faststart",
        str(tmp_path),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=TIMEOUT_S)
        if result.returncode != 0 or not tmp_path.exists() or tmp_path.stat().st_size == 0:
            log.warning("clip cut failed for %s @ %dms: %s", source, offset_ms,
                       result.stderr.decode("utf-8", "replace")[-500:])
            tmp_path.unlink(missing_ok=True)
            return False
        tmp_path.replace(out_path)
        return True
    except (subprocess.TimeoutExpired, OSError) as exc:
        log.warning("clip cut errored for %s @ %dms: %s", source, offset_ms, exc)
        tmp_path.unlink(missing_ok=True)
        return False
