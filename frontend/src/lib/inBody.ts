// Inside-vs-outside-the-colon gate. Handcrafted colour cues, no model, no weights.
//
// Separate concern from informativeness (blur / bubble / wall contact): this only
// answers "is the scope in the patient at all" — the pre-insertion and
// post-withdrawal stretches where the camera is looking at the room. Colour
// separates those two with a wide margin, and unlike the informativeness task the
// cue does not invert: wall contact is red AND in-body, so scoring it in-body is
// correct.
//
// Runs client-side on the same 320px canvas that is about to be sent, so an
// out-of-body frame costs no JPEG encode, no WebSocket round trip and no
// inference. ~0.3 ms/frame.
//
// Reference implementation and the measurements behind the constants live in
// bench-inbody/ (inbody.py is the same maths in numpy; keep the two in step).

const SMALL = 96;   // features are computed on a 96x96 thumbnail
const DARK_V = 12;  // below this the pixel is the black surround, not image
const SAT_MIN = 40; // unsaturated pixels have a meaningless hue

export interface InBodyFeatures {
  redness: number;      // mean(R) / (mean(G) + mean(B)) — mucosa is red-to-brown
  hueRedFrac: number;   // fraction of saturated pixels in the red hue band
  satMean: number;      // operating rooms are grey/blue and desaturated
  vMean: number;
  validFrac: number;
}

// p_inbody = sigmoid(B0 + sum(W[i] * (x[i] - MU[i]) / SIGMA[i]))
//
// These are a physics-derived prior, NOT a fit — set from how the cue behaves and
// sanity-checked on in-body footage only (108 frames across the three demo clips:
// redness p5 0.892 / median 1.077, hueRedFrac p5 0.865 / median 0.976, every frame
// scored in-body). A white-balanced room sits near redness 0.50, so the margin is
// wide, but the negative side is not yet validated against real out-of-body
// footage. Refit with inbody.fit() on REAL-Colon (CC BY, keeps the out-of-colon
// segments before and after each procedure) and paste the coefficients here.
const MU = [0.630, 0.550, 0.300];
const SIGMA = [0.100, 0.200, 0.120];
const W = [4.0, 3.0, 1.0];
const B0 = 0.0;

// One reusable scratch canvas — the loop runs at inference rate, but allocating a
// canvas per frame is still pointless garbage.
let scratch: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;

function thumbnail(source: CanvasImageSource): ImageData | null {
  if (typeof document === "undefined") return null;
  if (!scratch) {
    scratch = document.createElement("canvas");
    scratch.width = SMALL;
    scratch.height = SMALL;
    // willReadFrequently: this canvas exists only to be read back.
    scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
  }
  if (!scratchCtx) return null;
  try {
    scratchCtx.drawImage(source, 0, 0, SMALL, SMALL);
    return scratchCtx.getImageData(0, 0, SMALL, SMALL);
  } catch {
    // A tainted canvas (cross-origin video) throws here. Caller fails open.
    return null;
  }
}

/** Colour statistics inside the endoscope's image circle. Null if unreadable. */
export function features(source: CanvasImageSource): InBodyFeatures | null {
  const img = thumbnail(source);
  if (!img) return null;
  const d = img.data;

  let n = 0, sumR = 0, sumG = 0, sumB = 0, sumS = 0, sumV = 0, satN = 0, redN = 0;

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const v = r > g ? (r > b ? r : b) : (g > b ? g : b);
    // The endoscope image is a bright circle on a black surround. Measuring the
    // surround would drag every statistic toward zero, so skip it.
    if (v <= DARK_V) continue;
    const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const s = ((v - min) * 255) / v;

    n++; sumR += r; sumG += g; sumB += b; sumS += s; sumV += v;

    if (s > SAT_MIN) {
      satN++;
      // OpenCV-convention hue, 0..179, so the red band wraps: [0,20] U [160,179].
      const c = v - min;
      let h: number;
      if (c === 0) h = 0;
      else if (v === r) h = 30 * (((g - b) / c) % 6);
      else if (v === g) h = 30 * ((b - r) / c + 2);
      else h = 30 * ((r - g) / c + 4);
      if (h < 0) h += 180;
      if (h <= 20 || h >= 160) redN++;
    }
  }

  const total = d.length / 4;
  // A genuinely dark frame leaves nothing to measure. Fail open rather than
  // reporting a confident zero on no evidence.
  if (n < 0.05 * total) return null;

  return {
    redness: sumR / (sumG + sumB + 1e-6),
    hueRedFrac: satN > 0 ? redN / satN : 0,
    satMean: sumS / n / 255,
    vMean: sumV / n / 255,
    validFrac: n / total,
  };
}

