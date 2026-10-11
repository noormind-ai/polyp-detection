# Deinterlacing: blend, in the browser, on both panels

## Status
Resolved 2026-10-11. **Confirmed working in the clinic app by the operator** on both
panels, including fast motion -- the symptom that drove four of the five attempts
below. Revised three times the same day as measurements overturned earlier reasoning — the attempts below are kept in full, because each wrong turn
was caused by a specific habit worth not repeating.

## Problem / Context

The clinic's endoscope reaches us over **composite analog SD** into an ezcap Video
Grabber (Somagic SMI2021, USB `1c88:1001`). Composite is the only output free on the
processor, so interlacing cannot be designed out: every frame is two half-pictures
captured 1/60 s apart and woven together, and wherever something moved the two halves
disagree and produce a zipper.

Measured, not assumed: `ffmpeg -vf idet` reports **679 of 679 frames interlaced,
top-field-first** on our own clinic recordings, and still 679/679 after cropping the
padding band away — so it is the picture, not the pad.

Nothing in the file says so. WebM/VP9 cannot signal interlace at all
(`field_order=unknown`), so no player ever deinterlaces these, and `MediaStreamTrack`
exposes no equivalent. The only evidence is pixels.

**This is orthogonal to the PAL/NTSC fix in `lib/cameraMode.ts`.** That chose the right
capture mode (geometry, green band, frame rate). Both modes the card offers are
interlaced — PAL 720x576@25 is 50 fields/s, NTSC 720x480@29.97 is 59.94 — so this work
is required either way.

### The capture card cannot help

`ffmpeg -f dshow -list_options` on the real device:

```
uyvy422  720x576  fps=25       PAL
uyvy422  720x486  fps=29.97    NTSC
uyvy422  720x480  fps=29.97    NTSC
Crossbar Output "Video Decoder" current input pin: 1 = "Video Composite"
```

Raw UYVY only — **no deinterlace mode of any kind**. A Magewell-class card exposes
*Weave / Blend / Top-field-only* in hardware; this one is a dumb analog-to-USB bridge.
Software is the only option.

## Prior Work / Literature

| source | claim | verdict |
|---|---|---|
| VideoHelp, "deinterlace when downscaling?" | Deinterlacing must precede any *vertical* resize | Adopted — and it is why the 320px model input needs nothing (see Attempts) |
| Wikipedia, *Deinterlacing* / *Line doubler* | Single-field ("bob") is the simplest deinterlacer; halving vertical size exactly *is* a deinterlace | Both used |
| Doom9 / VideoHelp deinterlacer comparisons | bwdif > yadif > bob; bwdif weaves static content to full resolution | Confirmed by our own measurement, with one surprise — see below |
| dayverse, *Why ffmpeg.wasm fails to leverage GPU* | WebAssembly has no pathway to the GPU; ffmpeg.wasm is for transcoding, not realtime per-frame filtering | Ruled out ffmpeg.wasm |
| webrtcHacks / WebCodecs guidance | No off-the-shelf JS/WebGL deinterlacer exists; the documented path is porting yadif into a shader | Accepted as the upgrade path, not taken now |
| QTGMC wiki; QSVEnc #294 | QTGMC is the gold standard: motion-compensated, 1-3 fps at 1080p, CPU-only; an in-progress GPU port targets ~20 fps and is still "not real-time" | Out of reach at 26 fps |

## Candidates

1. Progressive output from the processor (DVI/HDMI/3G-SDI)
2. Hardware deinterlace in the capture card
3. Blend — average the two half-pictures
4. Bob — discard one half-picture
5. Motion-adaptive — weave where still, interpolate where moving
6. Port yadif/bwdif to WebGL

## Attempts

### Probing the source — 2026-10-11
`idet` 679/679 TFF. 720x576, exactly 25.000 fps, plus 96 rows (480-575) of pure
green — an *unwritten* buffer (Y=0,U=0,V=0), the PAL/NTSC mismatch, handled separately.

Retracted along the way: the 25 fps was first read as evidence of 29.97 -> 25 frame
decimation. Packet timestamps refute it — gaps alternate 32/48 ms about a mean of
exactly 40.00 ms with **zero** 67 ms gaps, which decimation would require.

### The 320px model input needs nothing — 2026-10-11
Candidates 1 and 2 are unavailable, so the first implementation deinterlaced
everything, including the frame sent to the model. Measured later at the size the model
actually sees:

| clip time | woven, drawn straight | field discarded first |
|---|---|---|
| 2.5s | comb 0.650, detail 3.34 | comb 0.561, detail 3.17 |
| 5.0s | comb 0.604, detail 6.24 | comb 0.563, detail 6.08 |
| 12.0s | comb 0.645, detail 5.04 | comb 0.561, detail 5.06 |

