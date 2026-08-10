"use client";

import { useEffect, useRef, useState } from "react";
import { useLanguage } from "@/lib/i18n";

const API_WS = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8001").replace(/^http/, "ws");
const INFER_TIMEOUT_MS = 6000;
// Resize frames to this width before sending — faster inference, smaller payload
const INFER_WIDTH = 320;

interface Box { bbox: [number, number, number, number]; conf: number; }
interface Timing { recv_ms: number; modal_ms: number; total_ms: number; }

export default function LiveCameraPlayer({ onStop, onActivity, wsPath = "/api/ws/infer", initialMode = "camera", backend }: { onStop: () => void; onActivity?: () => void; wsPath?: string; initialMode?: "camera" | "screen"; backend?: string }) {
  const { t } = useLanguage();
  // Pinned for the life of the socket — see RealtimePlayer.
  const WS_URL = `${API_WS}${wsPath}${backend ? `?backend=${encodeURIComponent(backend)}` : ""}`;
  const videoRef    = useRef<HTMLVideoElement>(null);
  const analyzedRef = useRef<HTMLCanvasElement>(null); // last frame actually sent to the model, with boxes burned on
  const wsRef       = useRef<WebSocket | null>(null);
  const scanRef     = useRef(false); // capture loop running?
  const streamRef   = useRef<MediaStream | null>(null);

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
  const [captureMode, setCaptureMode]     = useState<"camera" | "screen">("camera");
  const msHistory = useRef<number[]>([]);

  // Crop applied to screen-share frames before sending (normalized 0..1, relative to native frame size).
  // Lets you box just the video-feed area out of a shared app window that also shows toolbars/UI chrome.
  const [cropRect, setCropRectState] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const cropRectRef = useRef<typeof cropRect>(null);
  const [selectingRegion, setSelectingRegion] = useState(false);
  const [dragBox, setDragBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const snapshotCanvasRef = useRef<HTMLCanvasElement>(null);
  const CROP_KEY = "polyp_screen_crop_rect";

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

  function updateBoxes(b: Box[]) { setPolyp(b.length > 0); }

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

      const vw = video.videoWidth, vh = video.videoHeight;
      const crop  = cropRectRef.current;
      const srcX  = crop ? Math.round(crop.x * vw) : 0;
      const srcY  = crop ? Math.round(crop.y * vh) : 0;
      const srcW  = crop ? Math.round(crop.w * vw) : vw;
      const srcH  = crop ? Math.round(crop.h * vh) : vh;

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
        updateBoxes(result.boxes);
        drawAnalyzedFrame(cap, result.boxes);
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
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
      setCaptureMode("camera");
      setCameraBusy(false);
      setLastError("");
      setStreaming(true);
      startLoop();
    } catch (err: unknown) {
      setLastError(describeCameraError(err));
      setCameraBusy(err instanceof DOMException && (err.name === "NotReadableError" || err.name === "TrackStartError"));
    }
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
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
      stream.getVideoTracks()[0].addEventListener("ended", stopCamera);
      setCaptureMode("screen");
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
    setSelectedId(id);
    startStream(id);
  }

  function stopCamera() {
    scanRef.current = false;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStreaming(false);
    updateBoxes([]);
  }

  const wsOk = wsStatus === "open";
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
      {devices.map((d) => (
        <option key={d.deviceId} value={d.deviceId}>
          {d.label || t("Camera {id}", { id: d.deviceId.slice(0, 6) })}
        </option>
      ))}
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
        <span className="text-gray-500">{t("Modal latency (avg)")}</span>
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
              {devices.length > 0 && <div>{deviceSelect}</div>}

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
      <div className={streaming ? "space-y-3" : "hidden"}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <p className="text-xs text-gray-500 uppercase tracking-wide">{t("Live · no lag")}</p>
            <div className="relative w-full rounded-xl overflow-hidden border border-gray-800 bg-black"
              style={{ aspectRatio: "560/480" }}>
              <video ref={videoRef} muted playsInline className="absolute inset-0 w-full h-full object-cover" />
            </div>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs text-gray-500 uppercase tracking-wide">
              {t("Detected · ~{avgMs}ms behind live", { avgMs: stats.avgMs || 250 })}
            </p>
            <div className="relative w-full rounded-xl overflow-hidden border border-gray-800 bg-black"
              style={{ aspectRatio: "560/480" }}>
              <canvas ref={analyzedRef} className="absolute inset-0 w-full h-full object-contain" />
            </div>
          </div>
        </div>

        {captureMode === "camera" && devices.length > 1 && deviceSelect}

        {captureMode === "screen" && (
          <div className="flex items-center gap-3 text-sm">
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
          {captureMode === "screen" ? t("← Disconnect screen share") : t("← Disconnect camera")}
        </button>
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
