// Inside-vs-outside-the-colon gate. Four colour statistics and a logistic, no model.
//
// The coefficients below are FITTED, not chosen. Earlier versions of this file
// used numbers I set by hand from how the cues ought to behave, and they were
// wrong twice: a phone pointed at a warm room read as in-body, and then a
// hand-held phone read as in-body again because the motion and uniformity terms
// were unbounded upward and so rewarded shaking and blank walls.
//
// Fitted on 2,910 frames: 1,556 in-body -- of which 1,176 come from 108 REAL
// PATIENT colonoscopies in the panel archive, not just demo clips -- against
// 1,354 frames of webcam and screen recordings that are plainly not endoscopy.
//
// The first fit used only three demo clips as its in-body set. They all look
// alike, it scored 0/2230 held out, and it then muted real procedures: on real
// patient frames its 1st percentile was p=0.285, sitting on the exit threshold.
// The lesson is that held-out accuracy means nothing if the held-out data is not
// the population being served.
//
//                                   in-body called OUTSIDE
//     fitted on demo clips only            1.020%   (p1 = 0.285)
//     fitted including patient frames      0.510%   (p1 = 0.884)
//
// Negatives are unaffected: neither calls any of the 1,354 inside.
// Held out one whole SOURCE at a time, with each patient case its own source:
// in-body misclassified 0.578%, negatives 3.102%.
//
// Motion was measured and dropped. "Automatic Real-Time Detection of Endoscopic
// Procedures Using Temporal Features" (PMC10602398) uses it to catch a scope
// parked between procedures, and for that it is the right cue -- but it does not
// separate anything here, because a hand-held phone moves at least as much as an
// endoscope (in-body log-variance median -4.04 against -4.54 for the negatives,
// ranges overlapping). Removing it also removes a ring buffer, a rolling window
// and a special case for paused clips.

const SMALL = 96;   // features are computed on a 96x96 thumbnail
const DARK_V = 12;  // below this the pixel is the black surround, not image
const SAT_MIN = 40; // unsaturated pixels have a meaningless hue

export interface InBodyFeatures {
  redness: number;      // mean(R) / (mean(G) + mean(B)) — mucosa is red-to-brown
  hueRedFrac: number;   // fraction of vivid pixels whose colour is in the red band
  satMean: number;      // operating rooms are grey/blue and washed out
  hueSpread: number;    // degrees of the colour wheel the frame covers — the discriminator
  /**
   * mean(B)/mean(R). Endoscope light on blood-rich tissue suppresses blue
   * hard; skin under white room light does not. Measured but NOT scored:
   * every negative available is desk-distance webcam, none is close-up skin,
   * so a threshold picked now would be fitted to the wrong thing. Shown in
   * the panel so the failing case can be measured rather than guessed at.
   */
  blueRatio: number;
  vMean: number;
  validFrac: number;
}

// p = sigmoid(B0 + sum(Wi * (feature_i - MUi) / SIGMAi)), fitted as described above.
// hueSpread carries by far the largest weight, and it is negative: the wider the
// range of colours in the picture, the less it looks like one wet surface under
// one lamp.
const MU = [0.8378, 0.8261, 0.5301, 23.9769];
const SIGMA = [0.2365, 0.1992, 0.1244, 17.9719];
const W = [8.2133, 0.0394, -4.6253, -4.2347];
const B0 = 2.0668;

function sigmoid(z: number) {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

let scratch: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;

function thumbnail(source: CanvasImageSource): ImageData | null {
  if (typeof document === "undefined") return null;
  if (!scratch) {
    scratch = document.createElement("canvas");
    scratch.width = SMALL;
    scratch.height = SMALL;
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

  let n = 0, sumR = 0, sumG = 0, sumB = 0, sumS = 0, sumV = 0;
  let satN = 0, redN = 0, sumCos = 0, sumSin = 0;

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
      // Hue is an angle, so it must be averaged as one — 179 and 0 are
      // neighbours, not opposites. Accumulate unit vectors; the length of their
      // mean is near 1 when every pixel points the same way.
      const a = h * (Math.PI / 90);
      sumCos += Math.cos(a);
      sumSin += Math.sin(a);
    }
  }

  const total = d.length / 4;
  // A genuinely dark frame leaves nothing to measure. Fail open rather than
  // reporting a confident zero on no evidence.
  if (n < 0.05 * total) return null;

  let hueSpread = 0;
  if (satN > 10) {
    const R = Math.min(1, Math.hypot(sumCos / satN, sumSin / satN));
    hueSpread = (180 / Math.PI) * Math.sqrt(-2 * Math.log(Math.max(R, 1e-9)));
  }

  return {
    redness: sumR / (sumG + sumB + 1e-6),
    hueRedFrac: satN > 0 ? redN / satN : 0,
    satMean: sumS / n / 255,
    hueSpread,
    blueRatio: sumB / (sumR + 1e-6),
    vMean: sumV / n / 255,
    validFrac: n / total,
  };
}

