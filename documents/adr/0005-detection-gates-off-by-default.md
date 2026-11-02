# The detection gates are off by default

## Status
Resolved 2026-10-11 -- see decisions.md line: "Detection gates off by default".

## Problem / Context

What this product is for is the lesion the endoscopist did not see. Over time
the live path accumulated **five** independent mechanisms that could withhold a
detection from the screen. Each was added for a defensible local reason; nobody
had ever looked at them as a stack, and their combined cost in recall had never
been measured.

The stack as it stood, in pipeline order:

| # | gate | where | rule | cost, where known |
|---|---|---|---|---|
| 1 | FOV crop | `lib/fov.ts` | Crops the black border/banner so only the picture area is inferred on | none -- it removes non-image pixels |
| 2 | In-body | `lib/inBody.ts` | Logistic on redness + hue spread + motion; `ENTER 0.70` / `EXIT 0.30`, dwell 2 in / 2 out, every 2nd frame, hard `BRIGHT_MIN 50` | unmeasured; observed bouncing mid-procedure |
| 3 | Frame quality | `lib/frameQuality.ts` | `medium`: gradmean < 17.1 plus dark/glare/exposure bounds; dropped **before** inference | rejects **3.5%** of doctor-labelled polyp frames (gentle: 0.6%) |
| 4 | Confidence floor | `services/local_cpu.py` | per model; RT-DETR 0.30 | unmeasured below 0.30 |
| 4b | NMS | `services/local_cpu.py` | IoU 0.45, YOLO decode path only | duplicate suppression, not lesion suppression |
| 5a | Temporal persistence | `lib/temporal.ts` | `heuristic`, 2 hits in last 3 inferred frames, IoU 0.25 matching | **unmeasurable from production data -- see below** |
| 5b | ByteTrack | `services/tracker.py` | ran unconditionally; 2-of-3 window | **two hidden rules nobody chose -- see below** |

Three findings drove the decision.

### The temporal gate's cost cannot be seen from production data

`maybeAutoCapture(shown, ...)` (`LiveCameraPlayer.tsx`) is fed **post-gate**
boxes. Anything the temporal gate suppressed was therefore never filed, never
reviewed, and could never appear in the feedback manifest. The manifest at the
time of this decision held 1,544 rows -- 53 `confirmed`/`ai`, 122
`false_positive`/`ai`, 24 `dr_found`/`dr` -- and **every one of those 53
AI-first catches had cleared the 2-of-3 bar by construction**. The data could
confirm what the gate let through and was structurally blind to what it stopped.
The UI's `held` counter tallies withheld detections but says nothing about
whether any were real.

The gate's own header is candid that it was never validated: "self authored, no
motion model, unvalidated against labels".

### The gate's window is in frames, so its meaning drifted with the hardware

