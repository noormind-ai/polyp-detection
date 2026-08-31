// Inside-vs-outside-the-colon gate. Handcrafted, no model, no weights.
//
// Method follows "Automatic Real-Time Detection of Endoscopic Procedures Using
// Temporal Features" (PMC10602398), which reports 99.90%/99.97% over 265M frames
// using colour statistics plus their variation over time, no neural network.
// Their central finding is the one that matters here:
//
//   "a high amount of red occasionally occurs when the endoscope points at some
//    object (e.g., orange floor) very closely ... Therefore, color features
//    alone are insufficient."
//
// A phone camera pointed at a warm room is that orange floor: an earlier
// colour-only version of this file called it in-body. Two things fix it, both
// taken from that paper rather than invented here:
//
//   1. how spread out the colours are. Mucosa is one material under one lamp, so
//      its colour is very uniform; a room contains many things and is not.
//   2. how much the picture changes over time. A scope inside a patient never
//      stops moving; a phone or a scope on a trolley sits still.
//
// Thresholds below come from measuring real footage, not from a guess -- see the
// numbers next to each constant.

const SMALL = 96;   // features are computed on a 96x96 thumbnail
const DARK_V = 12;  // below this the pixel is the black surround, not image
const SAT_MIN = 40; // unsaturated pixels have a meaningless hue
// Mean brightness below which a frame cannot be in-body. HSV saturation is
// (V - min) / V, so near V = 0 a pixel three units off neutral reports as
// vividly coloured -- dark sensor noise reads as perfect mucosa, and a
// near-black frame with a faint warm cast scored p = 0.9986 before this.
// Across 1,443 real in-body frames the darkest averaged V = 70, p1 was 92 and
// the median 162, so 50 clears the darkest real frame by 20 and cannot be
// reached by genuine footage.
const BRIGHT_MIN = 50;
// The paper counts a pixel toward mean-normalized-red only when r, g AND b
// all clear a floor, which is stricter than the value-channel mask used for
// the hue statistics.
const VALID_FLOOR = 12;

export interface InBodyFeatures {
  /**
   * The paper's mean-normalized-red: mean over valid pixels of
   * 255*r/(r+g+b). Roughly 127 on mucosa and 107-117 on room footage.
   * Preferred over a ratio of channel averages because every pixel counts
   * equally, so a few specular highlights cannot swing the frame.
   */
  redness: number;
  hueRedFrac: number;   // fraction of vivid pixels whose colour is in the red band
  satMean: number;      // operating rooms are grey/blue and washed out
  hueSpread: number;    // how many degrees of the colour wheel the picture covers
  vMean: number;
  validFrac: number;
}

// z = B0 + sum(Wi * (feature_i - MUi) / SIGMAi); p_inbody = sigmoid(z)
//
// Measured on real colonoscopy video (454 evaluated frames, three demo clips plus
// a session recording): redness median 0.99, hueSpread median 9.3 deg with p95
// at 14 deg. Two saved recordings that are plainly not endoscopic footage sit at
// redness 0.38/0.71 with hueSpread 32/42 deg, which is what the hueSpread term
// separates.
// MU[0]/SIGMA[0] are the old 0.630/0.100 translated onto the paper's scale by
// the measured slope of 77.9 paper-units per unit of the old redness, so the
// term behaves as before while using the better-conditioned formula.
const MU = [100.0, 0.550, 0.300];
const SIGMA = [7.8, 0.200, 0.120];
const W = [4.0, 3.0, 1.0];
const B0 = 0.0;

// Colour uniformity. Real in-body frames sit under 14 deg at p95; the
// non-endoscopic recordings sit at 32-42. 20 deg is between the two, closer to
// in-body so a legitimate frame is not pushed out by an unusual moment.
const SPREAD_REF = 20.0;
const SPREAD_SIGMA = 8.0;
const SPREAD_W = 2.0;

