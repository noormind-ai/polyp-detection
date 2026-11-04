/** Hands JPEG encoding to a Web Worker instead of the main thread -- see
 *  workers/jpegEncode.worker.js for why. One instance per live session;
 *  create once, reuse every frame, terminate on unmount.
 *
 *  Falls back to plain canvas.toBlob() on the main thread if OffscreenCanvas
 *  or Worker aren't available (older/locked-down browsers) -- same behavior
 *  as before this existed, never a hard failure. */
export class JpegEncoder {
  private worker: Worker | null = null;
  private nextId = 0;
  private pending = new Map<number, { resolve: (buf: ArrayBuffer) => void; reject: (e: unknown) => void }>();

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
        const { id, buf, error } = e.data as { id: number; buf?: ArrayBuffer; error?: string };
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        if (error) entry.reject(new Error(error));
        else entry.resolve(buf!);
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
  async encode(source: HTMLCanvasElement, quality: number): Promise<ArrayBuffer> {
    if (!this.worker) throw new Error("JpegEncoder not ready");
    const bitmap = await createImageBitmap(source);
    const id = this.nextId++;
    return new Promise<ArrayBuffer>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, bitmap, quality }, [bitmap]);
    });
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}