export function pInBody(f: InBodyFeatures): number {
  const x = [f.redness, f.hueRedFrac, f.satMean];
  let z = B0;
  for (let i = 0; i < x.length; i++) z += W[i] * ((x[i] - MU[i]) / SIGMA[i]);
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

/**
 * Per-frame score plus temporal hysteresis.
 *
 * In/out changes maybe twice per procedure, so a single frame must never flip the
 * state — a red drape passing the lens, or one dropped frame, would otherwise
 * toggle it mid-inspection. Two thresholds plus a dwell requirement make the
 * state stable by construction.
 *
 * The asymmetry is deliberate and is the safety property: suppressing inference
 * on a frame that IS inside the patient is the harmful error, so leaving in-body
 * state requires DWELL consecutive confident frames, and anything unmeasurable
 * counts as in-body.
 */
const ENTER = 0.70;   // raw p above this for DWELL evaluations => inside
const EXIT = 0.30;    // raw p below this for DWELL evaluations => outside
const DWELL = 2;      // 2 evaluations = 4 frames, ~0.8 s at 5 fps
// Display smoothing ONLY. The decision runs off the raw score: on this
// footage it reads 1.0000 inside and 0.0000 outside, so smoothing before
// deciding bought no robustness and cost three evaluations of lag — long
// enough to draw polyp boxes over the room before the gate caught up.
const EMA = 0.4;
// Inside-vs-outside changes about twice per procedure. Measuring pixels on
// every frame costs main-thread time in the middle of the inference loop to
// re-derive an answer that cannot have changed, so only every Nth frame is
// measured and the verdict is held in between.
const EVAL_EVERY = 2;

export class InBodyGate {
  /**
   * Starts INSIDE even though a session begins before insertion. The opening
   * seconds of a procedure are cheap to infer and get corrected within DWELL
   * frames; starting outside would suppress inference before the gate has
   * positively decided anything, which is the error that matters.
   */
  inside = true;
  p = 1;
  private streak = 0;
  private tick = 0;

  reset(startInside = true) {
    this.inside = startInside;
    this.p = startInside ? 1 : 0;
    this.streak = 0;
    this.tick = 0;
  }

  /**
   * Returns true if this frame should be sent for inference.
   *
   * `evaluated` is false on the frames between measurements: the verdict is
   * still valid, it just did not change, so callers must not treat it as a
   * fresh observation.
   */
  update(source: CanvasImageSource): { inside: boolean; p: number; f: InBodyFeatures | null; evaluated: boolean } {
    if (this.tick++ % EVAL_EVERY !== 0) {
      return { inside: this.inside, p: this.p, f: null, evaluated: false };
    }
    const f = features(source);
    if (!f) {
      // Unmeasurable — fail open. Never suppress inference on no evidence.
      this.inside = true;
      this.streak = 0;
      return { inside: true, p: this.p, f: null, evaluated: true };
    }
    const raw = pInBody(f);
    this.p = EMA * raw + (1 - EMA) * this.p;
    const want = this.inside ? !(raw < EXIT) : raw > ENTER;
    if (want !== this.inside) {
      if (++this.streak >= DWELL) { this.inside = want; this.streak = 0; }
    } else {
      this.streak = 0;
    }
    return { inside: this.inside, p: this.p, f, evaluated: true };
  }
}