**Already clean at 320px.** Squashing 480 lines into 213 averages neighbouring lines and
cancels the comb by itself — the downscale *is* a blend deinterlace. Detail identical.
Reverted; the model input is drawn straight.

### Bob shipped, and the operator rejected it — 2026-10-11
Bob measured clean (0.55 against a source of 1.9-2.1) and 44 frames from the live app
confirmed it. The operator still reported comb. It was not comb: bob halves vertical
resolution *everywhere* and the doubling reads as horizontal banding — invisible while
the Detected panel showed a 320px thumbnail, obvious once it showed frames at native
size.

### Motion-adaptive, attempt 1: spatial — FAILED — 2026-10-11
"Still" judged by comparing a line against the average of its neighbours. Measured
comb **1.835** against a source of 2.141 — barely deinterlaced. On smooth mucosa a line
sits close to its neighbours' average whether or not anything moved, so a spatial test
cannot tell "still" from "soft".

### Motion-adaptive, attempt 2: temporal — shipped, then withdrawn — 2026-10-11
"Still" judged against the previous frame. Measured comb 0.61-0.72 with ~8% more detail
than bob, and shipped. The operator reported it was *worse*, especially on fast motion.
They were right. A threshold sweep showed why:

| thresholds | pixels keeping their REAL line | interpolated | comb |
|---|---|---|---|
| 2/6 (shipped) | **8.7%** | 85.6% | 0.610 |
| 12/24 | 18.3% | 68.6% | 0.707 |
| 20/40 | 25.5% | 24.7% | **1.124 — comb returns** |

It could only weave 8.7% of pixels — the scope moves too much — and those few included
enough wrong calls to leave **patchy, irregular comb fragments** exactly where motion
was. Irregular residue reads worse than uniform comb. It cost ~11 ms/frame to be
measurably dirtier than a 0.1 ms method.

### Two measurement mistakes, recorded — 2026-10-11

- **"98% of frames are duplicates."** False. An artifact of decoding with ffmpeg, which
  pads to a constant rate against the bogus `r_frame_rate=1000/1` header in these files.
  The browser sees **120/120 distinct frames**. A duplicate-frame guard was written on
  this premise and removed.
- **"No deinterlacer can recover the lines lost to motion."** Wrong — see below.

### Is it noise rather than motion? — no — 2026-10-11
Composite capture is noisy, so the thresholds might have been firing on noise. Noise
floor on the most static frame pair: median 1, p90 7, **10.4% above T_MOVING=6**.
But the code interpolated 85.6%, so ~75 points is genuine motion. 3x3 averaging
recovers ~2 points and barely dents the noise (structured line noise, not white).
Dead end — recorded so it is not re-tried.

### The comparison that settled it — 2026-10-11
The browser implementation had never been measured against a real deinterlacer.
References generated with ffmpeg (`setfield=tff` then `yadif`/`bwdif`) on the same
clinic clip, everything scored on the same frames:

| method | comb | detail | PSNR vs bwdif | SSIM |
|---|---|---|---|---|
| source (woven) | 1.545 | 3.16 | 33.45 | 0.9961 |
| bwdif (ffmpeg) | 0.592 | **3.02** | — | 1.0000 |
| yadif (ffmpeg) | 0.593 | 2.76 | 45.65 | 0.9999 |
| **blend** | **0.500** | 2.67 | **35.11** | **0.9977** |
| bob | 0.565 | 2.83 | 28.76 | 0.9902 |
| motion-adaptive (deployed at the time) | **0.743 — worst** | 2.97 | 30.64 | 0.9928 |

And split by motion, which is what the operator was reacting to:

| method | gentle | medium | **fast** |
|---|---|---|---|
| source | 1.146 | 1.459 | 1.992 |
| motion-adaptive | 0.748 | 0.760 | 0.726 |
| bob | 0.561 | 0.563 | 0.573 |
| **blend** | **0.500** | **0.500** | **0.500** |
| bwdif | 0.595 | 0.590 | 0.592 |

**Blend is flat at 0.500 at every motion level** — the only method whose comb does not
degrade as motion rises, and lower than bwdif's. Structural: averaging a line pair
cancels the alternation exactly, however far apart the two fields are.

**bwdif keeps 96% of the source's vertical detail (3.02 vs 3.16) while removing the
comb**, which disproves the earlier claim that motion-lost detail is unrecoverable. It
motion-compensates — shifting the other field's real pixels into place rather than
interpolating.

All six variants were rendered side by side at three motion levels and published at
**`/interlace/index.html`**; the operator compared them and chose blend, which the
numbers above independently support.

## Decision

**Blend, in the browser, on every full-size path — and only when the pixels say the
source is interlaced.**

