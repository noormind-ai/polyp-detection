"use client";

/**
 * The capture-card diagnostic: seven measured steps, one JSON report.
 *
 * Everything here is measurement logic so ClinicTest.tsx stays UI-only.
 * Each step is independently try/caught by the orchestrator — a run that
 * dies on step 4 of 7 is worth far less than one that reports steps 1-3
 * plus the error, so failures are FILED (report.errors) and the run
 * continues. The report is uploaded to /api/diagnostics; raw frames go up
 * as separate PNG PUTs so one oversized frame can't sink the report.
 *
 * Internal tool: English-only, no i18n.
 */

import { negotiateCameraMode, describeMode } from "@/lib/cameraMode";
import { combRatio, createDeinterlacer } from "@/lib/interlace";
import { frameQuality } from "@/lib/frameQuality";
import { detectFovRect, trimmedFraction } from "@/lib/fov";
import { RECORDING_QUALITIES, pickMimeType } from "@/lib/useSessionRecorder";
import { isLiveInferenceActive } from "@/lib/uploadCoordinator";

const API = process.env.NEXT_PUBLIC_API_URL || "";

export const MACHINE_TYPES = [
  { value: "clinic-computer", label: "Clinic computer (theirs)" },
  { value: "our-pc", label: "Our PC at the clinic" },
  { value: "laptop", label: "My laptop" },
  { value: "other", label: "Other" },
] as const;

export const CONNECTIONS = [
  { value: "composite", label: "Composite (yellow RCA plug — what we use)" },
  { value: "s-video", label: "S-Video (round 4-pin plug)" },
  { value: "unknown", label: "Don't know" },
] as const;

export interface DiagnosticProgress {
  step: number;
  totalSteps: number;
  label: string;
  detail?: string;
}

export interface StatSummary { median: number; p90: number; min: number; max: number; n: number }

// The report is assembled piecemeal across fallible steps, so it's typed
// loosely on purpose; the schema lives in the plan + backend, not here.
export type ClinicReport = Record<string, unknown> & { errors: Record<string, string> };

export interface DiagnosticResult { report: ClinicReport; frames: Blob[]; clip: Blob | null }

const FRAME_COUNT = 9;
/** Margin crops filed after the full frames: the OSD lives in the border, and
 *  at full resolution its text is legible in a way a scaled-down frame is not. */
const OSD_CROP_COUNT = 2;
/** Near-transparent for SD: high enough that what we study later is the
 *  signal rather than the encoder. */
const SAMPLE_CLIP_BPS = 25_000_000;
/** Consecutive full-resolution frames kept losslessly — about a second. */
const BURST_FRAMES = 24;
const SIGNAL_WINDOW_MS = 5000;
const TIMING_WINDOW_MS = 10000;
const RECORD_SECONDS = 8;
const UPLOAD_TEST_BYTES = 4 * 1024 * 1024;

function msg(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function summarize(samples: number[]): StatSummary | null {
  if (!samples.length) return null;
  const s = [...samples].sort((a, b) => a - b);
  const q = (f: number) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
  const r = (x: number) => Math.round(x * 100) / 100;
  return { median: r(q(0.5)), p90: r(q(0.9)), min: r(s[0]), max: r(s[s.length - 1]), n: s.length };
}

function jsonClone<T>(obj: T): unknown {
  try { return JSON.parse(JSON.stringify(obj)); } catch { return null; }
}

function toBlobAsync(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))), type, quality);
  });
}

type VideoWithRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

/** Per-decoded-frame loop with a rAF fallback for browsers without rVFC.
 *  Returns a stop function. */
