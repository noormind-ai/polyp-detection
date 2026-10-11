/**
 * Picking the right mode out of a capture device.
 *
 * A capture card does not hand you one picture format, it hands you a menu —
 * and the browser picks from that menu for us, badly. The clinic's card (an
 * ezcap/Somagic SMI-2021, analog SD) offers exactly three:
 *
 *     720x576 @ 25      PAL
 *     720x486 @ 29.97   NTSC
 *     720x480 @ 29.97   NTSC
 *
 * The endoscope processor feeding it generates a 480-line NTSC picture. Asked
 * for `height: { ideal: 720 }` — which is what this app used to request —
 * Chrome scores each mode by distance from the ideal and picks 576, because
 * 576 is nearer to 720 than 480 is. The card then has 96 lines it was never
 * given anything to put in, and an untouched YUV buffer is not black: it is
 * green. That is the green band across the bottom 16.7% of every clinic
 * recording. We were choosing it ourselves, every session. Left alone the card
 * opens at 720x480 @ 29.97 — the correct mode — entirely on its own.
 *
 * Two things make "just pick properly" harder than reading a list:
 *
 *  - **There is no list.** `getCapabilities()` returns a *range* per property
 *    (`height: {min: 1, max: 576}`), never the combinations. That is deliberate
 *    in the spec: capabilities cannot express that a device does one height at
 *    one frame rate and another height at another. The prescribed method is to
 *    try a combination and see what happens.
 *  - **The browser will lie by downscaling.** Ask for 480 and Chrome may hand
 *    back a 576 frame scaled to 480 rather than selecting the native mode, so
 *    `getSettings()` reporting 480 proves nothing on its own.
 *
 * Hence: adjust the track, then judge the result on the only evidence that
 * cannot be faked — the pixels.
 *
 * Everything happens on ONE open track, via applyConstraints. That is not a
 * detail. An earlier version closed the device between candidates, and a USB
 * grabber of this class does not finish releasing when stop() returns: the next
 * getUserMedia then lands on a device Chrome still considers active and is
 * locked to the *current* configuration, so every other exact size comes back
 * OverconstrainedError — indistinguishable from "this card cannot do that".
 * The first rung won by default, which is the padded one, and the green band
 * came straight back. Measured on the real card, the single-track ladder
 * returns exactly the same numbers with none of that risk.
 *
 * Frame rate carries the other half of the answer. PAL is 25, NTSC is 29.97, so
 * `frameRate: { min: 26 }` is a hard requirement no PAL mode can satisfy. It is
 * a cleaner discriminator than `exact: 29.97`, which asks a float to match a
 * number the device actually calls 30000/1001.
 */

/** Above this fraction of pad-coloured pixels, a mode is padded and we keep
 *  looking. Measured on the real card: PAL reads 16.7% (96 of 576 rows), the
 *  486-line mode reads 1.2% (6 rows), and 480 reads 0.0%. 1% sits in the gap
 *  and is the reason the 486 mode is correctly passed over. */
export const PAD_MAX_FRACTION = 0.01;

export interface ModeCandidate {
  label: string;
  width?: number;
  height?: number;
  frameRate?: ConstrainDouble;
}

export interface ModeAttempt {
  label: string;
  /** What the device actually produced, e.g. "720x480@29.97". Absent on error. */
  got?: string;
  /** Fraction of the frame that was pad colour, 0..1. Absent on error. */
  pad?: number;
  /** DOMException name when the mode could not be applied at all. */
  error?: string;
}

export interface NegotiatedMode {
  /** Live stream, already open and already on the chosen mode. Null only if the
   *  device could not be opened at all. */
  stream: MediaStream | null;
  settings: MediaTrackSettings | null;
  padFraction: number;
  /** Every rung tried, in order, with its outcome. Drives the diagnostics UI. */
  tried: ModeAttempt[];
  /** True when nothing clean was found and what we settled on still has a pad.
   *  fov.ts crops it; this flag is what tells the operator that is happening. */
  padded: boolean;
}

