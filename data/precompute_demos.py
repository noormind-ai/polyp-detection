"""Run every bundled demo clip through Modal once and save the detections.

Why this exists
---------------
The demo clips used to be inferred live, frame by frame, every single time
anyone opened them — a GPU container spun up on Modal for footage whose
detections never change. This bakes the result to JSON so the player can
replay it with no GPU at all.

Matching the live pipeline exactly
----------------------------------
The player does not send full-resolution frames: it downscales each one to
INFER_WIDTH px wide and JPEG-encodes it at quality 85 before sending. Boxes
therefore come back in *downscaled* pixel coordinates, and that is what gets
drawn. So this script reproduces that same pipeline rather than calling
infer_video() on the original file — inferring at native resolution would
return boxes in a different coordinate space AND give the model a different
image than it sees live, which on small polyps is not a cosmetic difference.

Keep INFER_WIDTH/JPEG_QUALITY in step with RealtimePlayer.tsx.

Usage:  python data/precompute_demos.py [--force]
"""

import argparse
import json
import sys
from pathlib import Path

import cv2
from dotenv import load_dotenv

REPO = Path(__file__).resolve().parent.parent
# Same credentials the backend uses — must be loaded before modal is imported,
# since the client reads MODAL_TOKEN_* from the environment at import time.
load_dotenv(REPO / "backend" / ".env")

import modal  # noqa: E402

# Must match RealtimePlayer.tsx
INFER_WIDTH = 320
JPEG_QUALITY = 85

DEMO_DIR = REPO / "frontend" / "public" / "demos"
OUT_DIR = DEMO_DIR / "pred"


def encoded_frames(path: Path):
    """Decode the clip and yield exactly the JPEG bytes the browser would send."""
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise SystemExit(f"cannot open {path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    # Same rounding as the player: width is pinned, height follows the ratio.
    out_w = INFER_WIDTH
    out_h = round(src_h * (INFER_WIDTH / src_w))

    frames = []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        small = cv2.resize(frame, (out_w, out_h), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        if not ok:
            raise SystemExit(f"failed to encode a frame of {path.name}")
        frames.append(buf.tobytes())
    cap.release()
    return fps, out_w, out_h, frames


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true",
                    help="re-infer clips that already have a saved result")
    args = ap.parse_args()

    clips = sorted(DEMO_DIR.glob("*.mp4"))
    if not clips:
        raise SystemExit(f"no .mp4 files under {DEMO_DIR}")
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    detector = modal.Cls.from_name("polyp-detection", "PolypDetector")()

    for clip in clips:
        out_path = OUT_DIR / f"{clip.stem}_pred.json"
        if out_path.exists() and not args.force:
            print(f"{clip.name}: already done ({out_path.name}) — skipping")
            continue

        fps, w, h, frames = encoded_frames(clip)
        print(f"{clip.name}: {len(frames)} frames at {w}x{h}, {fps:.2f} fps — inferring...",
              flush=True)

        # .map() fans the frames out across containers; order is preserved, which
        # matters because the index IS the frame number.
        per_frame = list(detector.infer_frame.map(frames))

        hits = sum(1 for boxes in per_frame if boxes)
        payload = {
            "fps": fps,
            "width": w,
            "height": h,
            "infer_width": INFER_WIDTH,
            "jpeg_quality": JPEG_QUALITY,
            "source": clip.name,
            "frames": per_frame,
        }
        out_path.write_text(json.dumps(payload), encoding="utf-8")
        size_kb = out_path.stat().st_size / 1024
        print(f"{clip.name}: polyp in {hits}/{len(per_frame)} frames "
              f"-> {out_path.name} ({size_kb:.0f} KB)")

    print("done", file=sys.stderr)


if __name__ == "__main__":
    main()
