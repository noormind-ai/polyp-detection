"use client";

/**
 * Live "what will the saved file look like" preview for /sim.
 *
 * Primary path: canvas.captureStream → MediaRecorder at the chosen bitrate →
 * chunks fed straight into a MediaSource SourceBuffer on a second <video>,
 * so the encoded result plays ~1s behind the raw panel, continuously.
 *
 * MediaSource-fed MediaRecorder output is the least-paved road in this app,
 * so every failure mode drops to a self-contained A/B fallback: record an
 * 8-second segment, loop it from a blob URL. The fallback is also reachable
 * deliberately (segment mode toggle in the UI) — a comparison you can only
 * reach through an error path is not a feature.
 *
 * A MediaRecorder's bitrate is fixed for its lifetime, so a bitrate change
 * is a full rebuild — the UI debounces the slider before calling swap().
 */

export type EncoderPreviewState =
  | { kind: "starting" }
  | { kind: "live"; mime: string }
  | { kind: "segment"; mime: string; reason: string; recording: boolean }
  | { kind: "error"; message: string };

export interface EncoderStats { bytes: number; kbps: number }

interface Opts {
  /** The raw panel's canvas — the encoder's input. */
  canvas: HTMLCanvasElement;
  /** The preview <video> the encoded result plays in. */
  videoEl: HTMLVideoElement;
  bitsPerSecond: number;
  /** Measured output rate over a sliding window, ~1 Hz. */
  onStats: (s: EncoderStats) => void;
  onStateChange: (s: EncoderPreviewState) => void;
}

const SEGMENT_SECONDS = 6;
/** How often a sample re-records itself, so the panel keeps showing the part
 *  of the procedure you are actually watching rather than one frozen clip. */
const SEGMENT_REFRESH_MS = 20_000;
const TIMESLICE_MS = 500;
const MAX_LAG_S = 2;
const KEEP_BEHIND_S = 10;
const STALL_CHECK_MS = 3000;

function pickDualMime(): string | null {
  if (typeof MediaRecorder === "undefined" || typeof MediaSource === "undefined") return null;
  for (const m of ["video/webm;codecs=vp9", "video/webm;codecs=vp8"]) {
    // Must satisfy BOTH ends of the pipe: the recorder producing it and the
    // MediaSource consuming it.
    if (MediaRecorder.isTypeSupported(m) && MediaSource.isTypeSupported(m)) return m;
  }
  return null;
}

