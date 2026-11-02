"use client";

import type { Box } from "./drawBoxes";

/**
 * Every frame of the current patient that the model scored, kept in the tab so
 * the review panel's timeline can be scrubbed and played.
 *
 * WHY NOT THE RECORDING. The session recording is already stored locally in
 * chunks, which looks like the obvious source, and it cannot be used. A WebM
 * written by MediaRecorder has no duration and no cue index, and Chrome never
 * goes back to add them -- its own README says the lack of seekability "is by
 * design of the webm live format". Measured on Chromium 131:
 *
 *   - a blob: URL of the concatenated chunks reports duration Infinity and a
 *     seek to the middle never completes, with seeks properly serialised.
 *   - MediaSource with EVERY chunk appended does work, but reaching minute 7
 *     means pushing ~420 MB through the decoder.
 *   - MediaSource with [header chunk, tail chunks] fails outright:
 *     "CHUNK_DEMUXER_ERROR_APPEND_FAILED: Got a block with a timecode before
 *     the previous block", in both segments and sequence mode -- because
 *     timeslice chunks are BYTE slices, not media segments, so a later chunk
 *     can begin mid-cluster.
 *
 * The documented way to build a DVR is short self-contained pieces plus your
 * own index. Taken to its limit, one JPEG per frame: every piece is
 * independently decodable, so seeking is free and there is no container to
 * repair.
 *
 * WHY IT IS FREE. The capture loop already encodes a JPEG of every frame to
 * send for inference, and used to throw it away. This keeps that exact blob.
 * Per frame the work is one array push -- no encode, no re-encode, no copy, no
 * decode, and no disk I/O. Decoding happens only while someone is watching a
 * replay. The clinic PC must not pay for this feature.
 */

export interface RingFrame {
  /** Monotonic, from the start of the procedure. */
  seq: number;
  /** Milliseconds since the procedure started -- the timeline's own axis. */
  atMs: number;
  /** The JPEG the loop already sent for inference. */
  jpeg: Blob;
  /** Boxes in this JPEG's pixel space -- it is the frame they were scored on,
   *  so no rescaling is involved. */
  boxes: Box[];
  w: number;
  h: number;
}

/**
 * Ceiling on what the store may hold. Hit it and the store THINS rather than
 * forgetting the beginning: the timeline keeps covering the whole patient, with
 * older stretches getting sparser. ~20 KB a frame at ~10 fps is ~12 MB a
 * minute, so this is roughly 16 minutes at full density -- about one patient.
 */
export const RING_MAX_BYTES = 192 * 1024 * 1024;

/** Seconds of run-up a replay opens with, so it shows the approach to the
 *  lesion rather than the lesion already centred. */
export const LEAD_IN_MS = 3000;

/**
 * Index of the frame with this seq, or of the first one AFTER it when that
 * frame has been thinned away. -1 when every held frame is older.
 *
 * A replay's cursor has to be a seq rather than an index, which is what this
 * exists for: thinning removes frames from the middle of the store, so every
 * index after the thinned region shifts. An index-based cursor silently starts
 * pointing at a different moment, and a cursor held against a stale copy of
 * the array stops advancing altogether.
 */
export function indexOfSeq(frames: RingFrame[], seq: number): number {
  let lo = 0, hi = frames.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].seq >= seq) { found = mid; hi = mid - 1; } else { lo = mid + 1; }
  }
  return found;
}

export class FrameStore {
  private items: RingFrame[] = [];
  private total = 0;
  private nextSeq = 0;
  /** How many times the store has had to thin, surfaced so the panel can admit
   *  that older playback is sparser than it looks. */
  private thinnings = 0;

  constructor(private maxBytes = RING_MAX_BYTES) {}

  /** Keep a frame. Called once per inferred frame, from the capture loop --
   *  everything here is O(1) except the occasional thinning pass. */
  push(f: Omit<RingFrame, "seq">): void {
    this.items.push({ ...f, seq: this.nextSeq++ });
    this.total += f.jpeg.size;
    while (this.total > this.maxBytes && this.thin()) { /* keep going */ }
  }

  /**
   * Halve the density of the older half, skipping any frame the model put a box
   * on. A detection frame is the whole point of the timeline, so it is never
   * the thing that gets dropped to save room.
   *
   * The very first frame is skipped too, and that is not cosmetic. An earlier
   * version alternated from index 0, so every pass took the oldest frame --
   * and since each pass halves what is left, the start of the procedure eroded
   * by 1, 2, 4, 8... frames. Eleven passes of a long session ate the first
   * 205 seconds, which is exactly the coverage this class exists to keep. The
   * timeline must still begin where the patient did.
   *
   * Returns false when there is nothing left to give up, at which point the
   * oldest frames go after all -- a ceiling that cannot be enforced is not a
   * ceiling.
   */
  private thin(): boolean {
    const half = Math.floor(this.items.length / 2);
    const kept: RingFrame[] = [];
    let dropped = 0;
    let alternate = false;
    for (let i = 0; i < this.items.length; i++) {
      const f = this.items[i];
      if (i > 0 && i < half && f.boxes.length === 0) {
        alternate = !alternate;
        if (alternate) { this.total -= f.jpeg.size; dropped++; continue; }
      }
      kept.push(f);
    }
    if (dropped > 0) {
      this.items = kept;
      this.thinnings++;
      return true;
    }
    // Everything droppable is already gone: give up the oldest tenth.
    const cut = Math.max(1, Math.floor(this.items.length / 10));
    if (this.items.length <= 1) return false;
    for (let i = 0; i < cut && this.items.length > 1; i++) {
      this.total -= this.items[0].jpeg.size;
      this.items.shift();
    }
    this.thinnings++;
    return true;
  }

  /** Index of the last frame at or before `atMs`, or -1 when empty. */
  indexAt(atMs: number): number {
    let lo = 0, hi = this.items.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.items[mid].atMs <= atMs) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best;
  }

  /** Everything from `atMs` to the newest frame, oldest first. */
  from(atMs: number): RingFrame[] {
    const i = this.items.findIndex((f) => f.atMs >= atMs);
    return i < 0 ? [] : this.items.slice(i);
  }

  /** The frames themselves. Live array, not a copy: a replay re-reads this on
   *  every frame it shows, and copying thousands of entries per step to
   *  protect a read-only consumer would be the most expensive thing in here. */
  get frames(): RingFrame[] { return this.items; }

  get length(): number { return this.items.length; }
  get bytes(): number { return this.total; }
  get thinned(): number { return this.thinnings; }
  /** Oldest moment still held, for saying what the timeline can actually play. */
  get fromMs(): number { return this.items.length ? this.items[0].atMs : 0; }
  get toMs(): number { return this.items.length ? this.items[this.items.length - 1].atMs : 0; }

  clear(): void {
    this.items = [];
    this.total = 0;
    this.nextSeq = 0;
    this.thinnings = 0;
  }
}