- `createDeinterlacer()` in `lib/interlace.ts` halves the height with smoothing ON
  (averaging each line pair, one from each field) and scales back. Two `drawImage`
  calls, ~0 ms, **no tuning constants** — so it is unaffected by the switch from PAL
  25 fps to NTSC 29.97 fps, and will ghost slightly *less* there (fields 16.7 ms apart
  instead of 20 ms).
- Used by `grabCapture()`, `captureCanvas()`, and now the **Live panel**, which paints
  through a canvas driven by `requestVideoFrameCallback` instead of showing the
  `<video>` directly. The `<video>` stays in the DOM at `opacity: 0` — it holds the
  MediaStream and the capture loop reads from it; `display:none` would stop it
  producing frames. A failure reveals it again rather than showing a black panel.
- **The 320px model input is NOT deinterlaced** — the downscale already is one.
- `lib/interlace.ts` decides scan type from pixels, latching on the first frame showing
  comb and only concluding "progressive" after 60 frames; comb proves interlacing, its
  absence proves nothing about a still picture.
- `sourceRect()` snaps `y`/`h` to even scanlines.
- **Review clips get `yadif`** — human-facing, occasional, so a proper filter is free.
- **The session recorder keeps the raw woven stream**, preserving both fields for a
  better offline deinterlace when this becomes training data.

### Alternatives considered

**Progressive output (candidate 1)** — the only true cure. Only composite is free on
this processor. Still the right answer if that changes.

**Hardware deinterlace (candidate 2)** — zero CPU, fixes every consumer at once, no
code. The SMI2021 does not offer it. **A Magewell-class card would, and would also have
prevented the PAL/NTSC episode** — worth buying before investing further in software.

**Bob (candidate 4)** — pros: no ghosting, keeps slightly more measured detail (2.83 vs
2.67). / cons: more comb at every motion level (0.565-0.573 vs a flat 0.500), and the
line-doubling is visible at native size. Rejected on the operator's side-by-side.

**Motion-adaptive (candidate 5)** — pros: in principle keeps every real scanline in
still areas. / cons: measured worst of everything, 100x the cost. Rejected.

**Port yadif/bwdif to WebGL (candidate 6)** — the real upgrade, and the only software
route to bwdif's 96% detail retention. Deferred: no off-the-shelf implementation
exists, and blend already beats both on the metric the operator cares about.

### Consequences / risks

- **Blend averages two moments**, so fast motion shows mild ghosting instead of a
  zipper. This is the trade that was consciously chosen; it is also why blend scores
  lowest on "detail" (2.67) — a measure that counts comb itself as detail.
- **Vertical detail is roughly halved** on moving content. Recoverable only by motion
  compensation (bwdif/QTGMC) or by capturing progressive. -> documented upgrade path.
- **The Live panel now costs a canvas draw per decoded video frame.** ~0 ms for blend,
  driven by `requestVideoFrameCallback` so it never repaints an unchanged frame.
  -> if the deinterlacer is ever made expensive again, re-check this.
- **The `<video>` must never be `display:none`** — it would stop producing frames and
  the capture loop would stall. -> `opacity` only, commented at the call site.
- **The detector needs motion** to see comb; a still scope delays the decision.
  -> 60-frame budget, latch on first positive, default to not deinterlacing.
- **Quality gate thresholds were fitted on combed input**; measured shift was +4.7% and
  in the safe direction, so no retune shipped. Watch the `"blurry"` rejection rate.
- **The comparison page is NOT in version control.** It lives at
  `frontend/public/interlace/` on the box (served at `/interlace/index.html`) and is
  gitignored: it is ~4.4 MB of real patient frames, and git history is impractical to
  purge if that ever becomes a problem. The numbers it supports are all in this ADR;
  only the pictures are impermanent. To regenerate after changing the deinterlacer:

  ```sh
  # references, straight from ffmpeg, on a 720x576 clinic recording
  ffmpeg -vsync 0 -i CLIP.webm -vf "crop=720:480:0:0"                        -frames:v 40 woven/%03d.png
  ffmpeg -vsync 0 -i CLIP.webm -vf "crop=720:480:0:0,setfield=tff,yadif=0:0:0" -frames:v 40 yadif/%03d.png
  ffmpeg -vsync 0 -i CLIP.webm -vf "crop=720:480:0:0,setfield=tff,bwdif=0:0:0" -frames:v 40 bwdif/%03d.png
  ```

  `-vsync 0` matters: these files carry a bogus `r_frame_rate=1000/1`, and without it
  ffmpeg pads to a constant rate by duplicating frames — which is what produced the
  false "98% of frames are duplicates" reading recorded above. Score each variant on
  comb (mean |row y - row y+1| over mean |row y - row y+2|), on detail (the
  denominator alone), and on PSNR/SSIM against bwdif. Pick frames by measured
  inter-frame difference so gentle, medium and fast motion are all represented —
  methods separate most at the fast end.
