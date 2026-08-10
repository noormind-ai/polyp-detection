"use client";

import { useEffect, useRef, useState } from "react";
import DemoVideoPicker from "./DemoVideoPicker";
import FeedbackPanel from "./FeedbackPanel";
import { useLanguage } from "@/lib/i18n";
import { useRollingClip } from "@/lib/useRollingClip";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8001";
const API_WS = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8001").replace(/^http/, "ws");
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const INFER_TIMEOUT_MS = 6000;
// Resize frames to this width before sending — faster inference, smaller payload
const INFER_WIDTH = 320;
const SPEEDS = [0.1, 0.25, 0.5, 1, 1.5, 2];
// Don't auto-capture the same ongoing detection every single frame — once a
// polyp is flagged, wait this long before the next auto-capture so the
// review queue fills with distinct moments, not near-duplicates.
const AUTO_CAPTURE_COOLDOWN_MS = 4000;

interface Box { bbox: [number, number, number, number]; conf: number; }
interface Timing { recv_ms: number; modal_ms: number; total_ms: number; }

export default function RealtimePlayer({
  caseId, onStop, onActivity, wsPath = "/api/ws/infer", backend,
}: { caseId: string; onStop: () => void; onActivity?: () => void; wsPath?: string; backend?: string }) {
  const { t } = useLanguage();
  // The backend is pinned for the life of the socket — the server reads it once
  // on connect, so switching would need a reconnect, not just a different param.
  const WS_URL = `${API_WS}${wsPath}${backend ? `?backend=${encodeURIComponent(backend)}` : ""}`;
  const videoRef    = useRef<HTMLVideoElement>(null);
  const analyzedRef = useRef<HTMLCanvasElement>(null); // last frame actually sent to the model, with boxes burned on
  const wsRef       = useRef<WebSocket | null>(null);
  const scanRef     = useRef(false); // capture loop running?
  const lastAutoCaptureRef = useRef(0);

  // Pending response promise resolver — one in-flight request at a time
  const pendingRef = useRef<((v: { boxes: Box[]; timing: Timing } | null) => void) | null>(null);

  const [videoUrl, setVideoUrl]   = useState<string | null>(null);
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

  function handleVideoLoad() {
    const video = videoRef.current;
    if (!video) return;
    setDuration(video.duration || 0);
    // Size the panels to the clip's own shape — a fixed guess letterboxes
    // anything that isn't exactly that ratio.
    if (video.videoWidth && video.videoHeight) setAspect(`${video.videoWidth}/${video.videoHeight}`);
    startLoop(video);
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
    startLoop(video);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) { scanRef.current = false; setVideoUrl(URL.createObjectURL(file)); }
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) { scanRef.current = false; setVideoUrl(URL.createObjectURL(file)); }
  }

  function handleDemoSelect(filename: string) {
    scanRef.current = false;
    setVideoUrl(`${BASE_PATH}/demos/${filename}`);
  }

  const wsOk = wsStatus === "open";
  // Both panels show the same frame at the same size — one just carries the AI
  // mask and trails by the inference round-trip. Hiding one hands its height to
  // the other. Hidden panels are clipped, never unmounted: the <video> has to
  // keep decoding and the <canvas> has to keep being drawn into for inference
  // to continue while it's out of sight.
  // Width comes from the 3-column grid below, not from viewport height: the video
  // column and the two feedback lanes are each 1/3, so the frames get as much
  // width as a review thumbnail column. Panel height then follows the clip's own
  // ratio, which is what makes a polyp big enough to actually judge.
  const panelBox = "relative w-full rounded-xl overflow-hidden border border-gray-800 bg-black";
  const toggleBtn = "text-xs px-2 py-0.5 rounded-md border border-gray-800 text-gray-500 hover:text-gray-300 hover:border-gray-600 transition-colors flex-shrink-0";

  const wsStatusText =
    wsStatus === "open" ? t("connected") :
    wsStatus === "closed" ? t("closed ({code})", { code: closeCode ?? "" }) :
    t(wsStatus);

  return (
    <div className="space-y-3">
      {/* Status bar */}
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-3">
          <span className={`flex items-center gap-1.5 ${wsOk ? "text-green-400" : "text-yellow-400"}`}>
            <span className={`w-2 h-2 rounded-full inline-block ${wsOk ? "bg-green-400 animate-pulse" : "bg-yellow-400"}`} />
            {wsStatusText}
          </span>
          {polyp && <span className="text-[#39ff14] font-medium animate-pulse">{t("Polyp detected")}</span>}
        </div>
        <button onClick={onStop} className="text-sm text-red-400 hover:text-red-300 transition-colors">{t("Stop")}</button>
      </div>

      {/* Debug panel — one compact row, so it costs height only once */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 font-mono text-xs flex flex-wrap items-center gap-x-5 gap-y-1">
        <span><span className="text-gray-500">{t("Frames sent")} </span><span className="text-white">{stats.sent}</span></span>
        <span><span className="text-gray-500">{t("Responses back")} </span><span className="text-white">{stats.received}</span></span>
        <span>
          <span className="text-gray-500">{backend === "local" ? t("Inference latency (avg)") : t("Modal latency (avg)")} </span>
          <span className={stats.avgMs > 800 ? "text-red-400" : "text-green-400"}>
            {stats.avgMs > 0 ? t("{avgMs} ms", { avgMs: stats.avgMs }) : "—"}
          </span>
        </span>
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
              </button>
            ))}
          </div>

          {tab === "upload" && (
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
            <DemoVideoPicker onSelect={handleDemoSelect} />
          )}
        </div>
      )}

      {/* Desktop: video column on one side, feedback box on the other, so the
          whole workflow fits one screen without scrolling. Videos are capped in
          viewport height (not aspect ratio) for the same reason; they letterbox
          rather than push the controls off-screen. Stacks on narrow screens. */}
      {videoUrl && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
          <div className="space-y-2 min-w-0">
            {/* Detected on top — it's the panel being read during the procedure */}
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

            {/* The one case auto-capture can't cover on its own: a doctor pointing
                out something the model missed. Everything else shows up on its
                own in the side panel, no button needed to go look for it. */}
            <button
              onClick={captureDrFound}
              className="w-full py-2.5 px-4 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-medium text-sm transition-colors"
            >
              {t("👁 Dr. found a polyp AI missed")}
            </button>

            <button
              onClick={() => { scanRef.current = false; setVideoUrl(null); }}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              {t("← Load different video")}
            </button>
          </div>

          {/* Feedback box spans the remaining two columns and splits them into its
              own two lanes, so video / AI-detected / dr-found all end up 1/3 wide.
              Scrolls internally so it never lengthens the page. */}
          <div className="min-w-0 xl:col-span-2 rounded-2xl border border-gray-800 bg-gray-900/40 p-3 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto">
            <FeedbackPanel caseId={caseId} refreshSignal={feedbackRefreshKey} />
          </div>
        </div>
      )}

      <p className="text-xs text-gray-600">
        {t("Frames scaled to {width}px before sending · one frame in flight at a time", { width: INFER_WIDTH })}
      </p>
    </div>
  );
}
