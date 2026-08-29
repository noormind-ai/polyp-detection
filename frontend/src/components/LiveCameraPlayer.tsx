"use client";

import { useEffect, useRef, useState } from "react";
import FeedbackPanel from "./FeedbackPanel";
import RecordingControls from "./RecordingControls";
import RecordingsPanel from "./RecordingsPanel";
import { DEMO_VIDEOS } from "./demos";
import { useLanguage } from "@/lib/i18n";
import { useSessionRecorder } from "@/lib/useSessionRecorder";
import { detectFovRect, unionRect, intersectRect, trimmedFraction, NEGLIGIBLE_TRIM, type Rect } from "@/lib/fov";

const API = process.env.NEXT_PUBLIC_API_URL || "";
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
// Resolve the socket origin explicitly rather than leaning on a relative
// WebSocket URL: the spec allows it, but an absolute ws:// is unambiguous and
// still follows the page from an IP to a domain with no rebuild.
const API_WS = (process.env.NEXT_PUBLIC_API_URL
  || (typeof window !== "undefined" ? window.location.origin : "")).replace(/^http/, "ws");
const INFER_TIMEOUT_MS = 6000;
// Resize frames to this width before sending — faster inference, smaller payload
const INFER_WIDTH = 320;
// How many of the first frames of a session are measured to find the picture
// area. The border does not move, so this is a fixed startup cost, not a
// per-frame one. Several rather than one because the union of several frames
// cannot be fooled by a single dark frame — see lib/fov.ts.
const FOV_SAMPLE_FRAMES = 8;
// Same throttle as the real-time player: once a polyp is flagged, wait this long
// before auto-capturing again so the queue fills with distinct moments.
// A polyp that is STILL on screen is re-filed at most this often. A polyp that
// has just appeared is filed immediately regardless — see maybeAutoCapture.
const AUTO_CAPTURE_REFRESH_MS = 8000;
// A detection gap shorter than this counts as the same episode. The detector
// drops the odd frame on a lesion that never left the screen, and treating that
// as "gone" would re-trigger a capture on the very next frame.
const DETECTION_GAP_MS = 1000;

// A demo clip is a third source alongside the two real ones, and a recording
// already on this server is a fourth. Neither is a separate playback mode: the
// frames go through the identical capture loop, socket, FOV crop, auto-capture
// and session-recording path, so from here down both behave like a camera.
// That is the point of replaying a recording — it is not a preview, it is the
// live pipeline fed from a file instead of from the capture card.
type CaptureMode = "camera" | "screen" | "demo" | "recording";
// Demo entries share the device <select> with real cameras, so their option
// values have to be distinguishable from a deviceId.
const DEMO_PREFIX = "demo:";
// Recordings share the same <select>, so their option values have to be
// distinguishable from both a deviceId and a demo filename.
const REC_PREFIX = "rec:";

/** Just the fields the source picker needs — RecordingsPanel owns the full shape. */
interface ServerRecording {
  id: string;
  case_id: string;
  source: "camera" | "screen";
  width: number;
  height: number;
  started_at: number;
  duration_ms: number;
  status: string;
}

/** Enough to tell two recordings apart in a dropdown: when it was made, how
 *  long it ran, and what it came from. */
function describeRecording(r: ServerRecording): string {
  const when = new Date(r.started_at * 1000);
  const stamp = `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const secs = Math.round((r.duration_ms || 0) / 1000);
  const dur = secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s` : `${secs}s`;
  return `${stamp} · ${dur} · ${r.source}`;
}

interface Box { bbox: [number, number, number, number]; conf: number; }
interface Timing { recv_ms: number; modal_ms: number; total_ms: number; }

