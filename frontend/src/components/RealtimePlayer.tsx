"use client";

import { useEffect, useRef, useState } from "react";
import DemoVideoPicker from "./DemoVideoPicker";
import FeedbackPanel from "./FeedbackPanel";
import LoginPanel from "./LoginPanel";
import { useAuth } from "@/lib/auth";
import { useLanguage } from "@/lib/i18n";
import { useRollingClip } from "@/lib/useRollingClip";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8001";
const API_WS = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8001").replace(/^http/, "ws");
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const INFER_TIMEOUT_MS = 6000;
// Resize frames to this width before sending — faster inference, smaller payload.
// data/precompute_demos.py encodes the saved demo results at this same width, so
// replayed boxes land in the same coordinate space as live ones. Change both together.
const INFER_WIDTH = 320;
const SPEEDS = [0.1, 0.25, 0.5, 1, 1.5, 2];
// Don't auto-capture the same ongoing detection every single frame — once a
// polyp is flagged, wait this long before the next auto-capture so the
// review queue fills with distinct moments, not near-duplicates.
const AUTO_CAPTURE_COOLDOWN_MS = 4000;

interface Box { bbox: [number, number, number, number]; conf: number; }
interface Timing { recv_ms: number; modal_ms: number; total_ms: number; }

/** A demo clip's detections, precomputed once by data/precompute_demos.py. */
interface PredData {
  fps: number;
  width: number;    // capture size the boxes are in — INFER_WIDTH at bake time
  height: number;
  frames: Box[][];  // index IS the frame number
}