function onEachFrame(video: HTMLVideoElement, cb: () => void): () => void {
  const v = video as VideoWithRVFC;
  let stopped = false;
  if (typeof v.requestVideoFrameCallback === "function") {
    let handle = 0;
    const loop = () => {
      if (stopped) return;
      cb();
      handle = v.requestVideoFrameCallback!(loop);
    };
    handle = v.requestVideoFrameCallback(loop);
    return () => { stopped = true; try { v.cancelVideoFrameCallback?.(handle); } catch { /* gone */ } };
  }
  let raf = 0;
  const loop = () => {
    if (stopped) return;
    cb();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return () => { stopped = true; cancelAnimationFrame(raf); };
}

/** A fresh track can report dimensions before it has painted anything —
 *  the same trap cameraMode.ts documents — so wait for real pixels. */
async function waitForFrame(video: HTMLVideoElement, timeoutMs = 5000): Promise<void> {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    if (video.videoWidth > 0 && video.currentTime > 0) return;
    await sleep(50);
  }
  throw new Error("video produced no frames within timeout");
}

// ---------------------------------------------------------------- steps ----

function collectEnvironment(): Record<string, unknown> {
  let gpuVendor: string | null = null, gpuRenderer: string | null = null;
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    if (gl && info) {
      gpuVendor = String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL));
      gpuRenderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
    }
  } catch { /* masked on hardened browsers — nullable by design */ }
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    user_agent: navigator.userAgent,
    hardware_concurrency: navigator.hardwareConcurrency ?? null,
    device_memory: nav.deviceMemory ?? null,
    screen: { w: screen.width, h: screen.height, dpr: window.devicePixelRatio },
    gpu_vendor: gpuVendor,
    gpu_renderer: gpuRenderer,
    is_secure_context: window.isSecureContext,
    page_url: window.location.href,
  };
}

async function captureFrames(video: HTMLVideoElement):
    Promise<{ frames: Blob[]; meta: Record<string, unknown>[] }> {
  const canvas = document.createElement("canvas");
  const frames: Blob[] = [];
  const meta: Record<string, unknown>[] = [];
  const t0 = performance.now();
  for (let i = 0; i < FRAME_COUNT; i++) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) throw new Error("video has no dimensions");
    canvas.width = vw;
    canvas.height = vh;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    const blob = await toBlobAsync(canvas, "image/png");
    meta.push({ seq: i, w: vw, h: vh, bytes: blob.size,
                captured_at_ms: Math.round(performance.now() - t0) });
    frames.push(blob);
    await sleep(500);
  }
  return { frames, meta };
}

function lumaStats(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const { width: w, height: h } = canvas;
  const data = ctx.getImageData(0, 0, w, h).data;
  const bins = new Array(16).fill(0);
  let crush = 0, clip = 0;
  const n = w * h;
  const luma = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const y = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    luma[i] = y;
    bins[Math.min(15, Math.floor(y / 16))]++;
    if (y <= 5) crush++;
    if (y >= 250) clip++;
  }
  return { bins: bins.map((b) => Math.round((b / n) * 1000) / 10),
           pct_0_5: Math.round((crush / n) * 1000) / 10,
           pct_250_255: Math.round((clip / n) * 1000) / 10,
           luma };
}

