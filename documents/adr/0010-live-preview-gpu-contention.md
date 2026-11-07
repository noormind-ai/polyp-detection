# Live preview panel contends for GPU/CPU, slowing JPEG encode and FPS

## Status
Open — mitigated 2026-11-07 (live preview now defaults off), root cause not fixed.

## Problem / Context

On the clinic PC (Intel N100, weak integrated GPU), JPEG encode of each live
frame (`jpegEncoder.encode()`, run in a Worker via `OffscreenCanvas.convertToBlob`)
measured **100-170 ms** during normal live use, against **17-22 ms** for the exact
same encode operation tested in isolation (same machine, same frame size).

The single most effective lever found: **turning off the live preview panel**
(`showLive`) restores fast encode, and the AIMD quality controller (see
`documents/live-inference-bitrate-adaptation.txt`) settles at a higher quality
and better FPS. This happens with deinterlacing already set to "off" by the
operator.

## Attempts

### DevTools Performance trace analysis — 2026-11 (ongoing)
Real production traces (not synthetic benchmarks) pulled from the clinic PC and
read via Bottom-Up/Call Tree, per-thread:

- **Recordings `<select>` re-rendering every inference frame** — an unstable
  `t()` function reference (not wrapped in `useCallback`) broke memoization of
  the dropdown's option list app-wide. Confirmed 47.8% -> 3.1% main-thread cost
  after fixing (commit `74f15b3`, `bdb5433`). **Zero measurable effect on JPEG
  encode time** — ruled out as a cause of the encode slowdown specifically,
  even though it was a real, separate bug worth fixing.
- **`willReadFrequently` canvas hint** — tested, no significant effect either
  machine.
- **Fresh-vs-reused canvas per frame** — real but small effect only.
- **`recv_ms` quality-controller bug** — the server stamps its receive-wait
  timer right after finishing the *previous* frame's reply, so `recv_ms`
  conflates client encode time with real network time. Fixed by switching the
  AIMD decision to `curNet` (`rtt - modal_ms`, scoped to one request/reply pair)
  instead (commit, see `LiveCameraPlayer.tsx:1771-1786` comment for the full
  reasoning). This explained the quality/FPS dips previously seen on mouse
  movement, hiding the preview, and stopping recording as one mechanism, not
  several unrelated bugs — but per the analysis below, `curNet` is stamped
  *after* encode already finished, so it should not be moved by encode time at
  all. If quality still drops when the panel contends for GPU, the likely
  mechanism is main-thread scheduling delay inflating `curNet` indirectly (a
  busy main thread delays when the reply-arrived code actually runs), not
  encode time entering the formula directly. Not yet confirmed with real
  traces — the HUD now shows `longTaskMs` next to `curNet` and server-ms
  specifically so this can be checked without a new build.
- **Deinterlace "weave" (off) mode still running its full GPU pipeline** —
  `GLDeinterlacer.process()` did not early-return for `mode === "weave"` the
  way it already did for `"legacy"`, so the full texture-upload + shader pass
  ran every frame and was simply discarded. It also always uploaded a second
  "history" texture (`texPrev`) even though only `yadif`/`bwdif` ever read it.
  Fixed (commit `4358229`): `weave` now skips the GPU path entirely, and
  `texPrev` upload is skipped for any mode that doesn't need it. **Deployed,
  not yet verified against a new live trace** — this was the last change made
  before this document was written.

### Still open
Why `convertToBlob` itself stays slow even with the live preview panel fully
*disabled* (so no draw, no GL calls at all) was never conclusively explained.
Candidates not yet tried: `chrome://tracing` with
`disabled-by-default-skia.gpu`/`gpu`/`video` categories enabled; OS-level
`Get-Counter '\GPU Engine(*)\Utilization Percentage'` sampled per-process
during a live session, time-aligned against the HUD's on-screen encode-ms
reading, to get a direct (not inferred) answer to "is the GPU actually busy
during the slow encodes, and with what."

## Decision

**Default the live preview panel off** (`showLive` now starts `false`,
`LiveCameraPlayer.tsx:753`), rather than leave it on while root-causing the
GPU contention. This achieves zero preview-related cost for anyone who
doesn't explicitly need to watch the live feed while inference runs — which
based on testing is most of the measured slowdown's trigger — accepting that
operators who do want the live preview must click "Show" every session (the
choice is not persisted to `localStorage`, unlike other operator toggles in
this file), and will still hit the underlying slowdown until it's root-caused.

### Consequences / risks
- Not persisted — resets to off on every reload/new session. If this turns
  out to be the wrong default for a specific clinic workflow, that's a
  one-line change back (`useState(true)`), not a design decision to revisit.
- Does not fix the root cause — if `convertToBlob` is still slow with the
  panel off (open question above), this default change won't help that case.
- The deinterlace-weave fix (immediately prior entry) may turn out to make
  this mitigation unnecessary once verified live — if a future trace with the
  preview *on* shows encode back to ~20-30ms, consider flipping the default
  back and removing this ADR's "Open" status.
