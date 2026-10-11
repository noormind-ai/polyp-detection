/**
 * Is this source interlaced?
 *
 * The clinic's signal is analog SD over composite (see lib/cameraMode.ts for
 * how the capture mode is chosen), and analog SD is interlaced: every frame is
 * two fields captured 1/60s apart and woven together, so on anything that moved
 * the even lines show the scene 16.7ms before the odd ones. Measured on our own
 * clinic recordings, ffmpeg's idet reports 679 of 679 frames interlaced,
 * top-field-first.
 *
 * But the live players do not only ever see that card. The same capture loop
 * runs over a screen share (a progressive desktop), the bundled demo clips
 * (progressive public datasets), a saved recording, and a file the operator
 * picked off their own disk. Deinterlacing is not free on those: it throws away
 * half the vertical resolution, and at the sizes grabCapture works at that is a
 * real loss, not a rounding error. So it has to be asked, not assumed.
 *
 * Nothing in the file can answer it. WebM/VP9 cannot signal interlace at all
 * (`field_order=unknown`), MediaStreamTrack exposes no such property, and a
 * capture card will happily hand over woven frames with no flag anywhere. The
 * only evidence is the pixels.
 *
 * ## The measure
 *
 * Compare two vertical differences over the same frame:
 *
 *     dAdjacent  mean |row[y] - row[y+1]|     neighbouring lines
 *     dSameField mean |row[y] - row[y+2]|     two apart -- the SAME field
 *
 * On progressive video, neighbouring lines are more alike than lines two apart,
 * simply because real images are vertically smooth: the ratio sits below 1.
 *
 * On interlaced video the two neighbouring lines are different *moments*, while
 * the lines two apart are the same moment. Motion therefore inflates the first
 * and not the second, and the ratio climbs above 1.
 *
 * Measured on real material, the gap is wide and empty:
 *
 *     progressive (synthetic motion)        median 0.70   max 0.73
 *     progressive (a clip we yadif'd)       median 0.61   max 0.63
 *     interlaced clinic recording A         median 1.23   max 1.65
 *     interlaced clinic recording B         median 1.99   max 3.24
 *
 * The second row is the useful self-check: run our own deinterlaced output back
 * through this and it reads progressive, which is what it now is.
 */

/** Horizontal sample width. Vertical resolution is NOT reduced -- the whole
 *  signal being measured lives in the line-to-line differences, so any vertical
 *  resample would average the comb away before it could be seen. Scaling across
 *  is free of that problem and keeps the loop cheap. */
const SAMPLE_WIDTH = 240;

/** Above this ratio, call it interlaced. Sits in the middle of the measured gap
 *  (progressive tops out at 0.73, interlaced starts at 1.23), so it is not a
 *  threshold anything is close to -- which is the point. */
export const COMB_THRESHOLD = 1.0;

/** Reused across calls. A canvas per sampled frame would churn for nothing. */
let probe: HTMLCanvasElement | null = null;

/**
 * Comb ratio for one frame, or null when it cannot be measured.
 *
 * Null means "cannot tell" -- a frame with no dimensions, a cross-origin video
 * the browser will not let us read back, or a frame so flat that the
 * denominator is zero. Never treated as "progressive", because a wrong answer
 * in that direction silently leaves the comb in.
 */
export function combRatio(source: CanvasImageSource, vw: number, vh: number): number | null {
  if (!vw || vh < 3) return null;

  const sw = Math.min(SAMPLE_WIDTH, vw);
  const sh = vh; // never scaled -- see SAMPLE_WIDTH

  if (!probe) probe = document.createElement("canvas");
  if (probe.width !== sw) probe.width = sw;
  if (probe.height !== sh) probe.height = sh;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  let data: Uint8ClampedArray;
  try {
    // Horizontal scale only: sw/vw across, 1:1 down.
    ctx.drawImage(source, 0, 0, vw, vh, 0, 0, sw, sh);
    data = ctx.getImageData(0, 0, sw, sh).data;
  } catch {
    return null; // tainted canvas
  }

  // Differenced pixel by pixel, not between row averages: a comb that is bright
  // on one side of the frame and dark on the other has a row mean barely
  // different from its neighbour's, so averaging first would cancel the very
  // thing being measured.
  //
  // Green only. It carries most of the luma weight in Rec.601, so it tracks
  // brightness closely at a third of the reads -- and since this is a ratio of
  // two differences taken the same way, the exact weighting cancels out.
  let adj = 0, same = 0;
  for (let y = 0; y + 2 < sh; y++) {
    const r0 = y * sw * 4, r1 = (y + 1) * sw * 4, r2 = (y + 2) * sw * 4;
    let a = 0, s = 0;
    for (let x = 0; x < sw; x++) {
      const p0 = data[r0 + x * 4 + 1];
      a += Math.abs(p0 - data[r1 + x * 4 + 1]);
      s += Math.abs(p0 - data[r2 + x * 4 + 1]);
    }
    adj += a / sw;
    same += s / sw;
  }

  if (same <= 0) return null; // flat frame: nothing to compare
  return adj / same;
}