async function measureSignal(video: HTMLVideoElement): Promise<Record<string, unknown>> {
  const vw = video.videoWidth, vh = video.videoHeight;
  const combs: number[] = [];
  let nulls = 0;

  // Downsampled luma of the PREVIOUS sampled frame, for temporal noise.
  const smallW = 120;
  const smallH = Math.max(2, Math.round((vh / vw) * smallW));
  const small = document.createElement("canvas");
  small.width = smallW; small.height = smallH;
  let prevLuma: Float32Array | null = null;
  const diffs: number[] = [];

  const full = document.createElement("canvas");
  full.width = vw; full.height = vh;
  let quality: unknown = null;

  const t0 = performance.now();
  let i = 0;
  while (performance.now() - t0 < SIGNAL_WINDOW_MS) {
    const r = combRatio(video, vw, vh);
    if (r === null) nulls++; else combs.push(r);

    small.getContext("2d")!.drawImage(video, 0, 0, smallW, smallH);
    const s = lumaStats(small);
    if (prevLuma) {
      let acc = 0;
      for (let k = 0; k < s.luma.length; k++) acc += Math.abs(s.luma[k] - prevLuma[k]);
      diffs.push(acc / s.luma.length);
    }
    prevLuma = s.luma;

    if (i === 7) {   // one mid-window full-res measurement is enough
      full.getContext("2d")!.drawImage(video, 0, 0);
      quality = frameQuality(full);
    }
    i++;
    await sleep(330);
  }

  full.getContext("2d")!.drawImage(video, 0, 0);
  const hist = lumaStats(full);
  if (quality === null) quality = frameQuality(full);

  return {
    comb: { median: summarize(combs)?.median ?? null, max: summarize(combs)?.max ?? null,
            samples: combs.length, nulls },
    quality: jsonClone(quality),
    histogram: { bins: hist.bins, pct_0_5: hist.pct_0_5, pct_250_255: hist.pct_250_255 },
    temporal_noise: { mean_abs_diff: summarize(diffs)?.median ?? null, samples: diffs.length },
  };
}

async function measureTimings(video: HTMLVideoElement): Promise<Record<string, unknown>> {
  const vw = video.videoWidth & ~1, vh = video.videoHeight & ~1;
  const deint = createDeinterlacer();
  const deintDst = document.createElement("canvas");
  deintDst.width = vw; deintDst.height = vh;
  const downW = 320, downH = Math.max(2, Math.round((vh / vw) * downW));
  const down = document.createElement("canvas");
  down.width = downW; down.height = downH;

  const gaps: number[] = [], deintMs: number[] = [], downMs: number[] = [], jpegMs: number[] = [];
  let last = 0, frame = 0;
  let jpegBusy = false;

  const stop = onEachFrame(video, () => {
    const now = performance.now();
    if (last) gaps.push(now - last);
    last = now;

    let t = performance.now();
    deint.draw(video, 0, 0, vw, vh, deintDst, vw, vh, video.currentTime);
    deintMs.push(performance.now() - t);

    t = performance.now();
    down.getContext("2d")!.drawImage(deintDst, 0, 0, downW, downH);
    downMs.push(performance.now() - t);

    // JPEG encode is async; time every 3rd frame, one in flight at a time.
    if (frame % 3 === 0 && !jpegBusy) {
      jpegBusy = true;
      const tj = performance.now();
      toBlobAsync(down, "image/jpeg", 0.7)
        .then(() => jpegMs.push(performance.now() - tj))
        .catch(() => { /* a failed encode is simply an absent sample */ })
        .finally(() => { jpegBusy = false; });
    }
    frame++;
  });
  await sleep(TIMING_WINDOW_MS);
  stop();

  return {
    rvfc_fps: summarize(gaps.map((g) => 1000 / g)),
    expected_fps: 29.97,
    deinterlace_ms: summarize(deintMs),
    downscale_ms: summarize(downMs),
    jpeg_encode_ms: summarize(jpegMs),
  };
}

async function testRecording(stream: MediaStream, video: HTMLVideoElement,
                             onDetail: (d: string) => void): Promise<unknown[]> {
  const results: unknown[] = [];
  const mime = pickMimeType();
  for (const q of RECORDING_QUALITIES) {
    onDetail(`${q.key} (${(q.bps / 1e6).toFixed(1)} Mbps)`);
    if (!mime) {
      results.push({ key: q.key, error: "MediaRecorder unsupported in this browser" });
      continue;
    }
    try {
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: q.bps });
      let bytes = 0;
      rec.ondataavailable = (e) => { bytes += e.data.size; };
      const gaps: number[] = [];
      let last = 0;
      const stopPaint = onEachFrame(video, () => {
        const now = performance.now();
        if (last) gaps.push(now - last);
        last = now;
      });
      const t0 = performance.now();
      rec.start(1000);
      await sleep(RECORD_SECONDS * 1000);
      await new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
        rec.stop();
      });
      stopPaint();
      const durMs = performance.now() - t0;
      results.push({
        key: q.key,
        requested_bps: q.bps,
        mime,
        duration_ms: Math.round(durMs),
        bytes,
        effective_kbps: Math.round((bytes * 8) / (durMs / 1000) / 1000),
        paint_fps: summarize(gaps.map((g) => 1000 / g)),
      });
    } catch (e) {
      results.push({ key: q.key, error: msg(e) });
    }
  }
  return results;
}

