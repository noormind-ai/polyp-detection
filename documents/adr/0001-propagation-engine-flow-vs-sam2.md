# Propagation engine: optical flow vs SAM2 for backward box propagation

## Status
Resolved 2026-09-27 -- see decisions.md: "Video-labeling propagation engine"

## Problem / Context
The video-labeling platform (`video-label/`, see `tasks/doing/video-labeling-plan.txt`)
propagates a doctor-drawn box backward across many frames per lesion, so
annotators aren't hand-drawing every frame. Two engines already exist in the
codebase: classic optical-flow tracking and SAM2, a trained video
segmentation model. The original plan rejected SAM2 outright because
`noormind-iran` had no GPU, no torch, and ~2GB free RAM. On 2026-09-27 the
box got an RTX A2000 12GB GPU, reopening the question: does SAM2 become
viable now that the GPU objection is gone?

## Prior Work / Literature
| source | claim | code available? | verdict |
|---|---|---|---|
| REAL-Colon (Biffi et al., *Scientific Data* 2024) | 350k boxes annotated via reverse-order tool-assisted tracking, not SAM2 | in-house tool (Cosmo IMD), unreleased | precedent for tracking-based propagation, not SAM2-specific |
| SAM2 paper / data engine | propagate-then-correct is 5.1x faster than manual frame-by-frame | ultralytics ships `SAM2VideoPredictor` | general video-annotation reference, not endoscopy-validated |
| Endoscopy literature (recorded in `video-labeling-plan.txt`) | SAM2 is strong on tools, weak on tissue-similar/ambiguous boundaries -- exactly the sessile-polyp-vs-mucosa case | -- | predicts SAM2 underperforms here; borne out by both benchmarks below |

## Candidates
1. **Optical flow (Median Flow / sparse LK)** -- already implemented
   (`video-label/app/propagate.py`), zero extra dependencies (stock OpenCV),
   forward-backward error doubles as the drift/stopping signal painted on
   the annotator's timeline.
2. **SAM2-tiny** (`sam2.1_t.pt` via ultralytics' `SAM2VideoPredictor`) --
   already implemented (`video-label/app/propagate_sam.py`) as a laptop-only
   spike; needs torch + real compute.

## Attempts

### Optical flow -- laptop CPU, `test_polyp_seq2`, pre-2026-09-27
Mean IoU 0.474, 60/82 frames >=0.5 IoU (73%), 20 ms/frame.
(`video-label/README.md`)

### SAM2-tiny -- laptop CPU, `test_polyp_seq2`, pre-2026-09-27
Mean IoU 0.458, 87/102 frames >=0.5 IoU (85%), 3802 ms/frame. Not more
accurate than flow; better at surviving hard/occluded stretches (102 vs 82
frames produced), at ~190x the per-frame cost. (`video-label/README.md`)

### SAM2-tiny -- noormind-iran GPU (RTX A2000 12GB), `test_polyp_seq2`, 2026-09-27
Installed torch 2.14.0+cu130 + ultralytics 8.4.163 into an isolated venv
(`~/sam2-bench/venv`), kept separate from the live backend's venv so the
production dependency set was never touched. Ran the same
seed-from-last-GT-box, propagate-backward, score-against-GT protocol
directly on the box, via a standalone harness adapted from
`video-label/tools/bench_propagate.py` (frames extracted from the bundled
demo clip with ffmpeg instead of going through the local video-label
SQLite app, which isn't deployed here).

Result: mean IoU 0.483, 90/102 frames >=0.5 IoU (88%), 305 ms/frame average
-- skewed by a one-time ~25s cold start (weights download + CUDA context
build) on the first call; the runs after that measured 69 and 73 ms/frame,
i.e. **~70 ms/frame steady-state**, a ~55x speedup over CPU.

Also measured: torch + CUDA wheels + ultralytics consumed **~7GB of disk**
in the isolated venv (12GB -> 5.2GB free, on the box with the tightest disk
budget in the fleet). GPU memory returned to baseline (971 MiB of 12282 MiB)
after the process exited -- no lasting VRAM footprint, and with 12GB total
VRAM, GPU memory headroom is not the binding constraint; disk is.

Optical flow, run through the same harness on the same box as a sanity
check: mean IoU 0.497, 71/82 (87%), 11 ms/frame -- consistent with the
laptop numbers (small deltas from JPEG re-extraction, not a real
discrepancy).

## Decision
**Optical flow (Median Flow / LK) stays the default and only propagation
engine.** SAM2 is not adopted, even with GPU access.

Across both hardware tiers, SAM2 has never been more accurate than flow on
this footage (0.458 and 0.483 IoU vs flow's 0.474 and 0.497) -- its only
real advantage is producing more frames before giving up on hard/occluded
stretches, not better per-frame boxes. The GPU closed the *speed* gap from
prohibitive (3.8s/frame) to merely worse-than-flow (~70ms/frame vs
11ms/frame, still ~6x slower), but did not close the *accuracy* gap, and it
opened a new *footprint* cost: torch + CUDA + ultralytics is a second ML
framework alongside the production onnxruntime-gpu stack, consuming ~7GB of
disk on the box with the least disk headroom in the fleet. Given no accuracy
win and a real, recurring resource cost, there is no case for making it the
default.

### Alternatives considered
**SAM2-tiny on GPU** -- pros: only engine that survives long
occluded/hard stretches (90/102 vs 71/82 frames on the hardest measured
run), now fast enough to be interactively usable (~70ms/frame) instead of
prohibitive. Cons: never more accurate than flow, ~6x slower even on GPU,
needs a whole second inference framework (torch) installed and maintained
alongside the existing onnxruntime-gpu stack, ~7GB disk footprint on the
tightest-disk box in the fleet.

**SAM2-tiny on CPU** -- rejected outright pre-GPU and still rejected:
3.8s/frame makes it unusable for interactive annotation regardless of
accuracy.

### Consequences / risks
- Annotators get no persistence-through-occlusion help from the default
  engine -- on hard stretches (e.g. `test_polyp_seq2` frames 64-128) flow
  gives up earlier than SAM2 would -> mitigated by the `occluded`/`outside`
  track flags and manual redraw-then-re-propagate the annotator protocol
  (`ANNOTATOR.md`) already expects as normal, not a gap.
- `video-label/app/propagate_sam.py` and the engine dropdown in the UI
  remain in the codebase as a manual fallback, unused by default -> future
  maintenance cost if ultralytics/SAM2 APIs change, for a rarely-exercised
  path. No mitigation planned; revisit if it starts bit-rotting.
- The `~/sam2-bench/` venv (torch/CUDA/ultralytics, ~7GB) is left on
  `noormind-iran` after this evaluation, not cleaned up as of this ADR ->
  revisit disk headroom before any future GPU work on that box assumes the
  full 12GB baseline back.
- Only one of the three demo clips (`test_polyp_seq2`) was re-run on GPU;
  the other two were not. If disk headroom improves materially, or if
  occlusion-survival becomes a measured real blocker rather than a
  theoretical one, this decision is worth revisiting with the full 3-clip
  sweep.
