# Tier 3 (alert) mirrors tier 1 (the drawn box), and is factored into one module

## Status
Resolved 2026-10-08. Supersedes [0002](0002-capture-also-alerts.md).

## Problem / Context
Three places can now show a live detection — `LiveCameraPlayer.tsx` (camera,
screen share, demo clip, recording replay), `RealtimePlayer.tsx` (file-backed
real-time) and `app/spectator/[caseId]/page.tsx` (remote viewer) — and each had
arrived at a *different* answer for when to beep:

| where | when it beeped |
|---|---|
| `LiveCameraPlayer` | `ALERT_MIN_MS=2000` + >=2 hits + a box with `conf >= 0.5`, once per appearance |
| `RealtimePlayer` | inside `flushBest()` — once per filed capture, including every refresh capture (8s, then doubling to 64s) while one lesion stayed on screen |
| spectator | `alertEpisodeGate.ts` — 1000 ms + 2 hits, no confidence floor, once per appearance |

0002 had decided tier 3 should fire on capture, and applied that to both
players. Its own closing consequence predicted how this would go:

> The two tiers were already duplicated across `LiveCameraPlayer.tsx` and
> `RealtimePlayer.tsx`; this change is applied in both rather than factored
> into a shared module, so a future change to either tier still has to be made
> twice. -> Worth factoring out if a third player or another tier change comes
> up.

Both happened. A third player (spectator) was added with a third rule, and
`LiveCameraPlayer` was separately reverted to an independent 2 s + confidence
bar — uncommitted, undocumented, and live. Nothing was wrong with any one of
the three rules in isolation; the problem was that "is this worth announcing?"
was being answered independently in three files.

The deeper issue: every version of tier 3 so far has tried to define
"worth announcing" a *second* time, separately from tier 1 — which already
defines it. Tier 1 is the temporal gate, and its whole purpose is deciding
which detections are real enough to put in front of the doctor. A box that
cleared that bar and is being drawn on screen is, by construction, a detection
this app is already asserting. Announcing a strict subset of it means filing
and drawing things we decline to mention.

## Decision
**Tier 3's trigger is tier 1's rendered box state, and nothing else.** The
alert sounds on the no-box -> box edge, stops on the box -> no-box edge, and
runs for at most an operator-chosen duration (default 0.5 s) in between.
No timing bar, no hit count, no confidence floor of its own.

    tier 1  box on screen   temporal gate, 2-of-3 (~0.5 s)   lib/temporal.ts
    tier 2  filed capture   FILE_MIN_MS + FILE_MIN_HITS
    tier 3  audible alert   tier 1's bar exactly

Factored into three small modules that all three views share, so there is one
implementation rather than three:

- `lib/alertEpisodeGate.ts` — pure edge detector over `hasBox`. No timers, no
  `Date.now()`.
- `lib/alertSound.ts` — `createAlertVoice()`, now **start/stop** rather than
  fire-and-forget, because the alert has to be interruptible: the chirp is the
  attack, a quieter hold follows, and a release ramp ends it whether it ran to
  full duration or was cut off early.
- `lib/useAlertSound.ts` — the hook each view calls. Owns the mute and duration
  settings and exposes a single `onBoxState(hasBox)`.

Wired into each player's `updateBoxes()` — already the single writer of "what
is on screen right now", and what drives the "Polyp detected" indicator. So the
beep and the on-screen indicator are now literally the same trigger.

Mute stays **per device** (`polyp_alert_sound` for the room,
`polyp_spectator_alert_sound` for a spectator, each with its own AudioContext):
whether a given machine makes noise is that machine's call. Duration
(`polyp_alert_ms`) is **shared** — it is part of the alerting rule, not a
per-device preference.

`RealtimePlayer` deliberately exposes no controls, only consumes the stored
settings, so a demo behaves like the room it is demonstrating.

## Alternatives considered
**Keep an independent bar, but tune it.** This is what the uncommitted
`LiveCameraPlayer` revert was doing, and 0002 had explicitly left the door open
for it ("Re-split the tiers if a future model raises capture frequency"). The
re-split is what produced the three-way divergence, and it reintroduces the
problem 0002 was solving: with capture volume low, a bar stricter than tier 2
means the room hears nothing. Rejected — tuning a second definition does not
fix having a second definition.

**Keep tier 3 on tier 2 (0002's decision).** Correct about not wanting a
stricter bar, wrong about which tier to inherit from. Tier 2 includes a
*refresh* cadence, so one long look at one lesion got announced repeatedly
(8 s, 16 s, 32 s…), and tier 2's filing is coupled to the upload queue, which
has nothing to do with whether the room should be told something.

**Expose tier 3 sensitivity as a gentle/medium/strong selector** (mirroring
tier 1's). Rejected again, for 0002's reason: there is no range of operating
points to expose once tier 3 has no bar of its own. Duration is exposed
instead, which is a question about the room's tolerance for noise, not about
what counts as a detection.

## Consequences / risks
- **Tier 3 is now exactly as noisy as tier 1 is wrong.** Alert fatigue is a
  real cost (Holzwanger et al., Endoscopy 2021: CADe ADR falling 49.9% ->
  39.9% across a list), and the only control over it is now the temporal gate
  and the model's false-positive rate. -> That is the intended trade: tier 1 is
  the thing we actually tune and measure, and it is where a fix belongs. If the
  room finds it noisy, tighten tier 1 (medium/strong) rather than adding a
  fourth definition here.
- **Setting tier 1 to `off` makes the beep follow raw per-frame detections**,
  with no persistence filtering at all. -> Honest consequence of tying them
  together, and visible: `off` is an explicit operator choice, not a default.
- **Flicker tolerance is inherited, not reimplemented.** `TemporalGate.filter()`
  records a *miss* against a track rather than dropping it, so at the default
  gentle 2-of-3 a lesion that blinks out for a single frame stays drawn and
  does not re-beep. -> This is why the alert gate needs no `DETECTION_GAP_MS`
  of its own. If tier 1's hysteresis ever changes, tier 3's re-beep behaviour
  changes with it — which is the point, but note it is now a coupling.
- **A timed-out inference frame no longer silences the alert.** Hanging tier 3
  off `updateBoxes()` rather than `maybeAutoCapture()` means a dropped round
  trip leaves the last good boxes drawn and the alert running, instead of
  being treated as "the lesion left".
- Tier 2 is untouched: `FILE_MIN_MS`, `FILE_MIN_HITS`, best-frame selection and
  the refresh backoff from [0003](0003-auto-capture-refresh-throttle.md) all
  behave exactly as before. Captures are now silent.