// Motion, as the paper's trimmed variance of frame-to-frame change in redness.
// Measured floor for real in-body video is ~1e-5 (p5); a static non-endoscopic
// recording measured 4e-8, roughly two decades below. Scored on a log scale
// because the quantity spans decades.
const MOTION_REF_LOG10 = -5.7;   // ~2e-6, between the two
const MOTION_SIGMA_LOG10 = 1.0;  // one decade
const MOTION_W = 2.0;
const MOTION_WINDOW = 12;        // evaluations kept (~24 frames)
const MOTION_TRIM = 1;           // drop the largest and smallest change, as the paper does

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
  // Separate accumulator: mean-normalized-red is a mean of per-pixel ratios,
  // not a ratio of the sums above, and it uses the stricter pixel test.
  let normRedN = 0, sumNormRed = 0;
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

    if (r >= VALID_FLOOR && g >= VALID_FLOOR && b >= VALID_FLOOR) {
      normRedN++;
      sumNormRed += Math.floor((255 * r) / (r + g + b));
    }

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
      // Hue is an angle, so it has to be averaged as one -- 179 and 0 are
      // neighbours, not opposites. Accumulate unit vectors and take the length
      // of their mean: near 1 means every pixel points the same way.
      const a = h * (Math.PI / 90);
      sumCos += Math.cos(a);
      sumSin += Math.sin(a);
    }
  }

  const total = d.length / 4;
  // Almost nothing above the black floor: a capped lens or a dead feed. Reported
  // with vMean = 0 rather than refused, so the brightness rule in pInBody can act
  // on it. Returning null here would instead force "inside", which is how a black
  // screen used to be treated as in-body.
  if (n === 0 || n < 0.05 * total) {
    return { redness: 0, hueRedFrac: 0, satMean: 0, hueSpread: 180, vMean: 0, validFrac: n / total };
  }

  let hueSpread = 0;
  if (satN > 10) {
    const R = Math.min(1, Math.hypot(sumCos / satN, sumSin / satN));
    hueSpread = (180 / Math.PI) * Math.sqrt(-2 * Math.log(Math.max(R, 1e-9)));
  }

  return {
    redness: normRedN > 0 ? sumNormRed / normRedN : 0,
    hueRedFrac: satN > 0 ? redN / satN : 0,
    satMean: sumS / n / 255,
    hueSpread,
    vMean: sumV / n / 255,
    validFrac: n / total,
  };
}

/**
 * `motion` is the trimmed variance of recent frame-to-frame change in redness,
 * or null when there is not enough history yet or the source is frozen. Null
 * means the motion term is simply left out rather than counted as "not moving" —
 * a paused clip must not read as out-of-body.
 */
export function pInBody(f: InBodyFeatures, motion: number | null = null): number {
  // Checked before anything else: below this the colour cues are not merely weak
  // but actively misleading, since saturation and hue are computed from
  // differences of near-zero channels.
  if (f.vMean * 255 < BRIGHT_MIN) return 0;

  const x = [f.redness, f.hueRedFrac, f.satMean];
  let z = B0;
  for (let i = 0; i < x.length; i++) z += W[i] * ((x[i] - MU[i]) / SIGMA[i]);

  // More spread-out colour means less likely to be one material under one lamp.
  z += SPREAD_W * ((SPREAD_REF - f.hueSpread) / SPREAD_SIGMA);

  if (motion !== null && motion > 0) {
    z += MOTION_W * ((Math.log10(motion) - MOTION_REF_LOG10) / MOTION_SIGMA_LOG10);
  }
  return sigmoid(z);
}

/** One term of the score: what it measured, and what that did to the verdict. */
export interface Term {
  key: string;
  /** The cue as measured, already formatted for display. */
  value: string;
  /** Signed push on the score. Positive argues in-body, negative argues out. */
  contribution: number;
}

/**
 * The same arithmetic pInBody performs, itemised.
 *
 * Deliberately a separate function rather than pInBody returning both: the gate
 * runs on every evaluated frame and must not pay for formatting, while this is
 * called only when the panel refreshes.
 */
export function explain(f: InBodyFeatures, motion: number | null = null): {
  terms: Term[]; z: number; p: number; tooDark: boolean;
} {
  const tooDark = f.vMean * 255 < BRIGHT_MIN;
  const x = [f.redness, f.hueRedFrac, f.satMean];
  const labels = ["red", "redHue", "sat"];
  const shown = [f.redness.toFixed(0), `${(f.hueRedFrac * 100).toFixed(0)}%`, f.satMean.toFixed(2)];

  const terms: Term[] = x.map((v, i) => ({
    key: labels[i],
    value: shown[i],
    contribution: W[i] * ((v - MU[i]) / SIGMA[i]),
  }));
  terms.push({
    key: "spread",
    value: `${f.hueSpread.toFixed(0)}\u00b0`,
    contribution: SPREAD_W * ((SPREAD_REF - f.hueSpread) / SPREAD_SIGMA),
  });
  terms.push({
    key: "motion",
    value: motion === null ? "\u2014" : motion.toExponential(1),
    contribution: motion !== null && motion > 0
      ? MOTION_W * ((Math.log10(motion) - MOTION_REF_LOG10) / MOTION_SIGMA_LOG10)
      : 0,
  });

  const z = tooDark ? -30 : B0 + terms.reduce((a, t) => a + t.contribution, 0);
  return { terms, z, p: tooDark ? 0 : sigmoid(z), tooDark };
}

