/** Fixed-window rolling statistics, and a spike test with hysteresis.
 *
 *  A plain class rather than a hook on purpose: the only writer is
 *  LiveCameraPlayer's ws.onmessage, which is synchronous and runs 12-20 times
 *  a second. Nothing in here may allocate per sample or trigger a render.
 *
 *  The three live buffers it replaces (server ms over 10, round trip over 10,
 *  inter-arrival gap over 20) are read by the stats grid AND posted to
 *  /api/spectate/{caseId}/room-stats, which spectator mode renders -- so the
 *  window lengths and rounding here are a compatibility surface, not a
 *  detail. Changing either changes what a spectator sees. */
export class Rolling {
  private buf: number[] = [];
  private sum = 0;
  private readonly cap: number;

  constructor(cap: number) {
    this.cap = Math.max(1, cap);
  }

  push(v: number): void {
    this.buf.push(v);
    this.sum += v;
    if (this.buf.length > this.cap) this.sum -= this.buf.shift()!;
  }

  get n(): number { return this.buf.length; }
  get last(): number { return this.buf.length ? this.buf[this.buf.length - 1] : 0; }
  get mean(): number { return this.buf.length ? this.sum / this.buf.length : 0; }

  clear(): void { this.buf.length = 0; this.sum = 0; }
}

export interface SpikeOpts {
  /** How many times the mean counts as a spike. */
  k?: number;
  /** Absolute floor, in the metric's own units. */
  minDelta?: number;
  /** Never judge a buffer this short. */
  minN?: number;
  /** For metrics where LOW is bad (fps): fire when cur < mean / k. */
  invert?: boolean;
}

/** Is `cur` far enough above (or below) its own rolling mean to be worth
 *  colouring red?
 *
 *  The obvious test, cur > mean, is true about half the time by construction
 *  when the mean is taken over a short window of the same series. A readout
 *  that strobes red through half a procedure is one nobody reads, and then
 *  the one spike that mattered goes unnoticed. So all three bars have to
 *  clear: a multiple of the mean, an absolute delta (so a jitter from 3 ms to
 *  6 ms is not "a 2x spike"), and a warm enough buffer to have a mean at
 *  all. */
export function isSpike(cur: number, mean: number, n: number, opts: SpikeOpts = {}): boolean {
  const { k = 1.5, minDelta = 15, minN = 5, invert = false } = opts;
  if (n < minN || mean <= 0 || cur <= 0) return false;
  if (invert) return cur < mean / k && mean - cur >= minDelta;
  return cur > mean * k && cur - mean >= minDelta;
}
