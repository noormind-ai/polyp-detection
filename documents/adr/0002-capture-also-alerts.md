# Tier 3 (alert) fires whenever tier 2 (capture) fires, not on its own timer

## Status
Resolved 2026-09-29. **Superseded by [0004](0004-alert-mirrors-box.md)** (2026-10-08): tier 3 no longer
tracks tier 2 either -- it mirrors tier 1, the drawn box. The factoring-out
this ADR called for in its last consequence was done at the same time.

## Problem / Context
Live inference (`LiveCameraPlayer.tsx`, `RealtimePlayer.tsx`) responds to a
detection in three tiers, each with a harder bar than the last:

    tier 1  box on screen   temporal gate, 2-of-3 (~0.5s)   lib/temporal.ts
    tier 2  filed capture   FILE_MIN_MS=1000  + FILE_MIN_HITS=2
    tier 3  audible alert   ALERT_MIN_MS=2000 + ALERT_MIN_CONF=0.5

Tier 3 was deliberately the hardest bar to clear — twice tier 2's patience
plus a confidence floor neither other tier has — on the reasoning that a
spurious beep is the one failure mode that does real damage (Holzwanger et
al., Endoscopy 2021: CADe alert fatigue tracks with adenoma detection rate
falling from 49.9% to 39.9% across a list).

In practice, with the current model, that bar is now rarely cleared: captures
themselves (tier 2) are already infrequent, so the extra 1s of patience and
the confidence floor on top mean the room almost never hears the alert even
when a capture is being filed. The felt problem is "alerting is too hard."

Reframing the goal: the alert isn't there to filter capture-worthy detections
down to a rarer, more-certain subset. With capture volume already low, we
want the doctor to notice every captured frame — filing a capture silently
and only sometimes beeping about it isn't the desired behavior. The alert
should track the capture, not sit behind its own independent bar.

## Decision
Tier 3 no longer has its own timing/confidence gate. The alert fires exactly
when tier 2 files a capture — first filing of an appearance, and any
refresh capture (`AUTO_CAPTURE_REFRESH_MS`) while the same lesion stays on
screen. Concretely: `alertSound()` moves inside `flushBest()`, and
`ALERT_MIN_MS`, `ALERT_MIN_CONF`, and `episodeAlertedRef` are removed from
both `LiveCameraPlayer.tsx` and `RealtimePlayer.tsx` — tier 3 inherits tier
2's bar (`FILE_MIN_MS` + `FILE_MIN_HITS`) exactly, rather than adding its own
on top.

The tier 3 sound toggle (`ALERT_KEY`, off by default, operator's call) is
unchanged — this only changes *when* an enabled alert fires, not whether
audio in the room is opt-in.

### Alternatives considered

**Expose ALERT_MIN_MS/ALERT_MIN_CONF as an operator-facing sensitivity
control** (mirroring tier 1's gentle/medium/strong selector), rather than
changing the default behavior. Rejected for now: the ask here is a specific,
already-decided operating point ("beep for any image captured"), not a range
of options to expose — adding a control surface for a decision that's
already been made is unneeded complexity. Revisit if a future model raises
capture volume back to where an independent, stricter alert bar earns its
keep again.

### Consequences / risks
- Capture volume is the alert-fatigue control now, not a separate bar on top
  of it. -> If a future model (or a noisier deployment) raises capture
  frequency, tier 3 gets noisy again automatically, since it now equals tier
  2. Re-split the tiers (or reintroduce a stricter bar) if that happens —
  don't just retune tier 2's numbers to compensate, since that also quietly
  changes what gets filed for review.
- The two tiers were already duplicated across `LiveCameraPlayer.tsx` and
  `RealtimePlayer.tsx`; this change is applied in both rather than factored
  into a shared module, so a future change to either tier still has to be
  made twice. -> Worth factoring out if a third player or another tier
  change comes up.