const ENTER = 0.70;   // raw p above this for DWELL_IN evaluations => inside
const EXIT = 0.30;    // raw p below this for DWELL_OUT evaluations => outside
// Leaving takes longer than returning, because the two errors are not equally
// costly: declaring out-of-body stops inference, declaring in-body only wastes a
// forward pass. The paper is far more extreme -- it requires 90% of the past
// FIVE MINUTES before it will call an exit -- which is unusable here, since the
// same gate runs over demo clips people scrub through. 12 evaluations is about
// 2.5-5 s depending on inference rate, six times more patient than the single
// second it used to take, and still quick enough to scrub against.
const DWELL_OUT = 12;
const DWELL_IN = 2;
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
  motion: number | null = null;
  private streak = 0;
  private tick = 0;
  /** No verdict has been measured since the last reset. */
  private cold = true;
  private history: number[] = [];

  reset(startInside = true) {
    this.inside = startInside;
    this.p = startInside ? 1 : 0;
    this.streak = 0;
    this.tick = 0;
    this.cold = true;
    this.history = [];
    this.motion = null;
  }

  /** Trimmed variance of successive changes, as the paper computes it. */
  private updateMotion(redness: number): number | null {
    this.history.push(redness);
    if (this.history.length > MOTION_WINDOW) this.history.shift();
    if (this.history.length < MOTION_WINDOW) return null;

    const d: number[] = [];
    for (let i = 1; i < this.history.length; i++) {
      d.push(Math.abs(this.history[i] - this.history[i - 1]));
    }
    d.sort((a, b) => a - b);
    const kept = d.length > 2 * MOTION_TRIM + 1 ? d.slice(MOTION_TRIM, d.length - MOTION_TRIM) : d;
    // Every frame byte-identical means a paused clip, not a still scene: a live
    // camera always carries some sensor noise. Report null so the motion term is
    // skipped rather than counted against being in-body.
    if (kept.length < 2 || kept[kept.length - 1] === 0) return null;

    const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
    return kept.reduce((a, b) => a + (b - mean) * (b - mean), 0) / kept.length;
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

    this.motion = this.updateMotion(f.redness);
    const raw = pInBody(f, this.motion);
    this.p = EMA * raw + (1 - EMA) * this.p;

    // First measurement since a reset: take it at face value. The dwell exists
    // to stop a stray frame overturning an established verdict, and at this point
    // there is none -- `inside` is only the fail-open assumption the gate opened
    // with. Requiring agreement with an assumption just delays the first real
    // answer by DWELL evaluations.
    if (this.cold) {
      this.cold = false;
      this.inside = raw > EXIT;
      this.streak = 0;
      return { inside: this.inside, p: this.p, f, evaluated: true };
    }

    const want = this.inside ? !(raw < EXIT) : raw > ENTER;
    if (want !== this.inside) {
      // want === false means this evaluation argues for leaving the body.
      const needed = want ? DWELL_IN : DWELL_OUT;
      if (++this.streak >= needed) { this.inside = want; this.streak = 0; }
    } else {
      this.streak = 0;
    }
    return { inside: this.inside, p: this.p, f, evaluated: true };
  }
}

export function fit(X: number[][], y: number[], iters = 4000, lr = 0.5) {
  const Z = X.map((row) => [1, ...row.map((v, i) => (v - MU[i]) / SIGMA[i])]);
  const w = new Array(Z[0].length).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array(w.length).fill(0);
    for (let i = 0; i < Z.length; i++) {
      const e = sigmoid(Z[i].reduce((a, v, k) => a + v * w[k], 0)) - y[i];
      for (let k = 0; k < w.length; k++) g[k] += e * Z[i][k];
    }
    for (let k = 0; k < w.length; k++) w[k] -= (lr * g[k]) / Z.length;
  }
  return w;
}
