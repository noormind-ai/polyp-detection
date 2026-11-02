"use client";

/**
 * Display-enhancement passes for the capture pipeline: motion-gated temporal
 * denoise and unsharp-mask sharpening. Step 4 and 5 of the capture-software
 * best-practice chain (/sim is the testbed; the live page integrates later).
 *
 * Plain 2D-canvas / ImageData implementation on purpose: at SD size the whole
 * chain is a few ms, and /sim reports the per-pass cost so "is WebGL needed"
 * is answered by measurement, not guessed. Both passes no-op cleanly at
 * strength 0 so one code path serves every setting.
 *
 * Enhancement is DISPLAY-ONLY by policy: nothing here may touch the AI send
 * or the recorded stream without a detection benchmark first — see the
 * pipeline design table in the project plan.
 */

export interface EnhanceParams {
  /** 0..1 — temporal denoise strength. Motion-gated: still pixels are
   *  averaged over time, moving pixels pass through untouched, so detail in
   *  motion is never smeared (the classic temporal-denoise failure mode). */
  denoise: number;
  /** 0..1 — unsharp-mask amount. Deliberately capped mild: oversharpening
   *  amplifies exactly the analog noise the denoiser just removed. */
  sharpen: number;
}

export interface EnhanceCost { denoiseMs: number; sharpenMs: number }

export interface Enhancer {
  /** Read `src`, write the enhanced picture into `dst` (resized to match).
   *  Returns the measured per-pass cost for the caller's stats readout. */
  process(src: HTMLCanvasElement, dst: HTMLCanvasElement, params: EnhanceParams): EnhanceCost;
  /** Forget temporal history (source changed / seeked). */
  reset(): void;
}

/** Luma difference above which a pixel counts as "moving" and is exempted
 *  from temporal averaging. In 0-255 units; chosen above analog noise
 *  amplitude (measured mean-abs-diff on clinic footage is single digits)
 *  and below real scene motion. */
const MOTION_GATE = 22;

export function createEnhancer(): Enhancer {
  // Temporal accumulator — the previous OUTPUT frame (recursive averaging),
  // which converges on the true signal faster than averaging raw inputs.
  let acc: Uint8ClampedArray | null = null;
  let accW = 0, accH = 0;

  function reset() { acc = null; }

  function process(src: HTMLCanvasElement, dst: HTMLCanvasElement, params: EnhanceParams): EnhanceCost {
    const w = src.width, h = src.height;
    if (!w || !h) return { denoiseMs: 0, sharpenMs: 0 };
    if (dst.width !== w) dst.width = w;
    if (dst.height !== h) dst.height = h;
    const dctx = dst.getContext("2d", { willReadFrequently: true })!;

    const denoise = Math.max(0, Math.min(1, params.denoise));
    const sharpen = Math.max(0, Math.min(1, params.sharpen));

    if (denoise === 0 && sharpen === 0) {
      dctx.drawImage(src, 0, 0);
      acc = null;        // history from enhanced frames must not leak back in
      return { denoiseMs: 0, sharpenMs: 0 };
    }

    const sctx = src.getContext("2d", { willReadFrequently: true })!;
    const img = sctx.getImageData(0, 0, w, h);
    const data = img.data;

    // ---- temporal denoise ----
    let denoiseMs = 0;
    if (denoise > 0) {
      const t0 = performance.now();
      if (!acc || accW !== w || accH !== h) {
        acc = new Uint8ClampedArray(data);   // first frame: history = input
        accW = w; accH = h;
      } else {
        // blend factor toward history; 0.75 at full strength keeps ~4-frame
        // memory — enough to flatten noise, short enough to track lighting.
        const k = 0.75 * denoise;
        const a = acc;
        for (let p = 0; p < data.length; p += 4) {
          const dy = Math.abs(
            (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) -
            (0.299 * a[p] + 0.587 * a[p + 1] + 0.114 * a[p + 2]));
          if (dy < MOTION_GATE) {
            data[p]     = data[p]     + (a[p]     - data[p])     * k;
            data[p + 1] = data[p + 1] + (a[p + 1] - data[p + 1]) * k;
            data[p + 2] = data[p + 2] + (a[p + 2] - data[p + 2]) * k;
          }
          a[p] = data[p]; a[p + 1] = data[p + 1]; a[p + 2] = data[p + 2];
        }
      }
      denoiseMs = performance.now() - t0;
    } else {
      acc = null;
    }

    // ---- unsharp mask ----
    let sharpenMs = 0;
    if (sharpen > 0) {
      const t0 = performance.now();
      const amount = 0.8 * sharpen;
      const srcCopy = new Uint8ClampedArray(data);
      const W4 = w * 4;
      // 3×3 box blur as the "unsharp" reference, edges skipped (border pixels
      // keep their value — a 1px frame nobody can see at display scale).
      for (let y = 1; y < h - 1; y++) {
        let p = y * W4 + 4;
        for (let x = 1; x < w - 1; x++, p += 4) {
          for (let c = 0; c < 3; c++) {
            const i = p + c;
            const blur = (
              srcCopy[i - W4 - 4] + srcCopy[i - W4] + srcCopy[i - W4 + 4] +
              srcCopy[i - 4]      + srcCopy[i]      + srcCopy[i + 4] +
              srcCopy[i + W4 - 4] + srcCopy[i + W4] + srcCopy[i + W4 + 4]) / 9;
            data[i] = srcCopy[i] + amount * (srcCopy[i] - blur);
          }
        }
      }
      sharpenMs = performance.now() - t0;
    }

    dctx.putImageData(img, 0, 0);
    return { denoiseMs: Math.round(denoiseMs * 100) / 100,
             sharpenMs: Math.round(sharpenMs * 100) / 100 };
  }

  return { process, reset };
}
