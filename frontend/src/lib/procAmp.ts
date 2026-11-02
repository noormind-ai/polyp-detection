"use client";

/**
 * The capture card's own picture controls, and setting them from the picture.
 *
 * Dedicated capture software has always had these; a browser usually does
 * not. When a driver does expose them, applyConstraints reaches the card's
 * analog front end — so unlike every filter we apply afterwards, these change
 * the signal the live view, the model and the recording all receive. They are
 * also the only thing that can fix what a filter cannot: detail the card
 * clipped or crushed on the way in was never digitised at all.
 *
 * Auto-tune aims at what a capture engineer would set on a waveform monitor:
 * blacks just above zero, highlights not clipping, midtones near the middle.
 * One property per pass, re-measuring after each — a driver may clamp or
 * silently ignore a value, and only the picture can say what really happened.
 */

export type ProcAmpCaps = Record<string, { min: number; max: number; step?: number }>;
export interface Levels { black: number; clip: number; mean: number }

const PROPS = ["brightness", "contrast", "saturation", "sharpness"] as const;

/** The proc-amp properties this track actually offers, or null for none. */
export function readProcAmpCaps(track: MediaStreamTrack | undefined | null): ProcAmpCaps | null {
  try {
    const caps = track?.getCapabilities?.() as Record<string, unknown> | undefined;
    const found: ProcAmpCaps = {};
    for (const k of PROPS) {
      const c = caps?.[k] as { min?: number; max?: number; step?: number } | undefined;
      if (c && typeof c.min === "number" && typeof c.max === "number") {
        found[k] = { min: c.min, max: c.max, step: c.step };
      }
    }
    return Object.keys(found).length ? found : null;
  } catch {
    return null;
  }
}

export function readProcAmpValues(track: MediaStreamTrack | undefined | null,
                                  caps: ProcAmpCaps): Record<string, number> {
  const st = track?.getSettings?.() as Record<string, number> | undefined;
  return Object.fromEntries(Object.keys(caps).map((k) => [k, st?.[k] ?? caps[k].min]));
}

/** Black level, clipping and brightness of whatever is on `canvas` now. */
export function measureLevels(canvas: HTMLCanvasElement | null): Levels | null {
  if (!canvas?.width || !canvas.height) return null;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    return null;    // tainted canvas — nothing to measure, and never a crash
  }
  const n = data.length / 4;
  const lumas = new Float32Array(n);
  let sum = 0, clip = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const y = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    lumas[i] = y;
    sum += y;
    if (y >= 250) clip++;
  }
  // Black is the 1st percentile, not the minimum: one dead pixel must not
  // decide what "black" means for the whole picture.
  const sorted = Array.from(lumas).sort((a, b) => a - b);
  return {
    black: Math.round(sorted[Math.floor(n * 0.01)] * 10) / 10,
    clip: Math.round((clip / n) * 1000) / 10,
    mean: Math.round((sum / n) * 10) / 10,
  };
}

export interface AutoTuneOpts {
  caps: ProcAmpCaps;
  /** Current values; the caller keeps its own copy in sync via `apply`. */
  values: Record<string, number>;
  measure: () => Levels | null;
  apply: (key: string, value: number) => Promise<void> | void;
  onProgress?: (message: string, levels: Levels | null) => void;
  maxPasses?: number;
}

export async function autoTuneProcAmp(opts: AutoTuneOpts): Promise<Levels | null> {
  const { caps, values, measure, apply, onProgress } = opts;
  const passes = opts.maxPasses ?? 10;
  const settle = () => new Promise((r) => setTimeout(r, 250));
  const snap = (k: string, v: number) => {
    const c = caps[k];
    const step = c.step || 1;
    return Math.max(c.min, Math.min(c.max, Math.round(v / step) * step));
  };
  const nudge = async (k: string, fraction: number) => {
    const c = caps[k];
    const next = snap(k, (values[k] ?? c.min) + (c.max - c.min) * fraction);
    if (next === values[k]) return false;    // already at the rail
    values[k] = next;
    await apply(k, next);
    return true;
  };

  let last: Levels | null = null;
  for (let i = 0; i < passes; i++) {
    await settle();
    const m = measure();
    if (!m) break;
    last = m;
    onProgress?.(`pass ${i + 1}: black ${m.black} · clipped ${m.clip}% · mean ${m.mean}`, m);

    // Clipping first: detail burnt out on the way in is gone for good.
    if (m.clip > 1.5 && caps.brightness && await nudge("brightness", -0.06)) continue;
    // Lifted blacks — the washed-out look, and a sign the card's black level
    // disagrees with what the processor is sending.
    if (m.black > 16 && caps.brightness && await nudge("brightness", -0.04)) continue;
    // Crushed blacks in an already-dark picture: shadow detail being thrown away.
    if (m.black < 2 && m.mean < 90 && caps.brightness && await nudge("brightness", 0.04)) continue;
    // Levels are sane; spend what is left on dynamic range.
    if (m.clip < 0.3 && m.mean < 110 && caps.contrast && await nudge("contrast", 0.05)) continue;

    onProgress?.(`done — black ${m.black} · clipped ${m.clip}% · mean ${m.mean}`, m);
    return m;
  }
  onProgress?.(last ? `stopped after ${passes} passes — black ${last.black} · clipped ${last.clip}%`
                    : "could not read the picture to tune against", last);
  return last;
}