export default function LiveCameraPlayer({ caseId, onStop, onActivity, wsPath = "/api/ws/infer", initialMode = "camera", backend }: { caseId: string; onStop: () => void; onActivity?: () => void; wsPath?: string; initialMode?: "camera" | "screen"; backend?: string }) {
  const { t } = useLanguage();
  // The engine is pinned for the life of the socket — the server reads it once,
  // so the latency average never blends two very different backends.
  const WS_URL = `${API_WS}${wsPath}${backend ? `?backend=${encodeURIComponent(backend)}` : ""}`;
  const videoRef    = useRef<HTMLVideoElement>(null);
  const analyzedRef = useRef<HTMLCanvasElement>(null); // last frame actually sent to the model, with boxes burned on
  const wsRef       = useRef<WebSocket | null>(null);
  const scanRef     = useRef(false); // capture loop running?
  const streamRef   = useRef<MediaStream | null>(null);
  const lastAutoCaptureRef = useRef(0);
  const lastDetectionRef   = useRef(0);     // when a box was last seen
  const inEpisodeRef       = useRef(false); // inside one continuous appearance?
  // One capture upload at a time. A rolling clip plus its frame is megabytes and
  // a clinic uplink is not fast: without this, a run of detections queues a dozen
  // multi-megabyte POSTs that compete with the websocket carrying frames for the
  // same upstream, inference stalls, and the uploads themselves get abandoned
  // (nginx logged 81 x 499 and 15 x 408 in one day). Skipping a capture costs
  // little — an episode that is still on screen files one on the next refresh.
  const uploadingRef       = useRef(false);
  const lastBoxesRef = useRef<Box[]>([]); // AI's most recent detections — attached as context to manual captures

  // Pending response promise resolver — one in-flight request at a time
  const pendingRef = useRef<((v: { boxes: Box[]; timing: Timing } | null) => void) | null>(null);

  const [devices, setDevices]             = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedId] = useState("");
  const [permission, setPermission]       = useState<"idle" | "requesting" | "granted" | "denied">("idle");
  const [streaming, setStreaming]         = useState(false);
  const [wsStatus, setWsStatus]           = useState<"connecting" | "open" | "error" | "closed">("connecting");
  const [closeCode, setCloseCode]         = useState<number | null>(null);
  const [polyp, setPolyp]                 = useState(false);
  const [stats, setStats]                 = useState({ sent: 0, received: 0, avgMs: 0 });
  const [lastError, setLastError]         = useState("");
  const [cameraBusy, setCameraBusy]       = useState(false); // device held by another app — offer screen-share fallback
  const [captureMode, setCaptureMode]     = useState<CaptureMode>("camera");
  // Mirrored into a ref because the capture loop is a long-running closure that
  // would otherwise read whatever the mode was when it started.
  const captureModeRef = useRef<CaptureMode>("camera");
  const [demoFile, setDemoFile]           = useState<string | null>(null);
  // Recordings already on this server, offered as a capture source so a past
  // session can be pushed back through the live pipeline exactly as it ran.
  const [recordings, setRecordings]       = useState<ServerRecording[]>([]);
  const [recordingLabel, setRecordingLabel] = useState<string | null>(null);
  const [feedbackRefreshKey, setFeedbackRefreshKey] = useState(0);
  const [aspect, setAspect]               = useState("560/480"); // replaced with the stream's real ratio once it starts
  // Auto-capture is off until the procedure is explicitly started. Before the
  // scope is in, the camera shows the trolley, the floor, a gloved hand — the
  // model flags things in all of it and the review queue fills with frames no
  // one wants. The doctor says when the procedure begins.
  const [procedureStarted, setProcedureStarted] = useState(false);
  // The capture loop is started once and closes over the render it began in, so
  // it cannot read the state above; it reads this instead.
  const procedureStartedRef = useRef(false);
  // Confidence gate, client-side and live-adjustable. The server runs the model
  // at its own low threshold (0.30) and reports every box with its score, so
  // moving this mid-procedure costs nothing — no round trip, no restart, and it
  // applies to what is drawn and what is auto-captured alike. A scope that is
  // noisy today can be tightened without redeploying anything.
  const [confMin, setConfMin] = useState(0.30);
  // The capture loop closes over the render it started in and cannot see the
  // state above.
  const confMinRef = useRef(0.30);
  const [showDetected, setShowDetected]   = useState(true);
  const [showLive, setShowLive]           = useState(true);
  const msHistory = useRef<number[]>([]);

  // Only starts recording once there's actually a stream on the element —
  // captureStream() on an empty <video> yields no tracks and MediaRecorder refuses it.

  // The capture stream as STATE as well as a ref: streamRef is read inside the
  // long-running capture loop, but the session recorder is a hook and has to
  // re-run when the stream is replaced (a device switch, or camera → screen).
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);
  // A demo clip records as "camera": it enters the pipeline the same way, and
  // the server only accepts camera|screen as a recording source.
  const recorder = useSessionRecorder(caseId, captureMode === "screen" ? "screen" : "camera", activeStream);
  const [showRecordings, setShowRecordings] = useState(false);

  // Surface the list the moment a recording finishes — the operator has just
  // saved something and the next thing they want is to confirm it is there.
  useEffect(() => {
    if (recorder.finishedCount > 0) setShowRecordings(true);
  }, [recorder.finishedCount]);

  // Crop applied to screen-share frames before sending (normalized 0..1, relative to native frame size).
  // Lets you box just the video-feed area out of a shared app window that also shows toolbars/UI chrome.
  const [cropRect, setCropRectState] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const cropRectRef = useRef<typeof cropRect>(null);
  const [selectingRegion, setSelectingRegion] = useState(false);
  const [dragBox, setDragBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const snapshotCanvasRef = useRef<HTMLCanvasElement>(null);
  const CROP_KEY = "polyp_screen_crop_rect";

  // The picture area inside the signal, measured from the first frames of the
  // session (lib/fov.ts explains why this is worth doing). Native pixels.
  const [fovRect, setFovRectState] = useState<Rect | null>(null);
  const fovRectRef  = useRef<Rect | null>(null);
  const fovSamplesRef = useRef(0);
  // Native frame size the rect was measured against — needed to express it as a
  // fraction for the overlay, and not the same as the analyzed `aspect`.
  const [fovFrame, setFovFrame] = useState<{ w: number; h: number } | null>(null);
  // On by default, but the operator can turn it off — a processor we have not
  // seen could confuse the detector, and being able to switch it off in the
  // room beats having to redeploy.
  const [fovEnabled, setFovEnabledState] = useState(true);
  const fovEnabledRef = useRef(true);
  // Shows exactly which pixels the crop discards, over the live panel.
  const [showFovOverlay, setShowFovOverlay] = useState(false);
  const FOV_KEY = "polyp_fov_enabled";

  function setFovEnabled(on: boolean) {
    fovEnabledRef.current = on;
    setFovEnabledState(on);
    try { localStorage.setItem(FOV_KEY, on ? "1" : "0"); } catch { /* ignore */ }
  }

  // Forget the measurement so the next session measures again. The border
  // belongs to the source, so anything that changes the source invalidates it.
  function resetFovDetection() {
    fovRectRef.current = null;
    fovSamplesRef.current = 0;
    setFovRectState(null);
    setFovFrame(null);
    setShowFovOverlay(false);
  }

  useEffect(() => {
    try {
      const raw = localStorage.getItem(FOV_KEY);
      if (raw !== null) { const on = raw === "1"; fovEnabledRef.current = on; setFovEnabledState(on); }
    } catch { /* ignore */ }
  }, []);

  // Recordings on this server, for the source picker. Only the finished ones:
  // a recording still being written has no reliable duration and replaying it
  // would race the writer. A failure here is not worth surfacing — the picker
  // simply offers the cameras and demos it already has.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API}/api/recordings`, { credentials: "include" });
        if (!res.ok) return;
        const all: ServerRecording[] = await res.json();
        if (!cancelled) setRecordings(all.filter((r) => r.status === "complete" && r.duration_ms > 0));
      } catch { /* leave the list empty */ }
    })();
    return () => { cancelled = true; };
  }, [recorder.finishedCount]);

  function switchCaptureMode(mode: CaptureMode) {
    captureModeRef.current = mode;
    setCaptureMode(mode);
  }

  function setCropRect(rect: typeof cropRect) {
    cropRectRef.current = rect;
    setCropRectState(rect);
    try {
      if (rect) localStorage.setItem(CROP_KEY, JSON.stringify(rect));
      else localStorage.removeItem(CROP_KEY);
    } catch { /* ignore */ }
  }

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CROP_KEY);
      if (raw) { const r = JSON.parse(raw); cropRectRef.current = r; setCropRectState(r); }
    } catch { /* ignore */ }
  }, []);

  const insecure = typeof window !== "undefined" && !window.isSecureContext;

  // Maps raw getUserMedia() failures to messages a non-technical user can act on.
  function describeCameraError(err: unknown): string {
    const name = err instanceof DOMException ? err.name : "";
    switch (name) {
      case "NotReadableError":
      case "TrackStartError":
        return t("Camera is already in use by another app on this computer (e.g. ColnoSpy). Close that app's connection to the device, or use a different capture device, then try again.");
      case "NotFoundError":
      case "OverconstrainedError":
        return t("Selected camera is no longer available — it may have been unplugged or disabled. Reopen the device list and pick again.");
      case "NotAllowedError":
        return t("Camera access was denied. Allow camera permission for this site in the browser settings and reload.");
      default:
        return err instanceof Error ? err.message : String(err);
    }
  }

  // WebSocket — connect once on mount
  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen  = () => setWsStatus("open");
    ws.onerror = () => setWsStatus("error");
    ws.onclose = (e) => { setWsStatus("closed"); setCloseCode(e.code); pendingRef.current?.(null); };

    ws.onmessage = (e) => {
      let data: unknown;
      try { data = JSON.parse(e.data); } catch { return; }

      if (data && typeof data === "object" && "error" in data) {
        const err = (data as { error: string }).error;
        setLastError(err);
        pendingRef.current?.(null);
        pendingRef.current = null;
        return;
      }

      const { boxes, timing } = data as { boxes: Box[]; timing: Timing };
      onActivity?.();
      msHistory.current.push(timing.modal_ms);
      if (msHistory.current.length > 10) msHistory.current.shift();
      const avg = Math.round(msHistory.current.reduce((a, b) => a + b, 0) / msHistory.current.length);
      setStats((s) => ({ sent: s.sent, received: s.received + 1, avgMs: avg }));

      pendingRef.current?.({ boxes, timing });
      pendingRef.current = null;
    };

    return () => { ws.close(); scanRef.current = false; };
  }, []);

  // Stop camera tracks on unmount
  useEffect(() => {
    return () => {
      scanRef.current = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  // Draws the exact frame that was sent to the model, with boxes at native (capture)
  // resolution — pixel-accurate for that frame, unlike overlaying on the live video
  // (which has moved on by the time the result comes back).
  function drawAnalyzedFrame(source: HTMLCanvasElement, boxes: Box[]) {
    const canvas = analyzedRef.current;
    if (!canvas) return;
    if (canvas.width !== source.width)   canvas.width  = source.width;
    if (canvas.height !== source.height) canvas.height = source.height;

    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(source, 0, 0);

    for (const det of boxes) {
      const [x1, y1, x2, y2] = det.bbox;
      ctx.shadowColor = "#39ff14";
      ctx.shadowBlur  = 10;
      ctx.strokeStyle = "#39ff14";
      ctx.lineWidth   = 3;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.shadowBlur  = 0;
      const label = t("polyp  {conf}%", { conf: Math.round(det.conf * 100) });
      ctx.font = "bold 13px monospace";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "#39ff14";
      ctx.fillRect(x1, y1 - 20, tw + 8, 20);
      ctx.fillStyle = "#000";
      ctx.fillText(label, x1 + 4, y1 - 5);
    }
  }

  function updateBoxes(b: Box[]) { setPolyp(b.length > 0); lastBoxesRef.current = b; }

  // The region of the live frame that actually gets sent to the model — the
  // crop for screen-share, the whole frame otherwise. Manual captures use the
  // same region so a saved frame matches what the AI was looking at.
  // The crop is persisted in localStorage and restored on mount, so it has to
  // be gated on the mode: otherwise a region drawn during an earlier screen
  // share silently keeps cropping the camera feed, with no UI to clear it.
  function sourceRect(video: HTMLVideoElement) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const crop = captureModeRef.current === "screen" ? cropRectRef.current : null;
    const base = {
      x: crop ? Math.round(crop.x * vw) : 0,
      y: crop ? Math.round(crop.y * vh) : 0,
      w: crop ? Math.round(crop.w * vw) : vw,
      h: crop ? Math.round(crop.h * vh) : vh,
    };
    // The hand-drawn region and the detected picture area are both constraints
    // on what is worth sending, so both apply. Intersecting also means a region
    // drawn tightly inside the picture is never widened back out by this.
    const fov = fovEnabledRef.current ? fovRectRef.current : null;
    // A frame that arrived already cropped trims a percent or two; applying that
    // buys nothing and only adds a coordinate transform to every capture.
    if (!fov || trimmedFraction(fov, vw, vh) < NEGLIGIBLE_TRIM) return base;
    const r = intersectRect(base, fov);
    return r.w > 0 && r.h > 0 ? r : base;
  }

  // Measure the picture area from the first frames of the session, then leave
  // it alone. Cheap (a 160px-wide probe) and it stops after FOV_SAMPLE_FRAMES,
  // so this costs nothing for the rest of the procedure.
  function sampleFov(video: HTMLVideoElement) {
    if (fovSamplesRef.current >= FOV_SAMPLE_FRAMES) return;
    fovSamplesRef.current += 1;
    const vw = video.videoWidth, vh = video.videoHeight;
    const found = detectFovRect(video, vw, vh);
    if (!found) return;
    const merged = unionRect(fovRectRef.current, found);
    fovRectRef.current = merged;
    setFovFrame((prev) => (prev && prev.w === vw && prev.h === vh ? prev : { w: vw, h: vh }));
    // Only push to React state when it actually moved — this runs inside the
    // capture loop and a setState per frame would re-render the whole player.
    setFovRectState((prev) =>
      prev && merged && prev.x === merged.x && prev.y === merged.y
        && prev.w === merged.w && prev.h === merged.h ? prev : merged);
  }

  // Auto-capture — the clean (no-overlay) frame that was already grabbed for
  // inference, plus what the model saw, plus a rolling clip if available.
  // Throttled so a polyp staying in view for a while doesn't flood the queue.
  function maybeAutoCapture(cap: HTMLCanvasElement, boxes: Box[]) {
    // Nothing is filed until the procedure has been started. Detection itself
    // keeps running and stays visible on screen — this only decides whether a
    // detection is worth keeping.
    if (!procedureStartedRef.current) return;
    const now = Date.now();

    if (boxes.length === 0) {
      if (now - lastDetectionRef.current > DETECTION_GAP_MS) inEpisodeRef.current = false;
      return;
    }
    lastDetectionRef.current = now;

    // The event worth reviewing is a polyp APPEARING, so capture on the rising
    // edge. A fixed cooldown could not tell a new lesion from the one already on
    // screen, so a second polyp arriving inside the window was dropped entirely
    // while a single polyp was re-filed every few seconds. Edge-triggering
    // inverts that: every distinct appearance lands, and one that lingers is
    // only refreshed occasionally instead of once per frame.
    if (inEpisodeRef.current) {
      if (now - lastAutoCaptureRef.current < AUTO_CAPTURE_REFRESH_MS) return;
    } else {
      inEpisodeRef.current = true;
    }
    // An upload still in flight means the uplink is already busy; filing
    // another now is what turns a slow link into a stalled page.
    if (uploadingRef.current) return;
    lastAutoCaptureRef.current = now;

    cap.toBlob(async (blob) => {
      if (!blob) return;
      const fd = new FormData();
      fd.append("file", blob, "frame.jpg");
      fd.append("ai_detections", JSON.stringify(boxes));
      // No clip. The session recording already holds this moment, so all a
      // reviewer needs is where to seek to — a few bytes instead of the ~250 KB
      // of video that was starving the live frame stream.
      const at = recorder.mark();
      if (at) {
        fd.append("recording_id", at.recordingId);
        fd.append("video_offset_ms", String(at.offsetMs));
      }
      uploadingRef.current = true;
      try {
        await fetch(`${API}/api/feedback/${caseId}/auto-capture`, { method: "POST", body: fd });
        setFeedbackRefreshKey((k) => k + 1);
      } catch { /* best-effort — never interrupt the live loop over this */ } finally { uploadingRef.current = false; }
    }, "image/jpeg", 0.85);
  }

  // Instant, no-dialog manual capture of whatever is on screen right now — the
  // one case auto-capture can't cover, a doctor spotting something the model
  // missed. Box drawing/correction happens in the side panel, not in a popup.
  // A doctor-found capture used to encode the camera's full frame (1280x720+)
  // at quality 0.9: a synchronous draw + JPEG encode on the same main thread as
  // the inference loop, then ~200 KB of JPEG plus the clip pushed up in one
  // burst. Both the encode and the upload showed as a hitch in the live video.
  // A review still does not need more than this.
  const CAPTURE_MAX_EDGE = 960;

  function captureCanvas(video: HTMLVideoElement, src: { x: number; y: number; w: number; h: number }) {
    const scale = Math.min(1, CAPTURE_MAX_EDGE / Math.max(src.w, src.h));
    const cap = document.createElement("canvas");
    cap.width = Math.round(src.w * scale);
    cap.height = Math.round(src.h * scale);
    cap.getContext("2d")!.drawImage(video, src.x, src.y, src.w, src.h, 0, 0, cap.width, cap.height);
    return cap;
  }

  function captureDrFound() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const src = sourceRect(video);
    const cap = captureCanvas(video, src);
    cap.toBlob(async (blob) => {
      if (!blob) return;
      const fd = new FormData();
      fd.append("file", blob, "frame.jpg");
      fd.append("ai_detections", JSON.stringify(lastBoxesRef.current));
      // No clip. The session recording already holds this moment, so all a
      // reviewer needs is where to seek to — a few bytes instead of the ~250 KB
      // of video that was starving the live frame stream.
      const at = recorder.mark();
      if (at) {
        fd.append("recording_id", at.recordingId);
        fd.append("video_offset_ms", String(at.offsetMs));
      }
      try {
        await fetch(`${API}/api/feedback/${caseId}/dr-found/capture`, { method: "POST", body: fd });
        setFeedbackRefreshKey((k) => k + 1);
      } catch { /* best-effort */ }
    }, "image/jpeg", 0.82);
  }

  // Live loop — send current frame → wait for result → send next. No seeking:
  // the video plays continuously, we just grab whatever frame is current each time.
  async function startLoop() {
    if (scanRef.current) return;
    scanRef.current = true;

    while (scanRef.current) {
      const ws = wsRef.current;
      const video = videoRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !video || !video.videoWidth) {
        await new Promise<void>((res) => requestAnimationFrame(() => res()));
        continue;
      }

      // Before choosing the region, not after — the first frames of a session
      // are exactly the ones that decide it.
      sampleFov(video);

      const { x: srcX, y: srcY, w: srcW, h: srcH } = sourceRect(video);
      // Size the panels to the region actually being analyzed, so the two live
      // panels and the captured feedback frames all share one aspect ratio.
      setAspect(`${srcW}/${srcH}`);

      const scale = INFER_WIDTH / srcW;
      const capW  = INFER_WIDTH;
      const capH  = Math.round(srcH * scale);
      const cap   = document.createElement("canvas");
      cap.width   = capW;
      cap.height  = capH;
      cap.getContext("2d")!.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, capW, capH);

      const blob: Blob = await new Promise((res) => cap.toBlob((b) => res(b!), "image/jpeg", 0.85));
      const buf = await blob.arrayBuffer();

      const result = await new Promise<{ boxes: Box[]; timing: Timing } | null>((resolve) => {
        pendingRef.current = resolve;
        ws.send(buf);
        setStats((s) => ({ ...s, sent: s.sent + 1 }));
        setTimeout(() => {
          if (pendingRef.current === resolve) { pendingRef.current = null; resolve(null); }
        }, INFER_TIMEOUT_MS);
      });

      // Draw the frame + its boxes together, win or lose (a timeout leaves the last good frame up)
      if (result) {
        // One gate for both what is shown and what is kept.
        const shown = result.boxes.filter((b) => b.conf >= confMinRef.current);
        updateBoxes(shown);
        drawAnalyzedFrame(cap, shown);
        maybeAutoCapture(cap, shown);
      }
    }
  }

  // First call: unlocks device labels via a throwaway permission prompt, then lists devices.
  async function requestDevices() {
    setPermission("requesting");
    setLastError("");
    setCameraBusy(false);
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true });
      probe.getTracks().forEach((track) => track.stop());

      const all = await navigator.mediaDevices.enumerateDevices();
      const cams = all.filter((d) => d.kind === "videoinput");
      setDevices(cams);
      setPermission("granted");
      if (cams.length > 0) {
        setSelectedId(cams[0].deviceId);
        await startStream(cams[0].deviceId);
      }
    } catch (err: unknown) {
      setPermission("denied");
      setLastError(describeCameraError(err));
      setCameraBusy(err instanceof DOMException && (err.name === "NotReadableError" || err.name === "TrackStartError"));
    }
  }

  async function startStream(deviceId: string) {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    scanRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;
      setActiveStream(stream);
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
      switchCaptureMode("camera");
      setCameraBusy(false);
      setLastError("");
      setStreaming(true);
      startLoop();
    } catch (err: unknown) {
      setLastError(describeCameraError(err));
      setCameraBusy(err instanceof DOMException && (err.name === "NotReadableError" || err.name === "TrackStartError"));
    }
  }

  // Play one of the bundled demo clips as if it were a camera: the <video> is
  // fed from a file instead of a MediaStream and looped, and everything after
  // that — the capture loop, the socket, auto-capture, the two panels — is the
  // camera path untouched. Works with no capture hardware attached at all.
  /**
   * Play a file through the camera pipeline. Everything downstream of the
   * <video> element — capture loop, socket, FOV crop, auto-capture, session
   * recording — is the same code the capture card drives, so this is a genuine
   * rehearsal of a live procedure rather than a preview of one.
   *
   * Loops on purpose: a capture card never reaches an end, and a source that
   * stops would end the session in a way the real one never does.
   */
  async function startFileSource(src: string, mode: "demo" | "recording", optionValue: string) {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    scanRef.current = false;
    setLastError("");
    setCameraBusy(false);
    const video = videoRef.current;
    if (!video) return;
    try {
      video.srcObject = null;
      video.src = src;
      video.loop = true;
      // Both sources are same-origin (demos are static assets, recordings come
      // from this server's own API), so the canvas stays readable and the FOV
      // probe works. A cross-origin file would taint it and silently disable it.
      setSelectedId(optionValue);
      switchCaptureMode(mode);
      // Unhide before waiting for pixels — a display:none <video> is not a
      // reliable captureStream() source, the same reason the screen-share path
      // flips this before it waits.
      setStreaming(true);
      await video.play();
      await waitForFrame(video);

      // The element's own captureStream() stands in for a device stream, so
      // session recording and the rolling clip work here unchanged.
      let stream: MediaStream | null = null;
      try {
        // @ts-expect-error captureStream isn't in the older lib.dom typings
        stream = typeof video.captureStream === "function" ? video.captureStream() : null;
      } catch { /* recording just won't be available for this clip */ }
      streamRef.current = stream;
      setActiveStream(stream);

      startLoop();
    } catch (err: unknown) {
      setStreaming(false);
      setDemoFile(null);
      setRecordingLabel(null);
      setLastError(err instanceof Error ? err.message : String(err));
    }
  }

  async function startDemo(file: string) {
    setDemoFile(file);
    setRecordingLabel(null);
    await startFileSource(`${BASE_PATH}/demos/${file}`, "demo", `${DEMO_PREFIX}${file}`);
  }

  async function startRecording(rec: ServerRecording) {
    setDemoFile(null);
    setRecordingLabel(describeRecording(rec));
    await startFileSource(
      `${API}/api/recordings/${rec.case_id}/${rec.id}/video`,
      "recording",
      `${REC_PREFIX}${rec.case_id}/${rec.id}`,
    );
  }

  // Fallback when the physical device is locked by another app (e.g. ColnoSpy already has it
  // open) — capture the pixels of whatever window/screen is showing the feed instead of the
  // device itself. No coordination with the other app needed, just a one-time picker consent.
  async function startScreenShare(surface: "window" | "monitor" = "window") {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    scanRef.current = false;
    setLastError("");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: surface } as MediaTrackConstraints,
        audio: false,
      });
      streamRef.current = stream;
      setActiveStream(stream);
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
      stream.getVideoTracks()[0].addEventListener("ended", stopCamera);
      switchCaptureMode("screen");
      setCameraBusy(false);
      setStreaming(true);
      startLoop();

      // Guide straight into region selection — a shared window/screen usually has toolbars/UI
      // chrome around the actual video, so cropping right away is part of the normal flow here.
      await waitForFrame(video);
      openRegionSelector();
    } catch (err: unknown) {
      setLastError(describeCameraError(err));
    }
  }

  function waitForFrame(video: HTMLVideoElement | null): Promise<void> {
    return new Promise((resolve) => {
      if (!video || video.videoWidth) return resolve();
      const check = () => { if (video.videoWidth) resolve(); else requestAnimationFrame(check); };
      requestAnimationFrame(check);
    });
  }

  // --- Screen-share crop selection: drag a box on a snapshot of the shared window/screen to
  // send only that region (e.g. just the video pane, not toolbars/UI chrome around it). ---
  function openRegionSelector() {
    const video = videoRef.current;
    const canvas = snapshotCanvasRef.current;
    if (!video || !video.videoWidth || !canvas) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    setDragBox(null);
    setSelectingRegion(true);
  }

  function handleSelectPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    dragStartRef.current = p;
    setDragBox({ x: p.x, y: p.y, w: 0, h: 0 });
  }

  function handleSelectPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const start = dragStartRef.current;
    if (!start) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    setDragBox({ x: Math.min(start.x, x), y: Math.min(start.y, y), w: Math.abs(x - start.x), h: Math.abs(y - start.y) });
  }

  function handleSelectPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const box = dragBox;
    dragStartRef.current = null;
    if (!box || box.w < 10 || box.h < 10) return; // ignore accidental clicks
    const canvas = e.currentTarget;
    const cssRect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / cssRect.width;
    const scaleY = canvas.height / cssRect.height;
    setCropRect({
      x: (box.x * scaleX) / canvas.width,
      y: (box.y * scaleY) / canvas.height,
      w: (box.w * scaleX) / canvas.width,
      h: (box.h * scaleY) / canvas.height,
    });
    setSelectingRegion(false);
  }

  function handleDeviceChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const id = e.target.value;
    if (!id) return;
    setSelectedId(id);
    // Demo clips sit in the same list as the real devices — picking one is the
    // same gesture as picking a camera, so it runs through the same handler.
    if (id.startsWith(DEMO_PREFIX)) startDemo(id.slice(DEMO_PREFIX.length));
    else if (id.startsWith(REC_PREFIX)) {
      const [caseId, recId] = id.slice(REC_PREFIX.length).split("/");
      const rec = recordings.find((r) => r.case_id === caseId && r.id === recId);
      if (rec) startRecording(rec);
    }
    else startStream(id);
  }

  function stopCamera() {
    scanRef.current = false;
    // Close the recording before killing the tracks: stop() flushes the final
    // slice, and a recorder whose source has already died has nothing to flush.
    recorder.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setActiveStream(null);
    // A demo is a file on the element, not a device: stopping the captured
    // tracks does not stop it playing, so unload it explicitly.
    const video = videoRef.current;
    if (video && video.src) { video.pause(); video.removeAttribute("src"); video.load(); }
    setDemoFile(null);
    setStreaming(false);
    updateBoxes([]);
    // The picture area belongs to the source. Whatever comes next gets measured
    // on its own frames rather than inheriting this one's border.
    resetFovDetection();
  }

  const wsOk = wsStatus === "open";
  // Both panels show the same frame at the same size — one just carries the AI
  // mask and trails by the inference round-trip. Hidden panels are clipped,
  // never unmounted: the <video> holds the MediaStream and the <canvas> has to
  // keep being drawn into for inference to continue while it's out of sight.
  const panelBox = "relative w-full rounded-xl overflow-hidden border border-gray-800 bg-black";
  // When a screen-share crop is active the Detected panel shows only that region,
  // so the Live panel has to be blown up and offset to the same region — otherwise
  // it sits next to a panel that looks zoomed in relative to it. The scaled <video>
  // keeps its native ratio exactly (the panel box is already the crop's ratio), so
  // this crops without distorting.
  // The detected picture area, normalized against the native frame so it can be
  // composed with the hand-drawn screen-share region and used for CSS.
  const fovNorm = fovRect && fovFrame
    ? { x: fovRect.x / fovFrame.w, y: fovRect.y / fovFrame.h,
        w: fovRect.w / fovFrame.w, h: fovRect.h / fovFrame.h }
    : null;
  const fovTrim = fovRect && fovFrame ? trimmedFraction(fovRect, fovFrame.w, fovFrame.h) : 0;
  // Worth acting on only if there is a real border. A frame that arrived already
  // cropped trims a percent or two, and applying that buys nothing.
  const fovWorthIt = !!fovNorm && fovTrim >= NEGLIGIBLE_TRIM;
  const fovApplied = fovEnabled && fovWorthIt;

  const screenCrop = captureMode === "screen" ? cropRect : null;
  // Same composition the capture loop does, in normalized space, so the Live
  // panel frames exactly the region the model is being given.
  const analyzedCrop =
    fovApplied && screenCrop ? intersectRect(screenCrop, fovNorm!)
    : fovApplied ? fovNorm
    : screenCrop;
  // While the overlay is up the whole frame is shown instead, because the point
  // of the overlay is to see the part that normally gets dropped.
  const liveCrop = showFovOverlay ? null : analyzedCrop;
  // The panel has to carry the native ratio in overlay mode, otherwise
  // object-contain letterboxes the video inside it and the overlay percentages
  // no longer line up with the picture they are describing.
  const liveAspect = showFovOverlay && fovFrame ? `${fovFrame.w}/${fovFrame.h}` : aspect;
  const liveStyle = liveCrop
    ? {
        width: `${100 / liveCrop.w}%`,
        height: `${100 / liveCrop.h}%`,
        left: `${(-liveCrop.x * 100) / liveCrop.w}%`,
        top: `${(-liveCrop.y * 100) / liveCrop.h}%`,
      }
    : undefined;
  const toggleBtn = "text-xs px-2 py-0.5 rounded-md border border-gray-800 text-gray-500 hover:text-gray-300 hover:border-gray-600 transition-colors flex-shrink-0";
  const wsStatusText =
    wsStatus === "open" ? t("connected") :
    wsStatus === "closed" ? t("closed ({code})", { code: closeCode ?? "" }) :
    t(wsStatus);
  const deviceSelect = (
    <select
      value={selectedDeviceId}
      onChange={handleDeviceChange}
      className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
    >
      {!selectedDeviceId && <option value="">{t("Select a source…")}</option>}
      {devices.length > 0 && (
        <optgroup label={t("Cameras")}>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || t("Camera {id}", { id: d.deviceId.slice(0, 6) })}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label={t("Demo clips")}>
        {DEMO_VIDEOS.map((v) => (
          <option key={v.file} value={`${DEMO_PREFIX}${v.file}`}>{t(v.label)}</option>
        ))}
      </optgroup>
      {recordings.length > 0 && (
        <optgroup label={t("Saved on this server")}>
          {recordings.map((r) => (
            <option key={`${r.case_id}/${r.id}`} value={`${REC_PREFIX}${r.case_id}/${r.id}`}>
              {describeRecording(r)}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );

  return (
    <div className="space-y-3">
      {/* Status bar */}
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-3">
          <span className={`flex items-center gap-1.5 ${wsOk ? "text-green-400" : "text-yellow-400"}`}>
            <span className={`w-2 h-2 rounded-full inline-block ${wsOk ? "bg-green-400 animate-pulse" : "bg-yellow-400"}`} />
            {wsStatusText}
          </span>
          {captureMode === "recording" && recordingLabel && (
            <span className="text-xs px-2 py-0.5 rounded-md border border-sky-800 bg-sky-950/40 text-sky-300">
              {t("Replaying recording: {name}", { name: recordingLabel })}
            </span>
          )}
          {captureMode === "demo" && demoFile && (
            <span className="text-xs px-2 py-0.5 rounded-md border border-purple-800 bg-purple-950/40 text-purple-300">
              {t("Demo clip: {name}", { name: t(DEMO_VIDEOS.find((v) => v.file === demoFile)?.label ?? demoFile) })}
            </span>
          )}
          {polyp && <span className="text-[#39ff14] font-medium animate-pulse">{t("Polyp detected")}</span>}
        </div>
        <button onClick={() => { stopCamera(); onStop(); }} className="text-sm text-red-400 hover:text-red-300 transition-colors">{t("Stop")}</button>
      </div>

      {insecure && (
        <div className="bg-yellow-950 border border-yellow-800 rounded-lg px-3 py-2 text-yellow-300 text-xs">
          {t("This page isn't served over HTTPS (or localhost) — browsers block camera access on insecure origins. Open it via https:// or localhost for the camera to work.")}
        </div>
      )}

      {/* Debug panel */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 font-mono text-xs grid grid-cols-2 gap-x-6 gap-y-0.5">
        <span className="text-gray-500">{t("Frames sent")}</span>
        <span className="text-white">{stats.sent}</span>
        <span className="text-gray-500">{t("Responses back")}</span>
        <span className="text-white">{stats.received}</span>
        <span className="text-gray-500">{backend && backend !== "modal" ? t("Inference latency (avg)") : t("Modal latency (avg)")}</span>
        <span className={stats.avgMs > 800 ? "text-red-400" : "text-green-400"}>
          {stats.avgMs > 0 ? t("{avgMs} ms", { avgMs: stats.avgMs }) : "—"}
        </span>
        {lastError && <>
          <span className="text-gray-500">{t("Error")}</span>
          <span className="text-red-400 truncate">{lastError}</span>
        </>}
      </div>

      {!streaming && (
        <div className="space-y-4 text-center py-16 border-2 border-dashed border-gray-700 rounded-xl">
          {initialMode === "screen" ? (
            <>
              <p className="text-gray-200 text-lg">{t("Share a screen or window")}</p>
              <p className="text-gray-500 text-sm max-w-sm mx-auto px-4">
                {t("Pick the window or monitor showing your video feed (e.g. ColnoSpy). Works even when the capture device itself is locked by another app.")}
              </p>
              <div className="flex items-center justify-center gap-3">
                <button
                  onClick={() => startScreenShare("window")}
                  className="px-6 py-2.5 bg-purple-600 hover:bg-purple-500 rounded-lg text-white font-medium transition-colors"
                >
                  {t("Share a window")}
                </button>
                <button
                  onClick={() => startScreenShare("monitor")}
                  className="px-6 py-2.5 bg-purple-600 hover:bg-purple-500 rounded-lg text-white font-medium transition-colors"
                >
                  {t("Share entire screen")}
                </button>
              </div>
            </>
          ) : (
            <>
              {permission !== "granted" ? (
                <>
                  <p className="text-gray-200 text-lg">{t("Connect a camera")}</p>
                  <p className="text-gray-500 text-sm max-w-sm mx-auto px-4">
                    {t("Laptop webcam, phone camera (if this page is opened on the phone itself), or a USB/HDMI capture card — any of them show up below once you grant camera access.")}
                  </p>
                  <button
                    onClick={requestDevices}
                    className="px-6 py-2.5 bg-purple-600 hover:bg-purple-500 rounded-lg text-white font-medium transition-colors"
                  >
                    {permission === "requesting" ? t("Requesting access...") : t("Choose a camera")}
                  </button>
                </>
              ) : (
                <p className="text-gray-500 text-sm">{t("No active stream — pick a device below.")}</p>
              )}
              <div>{deviceSelect}</div>

              {cameraBusy && (
                <div className="max-w-sm mx-auto bg-red-950 border border-red-800 rounded-lg px-4 py-3 space-y-2">
                  <p className="text-red-300 text-sm">{t("Camera is in use by another app on this computer.")}</p>
                  <div className="flex items-center justify-center gap-2">
                    <button
                      onClick={() => startScreenShare("window")}
                      className="px-3 py-2 bg-purple-600 hover:bg-purple-500 rounded-lg text-white text-sm font-medium transition-colors"
                    >
                      {t("Share a window")}
                    </button>
                    <button
                      onClick={() => startScreenShare("monitor")}
                      className="px-3 py-2 bg-purple-600 hover:bg-purple-500 rounded-lg text-white text-sm font-medium transition-colors"
                    >
                      {t("Share entire screen")}
                    </button>
                  </div>
                </div>
              )}

              <div className="pt-2 flex items-center justify-center gap-3 text-xs">
                <button onClick={() => startScreenShare("window")} className="text-gray-500 hover:text-gray-300 underline transition-colors">
                  {t("Share a window instead")}
                </button>
                <button onClick={() => startScreenShare("monitor")} className="text-gray-500 hover:text-gray-300 underline transition-colors">
                  {t("Share entire screen instead")}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Always mounted (just hidden) so the <video> node exists before `streaming` flips true —
          otherwise startStream() has nowhere to attach the MediaStream. */}
      <div className={streaming ? "" : "hidden"}>
        {/* Three equal columns — capture on the left, the two feedback lanes
            taking the other two. Same structure (and same card chrome) as the
            real-time player, so the live panels and the captured feedback
            frames render at identical size. Stacks on narrow screens. */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
          <div className="space-y-2 min-w-0 bg-gray-900/50 border border-gray-800 rounded-xl p-3">
            {/* Right at the top of the column — it's pressed mid-procedure, so it
                should never be somewhere you have to look for or scroll to. */}
            <button
              onClick={() => {
                const next = !procedureStarted;
                setProcedureStarted(next);
                procedureStartedRef.current = next;
                // A fresh start should not inherit the episode state of whatever
                // was on camera beforehand, or the first real detection is
                // treated as a continuation and skipped.
                inEpisodeRef.current = false;
                lastAutoCaptureRef.current = 0;
              }}
              className={`w-full py-2.5 px-4 rounded-xl text-white font-medium text-sm transition-colors ${
                procedureStarted
                  ? "bg-gray-700 hover:bg-gray-600"
                  : "bg-blue-600 hover:bg-blue-500"
              }`}
            >
              {procedureStarted ? t("⏹ Stop auto-capture") : t("▶ Start procedure")}
            </button>
            <p className="text-xs text-gray-500 text-center">
              {procedureStarted
                ? t("Detections are being filed for review.")
                : t("Detection is running, but nothing is filed until you start.")}
            </p>

            <div className="rounded-xl border border-gray-800 bg-gray-900/60 px-3 py-2 space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-400">{t("Confidence threshold")}</span>
                <span className="font-mono text-gray-200">{Math.round(confMin * 100)}%</span>
              </div>
              <input
                type="range"
                min={0.05}
                max={0.95}
                step={0.05}
                value={confMin}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setConfMin(v);
                  confMinRef.current = v;
                }}
                className="w-full accent-blue-500 cursor-pointer"
              />
              <p className="text-xs text-gray-500">
                {t("Only detections at or above this score are boxed and filed.")}
              </p>
            </div>

            <button
              onClick={captureDrFound}
              className="w-full py-2.5 px-4 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-medium text-sm transition-colors"
            >
              {t("👁 Dr. found a polyp AI missed")}
            </button>

            {/* Recording is opt-in: nothing is written to the server until this
                is pressed, so a session that nobody wants archived leaves nothing. */}
            <RecordingControls recorder={recorder} ready={streaming} />

            {/* Detected next — it's the panel being read during the procedure */}
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-gray-500 uppercase tracking-wide truncate">
                  {t("Detected · ~{avgMs}ms behind live", { avgMs: stats.avgMs || 250 })}
                </p>
                <button onClick={() => setShowDetected(!showDetected)} className={toggleBtn}>
                  {showDetected ? t("Hide") : t("Show")}
                </button>
              </div>
              <div className={showDetected ? "" : "h-0 overflow-hidden opacity-0"}>
                <div className={panelBox} style={{ aspectRatio: aspect }}>
                  <canvas ref={analyzedRef} className="absolute inset-0 w-full h-full object-contain" />
                </div>
              </div>
            </div>

            {/* Live source underneath, as the reference feed. Never unmounted —
                the <video> is where startStream() attaches the MediaStream. */}
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-gray-500 uppercase tracking-wide truncate">{t("Live · no lag")}</p>
                <button onClick={() => setShowLive(!showLive)} className={toggleBtn}>
                  {showLive ? t("Hide") : t("Show")}
                </button>
              </div>
              <div className={showLive ? "" : "h-0 overflow-hidden opacity-0"}>
                <div className={panelBox} style={{ aspectRatio: liveAspect }}>
                  <video
                    ref={videoRef}
                    muted
                    playsInline
                    loop={captureMode === "demo" || captureMode === "recording"}
                    className={liveStyle ? "absolute object-contain" : "absolute inset-0 w-full h-full object-contain"}
                    style={liveStyle}
                  />
                  {/* What the crop discards. The panel is showing the whole
                      frame right now (liveCrop is forced to null above), so the
                      kept region is outlined and everything outside it is
                      washed red by an outsized ring shadow the panel clips. */}
                  {showFovOverlay && fovNorm && (
                    <div className="absolute inset-0 pointer-events-none">
                      <div
                        className="absolute border-2 border-[#39ff14]"
                        style={{
                          left:   `${fovNorm.x * 100}%`,
                          top:    `${fovNorm.y * 100}%`,
                          width:  `${fovNorm.w * 100}%`,
                          height: `${fovNorm.h * 100}%`,
                          boxShadow: "0 0 0 9999px rgba(239,68,68,0.5)",
                        }}
                      />
                      <p className="absolute bottom-1 inset-x-1 text-center text-[11px] leading-tight text-white bg-black/75 rounded px-1 py-0.5">
                        {t("Red is dropped before inference — {pct}% of the frame", { pct: Math.round(fovTrim * 100) })}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Field of view. The signal is wider than the picture: there is a
                black border around it, and averaging quality statistics over
                that border flattens the difference between a sharp frame and a
                soft one. lib/fov.ts has the measurements. */}
            {streaming && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <label className="flex items-center gap-2 text-gray-400 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={fovEnabled}
                    onChange={(e) => setFovEnabled(e.target.checked)}
                    className="accent-green-500"
                  />
                  {t("Crop to the picture area")}
                </label>
                {fovWorthIt ? (
                  <>
                    <span className="text-xs text-gray-500">
                      {t("{pct}% of the frame is border", { pct: Math.round(fovTrim * 100) })}
                    </span>
                    <button onClick={() => setShowFovOverlay(!showFovOverlay)} className={toggleBtn}>
                      {showFovOverlay ? t("Hide what is cropped") : t("Show what is cropped")}
                    </button>
                  </>
                ) : (
                  <span className="text-xs text-gray-600">
                    {fovRect ? t("No border found — nothing to crop") : t("measuring…")}
                  </span>
                )}
              </div>
            )}

            {/* Shown whenever the source is switchable — with the demo clips in
                the list that is any time we are not screen-sharing. */}
            {captureMode !== "screen" && deviceSelect}

            {captureMode === "screen" && (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <button onClick={openRegionSelector} className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-white transition-colors">
                  {cropRect ? t("Change capture region") : t("Select capture region")}
                </button>
                {cropRect && (
                  <button onClick={() => setCropRect(null)} className="text-gray-500 hover:text-gray-300 transition-colors">
                    {t("Reset (use full frame)")}
                  </button>
                )}
              </div>
            )}

            <button onClick={stopCamera} className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
              {captureMode === "screen" ? t("← Disconnect screen share")
                : captureMode === "demo" ? t("← Stop demo clip")
                : captureMode === "recording" ? t("← Stop replay")
                : t("← Disconnect camera")}
            </button>
          </div>

          {/* Feedback box — spans the remaining two tracks (one per lane) and
              scrolls internally so it never lengthens the page. Mounted only
              while streaming so it isn't polling behind the setup screen. */}
          {streaming && (
            <div className="min-w-0 xl:col-span-2 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto">
              <FeedbackPanel caseId={caseId} refreshSignal={feedbackRefreshKey} />
            </div>
          )}
        </div>

        {/* Playback for what was recorded in THIS session, full width so the
            player isn't squeezed into the narrow capture column. Collapsed by
            default and unmounted while closed — during a procedure nobody is
            watching a replay, and an open panel would be polling for no one. */}
        <div className="mt-4 border-t border-gray-800 pt-3 space-y-3">
          <button
            onClick={() => setShowRecordings((v) => !v)}
            className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
          >
            {showRecordings ? t("▾ Recordings from this session") : t("▸ Recordings from this session")}
          </button>
          {showRecordings && (
            <RecordingsPanel
              caseId={caseId}
              refreshSignal={recorder.finishedCount}
              title={t("Recorded in this session")}
            />
          )}
        </div>
      </div>

      {/* Always mounted (just hidden) so snapshotCanvasRef exists before openRegionSelector()
          needs to draw into it — it draws first, then flips this visible. */}
      <div className={`fixed inset-0 z-50 bg-black/90 flex-col items-center justify-center gap-3 p-4 ${selectingRegion ? "flex" : "hidden"}`}>
        <p className="text-white text-sm">{t("Drag a rectangle around just the video area, then release.")}</p>
        <div className="relative">
          <canvas
            ref={snapshotCanvasRef}
            onPointerDown={handleSelectPointerDown}
            onPointerMove={handleSelectPointerMove}
            onPointerUp={handleSelectPointerUp}
            className="block max-w-full max-h-[70vh] border border-gray-600 cursor-crosshair"
            style={{ touchAction: "none" }}
          />
          {dragBox && (
            <div
              className="pointer-events-none absolute border-2 border-[#39ff14]"
              style={{ left: dragBox.x, top: dragBox.y, width: dragBox.w, height: dragBox.h }}
            />
          )}
        </div>
        <button onClick={() => setSelectingRegion(false)} className="text-sm text-gray-400 hover:text-gray-200">{t("Cancel")}</button>
      </div>

      <p className="text-xs text-gray-600">
        {t("Frames scaled to {width}px before sending · one frame in flight at a time · ~{avgMs}ms round trip per frame", { width: INFER_WIDTH, avgMs: stats.avgMs || 250 })}
      </p>
    </div>
  );
}