/** Exported so /sim (and session start -- see page.tsx) can measure the
 *  same link the same way -- one implementation, so a number from the
 *  simulator, the diagnostic, and a live session all mean the same thing.
 *
 *  `bytes` defaults to the full diagnostic's payload; session start passes
 *  a much smaller one -- this runs before the operator can begin scanning,
 *  so it has to stay a one-to-two-second cost, not reproduce the slow
 *  upload it exists to measure. */
export async function measureNetwork(bytes: number = UPLOAD_TEST_BYTES): Promise<Record<string, unknown>> {
  const rtts: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const r = await fetch(`${API}/api/diagnostics/ping`, { cache: "no-store", credentials: "include" });
    if (!r.ok) throw new Error(`ping returned ${r.status}`);
    await r.json();
    rtts.push(Math.round((performance.now() - t0) * 10) / 10);
  }
  const buf = new Uint8Array(bytes);
  // getRandomValues caps one call at 64 KB — fill in slices.
  for (let off = 0; off < buf.length; off += 65536) {
    crypto.getRandomValues(buf.subarray(off, Math.min(off + 65536, buf.length)));
  }
  const t0 = performance.now();
  const r = await fetch(`${API}/api/diagnostics/net-test`,
                        { method: "POST", credentials: "include", body: buf });
  if (!r.ok) throw new Error(`net-test returned ${r.status}`);
  await r.json();
  const ms = performance.now() - t0;
  return {
    rtt_ms: rtts,
    rtt_median_ms: summarize(rtts)?.median ?? null,
    upload: { bytes: buf.length, ms: Math.round(ms),
              mbps: Math.round(((buf.length * 8) / 1e6 / (ms / 1000)) * 100) / 100 },
  };
}

/** A sample of the real signal: a high-bitrate clip for motion, and a burst
 *  of consecutive lossless frames for everything motion hides.
 *
 *  The burst is captured as raw pixels first and encoded to PNG afterwards:
 *  PNG encoding costs tens of milliseconds a frame, so encoding inline would
 *  drop most of the frames we are trying to keep consecutive. */
async function captureSample(stream: MediaStream, video: HTMLVideoElement, seconds: number):
    Promise<{ clip: Blob | null; burst: Blob[]; info: Record<string, unknown> }> {
  const info: Record<string, unknown> = { seconds, requested_bps: SAMPLE_CLIP_BPS };
  const vw = video.videoWidth, vh = video.videoHeight;

  // --- the clip ---
  let clip: Blob | null = null;
  const mime = pickMimeType();
  if (mime) {
    try {
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: SAMPLE_CLIP_BPS });
      const parts: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
      const t0 = performance.now();
      rec.start(1000);
      await sleep(seconds * 1000);
      await new Promise<void>((resolve) => { rec.onstop = () => resolve(); rec.stop(); });
      clip = new Blob(parts, { type: mime });
      info.mime = mime;
      info.bytes = clip.size;
      info.duration_ms = Math.round(performance.now() - t0);
      info.effective_kbps = Math.round((clip.size * 8) / ((info.duration_ms as number) / 1000) / 1000);
    } catch (e) { info.clip_error = msg(e); }
  } else {
    info.clip_error = "MediaRecorder unsupported";
  }

  // --- the lossless burst ---
  const burst: Blob[] = [];
  try {
    const grab = document.createElement("canvas");
    grab.width = vw; grab.height = vh;
    const gctx = grab.getContext("2d", { willReadFrequently: true })!;
    const held: ImageData[] = [];
    const stamps: number[] = [];
    await new Promise<void>((resolve) => {
      const stop = onEachFrame(video, () => {
        gctx.drawImage(video, 0, 0);
        held.push(gctx.getImageData(0, 0, vw, vh));
        stamps.push(performance.now());
        if (held.length >= BURST_FRAMES) { stop(); resolve(); }
      });
      // Never wait forever on a source that stops producing frames.
      setTimeout(() => { stop(); resolve(); }, BURST_FRAMES * 100 + 3000);
    });
    const enc = document.createElement("canvas");
    enc.width = vw; enc.height = vh;
    const ectx = enc.getContext("2d")!;
    for (const frame of held) {
      ectx.putImageData(frame, 0, 0);
      burst.push(await toBlobAsync(enc, "image/png"));
    }
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
    info.burst_frames = burst.length;
    info.burst_interval_ms = summarize(gaps)?.median ?? null;
    info.burst_bytes = burst.reduce((a, b) => a + b.size, 0);
  } catch (e) { info.burst_error = msg(e); }

  return { clip, burst, info };
}

