// Plain JS on purpose, not .ts -- a worker's global scope (self, postMessage)
// conflicts with the DOM lib types the rest of this app uses, and this file
// is small enough that it doesn't need the app's type system anyway.
//
// Served as a plain static file from public/, not bundled by webpack --
// Next.js's default config doesn't support the `new Worker(new URL(...))`
// bundler pattern out of the box, and adding a worker-loader rule just for
// this one small file was more than this needed. See jpegEncoder.ts.
//
// Runs the JPEG encode on its own thread, not the main one. The main thread
// was measured taking anywhere from ~20ms to ~200ms for the exact same
// encode, because Chromium only encodes canvas.toBlob() during the main
// thread's idle moments -- if it's busy (video draw, DOM work), the encode
// gets forced and is dramatically slower. Moving the encode here removes
// the main thread from the question entirely: this thread never competes
// with it, so there's no "was the main thread free right now" variance.

let canvas = null;
let ctx = null;

// Timed in two pieces so a slow number has a visible cause instead of one
// lumped "encode" figure -- see jpegEncoder.ts for the main-thread half
// (bitmap copy, and the wait after this worker already replied).
self.onmessage = async (e) => {
  const { id, bitmap, quality, sentAt } = e.data;
  const workerStart = performance.now();
  try {
    if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      ctx = canvas.getContext("2d");
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    const buf = await blob.arrayBuffer();
    const workerDone = performance.now();
    self.postMessage({
      id,
      buf,
      // Time from the main thread handing this message off to this worker
      // actually starting on it -- message-passing plus however long this
      // thread had to wait its turn for a CPU core.
      handoffMs: workerStart - sentAt,
      // The real compression work, isolated from everything above and from
      // whatever happens after postMessage below.
      workerEncodeMs: workerDone - workerStart,
    }, [buf]);
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
