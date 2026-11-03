# Session recording: read from the `<video>` element, not the raw capture track

## Status
Open — code written and builds clean, not yet validated against real
capture-card hardware, not yet deployed to production at time of writing.

**Correction (2026-11-03): this is not what caused the Aban 6 incident.**
Live reproduction found the actual cause to be a separate, confirmed bug —
see `useSessionRecorder.ts`'s `putChunk()` status check. That bug alone
fully explains "duration says 11 minutes, file has 3 seconds," on any
hardware, with no capture card involved.

**Not shipped, by operator decision (2026-11-03).** The fix in this ADR
(recording from the decoded picture instead of the raw device feed) and its
accompanying stall watchdog addressed a real, independently-confirmed
hardware fragility — the new capture card can stop sending video entirely
after a physical cable disconnect/reconnect, with no recovery — but the
operator judged a physical mid-procedure disconnect unrealistic for actual
clinic use, and asked not to carry the extra code/risk for a scenario that
doesn't happen. Reverted out of the working tree; kept here only as a record
of what was found and why it wasn't pursued, should the question come up
again.

## Problem / Context

An 11-minute live-camera recording from the Masoud clinic (2026-10-28, case
`7abafa70`) turned out to contain **2.9 seconds** of real video. Confirmed by
remuxing the file (`ffmpeg -c copy`, frame count unchanged before/after) and
by server logs: only one chunk (`seq=0`) was ever uploaded in the whole
session, though the recorder's own bookkeeping — and the file's metadata —
still claimed ~11 minutes.

This was not a dead signal. Two AI-detection snapshots from the same session,
~2 minutes apart, show genuinely different endoscopic views — the live
picture kept changing the whole time. So whatever broke, it broke
specifically in the recording path, not in what the operator or the model
were seeing.

The capture card changed recently: confirmed via USB hardware ID
(`VID_534D&PID_2109`) to be a **Macrosilicon MS2109**, a commodity HDMI
capture chip, replacing the old analog (Somagic SMI2021, composite/S-Video)
card the deinterlace work in ADR 0006 was written against. Reproduced
directly: with no HDMI source connected, the MS2109 does not error or go
black — it silently substitutes its own built-in colour-bar test pattern and
keeps the UVC stream looking "live."

