/** Hands JPEG encoding to a Web Worker instead of the main thread -- see
 *  workers/jpegEncode.worker.js for why. One instance per live session;
 *  create once, reuse every frame, terminate on unmount.
 *
 *  Falls back to plain canvas.toBlob() on the main thread if OffscreenCanvas
 *  or Worker aren't available (older/locked-down browsers) -- same behavior
 *  as before this existed, never a hard failure. */
/** The four pieces that the single "JPEG encode" number used to hide:
 *  - bitmapMs: main-thread cost of createImageBitmap, before the worker
 *    even sees this frame.
 *  - handoffMs: message-passing plus however long the worker thread waited
 *    its turn for a CPU core, reported by the worker itself.
 *  - workerEncodeMs: the real compression work, isolated on its own thread
 *    -- this is what an isolated encode-only benchmark measures.
 *  - returnWaitMs: time from the worker finishing to the main thread
 *    actually noticing -- main-thread contention from other per-frame work
 *    (draw, grab, React renders) shows up here, not in workerEncodeMs. */
export interface EncodeTiming {
  bitmapMs: number;
  handoffMs: number;
  workerEncodeMs: number;
  returnWaitMs: number;
}

export interface EncodeResult {
  buf: ArrayBuffer;
  timing: EncodeTiming;
}

export class JpegEncoder {
  private worker: Worker | null = null;
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (r: EncodeResult) => void;
      reject: (e: unknown) => void;
      sentAt: number;
      bitmapMs: number;
    }
  >();

  readonly supported: boolean =
    typeof OffscreenCanvas !== "undefined" && typeof Worker !== "undefined";

  constructor() {
    if (!this.supported) return;
    try {
      // Plain static file under public/jpegEncode.worker.js, not a
      // bundler-resolved URL -- see that file's header for why. Same
      // BASE_PATH prefix convention LiveCameraPlayer.tsx already uses for
      // /demos/ etc.
      const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
      this.worker = new Worker(`${base}/jpegEncode.worker.js`);
      this.worker.onmessage = (e: MessageEvent) => {
        const returnedAt = performance.now();
        const { id, buf, error, handoffMs, workerEncodeMs } = e.data as {
          id: number; buf?: ArrayBuffer; error?: string; handoffMs?: number; workerEncodeMs?: number;
        };
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        if (error) { entry.reject(new Error(error)); return; }
        // Cross-thread performance.now() calls share the page's time origin
        // for a dedicated worker, so subtracting them is valid -- this is
        // the only piece not reported by the worker itself: how long the
        // reply sat waiting for the main thread to come back and read it.
        const returnWaitMs = returnedAt - entry.sentAt - (handoffMs ?? 0) - (workerEncodeMs ?? 0);
        entry.resolve({
          buf: buf!,
          timing: {
            bitmapMs: entry.bitmapMs,
            handoffMs: handoffMs ?? 0,
            workerEncodeMs: workerEncodeMs ?? 0,
            returnWaitMs: Math.max(0, returnWaitMs),
          },
        });
      };
    } catch {
      // Construction itself can throw in some locked-down environments --
      // treat exactly like unsupported.
      this.worker = null;
    }
  }

  get ready(): boolean {
    return this.worker !== null;
  }

  /** `source` must already be the resized (320px) canvas -- this never
   *  resizes, it only encodes whatever pixels it's given. */
  async encode(source: HTMLCanvasElement, quality: number): Promise<EncodeResult> {
    if (!this.worker) throw new Error("JpegEncoder not ready");
    const bitmapT0 = performance.now();
    const bitmap = await createImageBitmap(source);
    const sentAt = performance.now();
    const bitmapMs = sentAt - bitmapT0;
    const id = this.nextId++;
    return new Promise<EncodeResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, sentAt, bitmapMs });
      this.worker!.postMessage({ id, bitmap, quality, sentAt }, [bitmap]);
    });
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}
