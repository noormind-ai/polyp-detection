"""PersistenceTracker: wraps the vendored ByteTrack (bytetrack/, see
bytetrack/VENDORED.md for provenance and patches) to flag which detections
have persisted across frames -- for the "?tracking=bytetrack" option in
backend/routes/infer.py, offered as an alternative to the existing client-side
heuristic in frontend/src/lib/temporal.ts.

WHY track_thresh=0.3 HERE
--------------------------
BYTETracker's headline feature is a second association pass over detections
BELOW track_thresh (see inds_second in bytetrack/byte_tracker.py) -- it tries
to match them against tracks the high-confidence pass missed, rescuing
detections a plain confidence cutoff would have discarded. That pass only
sees anything if such detections reach the tracker at all. This app's model is
served at conf=0.3 (inference/app.py), so nothing below that ever arrives
here -- meaning with track_thresh=0.3 the low-confidence pass is permanently
empty, and this instance is really running ByteTrack's high-confidence path
only. Lowering the model's own serving threshold would be required to use the
feature ByteTrack is actually named for; that's a separate, bigger change
than this toggle, not made here.

WHY PERSISTENCE IS TRACKED HERE, NOT VIA is_activated
------------------------------------------------------
BYTETracker's own "confirmed" flag (is_activated) uses its own internal
rules, tuned for pedestrian/vehicle MOT at video frame rates -- not this app's
specific "2 of last 3 frames" spec. So persistence is counted independently
here, keyed by BYTETracker's track_id, to match the app's definition exactly
and stay comparable to the heuristic's "gentle" default in temporal.ts.
"""
from types import SimpleNamespace

import numpy as np

from .bytetrack.byte_tracker import BYTETracker

_ARGS = SimpleNamespace(
    track_thresh=0.3,   # matches this app's model-serving conf floor -- see module docstring
    track_buffer=10,    # frames a lost track is kept before being fully dropped
    match_thresh=0.8,   # IoU-distance threshold for the high-confidence association pass
    mot20=False,
)

WINDOW = 3
MIN_HITS = 2


class PersistenceTracker:
    """One instance per websocket session. update() takes this frame's
    [{"bbox": [x1,y1,x2,y2], "conf": float}, ...] and returns the same boxes
    tagged with track_id and persistent (seen >= MIN_HITS times in the last
    WINDOW frames)."""

    def __init__(self, window: int = WINDOW, min_hits: int = MIN_HITS):
        self._tracker = BYTETracker(_ARGS, frame_rate=30)
        self._window = window
        self._min_hits = min_hits
        self._history: dict[int, list] = {}

    def update(self, boxes: list[dict]) -> list[dict]:
        if boxes:
            arr = np.array([[*b["bbox"], b["conf"]] for b in boxes], dtype=np.float64)
        else:
            arr = np.empty((0, 5), dtype=np.float64)

        # img_info/img_size identical -> internal rescale factor is 1.0. Our
        # boxes are already in the pixel space of the frame we sent; there is
        # no second, differently-sized image to rescale from.
        tracks = self._tracker.update(arr, img_info=(1, 1), img_size=(1, 1))

        seen_ids = {t.track_id for t in tracks}
        for tid in seen_ids:
            self._history.setdefault(tid, []).append(True)
        for tid in list(self._history):
            if tid not in seen_ids:
                self._history[tid].append(False)
            if len(self._history[tid]) > self._window:
                del self._history[tid][: -self._window]
            # Drop bookkeeping for tracks BYTETracker itself has fully
            # forgotten, so a long session doesn't accumulate one dead entry
            # per track ever seen.
            if tid not in seen_ids and not any(self._history[tid]):
                del self._history[tid]

        out = []
        for t in tracks:
            hits = sum(self._history.get(t.track_id, []))
            x1, y1, x2, y2 = t.tlbr.tolist()
            out.append({
                "bbox": [round(x1), round(y1), round(x2), round(y2)],
                "conf": round(float(t.score), 3),
                "track_id": int(t.track_id),
                "persistent": hits >= self._min_hits,
            })
        return out