/** What the processor says about itself, read off its own output. */
async function measureScope(video: HTMLVideoElement):
    Promise<{ info: Record<string, unknown>; crops: Blob[] }> {
  const vw = video.videoWidth, vh = video.videoHeight;
  const full = document.createElement("canvas");
  full.width = vw; full.height = vh;
  const fctx = full.getContext("2d", { willReadFrequently: true })!;
  fctx.drawImage(video, 0, 0);

  // Where the camera picture actually is inside the signal. Its size and
  // offset are a fingerprint of the processor and the scope it is driving.
  const rect = detectFovRect(full, vw, vh);
  const trim = rect ? trimmedFraction(rect, vw, vh) : null;

  // Mean colour inside the picture vs the margins: the first is the
  // processor's white balance, the second tells us whether the margin is
  // true black (clean mask) or lifted (a signal-level problem).
  function meanRGB(x: number, y: number, w: number, h: number) {
    if (w < 2 || h < 2) return null;
    const d = fctx.getImageData(Math.max(0, x), Math.max(0, y),
                                Math.min(w, vw - x), Math.min(h, vh - y)).data;
    let r = 0, g = 0, b = 0;
    const n = d.length / 4;
    for (let p = 0; p < d.length; p += 4) { r += d[p]; g += d[p + 1]; b += d[p + 2]; }
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
  }

  // Ink in the margin: an OSD is high-contrast text on black, so a bright
  // tail in the border's histogram means "this processor draws an overlay".
  function inkFraction(x: number, y: number, w: number, h: number) {
    if (w < 2 || h < 2) return null;
    const d = fctx.getImageData(Math.max(0, x), Math.max(0, y),
                                Math.min(w, vw - x), Math.min(h, vh - y)).data;
    let bright = 0;
    const n = d.length / 4;
    for (let p = 0; p < d.length; p += 4) {
      if (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2] > 140) bright++;
    }
    return Math.round((bright / n) * 1000) / 10;
  }

  const leftW = rect ? rect.x : Math.round(vw * 0.1);
  const bottomY = rect ? rect.y + rect.h : Math.round(vh * 0.9);

  const info: Record<string, unknown> = {
    frame_size: { w: vw, h: vh },
    picture_rect: rect,
    picture_trim_fraction: trim === null ? null : Math.round(trim * 1000) / 1000,
    picture_aspect: rect ? Math.round((rect.w / rect.h) * 100) / 100 : null,
    white_balance_in_picture: rect ? meanRGB(rect.x, rect.y, rect.w, rect.h) : null,
    margin_level_left: meanRGB(0, 0, leftW, vh),
    osd_ink_left_pct: inkFraction(0, 0, leftW, vh),
    osd_ink_bottom_pct: inkFraction(0, bottomY, vw, vh - bottomY),
  };

  // The crops themselves, lossless: the OSD text (processor model clues, the
  // burnt-in date that proves a real capture, and Olympus's Eh/Cm settings)
  // is only readable at native resolution.
  const crops: Blob[] = [];
  const cut = document.createElement("canvas");
  async function crop(x: number, y: number, w: number, h: number) {
    if (w < 8 || h < 8) return;
    cut.width = w; cut.height = h;
    cut.getContext("2d")!.drawImage(full, x, y, w, h, 0, 0, w, h);
    crops.push(await toBlobAsync(cut, "image/png"));
  }
  await crop(0, 0, Math.max(leftW, Math.round(vw * 0.25)), vh);          // OSD column
  await crop(0, bottomY - 10, vw, Math.max(12, vh - bottomY + 10));      // bottom strip

  return { info, crops };
}