export default function RealtimePlayer({
  caseId, onStop, onActivity, wsPath = "/api/ws/infer-file",
}: { caseId: string; onStop: () => void; onActivity?: () => void; wsPath?: string }) {
  const { user } = useAuth();
  const { t } = useLanguage();
  const WS_URL = `${API_WS}${wsPath}`;
  const videoRef    = useRef<HTMLVideoElement>(null);
  const analyzedRef = useRef<HTMLCanvasElement>(null); // last frame actually sent to the model, with boxes burned on
  const wsRef       = useRef<WebSocket | null>(null);
  const scanRef     = useRef(false); // capture loop running?
  const lastAutoCaptureRef = useRef(0);
  // Replay reuses one scratch canvas instead of allocating per animation frame —
  // the live loop can get away with allocating because it runs at inference
  // speed (a few per second), replay runs at frame rate.
  const replayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastReplayIdxRef = useRef(-1);

  // Pending response promise resolver — one in-flight request at a time
  const pendingRef = useRef<((v: { boxes: Box[]; timing: Timing } | null) => void) | null>(null);

  const [videoUrl, setVideoUrl]   = useState<string | null>(null);
  // Non-null => this clip replays saved detections and never opens a socket.
  // The bundled demos always take this path: their footage never changes, so
  // inferring it again on every visit was paying a GPU to recompute a constant.
  const [pred, setPred]           = useState<PredData | null>(null);
  const [loadingDemo, setLoadingDemo] = useState<string | null>(null);
  const [tab, setTab]             = useState<"upload" | "demo">("demo");
  const [dragging, setDragging]   = useState(false);
  const [wsStatus, setWsStatus]   = useState<"connecting" | "open" | "error" | "closed">("connecting");
  const [closeCode, setCloseCode] = useState<number | null>(null);
  const [polyp, setPolyp]         = useState(false);
  const [speed, setSpeed]         = useState(0.1); // slow default — demo footage moves too fast to react to otherwise
  const [stats, setStats]         = useState({ sent: 0, received: 0, avgMs: 0 });
  const [lastError, setLastError] = useState("");
  const [duration, setDuration]   = useState(0);
  const [curTime, setCurTime]     = useState(0);
  const [feedbackRefreshKey, setFeedbackRefreshKey] = useState(0);
  const [videoEnded, setVideoEnded]   = useState(false);
  const [aspect, setAspect]           = useState("560/480"); // replaced with the clip's real ratio on load
  const [showDetected, setShowDetected] = useState(true);
  const [showLive, setShowLive]         = useState(true);
  const msHistory = useRef<number[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastBoxesRef = useRef<Box[]>([]); // AI's most recent detections — attached as context to manual captures

  const { getClip } = useRollingClip(videoRef.current);

  /** True while showing a clip whose detections come from the GPU, live. */
  const liveInference = videoUrl !== null && pred === null;

  // WebSocket — opened only for a clip that actually needs the GPU, and torn
  // down as soon as one isn't loaded. Connecting on mount (as this used to)
  // meant merely opening Real-time held a socket against the GPU backend even
  // if all you ever did was watch a demo.
  useEffect(() => {
    if (!liveInference) return;
    setWsStatus("connecting");
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
  }, [liveInference, WS_URL]);

  // Apply the chosen playback speed to whatever video is currently loaded
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed, videoUrl]);

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

  // Instant, no-dialog manual capture — grabs whatever frame is on screen
  // right now (staff can scrub the seek bar above first to line up an exact
  // moment) and drops it straight into the side-panel queue. Any box
  // drawing/correction happens there, not in a popup.
  function captureDrFound() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const cap = document.createElement("canvas");
    cap.width = video.videoWidth;
    cap.height = video.videoHeight;
    cap.getContext("2d")!.drawImage(video, 0, 0);
    cap.toBlob(async (blob) => {
      if (!blob) return;
      const fd = new FormData();
      fd.append("file", blob, "frame.jpg");
      fd.append("ai_detections", JSON.stringify(lastBoxesRef.current));
      const clip = getClip();
      if (clip) fd.append("video", clip, "clip.webm");
      try {
        await fetch(`${API}/api/feedback/${caseId}/dr-found/capture`, { method: "POST", body: fd });
        setFeedbackRefreshKey((k) => k + 1);
      } catch { /* best-effort */ }
    }, "image/jpeg", 0.9);
  }

  // Auto-capture — the clean (no-overlay) frame that was already grabbed for
  // inference, plus what the model saw, plus a rolling clip if available.
  // Throttled so a polyp staying in view for a while doesn't flood the queue.
  function maybeAutoCapture(cap: HTMLCanvasElement, boxes: Box[]) {
    if (boxes.length === 0) return;
    const now = Date.now();
    if (now - lastAutoCaptureRef.current < AUTO_CAPTURE_COOLDOWN_MS) return;
    lastAutoCaptureRef.current = now;

    cap.toBlob(async (blob) => {
      if (!blob) return;
      const fd = new FormData();
      fd.append("file", blob, "frame.jpg");
      fd.append("ai_detections", JSON.stringify(boxes));
      const clip = getClip();
      if (clip) fd.append("video", clip, "clip.webm");
      try {
        await fetch(`${API}/api/feedback/${caseId}/auto-capture`, { method: "POST", body: fd });
        setFeedbackRefreshKey((k) => k + 1);
      } catch { /* best-effort — don't interrupt the live loop over this */ }
    }, "image/jpeg", 0.85);
  }

  // Live loop — send whatever frame is currently playing → wait for result → send next.
  // The video plays continuously (at the chosen speed); we just grab whatever frame is
  // current each time, same pattern as the live-camera mode.
  async function startLoop(video: HTMLVideoElement) {
    if (scanRef.current) return;
    scanRef.current = true;
    video.loop = false;
    video.playbackRate = speed;
    await video.play();

    while (scanRef.current) {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !video.videoWidth) {
        await new Promise<void>((res) => requestAnimationFrame(() => res()));
        continue;
      }

      const scale = INFER_WIDTH / video.videoWidth;
      const capW  = INFER_WIDTH;
      const capH  = Math.round(video.videoHeight * scale);
      const cap   = document.createElement("canvas");
      cap.width   = capW;
      cap.height  = capH;
      cap.getContext("2d")!.drawImage(video, 0, 0, capW, capH);

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
        updateBoxes(result.boxes);
        drawAnalyzedFrame(cap, result.boxes);
        maybeAutoCapture(cap, result.boxes);
      }
    }
  }

  // Replay loop — the saved-results counterpart of startLoop.
  //
  // It deliberately reproduces what the live path puts on screen rather than
  // taking a shortcut: the frame is downscaled to the same capture size the
  // detections were computed at, and drawn through the same drawAnalyzedFrame,
  // so the overlay is pixel-identical to a live run. Auto-capture still fires,
  // because reviewing demo footage is a real workflow and it costs no GPU.
  //
  // The only honest difference: there is no round trip, so the "Detected" panel
  // does not lag behind the source. The status bar says so instead of inventing
  // a latency figure.
  async function startReplayLoop(video: HTMLVideoElement, data: PredData) {
    if (scanRef.current) return;
    scanRef.current = true;
    lastReplayIdxRef.current = -1;
    video.loop = false;
    video.playbackRate = speed;
    await video.play();

    if (!replayCanvasRef.current) replayCanvasRef.current = document.createElement("canvas");
    const cap = replayCanvasRef.current;
    cap.width = data.width;
    cap.height = data.height;
    const ctx = cap.getContext("2d")!;

    while (scanRef.current) {
      await new Promise<void>((res) => requestAnimationFrame(() => res()));
      if (!video.videoWidth) continue;

      // The frame index IS the array index — that is the contract the bake
      // script writes to. Clamp so the final frame holds rather than blanking.
      const idx = Math.min(data.frames.length - 1, Math.floor(video.currentTime * data.fps));
      if (idx === lastReplayIdxRef.current) continue;
      lastReplayIdxRef.current = idx;

      const boxes = data.frames[idx] ?? [];
      ctx.drawImage(video, 0, 0, cap.width, cap.height);
      updateBoxes(boxes);
      drawAnalyzedFrame(cap, boxes);
      maybeAutoCapture(cap, boxes);
      setStats((s) => ({ sent: s.sent + 1, received: s.received + 1, avgMs: 0 }));
    }
  }

  function handleVideoLoad() {
    const video = videoRef.current;
    if (!video) return;
    setDuration(video.duration || 0);
    // Size the panels to the clip's own shape — a fixed guess letterboxes
    // anything that isn't exactly that ratio.
    if (video.videoWidth && video.videoHeight) setAspect(`${video.videoWidth}/${video.videoHeight}`);
    if (pred) startReplayLoop(video, pred);
    else startLoop(video);
  }

  function handleTimeUpdate() {
    if (videoRef.current) setCurTime(videoRef.current.currentTime);
  }

  function seekTo(newTime: number) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(duration, newTime));
    setCurTime(video.currentTime);
  }

  // Restarts the current clip from the top — playback no longer loops on its
  // own, so this is how staff re-watch it (e.g. right after it finished).
  function replay() {
    const video = videoRef.current;
    if (!video) return;
    setVideoEnded(false);
    video.currentTime = 0;
    setCurTime(0);
    if (pred) startReplayLoop(video, pred);
    else startLoop(video);
  }

  /** Counters and the detection flag describe ONE clip; carrying them across
   *  clips leaves a stale "Polyp detected" lit over footage that has none. */
  function resetClipState() {
    scanRef.current = false;
    setPolyp(false);
    setStats({ sent: 0, received: 0, avgMs: 0 });
    msHistory.current = [];
    lastBoxesRef.current = [];
    lastReplayIdxRef.current = -1;
    setVideoEnded(false);
    setLastError("");
  }

  /** Back to the picker: no clip, so nothing is running and nothing is connected. */
  function unloadClip() {
    resetClipState();
    setVideoUrl(null);
    setPred(null);
  }

  /** A user-supplied clip always means live GPU inference — clear any saved set. */
  function loadUserFile(file: File) {
    resetClipState();
    setPred(null);
    setVideoUrl(URL.createObjectURL(file));
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) loadUserFile(file);
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) loadUserFile(file);
  }

  // Demos load their saved detections and play back from those. If the saved
  // file is missing we deliberately do NOT silently fall back to live
  // inference — that would quietly reintroduce exactly the GPU cost this
  // removes, and the fix (re-run the bake script) belongs to whoever deploys.
  async function handleDemoSelect(filename: string) {
    resetClipState();
    setLoadingDemo(filename);
    try {
      const stem = filename.replace(/\.mp4$/, "");
      const res = await fetch(`${BASE_PATH}/demos/pred/${stem}_pred.json`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as PredData;
      if (!data?.frames?.length) throw new Error("empty");
      setPred(data);
      setVideoUrl(`${BASE_PATH}/demos/${filename}`);
    } catch {
      setLastError(t("Saved results for this clip are missing. Run data/precompute_demos.py to generate them."));
    } finally {
      setLoadingDemo(null);
    }
  }

  const wsOk = wsStatus === "open";
  // Both panels show the same frame at the same size — one just carries the AI
  // mask and trails by the inference round-trip. Hiding one hands its height to
  // the other. Hidden panels are clipped, never unmounted: the <video> has to
  // keep decoding and the <canvas> has to keep being drawn into for inference
  // to continue while it's out of sight.
  // Panels fill their column and take their height from the clip's own ratio —
  // the column is one of three equal thirds, so a video panel and a feedback
  // image (same frame, same ratio) come out exactly the same size.
  const panelBox = "relative w-full rounded-xl overflow-hidden border border-gray-800 bg-black";
  const toggleBtn = "text-xs px-2 py-0.5 rounded-md border border-gray-800 text-gray-500 hover:text-gray-300 hover:border-gray-600 transition-colors flex-shrink-0";

  const wsStatusText =
    wsStatus === "open" ? t("connected") :
    wsStatus === "closed" ? t("closed ({code})", { code: closeCode ?? "" }) :
    t(wsStatus);

  // Replay has no socket and no GPU, so reporting a connection state (or a
  // latency) would be describing something that isn't happening. Say what it
  // actually is instead — the numbers below stay, they just count replayed
  // frames rather than round trips.
  const replaying = pred !== null;

  return (
    <div className="space-y-3">
      {/* Status bar */}
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-3">
          {!videoUrl ? (
            // Nothing loaded: no socket, no GPU. Showing the websocket's state
            // here would report "connecting" at a moment when, by design,
            // nothing is connecting at all.
            <span className="flex items-center gap-1.5 text-gray-500">
              <span className="w-2 h-2 rounded-full inline-block bg-gray-600" />
              {t("idle · nothing running")}
            </span>
          ) : replaying ? (
            <span className="flex items-center gap-1.5 text-cyan-400">
              <span className="w-2 h-2 rounded-full inline-block bg-cyan-400" />
              {t("saved results · no GPU")}
            </span>
          ) : (
            <span className={`flex items-center gap-1.5 ${wsOk ? "text-green-400" : "text-yellow-400"}`}>
              <span className={`w-2 h-2 rounded-full inline-block ${wsOk ? "bg-green-400 animate-pulse" : "bg-yellow-400"}`} />
              {wsStatusText}
            </span>
          )}
          {polyp && <span className="text-[#39ff14] font-medium animate-pulse">{t("Polyp detected")}</span>}
        </div>
        <button onClick={onStop} className="text-sm text-red-400 hover:text-red-300 transition-colors">{t("Stop")}</button>
      </div>

      {/* Debug panel — one compact row, so it costs height only once */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 font-mono text-xs flex flex-wrap items-center gap-x-5 gap-y-1">
        <span><span className="text-gray-500">{replaying ? t("Frames replayed") : t("Frames sent")} </span><span className="text-white">{stats.sent}</span></span>
        {!replaying && (
          <>
            <span><span className="text-gray-500">{t("Responses back")} </span><span className="text-white">{stats.received}</span></span>
            <span>
              <span className="text-gray-500">{t("Modal latency (avg)")} </span>
              <span className={stats.avgMs > 800 ? "text-red-400" : "text-green-400"}>
                {stats.avgMs > 0 ? t("{avgMs} ms", { avgMs: stats.avgMs }) : "—"}
              </span>
            </span>
          </>
        )}
        {replaying && (
          <span className="text-gray-500">{t("Detections precomputed once — this clip costs no GPU time")}</span>
        )}
        {lastError && (
          <span className="min-w-0">
            <span className="text-gray-500">{t("Error")} </span>
            <span className="text-red-400">{lastError}</span>
          </span>
        )}
      </div>

      {!videoUrl && (
        <div className="space-y-4">
          {/* Tab switcher */}
          <div className="flex gap-1 border-b border-gray-800">
            {(["demo", "upload"] as const).map((tabKey) => (
              <button
                key={tabKey}
                onClick={() => setTab(tabKey)}
                className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                  tab === tabKey
                    ? "border-green-500 text-white"
                    : "border-transparent text-gray-500 hover:text-gray-300"
                }`}
              >
                {tabKey === "upload" ? t("Upload video") : t("Try a demo")}
                {tabKey === "upload" && !user && <span className="ms-1.5 text-gray-600">🔒</span>}
              </button>
            ))}
          </div>

          {/* Your own clip means real per-frame GPU inference, so it needs an
              account — unlike the demo tab next to it, which is free to run. */}
          {tab === "upload" && !user && <LoginPanel onOpenDemos={() => setTab("demo")} />}

          {tab === "upload" && user && (
            <div
              onDrop={handleDrop}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-20 text-center cursor-pointer transition-colors ${
                dragging ? "border-green-400 bg-green-950/20" : "border-gray-700 hover:border-gray-500"
              }`}
            >
              <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={handleFile} />
              <p className="text-gray-200 text-lg">{t("Drop a colonoscopy video here")}</p>
              <p className="text-gray-500 text-sm mt-2">{t("Plays continuously — right panel shows the last analyzed frame")}</p>
            </div>
          )}

          {tab === "demo" && (
            <DemoVideoPicker onSelect={handleDemoSelect} loading={loadingDemo} />
          )}
        </div>
      )}

      {/* Desktop: three equal columns — video on the left, the two feedback
          lanes taking the other two. Equal tracks (plus the same card padding
          on every one) are what make the live panels and the feedback images
          render at identical size. Stacks on narrow screens. */}
      {videoUrl && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
          <div className="space-y-2 min-w-0 bg-gray-900/50 border border-gray-800 rounded-xl p-3">
            {/* The one case auto-capture can't cover on its own: a doctor pointing
                out something the model missed. Everything else shows up on its
                own in the side panel, no button needed to go look for it.
                Kept at the top of the column — it's pressed mid-procedure, so it
                should never be somewhere you have to look for or scroll to. */}
            <button
              onClick={captureDrFound}
              className="w-full py-2.5 px-4 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-medium text-sm transition-colors"
            >
              {t("👁 Dr. found a polyp AI missed")}
            </button>

            {/* Detected next — it's the panel being read during the procedure */}
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-gray-500 uppercase tracking-wide truncate">
                  {replaying
                    ? t("Detected · saved result, in sync")
                    : t("Detected · ~{avgMs}ms behind live", { avgMs: stats.avgMs || 250 })}
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

            {/* Live source underneath, as the reference feed */}
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-gray-500 uppercase tracking-wide truncate">
                  {videoEnded ? t("Finished · {speed}x", { speed }) : t("Live · {speed}x · no lag", { speed })}
                </p>
                <button onClick={() => setShowLive(!showLive)} className={toggleBtn}>
                  {showLive ? t("Hide") : t("Show")}
                </button>
              </div>
              <div className={showLive ? "" : "h-0 overflow-hidden opacity-0"}>
                <div className={panelBox} style={{ aspectRatio: aspect }}>
                  <video
                    ref={videoRef}
                    src={videoUrl}
                    muted
                    onCanPlay={handleVideoLoad}
                    onTimeUpdate={handleTimeUpdate}
                    onLoadedMetadata={handleVideoLoad}
                    onEnded={() => { scanRef.current = false; setVideoEnded(true); }}
                    className="absolute inset-0 w-full h-full object-contain"
                  />
                </div>
              </div>
            </div>

            {/* Seek — for lining up the exact moment before a manual capture */}
            <input
              type="range" min={0} max={duration || 0} step={0.1} value={curTime}
              onChange={(e) => seekTo(parseFloat(e.target.value))}
              className="w-full"
            />

            {/* Transport + speed on one row — vertical space is the scarce thing here */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
              <button onClick={() => seekTo(curTime - 3)} className="px-2.5 py-1 rounded-md bg-gray-800 hover:bg-gray-700 text-gray-300 font-mono transition-colors">{t("← 3s")}</button>
              <button onClick={() => seekTo(curTime - 1)} className="px-2.5 py-1 rounded-md bg-gray-800 hover:bg-gray-700 text-gray-300 font-mono transition-colors">{t("← 1s")}</button>
              <button onClick={replay} className="px-2.5 py-1 rounded-md bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium transition-colors">{t("↺ Replay")}</button>
              <span className="text-gray-500 font-mono">{curTime.toFixed(1)}s / {duration.toFixed(1)}s</span>
              <span className="w-px h-4 bg-gray-800" />
              <span
                className="text-gray-500"
                title={t("slower playback = less motion between frames = the two panels drift apart less")}
              >
                {t("Playback speed")}
              </span>
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  onClick={() => setSpeed(s)}
                  className={`px-2.5 py-1 rounded-md font-mono transition-colors ${
                    speed === s ? "bg-green-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                  }`}
                >
                  {s}x
                </button>
              ))}
            </div>

            <button
              onClick={unloadClip}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              {t("← Load different video")}
            </button>
          </div>

          {/* Feedback box — spans the remaining two tracks (one per lane) and
              scrolls internally so it never lengthens the page. No padding or
              border of its own: each lane brings the same card chrome as the
              video column, so all three line up. */}
          <div className="min-w-0 xl:col-span-2 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto">
            <FeedbackPanel caseId={caseId} refreshSignal={feedbackRefreshKey} />
          </div>
        </div>
      )}

      <p className="text-xs text-gray-600">
        {replaying
          ? t("Replaying detections computed once at {width}px — identical to a live run, without the GPU", { width: pred?.width ?? INFER_WIDTH })
          : t("Frames scaled to {width}px before sending · one frame in flight at a time", { width: INFER_WIDTH })}
      </p>
    </div>
  );
}
