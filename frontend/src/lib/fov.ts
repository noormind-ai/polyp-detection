/**
 * Field of view — finding the part of the signal that is actually the camera.
 *
 * What an endoscope processor emits is a rectangle, but the camera image does
 * not fill it. There is a black border around the picture, and on some
 * processors a text banner as well. Measured across our own 427-study corpus:
 * on the 720x480 captures the border is about 13% of every frame (a ~42px bar
 * on the left, ~40px on the right, a thin one on top); the 623x532 captures
 * arrive already cropped and have almost none.
 *
 * That dead area is not harmless:
 *
 *  - It corrupts any per-frame quality statistic. Blur, brightness and glare
 *    scores all average over the frame, and black contributes a flat zero to
 *    every one of them. The same dead weight drags down a sharp frame and a
 *    soft one alike, which squeezes together the very scores we would need to
 *    tell them apart.
 *  - It costs resolution where it matters. The frame is scaled to INFER_WIDTH
 *    before it is sent, so black bars consume part of a budget that should be
 *    spent on mucosa. Small polyps are small; those pixels are not free.
 *  - It differs per capture setup. Our corpus spans seven resolutions with
 *    different amounts of border, so a threshold tuned on one is wrong on
 *    another for reasons that have nothing to do with the patient.
 *
 * The border does not move during a procedure, so detection runs on the first
 * few frames of a session and the answer is reused for the rest of it. Per
 * frame this costs nothing — it is a slice.
 *
 * The estimate is the UNION of what those sample frames show, never the
 * intersection. A single dark frame — lens against the wall, or a lumen far
 * enough away that little light comes back — looks mostly like border. Taking
 * the union means such a frame can only ever widen the region we keep, never
 * eat into real image. Cropping away mucosa would be a much worse failure than
 * keeping some black.
 */

export interface Rect { x: number; y: number; w: number; h: number }

/** Width the frame is scaled to before measuring. The border is a large-scale
 *  feature, so there is nothing to gain from measuring at full resolution. */
const SAMPLE_WIDTH = 160;
/** Luminance (0..255) above which a pixel counts as picture rather than border.
 *  Deliberately low: real mucosa in a dark lumen is dim but not black, and the
 *  measured border on our corpus sits at a mean of 10-15 with a 99th percentile
 *  of 13-20. */
const LUMA_THRESHOLD = 18;
/**
 * Fraction of a row (or column) that must be lit for it to count as inside the
 * picture.
 *
 * This is not the tolerance knob it looks like. In a real frame a picture
 * column is lit over ~99% of its height and a border column over ~0%, so
 * anything between the two gives the same answer — measured across 594 clinic
 * stills, 0.10 and 0.45 produce byte-identical rects for every resolution.
 *
 * What it actually decides is what happens to a *partly* lit column, and that
 * case is real. Every 720x576 recording on this deployment carries a solid
 * green band across the bottom 16.5% of the frame (a zeroed YUV buffer renders
 * green, not black — the picture is 720x480 inside a 720x576 frame). Green has
 * luma near 77, so it is "lit", and at 0.10 that band alone qualified every
 * column on its own: the left black bar was invisible and nothing was ever
 * cropped. At 0.30 the band no longer carries a column by itself and the bar
 * is found — 0.7% trim becomes 6.2%, with the stills unchanged.
 *
 * The bound going up: a full-width strip taller than this fraction would mask
 * a side bar again. The bound going down: on a truly circular field of view the
 * outermost columns are lit over only a short span, so a high value would clip
 * into the image. Ours is a rounded rectangle (only 4-7% of the area inside the
 * detected box is black), which is why 0.30 costs nothing here — but a scope
 * with a real circular FOV would want this lower, and the overlay is how you
 * would notice.
 */
const LINE_COVERAGE = 0.30;
/** Refuse to believe a detection that would throw away most of the frame. If we
 *  land here the frame was probably just dark, and cropping to it would be
 *  worse than not cropping at all. */
const MIN_AREA_FRACTION = 0.35;

/** Below this, the border is not worth acting on — the frame was already
 *  cropped upstream. Applying a 1% crop would only add a coordinate transform
 *  for no benefit. */
export const NEGLIGIBLE_TRIM = 0.02;

/** Reused across calls. Allocating a canvas per sampled frame would churn. */
let probe: HTMLCanvasElement | null = null;

/** First and last index along an axis whose lit-pixel count clears the coverage
 *  threshold, or null if the frame is dark enough that nothing does. */
function span(lit: Int32Array, lineLength: number): [number, number] | null {
  const need = LINE_COVERAGE * lineLength;
  let lo = -1, hi = -1;
  for (let i = 0; i < lit.length; i++) {
    if (lit[i] >= need) { if (lo < 0) lo = i; hi = i; }
  }
  return lo < 0 ? null : [lo, hi];
}

/**
 * The picture area of one frame, in the source's own pixel coordinates.
 * Returns null when it cannot tell — a frame with no dimensions yet, a canvas
 * the browser will not let us read back, or a result too small to believe.
 */
export function detectFovRect(source: CanvasImageSource, vw: number, vh: number): Rect | null {
  if (!vw || !vh) return null;

  const sw = Math.min(SAMPLE_WIDTH, vw);
  const sh = Math.max(1, Math.round((vh / vw) * sw));

  if (!probe) probe = document.createElement("canvas");
  if (probe.width !== sw) probe.width = sw;
  if (probe.height !== sh) probe.height = sh;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  let data: Uint8ClampedArray;
  try {
    ctx.drawImage(source, 0, 0, sw, sh);
    data = ctx.getImageData(0, 0, sw, sh).data;
  } catch {
    // A tainted canvas — a cross-origin video the browser will not let us read
    // back. Not an error worth surfacing: it just means no FOV crop here.
    return null;
  }

  const colLit = new Int32Array(sw);
  const rowLit = new Int32Array(sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4;
      // Rec.601 luma, in integers — this runs over every pixel of the probe.
      const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      if (lum > LUMA_THRESHOLD) { colLit[x]++; rowLit[y]++; }
    }
  }

  const xs = span(colLit, sh);
  const ys = span(rowLit, sw);
  if (!xs || !ys) return null;

  const kx = vw / sw, ky = vh / sh;
  // Round outwards on both edges. Off-by-one at the probe's scale is several
  // pixels at native scale, and the safe direction is to keep too much.
  const x = Math.max(0, Math.floor(xs[0] * kx));
  const y = Math.max(0, Math.floor(ys[0] * ky));
  const rect: Rect = {
    x, y,
    w: Math.min(vw - x, Math.ceil((xs[1] + 1) * kx) - x),
    h: Math.min(vh - y, Math.ceil((ys[1] + 1) * ky) - y),
  };

  if (rect.w <= 0 || rect.h <= 0) return null;
  if (rect.w * rect.h < MIN_AREA_FRACTION * vw * vh) return null;
  return rect;
}

/** The smallest rect containing both. Used to accumulate samples — see the note
 *  at the top about why this is a union and not an intersection. */
export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x, y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/** The overlap of two rects, clamped so it never has negative extent. Used to
 *  compose the detected FOV with a screen-share region the operator drew by
 *  hand: both are constraints, so both apply. */
export function intersectRect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x, y,
    w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x),
    h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y),
  };
}

/** How much of the frame this rect throws away, 0..1. */
export function trimmedFraction(rect: Rect, vw: number, vh: number): number {
  if (!vw || !vh) return 0;
  return Math.max(0, 1 - (rect.w * rect.h) / (vw * vh));
}