/** True when a frame's comb ratio clears the threshold. Convenience wrapper so
 *  callers do not each repeat the null handling. */
export function looksInterlaced(ratio: number | null): boolean {
  return ratio !== null && ratio > COMB_THRESHOLD;
}

/* ------------------------------------------------------------------ *
 *  Deinterlacing
 * ------------------------------------------------------------------ */

export interface Deinterlacer {
  /** Draw a region of `video` into `dst`, progressive.
   *
   *  `frameKey` identifies the source frame. Unused by this implementation --
   *  it is stateless -- but kept in the signature because a motion-compensated
   *  replacement would need it. */
  draw(video: CanvasImageSource, sx: number, sy: number, sw: number, sh: number,
       dst: HTMLCanvasElement, dw: number, dh: number, frameKey: number): void;
  /** Forget any per-source state. A no-op here; kept so callers do not have to
   *  care which implementation they hold. */
  reset(): void;
}

/**
 * Blend deinterlacing: average the two half-pictures together, then scale back
 * to full height.
 *
 * Averaging a pair of lines cancels the comb outright -- the zipper is an
 * alternation about the true value, so the mean of the two sits on it. The
 * price is temporal: the result is a blend of two moments 1/60s apart, so fast
 * motion shows a little ghosting rather than a zipper.
 *
 * ## Why this, measured on the clinic's own footage against ffmpeg
 *
 *     method                comb     detail   PSNR vs bwdif   SSIM
 *     source (woven)        1.545    3.16     33.45           0.9961
 *     bwdif (ffmpeg)        0.592    3.02     -               1.0000
 *     yadif (ffmpeg)        0.593    2.76     45.65           0.9999
 *     blend (this)          0.500    2.67     35.11           0.9977
 *     bob                   0.565    2.83     28.76           0.9902
 *     motion-adaptive       0.743    2.97     30.64           0.9928
 *
 * (comb below 1.0 is clean, lower better; detail higher is sharper.)
 *
 * Blend has the lowest comb of anything tried -- lower than bwdif -- and is the
 * closest match to the bwdif reference by both PSNR and SSIM. It loses only on
 * "detail", and that measure counts vertical high-frequency content, which
 * comb itself contributes to; it penalises blend for removing the artifact.
 * The operator compared all six side by side on real footage and picked this
 * one. See /interlace/index.html for the images those numbers came from.
 *
 * ## What was here before, and why it went
 *
 * A motion-adaptive version that wove wherever it judged nothing had moved.
 * In principle strictly better -- still areas keep every real scanline -- but
 * it could only weave 8.7% of pixels, because the scope moves, and the few it
 * did weave included enough wrong calls to leave patchy, irregular comb
 * fragments exactly where the motion was. On screen that reads worse than
 * uniform comb. It measured worst of every option and cost ~11ms a frame to
 * do it.
 *
 * ## The upgrade path, when it is wanted
 *
 * bwdif removes the comb AND keeps 96% of the source's vertical detail (3.02
 * against 3.16), which proves the detail lost to motion is genuinely
 * recoverable: it motion-compensates, shifting the other field's real pixels
 * into place rather than interpolating. There is no off-the-shelf JS
 * deinterlacer, so that means porting it to WebGL -- or buying a capture card
 * that does it in hardware, which would also have avoided the PAL/NTSC
 * problem. Not a CPU loop in this file.
 */
export function createDeinterlacer(): Deinterlacer {
  let half: HTMLCanvasElement | null = null;

  return {
    reset() { /* stateless */ },

    draw(video, sx, sy, sw, sh, dst, dw, dh, _frameKey) {
      const hh = Math.max(1, sh >> 1);
      if (!half) half = document.createElement("canvas");
      if (half.width !== sw) half.width = sw;
      if (half.height !== hh) half.height = hh;

      const hctx = half.getContext("2d")!;
      // Smoothing ON at exactly 0.5 vertical averages each pair of lines --
      // one from each field -- which is what cancels the comb. (Smoothing OFF
      // here would instead pick one line of the pair, which is "bob".)
      // Resizing a canvas resets its context, so this must be set after the
      // resize, every time.
      hctx.imageSmoothingEnabled = true;
      hctx.imageSmoothingQuality = "high";
      hctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, hh);

      const dctx = dst.getContext("2d")!;
      dctx.imageSmoothingEnabled = true;
      dctx.imageSmoothingQuality = "high";
      dctx.drawImage(half, 0, 0, sw, hh, 0, 0, dw, dh);
    },
  };
}
