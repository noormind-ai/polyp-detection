# Auto-capture refresh: throttling repeated captures of a lesion that stays on screen

## Status
Resolved 2026-09-30

## Problem / Context
`maybeAutoCapture` (`RealtimePlayer.tsx`) files a fresh capture every
`AUTO_CAPTURE_REFRESH_MS` (8s) for as long as the same episode (continuous
detection, gaps under `DETECTION_GAP_MS`) stays on screen -- regardless of
whether the box's position, size, or the frame's appearance has changed at
all. A doctor lingering on one static polyp for 30s currently produces ~4
review-queue entries that are visually close to identical. Raised
2026-09-30 while reviewing whether long dwells flood the review queue.

## Prior Work / Literature
| source | claim | code available? | verdict |
|---|---|---|---|
| Holzwanger et al., Endoscopy 2021 (already cited in `RealtimePlayer.tsx`) | operating points for tier 1/2 timing bars | n/a | already applied; not revisited here |
| "Computer-Aided Colonoscopy Alert Fatigue and its Effect on Adenoma Detection" (PMC12900971) | repeated CADe alerts measurably track with falling adenoma detection rate | no | treats repeat-capture volume as a real clinical risk, not just a UX nicety |
| General alerting practice (industry writeups: Datadog, LogicMonitor, etc.) | dampening, exponential backoff, and deduplication are the three standard mitigations for repeat-alert noise | n/a -- not this codebase | backoff (candidate 2) and change-gating (candidate 3) below are the two with direct precedent |
| Video near-duplicate / hard-example-mining literature (arXiv 1808.04285; MDPI 2024, 13(8):1522) | appearance-similarity thresholds (NCC / IoU / perceptual hash) are the standard way to decide "is this frame actually new" | yes, generic -- not polyp-specific | supports change-gating (candidate 3) |

## Candidates

1. **Status quo -- fixed 8s refresh.** No code change. Simple, already
   shipped, and keeps catching appearance drift (scope angle, lighting,
   occlusion) on a lesion that never physically moves, since it doesn't need
   to detect that drift to act. Cost: floods the queue on long dwells with
   visually redundant frames -- the exact failure mode the alert-fatigue
   literature above flags.

2. **Exponential backoff.** After the first refresh, each subsequent
   refresh for the same episode waits longer than the last -- e.g. 8s, 16s,
   32s, optionally capped (60s). One-line change to the `due` check in
   `maybeAutoCapture`: track a growing interval instead of reading the
   constant `AUTO_CAPTURE_REFRESH_MS` directly. Needs no new signal -- no
   similarity/IoU computation, no new dependency or threshold to tune. Still
   captures periodically regardless of content (so a long static dwell still
   yields more than one frame), just at a shrinking rate. Does nothing for a
   *short* dwell -- first refresh is still 8s either way -- which is fine
   since the problem is specifically long dwells.

3. **Change-gating.** Only file a refresh capture if the box moved/resized
   past a threshold (IoU against the last-filed box) or reported confidence
   shifted meaningfully. Directly targets "don't recapture the literally same
   thing," so it's the more precise fix for the stated problem. Needs a new
   signal (an IoU or perceptual-similarity check) and a threshold to tune --
   genuinely new logic, with its own failure modes: too loose and it doesn't
   help; too tight and score jitter alone re-triggers it on a static lesion,
   or it misses a real re-angling the threshold doesn't count as "changed."

4. **Combination -- change-gating as the primary rule, backoff as a
   fallback ceiling.** Refresh on meaningful change (candidate 3), but if a
   lesion sits with truly no change past some long ceiling (e.g. 30-60s),
   file one anyway so an extremely long dwell isn't completely absent from
   the queue. Gets both properties at once, at the combined cost of both --
   the new similarity signal from (3) plus a second timer from (2).

## Decision
Candidate 2, exponential backoff -- chosen explicitly over change-gating
(candidate 3) for lower complexity: no new similarity/IoU signal to build
or tune, just a growing wait on the existing timer.

`AUTO_CAPTURE_REFRESH_MS` (8000ms) is now the *initial* refresh interval
rather than a constant one. A new ref, `refreshMsRef`, starts at that value
and doubles after each refresh capture, capped at a new constant
`AUTO_CAPTURE_REFRESH_MAX_MS` (64000ms -- 8s doubled three times). It resets
back to the initial value whenever an episode ends or a new one begins, so
each fresh appearance starts the sequence over. First-capture timing
(`FILE_MIN_MS`/`FILE_MIN_HITS`) is unchanged -- only the *refresh* cadence
for a lesion that stays on screen is affected. Resulting cadence for a
lesion that never leaves the screen: first file ~1s in, then refreshes at
+8s, +16s, +32s, +64s, +64s, ... (capped).

### Consequences / risks
- The same logic was duplicated between `RealtimePlayer.tsx` and
  `LiveCameraPlayer.tsx` (per the `0002-capture-also-alerts.md` precedent),
  and this change was applied identically in both -- still not factored
  into a shared module, so a future change to tier 2 still has to be made
  twice.
- The cap (64s) and growth rate (doubling) are untuned guesses, not
  measured against real dwell times -- revisit if review-queue volume on
  long dwells is still too high (lower the cap or the growth rate) or a
  long static look goes too sparsely represented (raise the cap).