/**
 * Fraction of pixels that are the colour of an unwritten video buffer.
 *
 * A zeroed YUV buffer converts to pure green. Straight off the card that is
 * (0,136,0); the same pixels come back around (0,72,0) after a round trip
 * through VP9, so the green channel needs a wide window while red and blue stay
 * pinned near zero. That combination is the point — mucosa is red, orange or
 * pink and is never green with no red in it at all, so this cannot be confused
 * with tissue however dark the lumen gets.
 *
 * Deliberately measured at full resolution. The 486-line mode pads only six
 * rows, 1.2%, and that is close enough to the 1% threshold that resampling the
 * frame smaller first could blur it under and let a padded mode through.
 */
export function padGreenFraction(data: Uint8ClampedArray): number {
  const total = data.length / 4;
  if (!total) return 0;
  let pad = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r < 40 && b < 40 && g >= 50 && g <= 160) pad++;
  }
  return pad / total;
}

/**
 * The ladder, best first.
 *
 * Capabilities are used only as an outer bound — to avoid wasting a step on a
 * mode the device certainly does not have — never as a statement of what works.
 * Order is by how much real picture a mode can carry, so the first rung that
 * comes back unpadded is also the best one available.
 *
 * SD cards get PAL offered before NTSC on purpose. If the source really is PAL
 * then 576 is 576 lines of picture and we should keep it; it is only when the
 * pixels come back padded that we learn the source is actually NTSC. That way
 * the same ladder is right in both worlds, with nothing about this particular
 * clinic hardcoded into it.
 */
export function candidateModes(caps: MediaTrackCapabilities | undefined): ModeCandidate[] {
  const maxH = caps?.height?.max ?? 0;
  const maxW = caps?.width?.max ?? 0;
  const out: ModeCandidate[] = [];
  if (maxH >= 1080 && maxW >= 1920) out.push({ label: "1080p", width: 1920, height: 1080 });
  if (maxH >= 720 && maxW >= 1280) out.push({ label: "720p", width: 1280, height: 720 });
  if (maxH >= 576) out.push({ label: "PAL 576i", width: 720, height: 576, frameRate: { max: 25 } });
  if (maxH >= 486) out.push({ label: "NTSC 486i", width: 720, height: 486, frameRate: { min: 26 } });
  if (maxH >= 480) out.push({ label: "NTSC 480i", width: 720, height: 480, frameRate: { min: 26 } });
  return out;
}

/** `exact`, never `ideal`: a mode the device does not have should fail loudly
 *  so the ladder moves on, rather than Chrome quietly substituting the nearest
 *  thing and us believing it. */
function constraintSetFor(m: ModeCandidate): MediaTrackConstraints {
  const c: MediaTrackConstraints = {};
  if (m.width) c.width = { exact: m.width };
  if (m.height) c.height = { exact: m.height };
  if (m.frameRate) c.frameRate = m.frameRate;
  return c;
}

/**
 * Nothing in here may hang forever.
 *
 * A capture device another process is holding can leave getUserMedia pending
 * indefinitely rather than rejecting, and a detached <video> that never
 * receives data leaves play() unresolved. Either one strands the operator on a
 * spinner with no way out but a page reload — which is precisely what happened
 * the first time this shipped. A step that takes too long is a failed step.
 */
const OPEN_TIMEOUT_MS = 8000;
const APPLY_TIMEOUT_MS = 5000;
const PLAY_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DOMException(`${what} timed out after ${ms}ms`, "TimeoutError")), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Reused across calls — one canvas per negotiation would churn for nothing. */
let probe: HTMLCanvasElement | null = null;

/**
 * One real frame from a stream, as pixels.
 *
 * A track reports its dimensions before it has painted anything, so reading
 * immediately gives a canvas of nothing and a pad fraction of zero — which
 * would make every rung look clean and defeat the whole exercise. Hence waiting
 * for `currentTime` to actually advance. Returns null if no frame arrives,
 * which is treated as "cannot tell", never as "clean".
 */
