# Vendored from ifzhang/ByteTrack

Source: https://github.com/ifzhang/ByteTrack, `yolox/tracker/` —
`byte_tracker.py`, `kalman_filter.py`, `matching.py`, `basetrack.py`.
Pulled 2026-09-06. This is the paper authors' own code (Zhang et al. 2022,
ECCV), not a reimplementation.

`kalman_filter.py` and `basetrack.py` are byte-for-byte identical to upstream.
`byte_tracker.py` and `matching.py` needed three patches to run standalone in
this app, none of which touch the tracking algorithm itself:

1. **`cython_bbox` removed** (`matching.py`). Upstream computes IoU via a
   compiled Cython extension. Replaced with a pure-numpy `bbox_overlaps` of
   identical signature/semantics — avoids needing a C compiler at install
   time on a disk-constrained server, and is fast enough here regardless
   (box counts per frame are small, nowhere near where the vectorized numpy
   version would start to matter).
2. **`torch` import removed** (`byte_tracker.py`). It was dead in this file
   (no `torch.`/`F.` call anywhere) — a leftover from upstream's original
   YOLOX (torch tensor) integration. `BYTETracker.update()` also dropped the
   6-column torch-tensor input branch it fed; this app always calls it with
   plain 5-column numpy (`[x1,y1,x2,y2,score]`).
3. **`np.float` → `float`**. Removed from numpy in 2.x; this repo predates
   that removal. Same value, just not a deprecated alias.
4. Cross-file imports changed from `yolox.tracker.X` to relative (`from . import X`),
   since only these four files are vendored, not the full `yolox` package.

## Known behavior, not a bug — worth knowing before trusting the output

- `det_thresh = track_thresh + 0.1`: a detection needs to clear
  `track_thresh + 0.1` to **start** a brand-new track; anything between
  `track_thresh` and `track_thresh + 0.1` can only extend/confirm a track
  that already exists. See `PersistenceTracker`'s docstring in `../tracker.py`
  for what this means given this app's actual serving confidence threshold.
- ByteTrack's whole point is a **second association pass over low-confidence
  detections** (`inds_second` in `byte_tracker.py`) — but that pass only
  contains anything if detections below `track_thresh` reach the tracker at
  all. If the model's serving threshold is already at or above
  `track_thresh`, this pass is permanently empty and the "Byte" in ByteTrack
  is doing nothing. Also documented in `../tracker.py`.
