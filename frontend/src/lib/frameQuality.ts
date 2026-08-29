// Cheap frame-quality gate: blur, exposure, glare, darkness. No model, no weights.
//
// Kept in step with bench-infocolon/tier1.py -- same metrics, same thresholds,
// same rule order -- so the browser and the numpy reference can be compared frame
// for frame. verify_quality.js checks they agree.
//
// The sharpness operator is `gradmean`: the mean Sobel gradient magnitude, which
// is Pertuz et al.'s GRA1 (Pattern Recognition 46(5), 2013 -- the standard
// catalogue of 36 focus measures). It replaced variance-of-Laplacian (their LAP4)
// after both were scored against 1,088 reviewer-labelled in-house frames:
//
//   rule                    noisy caught   polyp muted   caught per polyp lost
//   lapvar   < 120 (LAP4)          6.5%          5.8%                     1.1
//   gradmean < 15.1 (GRA1)        11.6%          0.6%                      20
//
// Same direction, ~2x the noise caught, ~10x fewer true polyps muted. Pertuz
// gives the reason: Laplacian operators are the most noise-sensitive of the 36
// they benchmark, because second derivatives amplify noise -- so on a cluttered
// frame LAP4 partly measures the clutter instead of the focus. A first-derivative
// operator does not.
//
// Caveat worth keeping in mind while calibrating: the threshold was fitted on
// panel stills (~450px downscaled to 160). Live frames arrive at 320px, so they
// are averaged less on the way down and may read slightly differently. Watch the
// live readout before trusting the number.

const MAX_DIM = 160; // tier1.py: metrics(small=160)

export interface QualityMetrics {
  gradmean: number;
  mean: number;
  std: number;
  specFrac: number;
  darkFrac: number;
}

/** Fitted on the in-house reviewer labels; the exposure/glare bounds are still
 *  tier1.py's unfitted starting points. */
/**
 * Operating points measured on 1,088 reviewer-labelled in-house frames
 * (noisy=275, polyp=172, no_polyp=641). `noisy` is the share of frames a doctor
 * called noisy that this threshold rejects; `polyp` is the share of frames a
 * doctor said contained a polyp that it would also reject — the cost.
 */
export const LEVELS = [
  { key: "gentle", gradMin: 15.1, noisy: 0.116, polyp: 0.006 },
  { key: "medium", gradMin: 17.1, noisy: 0.204, polyp: 0.035 },
  { key: "strong", gradMin: 19.1, noisy: 0.295, polyp: 0.087 },
  { key: "max",    gradMin: 22.4, noisy: 0.556, polyp: 0.134 },
] as const;

export type LevelKey = (typeof LEVELS)[number]["key"];
export const DEFAULT_LEVEL: LevelKey = "medium";

export const DEFAULTS = {
  gradMin: 17.1,
  darkMax: 0.45,
  specMax: 0.25,
  meanMin: 35.0,
  meanMax: 225.0,
};

export type Reason = "blurry" | "dark" | "glare" | "underexposed" | "overexposed" | "ok";

let scratch: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;

// Reused across calls. The gate runs at inference rate and the thumbnail size
// only changes when the source aspect does, so allocating these per frame was
// ~300 KB of garbage per frame for no reason.
let bufGray = new Float32Array(0);
let bufDx = new Float32Array(0);
let bufSx = new Float32Array(0);

function ensure(n: number) {
  if (bufGray.length >= n) return;
  bufGray = new Float32Array(n);
  bufDx = new Float32Array(n);
  bufSx = new Float32Array(n);
}

/** Grayscale at the same weights OpenCV's BGR2GRAY uses. */
function toGray(d: Uint8ClampedArray, n: number): Float32Array {
  const g = bufGray;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    g[i] = Math.round(0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]);
  }
  return g;
}

/**
 * Mean Sobel gradient magnitude (Pertuz GRA1), matching cv2.Sobel(ksize=3) with
 * BORDER_REFLECT_101. Over a one-pixel border reflect-101 is just index +-1 at
 * the edges, so the interior needs no bounds handling at all -- this is the hot
 * loop, and it runs on every frame the filter is enabled for.
 */
function gradMean(g: Float32Array, w: number, h: number): number {
  if (w < 3 || h < 3) return 0;
  const n = w * h;
  // Pass 1, along x: dx is the [-1,0,1] difference, sx the [1,2,1] smooth.
  const dx = bufDx;
  const sx = bufSx;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      // reflect-101 over a one-pixel border is just index +-1 at the edges.
      const l = g[row + (x === 0 ? 1 : x - 1)];
      const c = g[row + x];
      const r = g[row + (x === w - 1 ? w - 2 : x + 1)];
      dx[row + x] = r - l;
      sx[row + x] = l + 2 * c + r;
    }
  }
  // Pass 2, along y: smooth dx to finish Gx, difference sx to finish Gy.
  let sum = 0;
  for (let y = 0; y < h; y++) {
    const up = (y === 0 ? 1 : y - 1) * w;
    const cur = y * w;
    const dn = (y === h - 1 ? h - 2 : y + 1) * w;
    for (let x = 0; x < w; x++) {
      const gx = dx[up + x] + 2 * dx[cur + x] + dx[dn + x];
      const gy = sx[dn + x] - sx[up + x];
      sum += Math.sqrt(gx * gx + gy * gy);
    }
  }
  return sum / n;
}

/** Null when the frame cannot be read (tainted canvas, zero size). Fail open. */
export function frameQuality(source: HTMLCanvasElement): QualityMetrics | null {
  if (typeof document === "undefined") return null;
  const sw = source.width, sh = source.height;
  if (!sw || !sh) return null;

  // tier1.py only downsamples when the frame is larger than `small`.
  const r = Math.max(sw, sh) > MAX_DIM ? MAX_DIM / Math.max(sw, sh) : 1;
  const w = Math.max(1, Math.round(sw * r));
  const h = Math.max(1, Math.round(sh * r));

  if (!scratch) {
    scratch = document.createElement("canvas");
    scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
  }
  if (!scratchCtx) return null;
  if (scratch.width !== w) scratch.width = w;
  if (scratch.height !== h) scratch.height = h;

  let img: ImageData;
  try {
    scratchCtx.drawImage(source, 0, 0, w, h);
    img = scratchCtx.getImageData(0, 0, w, h);
  } catch {
    return null;
  }

  const n = w * h;
  ensure(n);
  const g = toGray(img.data, n);

  let sum = 0, sumSq = 0, spec = 0, dark = 0;
  for (let i = 0; i < n; i++) {
    const v = g[i];
    sum += v;
    sumSq += v * v;
    if (v > 245) spec++;
    if (v < 30) dark++;
  }
  const mean = sum / n;

  return {
    gradmean: gradMean(g, w, h),
    mean,
    std: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
    specFrac: spec / n,
    darkFrac: dark / n,
  };
}

/**
 * Same rule order as tier1.is_informative, so the first failing rule names the
 * reason. Order matters: a rejection has to be explainable, and if this ever
 * mutes a real detection you need to be able to say which rule did it.
 */
export function isInformative(m: QualityMetrics, t = DEFAULTS): { ok: boolean; reason: Reason } {
  if (m.gradmean < t.gradMin) return { ok: false, reason: "blurry" };
  if (m.darkFrac > t.darkMax) return { ok: false, reason: "dark" };
  if (m.specFrac > t.specMax) return { ok: false, reason: "glare" };
  if (m.mean < t.meanMin) return { ok: false, reason: "underexposed" };
  if (m.mean > t.meanMax) return { ok: false, reason: "overexposed" };
  return { ok: true, reason: "ok" };
}