export function pInBody(f: InBodyFeatures): number {
  const x = [f.redness, f.hueRedFrac, f.satMean, f.hueSpread];
  let z = B0;
  for (let i = 0; i < x.length; i++) z += W[i] * ((x[i] - MU[i]) / SIGMA[i]);
  return sigmoid(z);
}

const ENTER = 0.70;   // raw p above this for DWELL_IN evaluations => inside
const EXIT = 0.30;    // raw p below this for DWELL_OUT evaluations => outside
// Asymmetric on purpose: the two errors are not equally costly. Declaring
// out-of-body stops inference, so if it is wrong a real procedure goes unwatched;
// declaring in-body merely wastes a forward pass on a room. Leaving therefore
// needs twice the agreement, which costs ~1.6 s of extra latency on a genuine
// exit -- nothing depends on that -- and makes an isolated run of odd frames
// unable to mute a procedure.
const DWELL_OUT = 4;  // 4 evaluations = 8 frames, ~1.6 s at 5 fps
const DWELL_IN = 2;   // 2 evaluations = 4 frames, ~0.8 s
const EMA = 0.4;      // display smoothing only; the decision uses the raw score
// Inside-vs-outside changes about twice per procedure, so measuring every frame
// re-derives an answer that cannot have changed.
const EVAL_EVERY = 2;

export class InBodyGate {
  /**
   * Starts INSIDE even though a session begins before insertion. The opening
   * seconds are cheap to infer and get corrected within DWELL evaluations;
   * starting outside would suppress inference before the gate has decided
   * anything, which is the error that matters.
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
  update(source: CanvasImageSource): {
    inside: boolean; p: number; f: InBodyFeatures | null; evaluated: boolean;
  } {
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
      // `want === false` means this evaluation argues for leaving the body.
      const needed = want ? DWELL_IN : DWELL_OUT;
      if (++this.streak >= needed) { this.inside = want; this.streak = 0; }
    } else {
      this.streak = 0;
    }
    return { inside: this.inside, p: this.p, f, evaluated: true };
  }
}

/**
 * Refit MU/SIGMA/W/B0 above from labelled frames. `X` rows are
 * [redness, hueRedFrac, satMean, hueSpread]; `y` is 1 for in-body.
 * Hand-rolled because this box's venv is onnxruntime+numpy only.
 */
export function fit(X: number[][], y: number[], iters = 20000, lr = 0.5) {
  const k = X[0].length;
  const mu = Array.from({ length: k }, (_, j) => X.reduce((a, r) => a + r[j], 0) / X.length);
  const sd = Array.from({ length: k }, (_, j) =>
    Math.sqrt(X.reduce((a, r) => a + (r[j] - mu[j]) ** 2, 0) / X.length) + 1e-9);
  const Z = X.map((r) => [1, ...r.map((v, j) => (v - mu[j]) / sd[j])]);
  const w = new Array(k + 1).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array(k + 1).fill(0);
    for (let i = 0; i < Z.length; i++) {
      const e = sigmoid(Z[i].reduce((a, v, j) => a + v * w[j], 0)) - y[i];
      for (let j = 0; j <= k; j++) g[j] += e * Z[i][j];
    }
    for (let j = 0; j <= k; j++) w[j] -= (lr * g[j]) / Z.length;
  }
  return { MU: mu, SIGMA: sd, W: w.slice(1), B0: w[0] };
}