Every other new-card recording checked (server + two found later on the
clinic PC's local Downloads folder, never uploaded) showed the same pattern:
claimed duration far exceeding real frame count, in one case an outright
unreadable/corrupt container. The one available full-length old-card local
recording (`03c15dcf`, Oct 21) was clean: 28,346 real frames, no anomalies.

## Prior Work / Literature

| source | claim | verdict |
|---|---|---|
| [Chromium issue tracker #40745420](https://issues.chromium.org/issues/40745420) | MediaRecorder can silently stop producing data when a track's state changes | Could not actually read it (sign-in wall) — cited once, shouldn't have been; dropped as evidence |
| [mediamtx #3747](https://github.com/bluenviron/mediamtx/issues/3747) | "Video plays, recorder gets ~1-2s" — matches our symptom almost exactly | Symptom match confirmed. **Their actual fix was unrelated to ours**: a server-side FFmpeg keyframe-interval setting (`-g 60 -keyint_min 60`) on a stream from their own media server, not a browser capture device. No mention of `captureStream()`. Validates the *problem class* only. |
| Follow-up search for "`captureStream()` as fix for raw-track MediaRecorder stalls" | — | Found only *other*, unrelated `captureStream()` bugs (empty-blob race, a GPU-hardware-acceleration data loss bug, audio/video sync issues). **No external source recommends this specific fix.** |
| This codebase, `useSessionRecorder.ts`, file-source path (commit `6ee34a2`, 2026-08-14) | Records from `video.captureStream()` for demo/saved clips | Already running in production for months, for an unrelated reason (no raw device track exists for a file) — the strongest evidence available, because it's proof *in this exact stack*, not a general web claim |
| This codebase, ADR 0006 (deinterlace) | `<video>` must stay `opacity:0`, never `display:none`, or it stops producing frames for the capture loop | Directly relevant constraint, carried forward unchanged (see Consequences) |

**Honest bottom line**: no external source says "switch to `captureStream()`"
for this bug. The fix is this project's own engineering judgment, built on
in-house precedent and on how `captureStream()` is known to behave in this
codebase already — not a borrowed industry best practice. Flagged clearly so
this isn't mistaken for more settled than it is.

## Candidates

1. **`video.captureStream()` instead of the raw device track** — same
   technique already proven in this file for the camera/screen-share paths
   too. Cost: a few lines, reuses an existing pattern.
2. Recalibrate the out-of-body colour gate for the new card's colour
   rendering — **tested and rejected**, see Attempts: no evidence it was
   ever at fault.
3. Tune the capture card's own encoding (keyframe interval etc.), as
   `mediamtx`'s fix did — not applicable; we don't control the MS2109's
   firmware/encoding, only what Chrome does with its UVC output.
4. Detect-and-restart `MediaRecorder` on the raw track when it goes quiet —
   kept, but as a **safety net alongside** candidate 1, not instead of it:
   it still loses whatever happened during the gap before detection; a
   healthier underlying source (candidate 1) has no such gap.

## Attempts

### Ruling out the out-of-body gate — 2026-11-02
Ported the gate's real feature math (`inBody.ts`) to Python, ran it against
real saved frames from both cards. Old card (240 frames, 3 Aug-26 clinic
clips): mixed, one clip scored 31/80 frames below the out-of-body cutoff —
normal real-world variation. New card (116 surviving frames across 3
incident clips — the only new-card footage that survived): **0/116** ever
scored below cutoff; if anything more confidently "in body" than the old
card. Independently corroborated by the recorder's own pause bookkeeping for
the incident session: only ~15s of 11+ minutes was ever marked paused. Two
independent signals agree the gate was not the cause.

### Reproducing the card's fallback behaviour — 2026-11-02
Connected the MS2109 (on the investigator's own machine) with no HDMI source
plugged in. `ffmpeg` frame grab returned a clean 8-bar SMPTE colour-bar
test pattern, not an error or black frame — confirms the chip hides signal
loss rather than surfacing it.

### Checking the clinic computer's actual HDMI output — 2026-11-02
Remote display-topology check and a forced "Extend displays" action (via a
self-deleting scheduled task over SSH, run with the operator's explicit
sign-off) both showed Windows was not sending anything out that port at
all — a separate, real hardware/handshake issue, unresolved, needs a
splitter or dummy HDMI plug on-site. Orthogonal to the fix in this ADR.

## Decision (proposed, pending hardware validation)

Record from `video.captureStream()` for the camera and screen-share paths in
`LiveCameraPlayer.tsx`/`useSessionRecorder.ts`, matching what the file-source
path already does. Added alongside: a per-recording stall watchdog (mirrors
the existing pattern in `encoderPreview.ts`) that flags `MediaRecorder` going
quiet for ~2 missed chunk intervals, shows a visible on-screen warning, and
reports a `stall_events` count to the server's `/stop` endpoint so a future
incident is visible in the recording's own saved metadata instead of needing
hours of log correlation, as this one did.

### Alternatives considered

**Recalibrate the gate (candidate 2)** — pros: would have been cheap if
true. / cons: measurement found no fault to fix; recalibrating a working
component on a hunch risks introducing a new problem while leaving the real
one untouched. Rejected on evidence, not cost.

**Restart-on-stall only, keep the raw track (candidate 4 alone)** — pros:
keeps the original "camera's own frames, nothing else in the pipe" property
fully intact. / cons: still loses real footage during the gap between a
stall starting and the watchdog catching it (strikes × check interval, a
handful of seconds each time); doesn't address the chip's apparent tendency
to never recover once its encoder pipe desyncs. Kept as a safety net, not a
replacement — a confirmed stall going forward is still useful data even with
the stream-source fix in place.

### Consequences / risks

- **The original reason for recording the raw track** (commit `6ee34a2`,
  Aug 2026) was to keep the saved file free of the AI's detection-box
  overlay, not card resilience. Checked: boxes are drawn on a separate
  canvas (`drawBoxes`), never onto the `<video>` element itself, so
  `captureStream()` still reads the clean, unannotated picture. That
  property is preserved. → if a future overlay implementation ever draws
  directly onto the video element, re-check this.
- **ADR 0006's `display:none` constraint now matters for recording too, not
  just the live deinterlace canvas** — if the `<video>` element is ever
  hidden with `display:none` instead of `opacity:0` while a recording is
  active, `captureStream()` would starve the same way the live panel would.
  No new code path introduces this risk; it was already a hard rule. →
  worth a comment at the recording call site cross-referencing this, not
  yet added.
- **`captureStream()` has its own known bugs in other projects** (see
  literature table) — none matched to our stack, but not independently
  ruled out here either.
- **Not yet tested against real hardware.** The build is clean and typechecks,
  but this class of bug only showed up on real hardware in the first place —
  a clean build proves the logic, not the fix. Plan: loop this machine's own
  HDMI output into the MS2109 (no endoscope needed), record through the real
  `/` live-camera page, deliberately unplug/replug mid-recording, check the
  saved file's real frame count and whether the new stall warning fires.
- **Not deployed.** Changes are committed locally only (pending), not pushed
  to `origin/live-recording`, not on `noormind-iran`. This project's own
  rules call for confirmation before touching a live/shared branch, and this
  touches the live clinical recording path specifically.