`of` counts frames, not time. Measured on this box on 2026-10-11 (30 reps,
320px frame, the service's own CUDA env):

| model | median | p90 | rate |
|---|---|---|---|
| RT-DETR @320 (live default) | **17.3 ms** | 18.8 ms | ~58/s |
| yolov5m @320 | 10.7 ms | 21.0 ms | ~93/s |
| RT-DETR, CPU fallback (no CUDA libs) | 192 ms | 261 ms | ~5/s |

Those are synthetic single-frame reps. What actually governs the gate is
end-to-end session throughput, from this box's own `logs/backend.log` WS session
summaries on 2026-10-11:

| session | frames | infer median | p90 | throughput |
|---|---|---|---|---|
| 08:15 | 728 | 38 ms | 45 ms | **26.3 fps** |
| 08:30 | 2,232 | 37 ms | 46 ms | **27.0 fps** |
| 14:02 | 2,928 | 36 ms | 44 ms | **27.8 fps** |

Real frames cost more than the bench frame (JPEG decode of a ~13 KB payload on
top of the forward pass) and the client loop keeps one frame in flight, so
**~27 fps is the live cadence** -- not the ~58/s the bench suggests. A 3-frame
window is therefore **~110 ms** of footage in the clinic.

A 3-frame window was ~0.75 s of footage when the box was CPU-only -- which is
where `temporal.ts`'s "~4 inferences/second ... about a second late" comment
comes from, and that comment is now stale. On the GPU the same config is ~110 ms.
So the gate had quietly stopped being the Holzwanger-style ">= 0.5 s
persistence" rule it was designed as, and had become "the detector must fire
twice within a tenth of a second" -- which suppresses an intermittently
detected lesion no matter how long it stays in view, while barely delaying a
solid one. It was never re-tuned after the GPU arrived (2026-09-27).

### ByteTrack was enforcing two rules nobody chose

`infer.py` carried the comment "Tags each box with track_id/persistent; does not
drop or reorder anything, so a client that ignores these two keys sees no
change." That was **false**. Reading the vendored `bytetrack/byte_tracker.py`:

- `det_thresh = args.track_thresh + 0.1` = **0.40** (line 143). Step 4
  (~line 258) skips any unmatched detection scoring below that when initialising
  new tracks. A **newly appearing** lesion therefore needed conf >= 0.40 while
  the model was being served at 0.30 -- every new detection in 0.30-0.40 was
  discarded server-side.
- `STrack.activate()` sets `is_activated = True` only when `frame_id == 1`
  (~line 49), and `update()` returns only activated tracks (~line 277). A lesion
  first detected on any later frame was **withheld until matched a second
  time** -- a hidden, always-on, non-switchable 2-frame persistence rule.
- Boxes sent to the browser were `t.tlbr`, the Kalman filter's state, not the
  model's output.
- `infer.py` *replaced* `detections` with the tracker's return value, so the
  tracker was the sole source of what the browser received.

Critically, this meant turning the client-side temporal gate off would **not**
have un-gated the system: an equivalent requirement was baked into the backend.

## Prior Work / Literature

| source | claim | code available? | verdict |
|---|---|---|---|
| Holzwanger et al., Endoscopy 2021 | CADe specificity/accuracy 93.2%/97.8% at >=0.5 s persistence, 98.6%/99.5% at >=1 s; >95% of per-frame FPs are ignored by endoscopists outright | no | Still the best argument for *a* persistence rule. But it specifies a **duration**, and our implementation counted frames -- which is how it drifted to ~50 ms. If persistence returns, it must be time-based. |
| Zhang et al. 2022 (ByteTrack) | Low-confidence second association pass recovers detections a plain cutoff discards | yes, vendored | The named feature was inert here (nothing below 0.30 ever reached it), while its *unadvertised* `det_thresh + 0.1` and activation rules were silently gating. Wrong tool at this serving threshold. |
| Pertuz et al., Pattern Recognition 2013 | GRA1 (mean Sobel) is a better focus measure than Laplacian variance | n/a | Upheld and kept -- it is why the quality gate uses gradmean. Does not bear on whether the gate should be *on*. |

## Decision

**Nothing on the live path suppresses a detection on persistence or frame
quality grounds. The model's output reaches the screen.**

| gate | before | after |
|---|---|---|
| Temporal persistence | `heuristic`, 2-of-3 | **default `off`**, still selectable per operator |
| Frame quality | on, `medium` | **default off**, switch and levels still in the UI |
| ByteTrack | ran unconditionally, gated silently | **not run** (`tracker = None`); mode removed from the UI picker |
| In-body | on | **unchanged, still on** |
| FOV crop | on | **unchanged** -- removes non-image pixels, not detections |
| Confidence floor | 0.30 server-side | **unchanged** |
| Backend filter bank | report-only | **unchanged, still report-only** |
| NMS | IoU 0.45, YOLO paths only | **unchanged** -- see below |

Per-browser stored choices had to be dealt with too: both gates remembered the
operator's selection in `localStorage`, and a stored value beats a default, so
flipping the defaults would have changed nothing for exactly the people who had
touched those controls. `lib/gateDefaults.ts` clears the four keys once per
browser and records that it has done so, so a deliberate choice made *after*
this deploy still sticks.

### Alternatives considered

**Keep 2-of-3 but widen the window (2-of-8, or a time-based 2-hits-in-250 ms)**
-- pros: tolerates intermittent detection, which is the failure mode that
actually matters, while still requiring corroboration; fixes the frame-rate
drift. cons: still an unvalidated suppression rule, still invisible in the
review data. Deferred, not rejected: this is the most likely shape of a
persistence rule if the replay below says one is needed.

**Turn off NMS as well** -- rejected. It was raised, and it is not a recall
gate: NMS removes *duplicate boxes of the same object*, not distinct lesions.
Raw RT-DETR output on one region in the TRUE-Colon run produced 7 heavily
overlapping boxes; drawing all of them finds no extra polyp and makes the screen
unreadable. It is also already **not applied to the live model** -- RT-DETR is a
set predictor and uses the NMS-free `_decode_rtdetr`; `IOU = 0.45` only affects
the YOLO models still in the picker. The one genuine cost is two adjacent
lesions overlapping above 0.45, which would be better addressed by raising IoU
to ~0.6 than by removing NMS.

**Turn off the in-body gate too** -- left open. It is the one remaining gate
that drops frames before inference, and it was observed bouncing mid-procedure
(the 2026-09-30 clinic session fragmented into 9 recordings, one holding 0.3 s
of video inside 5.5 s of wall clock), which means it discards in-body frames.
But it also drives recording auto start/stop: with it off, `shouldInfer()`
returns true permanently, so recording would start on scan and never auto-stop
on withdrawal. Bigger blast radius than the rest, so it is a separate decision.

### Consequences / risks

- **More false positives on screen, and more beeps.** Tier 3 mirrors tier 1 by
  design (ADR 0004), so the alert now follows raw per-frame detections,
  including single-frame artefacts. -> The alert duration control remains; if
  the room finds it intolerable, that is evidence for a time-based persistence
  rule rather than for restoring 2-of-3.
- **The review queue now does take single-frame detections**, by a later
  decision on the same day -- see "Capture rule" below. When this ADR was first
  written tier 2 still required 2 hits, so a one-frame blip beeped and left
  nothing to review; that asymmetry was the thing the user objected to.
- **Recall gained is as unmeasured as the recall previously lost.** This
  decision removes suppression on the argument that an unvalidated,
  unmeasurable filter should not stand between a doctor and a lesion -- not on
  evidence that it was costing specific polyps. -> The replay below is what
  closes that gap, and until it runs this is a judgement call, logged as one.
- **`POLYP_GATE_ENFORCE` is still one env var from re-introducing
  suppression.** The backend filter bank (`frame_gate.py`) is computed on every
  frame and reports; setting that variable makes `gra1 < 14.675` drop every box
  on the frame, muting ~2% of doctor-confirmed polyp frames. -> Deliberately
  left report-only. Anyone tempted to set it should read this ADR first; a
  config flag that changes clinical behaviour invisibly is the same class of
  problem as the ByteTrack comment.
- **A stale comment caused this.** The ByteTrack behaviour was documented as
  "does not drop or reorder anything" and had been believed for weeks. -> The
  claim is now stated at the call site with line references into the vendored
  library, so it can be re-checked rather than re-trusted.

## Capture rule (tier 2), revised the same day

Turning tier 1 off made the beep fire on any single detection while tier 2 still
required two frames. So the room could hear a sound with nothing behind it for a
reviewer to look at -- and a lesion the model glimpsed exactly once is precisely
the one most likely to have been missed by eye, which is the case this product
exists for. The user's call: if it beeped, there must be an image.

**Every appearance now files two captures, labelled so a reviewer can tell them
apart:**

| kind | when | bar to clear |
|---|---|---|
| `first` | the frame the appearance is first detected on, filed immediately | **none** |
| `best` | the clearest frame of the appearance, by `frameScore` -- 50% sharpness (gradmean/30), 30% confidence, 20% apparent size -- filed once `FILE_MIN_MS` (1 s) passes or the appearance ends, whichever is first; then refreshed while the lesion stays on screen | `FILE_MIN_HITS = 2` |

Three details that matter:

- **`FILE_MIN_HITS` was not lowered to 1.** It now guards `best` only. A
  single-frame detection therefore files exactly one image (`first`) instead of
  the same frame twice under two labels.
- **`first` deliberately does not touch the episode bookkeeping.** Marking the
  episode filed would have pushed `best` out to the 8 s refresh interval
  instead of `FILE_MIN_MS`, and clearing `bestRef` would have stopped the frame
  being scored at all. Both were live traps in the obvious implementation.
- **The 1 s window still only ever delays.** If the appearance ends first, the
  best frame so far is filed on the spot.

Recorded in the manifest as a new `capture_kind` column (`first` | `best` | `""`
for pre-2026-10-11 rows and manual doctor-found captures). An unrecognised value
is stored as `""` rather than rejected -- a capture is worth more than its label.
The column was added through the existing `_migrate_header_locked` path and
verified against a copy of the live 1,940-row manifest before deploying: header
18 -> 19 columns, every legacy row's fields still aligned, old rows reading `""`.

### No clips, and none were being made

Worth recording because it was asked twice: an auto-capture **does not upload a
video clip**, and has not for some time. It sends `recording_id` +
`video_offset_ms`, a few bytes, so the reviewer seeks to the moment in the full
session recording instead -- the clip upload used to cost ~250 KB per capture on
a ~100 KB/s link and was starving the live frame stream. 172 `.webm` files
survive from the old behaviour; **none written since 2026-09-01**. A server-side
cutter (`review_clips.py`) can still slice a clip from a finished recording for
the reviewer's convenience, and the panel falls back to the offset text when
there is none.

## Open: what would settle it

The measurement that should have preceded all of this, and still should:

1. Replay the **50 saved clinic recordings** (825 MB, native frame rate, on this
   box) through RT-DETR @320 at conf 0.30, frame by frame.
2. Rebuild the IoU-0.25 tracks and report the hits-per-track distribution, then
   the release/suppress counts for `off`, 2-of-3, 3-of-5 and 4-of-7.
3. Push the episodes that **only `off` releases** into the review panel for
   clinician adjudication.

That converts "an unvalidated gate might be costing us lesions" into "N real
polyps hidden vs M artefacts correctly killed", which is the number needed to
choose a persistence rule rather than guess one.

Note that the TRUE-Colon benchmark **cannot** answer this: those prediction
CSVs are stills (one hashed frame per case folder, 7,167 rows), with no frame
sequences, so nothing in that corpus can measure persistence. The in-house
recordings plus reviewer adjudication are the only instrument available.