// ----------------------------------------------------------- orchestrator ----

export async function runDiagnostic(
  opts: { deviceId: string; label: string; machineType: string;
          connection: string; hardwareId: string;
          processorModel: string; scopeModel: string;
          sampleSeconds: number },
  onProgress: (p: DiagnosticProgress) => void,
): Promise<DiagnosticResult> {
  const report: ClinicReport = {
    schema: 1,
    label: opts.label,
    machine_type: opts.machineType,
    connection: opts.connection,
    hardware_id: opts.hardwareId,
    processor_model: opts.processorModel,
    scope_model: opts.scopeModel,
    client_started_at: Date.now(),
    live_inference_active: isLiveInferenceActive(),
    errors: {},
  };
  const frames: Blob[] = [];
  let clip: Blob | null = null;
  const total = opts.sampleSeconds > 0 ? 8 : 7;
  const step = (n: number, label: string, detail?: string) =>
    onProgress({ step: n, totalSteps: total, label, detail });

  step(1, "Environment snapshot");
  try { report.environment = collectEnvironment(); }
  catch (e) { report.errors.environment = msg(e); }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const d = devices.find((x) => x.deviceId === opts.deviceId);
    report.device = { device_id: opts.deviceId.slice(0, 16), label: d?.label ?? "", kind: d?.kind ?? "videoinput" };
  } catch (e) { report.errors.device = msg(e); }

  let stream: MediaStream | null = null;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;

  try {
    step(2, "Scanning camera modes");
    try {
      const negotiated = await negotiateCameraMode(opts.deviceId, {
        scanAll: true,
        onProgress: (s, i, total) => step(2, "Scanning camera modes", `${s} (${i}/${total})`),
      });
      stream = negotiated.stream;
      const track = stream?.getVideoTracks()[0];
      const caps = track?.getCapabilities ? (track.getCapabilities() as Record<string, unknown>) : null;
      report.mode_scan = {
        tried: jsonClone(negotiated.tried),
        final_settings: jsonClone(negotiated.settings),
        capabilities: jsonClone(caps),
        pad_fraction: negotiated.padFraction,
        padded: negotiated.padded,
        description: describeMode(negotiated.settings, negotiated.padFraction),
        // The proc-amp question, answered per control: can the browser set it?
        proc_amp: {
          brightness: !!caps && "brightness" in caps,
          contrast: !!caps && "contrast" in caps,
          saturation: !!caps && "saturation" in caps,
          sharpness: !!caps && "sharpness" in caps,
        },
      };
    } catch (e) { report.errors.mode_scan = msg(e); }

    // The scan failing must not kill the pixel steps — fall back to a plain open.
    if (!stream) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: opts.deviceId } },
        });
      } catch (e) { report.errors.stream = msg(e); }
    }

    if (stream) {
      video.srcObject = stream;
      await video.play().catch(() => { /* autoplay with muted should pass */ });
      await waitForFrame(video);

      step(3, "Capturing raw frames");
      try {
        const got = await captureFrames(video);
        frames.push(...got.frames);
        report.frames = got.meta;
      } catch (e) { report.errors.frames = msg(e); }

      step(4, "Reading the endoscope's own output");
      try {
        const scope = await measureScope(video);
        report.scope = scope.info;
        // Filed after the full frames, so frame indices stay stable.
        frames.push(...scope.crops.slice(0, OSD_CROP_COUNT));
      } catch (e) { report.errors.scope = msg(e); }

      step(4, "Measuring signal");
      try { report.signal = await measureSignal(video); }
      catch (e) { report.errors.signal = msg(e); }

      step(5, "Timing pipeline stages");
      try { report.timings = await measureTimings(video); }
      catch (e) { report.errors.timings = msg(e); }

      step(6, "Test recordings");
      try { report.recording = await testRecording(stream, video, (d) => step(6, "Test recordings", d)); }
      catch (e) { report.errors.recording = msg(e); }
    }

      if (opts.sampleSeconds > 0 && stream) {
        step(7, "Keeping a sample of the signal", `${opts.sampleSeconds}s clip + ${BURST_FRAMES} lossless frames`);
        try {
          const sample = await captureSample(stream, video, opts.sampleSeconds);
          clip = sample.clip;
          frames.push(...sample.burst);
          report.sample = sample.info;
        } catch (e) { report.errors.sample = msg(e); }
      }

    step(total, "Network test");
    try { report.network = await measureNetwork(); }
    catch (e) { report.errors.network = msg(e); }
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }

  report.duration_ms = Date.now() - (report.client_started_at as number);
  return { report, frames, clip };
}

