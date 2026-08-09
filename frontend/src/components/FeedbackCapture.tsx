"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useLanguage } from "@/lib/i18n";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8001";

interface Box { bbox: [number, number, number, number]; conf: number; }
interface Props {
  mode: "dr_found" | "false_positive";
  video: HTMLVideoElement;
  caseId: string;
  getClip?: () => Blob | null;
  onClose: () => void;
  onSaved: () => void;
}

// Manual capture flow — for the two cases auto-capture can't cover on its own:
// - dr_found: a doctor pointing out a polyp the model never flagged, so
//   there's no detection event to auto-trigger from.
// - false_positive: staff flagging what the model is showing RIGHT NOW as
//   wrong, on the spot, rather than waiting for the review queue.
// Either way the saved image is always the plain camera frame; the model's
// own output for this exact frame is shown for reference and stored as
// metadata, so review can catch "actually the model did/didn't agree" cases.
export default function FeedbackCapture({ mode, video, caseId, getClip, onClose, onSaved }: Props) {
  const { t } = useLanguage();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [duration, setDuration] = useState(video.duration || 0);
  const [time, setTime] = useState(video.currentTime);
  const [aiBoxes, setAiBoxes] = useState<Box[]>([]);
  const [checking, setChecking] = useState(false);
  const [drawnBox, setDrawnBox] = useState<[number, number, number, number] | null>(null);
  const [dragStart, setDragStart] = useState<[number, number] | null>(null);
  const [saving, setSaving] = useState(false);
  const wasPlayingRef = useRef(!video.paused);
  const checkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    wasPlayingRef.current = !video.paused;
    video.pause();
    return () => { if (wasPlayingRef.current) video.play().catch(() => {}); };
  }, [video]);

  const captureFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(video, 0, 0);
    return canvas;
  }, [video]);

  const runAiCheck = useCallback(() => {
    const canvas = captureFrame();
    if (!canvas) return;
    setChecking(true);
    canvas.toBlob(async (blob) => {
      if (!blob) { setChecking(false); return; }
      try {
        const fd = new FormData();
        fd.append("file", blob, "frame.jpg");
        const res = await fetch(`${API}/api/feedback/check-frame`, { method: "POST", body: fd });
        const data = await res.json();
        setAiBoxes(data.detections ?? []);
      } catch {
        setAiBoxes([]);
      } finally {
        setChecking(false);
      }
    }, "image/jpeg", 0.9);
  }, [captureFrame]);

  useEffect(() => {
    captureFrame();
    runAiCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (video.duration && !isNaN(video.duration)) setDuration(video.duration);
  }, [video.duration]);

  function seekTo(newTime: number) {
    const clamped = Math.max(0, Math.min(duration || newTime, newTime));
    video.currentTime = clamped;
    setTime(clamped);
    setDrawnBox(null);
    captureFrame();
    if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
    checkTimerRef.current = setTimeout(runAiCheck, 300);
  }

  function handleBack(seconds: number) { seekTo((video.currentTime || time) - seconds); }

  function canvasPos(e: React.MouseEvent<HTMLCanvasElement>): [number, number] {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
    return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY];
  }
  function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>) { setDragStart(canvasPos(e)); setDrawnBox(null); }
  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!dragStart) return;
    const [x, y] = canvasPos(e);
    setDrawnBox([Math.min(dragStart[0], x), Math.min(dragStart[1], y), Math.max(dragStart[0], x), Math.max(dragStart[1], y)]);
  }
  function handleMouseUp() { setDragStart(null); }

  async function handleSave() {
    const canvas = captureFrame();
    if (!canvas) return;
    setSaving(true);
    canvas.toBlob(async (blob) => {
      if (!blob) { setSaving(false); return; }
      try {
        const fd = new FormData();
        fd.append("file", blob, "frame.jpg");
        if (drawnBox) fd.append("bbox", JSON.stringify(drawnBox.map((n) => Math.round(n))));
        fd.append("ai_detections", JSON.stringify(aiBoxes));
        const clip = getClip?.();
        if (clip) fd.append("video", clip, "clip.webm");
        const endpoint = mode === "dr_found" ? "dr-found/capture" : "false-positive/capture";
        const res = await fetch(`${API}/api/feedback/${caseId}/${endpoint}`, { method: "POST", body: fd });
        if (res.ok) { onSaved(); onClose(); }
      } finally {
        setSaving(false);
      }
    }, "image/jpeg", 0.92);
  }

  const accent = mode === "dr_found" ? "border-emerald-500" : "border-amber-500";
  const saveColor = mode === "dr_found" ? "bg-emerald-600 hover:bg-emerald-500" : "bg-amber-600 hover:bg-amber-500";

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className={`bg-gray-950 border-2 ${accent} rounded-2xl p-5 max-w-2xl w-full space-y-4`}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">
            {mode === "dr_found" ? t("Dr. found a polyp (AI missed it)") : t("Mark AI detection as false positive")}
          </h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-sm">{t("Cancel")}</button>
        </div>

        <div className="relative w-full rounded-xl overflow-hidden border border-gray-800 bg-black">
          <canvas
            ref={canvasRef}
            className="w-full h-auto block cursor-crosshair"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          />
          {aiBoxes.map((b, i) => {
            const canvas = canvasRef.current;
            if (!canvas || !canvas.width) return null;
            const scaleX = 100 / canvas.width, scaleY = 100 / canvas.height;
            const [x1, y1, x2, y2] = b.bbox;
            return (
              <div key={i} className="absolute border-2 border-dashed border-[#39ff14] pointer-events-none"
                style={{ left: `${x1 * scaleX}%`, top: `${y1 * scaleY}%`, width: `${(x2 - x1) * scaleX}%`, height: `${(y2 - y1) * scaleY}%` }}>
                <span className="absolute -top-5 left-0 text-[10px] text-[#39ff14] font-mono">{t("AI")}: {Math.round(b.conf * 100)}%</span>
              </div>
            );
          })}
          {drawnBox && (() => {
            const canvas = canvasRef.current;
            if (!canvas || !canvas.width) return null;
            const scaleX = 100 / canvas.width, scaleY = 100 / canvas.height;
            const [x1, y1, x2, y2] = drawnBox;
            return (
              <div className="absolute border-2 border-red-500 pointer-events-none"
                style={{ left: `${x1 * scaleX}%`, top: `${y1 * scaleY}%`, width: `${(x2 - x1) * scaleX}%`, height: `${(y2 - y1) * scaleY}%` }} />
            );
          })()}
        </div>

        <p className="text-xs text-gray-500">
          {checking ? t("Checking what AI sees on this exact frame…") :
            mode === "dr_found" ? (
              aiBoxes.length > 0 ? t("AI also detected {n} box(es) on this frame — check before saving.", { n: aiBoxes.length }) :
              t("AI detected nothing on this exact frame — confirmed miss.")
            ) : (
              aiBoxes.length > 0 ? t("AI currently shows {n} box(es) here — save to record this as a false alarm.", { n: aiBoxes.length }) :
              t("AI shows nothing right now — if it flagged something moments ago, save anyway to record the false alarm.")
            )}
        </p>

        <div className="space-y-2">
          <input type="range" min={0} max={duration || 0} step={0.1} value={time}
            onChange={(e) => seekTo(parseFloat(e.target.value))} className="w-full" />
          <div className="flex items-center gap-2">
            <button onClick={() => handleBack(3)} className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-white text-xs font-medium transition-colors">{t("← 3s")}</button>
            <button onClick={() => handleBack(1)} className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-white text-xs font-medium transition-colors">{t("← 1s")}</button>
            <span className="text-xs text-gray-500 font-mono ml-2">{time.toFixed(1)}s / {duration.toFixed(1)}s</span>
            {drawnBox && (
              <button onClick={() => setDrawnBox(null)} className="ml-auto text-xs text-gray-500 hover:text-gray-300">{t("Clear box")}</button>
            )}
          </div>
          <p className="text-xs text-gray-600">{t("Drag on the frame above to draw a box around the polyp (optional).")}</p>
        </div>

        <div className="flex gap-3">
          <button onClick={handleSave} disabled={saving}
            className={`flex-1 py-2.5 ${saveColor} disabled:opacity-50 rounded-xl text-white font-medium transition-colors`}>
            {saving ? t("Saving…") : t("Save")}
          </button>
          <button onClick={onClose} className="px-5 py-2.5 bg-gray-800 hover:bg-gray-700 rounded-xl text-white font-medium transition-colors">
            {t("Cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