async function grabFrame(stream: MediaStream): Promise<Uint8ClampedArray | null> {
  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  try {
    await withTimeout(video.play(), PLAY_TIMEOUT_MS, "video.play()");
    for (let i = 0; i < 40; i++) {
      if (video.videoWidth && video.videoHeight && video.currentTime > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return null;
    if (!probe) probe = document.createElement("canvas");
    if (probe.width !== w) probe.width = w;
    if (probe.height !== h) probe.height = h;
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

function describe(s: MediaTrackSettings): string {
  return `${s.width ?? 0}x${s.height ?? 0}@${(s.frameRate ?? 0).toFixed(2)}`;
}

/**
 * Open a device and leave it on the best mode it has.
 *
 * `scanAll` suppresses the early exit so every rung is measured, for the
 * diagnostics button. It costs a few seconds but never closes the device, so
 * unlike the old implementation it is safe to run while a session is up.
 */
export async function negotiateCameraMode(
  deviceId: string,
  opts: { scanAll?: boolean; onProgress?: (step: string, i: number, total: number) => void } = {},
): Promise<NegotiatedMode> {
  const say = opts.onProgress ?? (() => {});
  const tried: ModeAttempt[] = [];

  let stream: MediaStream;
  try {
    say("opening", 0, 1);
    // No size constraints at all. Whatever the device considers its own default
    // is both the honest starting point and, on this hardware, already right.
    stream = await withTimeout(navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId } }, audio: false,
    }), OPEN_TIMEOUT_MS, "opening the camera");
  } catch (err) {
    return {
      stream: null, settings: null, padFraction: 1, padded: true,
      tried: [{ label: "open", error: err instanceof DOMException ? err.name : "Error" }],
    };
  }

  const track = stream.getVideoTracks()[0];
  const caps = track.getCapabilities?.();

  const measure = async () => {
    const data = await grabFrame(stream);
    return data ? padGreenFraction(data) : null;
  };

  // The device's own default, measured before we touch anything.
  const firstSettings = track.getSettings();
  const firstPad = await measure();
  tried.push({ label: "default", got: describe(firstSettings), pad: firstPad ?? undefined });
  if (firstPad !== null && firstPad <= PAD_MAX_FRACTION && !opts.scanAll) {
    return { stream, settings: firstSettings, padFraction: firstPad, tried, padded: false };
  }

  let best: { mode: ModeCandidate | null; pad: number; settings: MediaTrackSettings } =
    { mode: null, pad: firstPad ?? 1, settings: firstSettings };

  const ladder = candidateModes(caps);
  let i = 0;
  for (const m of ladder) {
    say(m.label, ++i, ladder.length);
    try {
      await withTimeout(track.applyConstraints(constraintSetFor(m)), APPLY_TIMEOUT_MS, m.label);
      const s = track.getSettings();
      const pad = await measure();
      tried.push({ label: m.label, got: describe(s), pad: pad ?? undefined });
      if (pad !== null && pad < best.pad) best = { mode: m, pad, settings: s };
      if (pad !== null && pad <= PAD_MAX_FRACTION && !opts.scanAll) break;
    } catch (err) {
      tried.push({ label: m.label, error: err instanceof DOMException ? err.name : "Error" });
    }
  }

  // The loop leaves the track wherever it last went, which is not necessarily
  // the winner — put it back.
  try {
    await withTimeout(track.applyConstraints(best.mode ? constraintSetFor(best.mode) : {}),
                      APPLY_TIMEOUT_MS, "restoring the chosen mode");
  } catch { /* stay where we are; the measurement below reports the truth */ }

  const settings = track.getSettings();
  const finalPad = (await measure()) ?? best.pad;
  return {
    stream, settings, padFraction: finalPad, tried,
    padded: finalPad > PAD_MAX_FRACTION,
  };
}

/** Human-readable one-liner for the status area. */
export function describeMode(settings: MediaTrackSettings | null, padFraction: number): string {
  if (!settings) return "";
  const base = `${settings.width ?? 0}×${settings.height ?? 0} @ ${(settings.frameRate ?? 0).toFixed(2)}`;
  return padFraction > PAD_MAX_FRACTION
    ? `${base} · ${(padFraction * 100).toFixed(1)}% padding, cropping it`
    : `${base} · no padding`;
}