export async function uploadDiagnostic(result: DiagnosticResult): Promise<string> {
  const r = await fetch(`${API}/api/diagnostics/reports`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(result.report),
  });
  if (!r.ok) throw new Error(`report upload failed (${r.status})`);
  const { id } = (await r.json()) as { id: string };
  if (result.clip && result.clip.size) {
    const cr = await fetch(`${API}/api/diagnostics/reports/${id}/clip`, {
      method: "PUT", credentials: "include", body: result.clip,
    });
    if (!cr.ok) throw new Error(`clip upload failed (${cr.status})`);
  }
  for (let i = 0; i < result.frames.length; i++) {
    const fr = await fetch(`${API}/api/diagnostics/reports/${id}/frames/${i}`, {
      method: "PUT",
      credentials: "include",
      body: result.frames[i],
    });
    if (!fr.ok) throw new Error(`frame ${i} upload failed (${fr.status})`);
  }
  return id;
}

/** Fallback when the upload can't reach the server: hand everything to the
 *  operator as files, to be carried home and uploaded or inspected there. */
export function downloadDiagnostic(result: DiagnosticResult): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const save = (blob: Blob, name: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
  save(new Blob([JSON.stringify(result.report, null, 1)], { type: "application/json" }),
       `clinic-test-${stamp}.json`);
  result.frames.forEach((f, i) =>
    save(f, `clinic-test-${stamp}-frame-${String(i).padStart(2, "0")}.png`));
  if (result.clip?.size) save(result.clip, `clinic-test-${stamp}-clip.webm`);
}

export interface ReportSummary {
  id: string;
  label: string;
  machine_type: string;
  connection: string;
  created_at: number;
  user: string;
  device_label: string;
  frames: number;
}

export async function fetchReportList(): Promise<ReportSummary[]> {
  const r = await fetch(`${API}/api/diagnostics/reports`, { credentials: "include" });
  if (!r.ok) throw new Error(`list failed (${r.status})`);
  return (await r.json()) as ReportSummary[];
}

export async function fetchReport(id: string): Promise<ClinicReport> {
  const r = await fetch(`${API}/api/diagnostics/reports/${id}`, { credentials: "include" });
  if (!r.ok) throw new Error(`report fetch failed (${r.status})`);
  return (await r.json()) as ClinicReport;
}