export class EncoderPreview {
  private opts: Opts;
  private recorder: MediaRecorder | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private queue: ArrayBuffer[] = [];
  private segmentChunks: Blob[] = [];
  private segmentUrl: string | null = null;
  private mode: "live" | "segment" = "live";
  private stopped = true;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private lastTime = -1;
  private stallStrikes = 0;
  private windowBytes: Array<{ t: number; b: number }> = [];
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: Opts) { this.opts = opts; }

  start(segmentMode = false): void {
    this.stopInternal();
    this.stopped = false;
    this.mode = segmentMode ? "segment" : "live";
    const mime = pickDualMime();
    if (!mime) {
      const recOnly = typeof MediaRecorder !== "undefined" &&
        ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
          .find((m) => MediaRecorder.isTypeSupported(m));
      if (recOnly) {
        this.mode = "segment";
        this.beginSegment(recOnly, "MediaSource can't play the recorder's format");
      } else {
        this.opts.onStateChange({ kind: "error", message: "MediaRecorder unsupported in this browser" });
      }
      return;
    }
    if (this.mode === "segment") this.beginSegment(mime, "manual");
    else this.beginLive(mime);
  }

  stop(): void { this.stopInternal(); }

  // ------------------------------------------------------------- live ----

  private beginLive(mime: string): void {
    this.opts.onStateChange({ kind: "starting" });
    const video = this.opts.videoEl;
    try {
      const stream = this.opts.canvas.captureStream(30);
      const ms = new MediaSource();
      this.mediaSource = ms;
      video.src = URL.createObjectURL(ms);
      video.muted = true;
      ms.addEventListener("sourceopen", () => {
        if (this.stopped || this.mediaSource !== ms) return;
        try {
          const sb = ms.addSourceBuffer(mime);
          this.sourceBuffer = sb;
          sb.addEventListener("updateend", () => this.drain());
          sb.addEventListener("error", () => this.fallBack(mime, "SourceBuffer error"));
          this.beginRecorder(stream, mime, (buf) => {
            this.queue.push(buf);
            this.drain();
          });
          void video.play().catch(() => { /* retried on next append via drain */ });
          this.opts.onStateChange({ kind: "live", mime });
          this.armStallWatchdog(mime);
        } catch (e) {
          this.fallBack(mime, `addSourceBuffer failed: ${e instanceof Error ? e.message : e}`);
        }
      }, { once: true });
      video.addEventListener("error", () => {
        if (!this.stopped && this.mode === "live") this.fallBack(mime, "preview video decode error");
      }, { once: true });
    } catch (e) {
      this.fallBack(mime, `captureStream failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  private drain(): void {
    const sb = this.sourceBuffer, video = this.opts.videoEl;
    if (this.stopped || !sb || sb.updating) return;
    try {
      const buffered = sb.buffered;
      // Memory clamp: drop everything well behind the playhead.
      if (buffered.length && video.currentTime > KEEP_BEHIND_S + 5) {
        const cut = video.currentTime - KEEP_BEHIND_S;
        if (buffered.start(0) < cut) { sb.remove(0, cut); return; }  // drain continues on updateend
      }
      const next = this.queue.shift();
      if (next) sb.appendBuffer(next);
      // Latency clamp: a live preview that slips far behind stops being live.
      if (buffered.length) {
        const start = buffered.start(0);
        const end = buffered.end(buffered.length - 1);
        if (video.currentTime < start || video.currentTime > end) video.currentTime = start;
        else if (end - video.currentTime > MAX_LAG_S) video.currentTime = end - 0.5;
        if (video.paused) void video.play().catch(() => { /* next drain retries */ });
      }
    } catch (e) {
      this.fallBack(this.recorder?.mimeType ?? "", `appendBuffer failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  private armStallWatchdog(mime: string): void {
    this.lastTime = -1;
    this.stallStrikes = 0;
    this.stallTimer = setInterval(() => {
      const t = this.opts.videoEl.currentTime;
      if (this.recorder?.state === "recording" && t === this.lastTime) {
        if (++this.stallStrikes >= 2) this.fallBack(mime, "playback stalled");
      } else {
        this.stallStrikes = 0;
      }
      this.lastTime = t;
    }, STALL_CHECK_MS);
  }

  private fallBack(mime: string, reason: string): void {
    if (this.stopped || this.mode === "segment") return;
    this.stopInternal(/* keepCallbacks */ true);
    this.stopped = false;
    this.mode = "segment";
    this.beginSegment(mime || "video/webm", reason);
  }

  // ---------------------------------------------------------- segment ----

  private beginSegment(mime: string, reason: string): void {
    this.opts.onStateChange({ kind: "segment", mime, reason, recording: true });
    const video = this.opts.videoEl;
    try {
      const stream = this.opts.canvas.captureStream(30);
      this.segmentChunks = [];
      this.beginRecorder(stream, mime, undefined, (blob) => this.segmentChunks.push(blob));
      setTimeout(() => {
        if (this.stopped || !this.recorder) return;
        const rec = this.recorder;
        rec.onstop = () => {
          if (this.stopped) return;
          if (this.segmentUrl) URL.revokeObjectURL(this.segmentUrl);
          this.segmentUrl = URL.createObjectURL(new Blob(this.segmentChunks, { type: mime }));
          video.src = this.segmentUrl;
          video.loop = true;
          video.muted = true;
          void video.play().catch(() => { /* operator can press play */ });
          this.opts.onStateChange({ kind: "segment", mime, reason, recording: false });
          this.refreshTimer = setTimeout(() => {
            if (!this.stopped && this.mode === "segment") this.beginSegment(mime, reason);
          }, SEGMENT_REFRESH_MS);
        };
        rec.stop();
      }, SEGMENT_SECONDS * 1000);
    } catch (e) {
      this.opts.onStateChange({ kind: "error", message: `segment record failed: ${e instanceof Error ? e.message : e}` });
    }
  }

  // ----------------------------------------------------------- shared ----

  private beginRecorder(stream: MediaStream, mime: string,
                        onBuf?: (b: ArrayBuffer) => void,
                        onBlob?: (b: Blob) => void): void {
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: this.opts.bitsPerSecond });
    this.recorder = rec;
    rec.ondataavailable = (e) => {
      if (!e.data.size || this.stopped) return;
      this.windowBytes.push({ t: performance.now(), b: e.data.size });
      onBlob?.(e.data);
      if (onBuf) void e.data.arrayBuffer().then((buf) => { if (!this.stopped) onBuf(buf); });
    };
    rec.start(TIMESLICE_MS);
    this.statsTimer ??= setInterval(() => {
      const now = performance.now();
      this.windowBytes = this.windowBytes.filter((x) => now - x.t < 5000);
      const bytes = this.windowBytes.reduce((a, x) => a + x.b, 0);
      const span = this.windowBytes.length ? (now - this.windowBytes[0].t) / 1000 : 0;
      this.opts.onStats({ bytes, kbps: span > 0.5 ? Math.round((bytes * 8) / span / 1000) : 0 });
    }, 1000);
  }

  private stopInternal(keepCallbacks = false): void {
    this.stopped = true;
    if (this.stallTimer) { clearInterval(this.stallTimer); this.stallTimer = null; }
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
    if (!keepCallbacks && this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
    try { if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop(); } catch { /* already */ }
    this.recorder = null;
    try { this.mediaSource?.endOfStream(); } catch { /* not open */ }
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.queue = [];
    if (!keepCallbacks) {
      if (this.segmentUrl) { URL.revokeObjectURL(this.segmentUrl); this.segmentUrl = null; }
      this.opts.videoEl.removeAttribute("src");
      this.opts.videoEl.load();
    }
  }
}
