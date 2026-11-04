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

self.onmessage = async (e) => {
  const { id, bitmap, quality } = e.data;
  try {
    if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      ctx = canvas.getContext("2d");
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    const buf = await blob.arrayBuffer();
    self.postMessage({ id, buf }, [buf]);
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
