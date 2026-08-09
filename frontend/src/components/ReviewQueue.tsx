"use client";

import { useEffect, useRef, useState } from "react";
import { useLanguage } from "@/lib/i18n";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8001";

interface Box { bbox: [number, number, number, number]; conf: number; }
interface QueueEntry {
  case_id: string;
  filename: string;
  has_video: string;
  timestamp: string;
  ai_detections: string;
}

// Triage UI for auto-captured frames: does staff agree the model was right?
// Deliberately NOT a blocking modal that pops up on every detection — items
// queue up and get reviewed whenever staff has a moment, in order.
// caseId: scope the queue to the current live session; omit (in Feedback
// mode, outside any session) to review across every case.
export default function ReviewQueue({ caseId, onClose, onReviewed }: { caseId?: string; onClose: () => void; onReviewed: () => void }) {
  const { t } = useLanguage();
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [adjustedBox, setAdjustedBox] = useState<[number, number, number, number] | null>(null);
  const [dragStart, setDragStart] = useState<[number, number] | null>(null);
  const [noticedFirst, setNoticedFirst] = useState<"dr" | "ai" | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgNatural, setImgNatural] = useState({ w: 0, h: 0 });

  async function load() {
    setLoading(true);
    try {
      const url = caseId ? `${API}/api/feedback/queue?case_id=${caseId}` : `${API}/api/feedback/queue`;
      const res = await fetch(url);
      setQueue(await res.json());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const current = queue[0];
  const aiBoxes: Box[] = current ? (() => { try { return JSON.parse(current.ai_detections || "[]"); } catch { return []; } })() : [];

  useEffect(() => {
    setAdjustedBox(null);
    setImgNatural({ w: 0, h: 0 });
    setNoticedFirst(null);
  }, [current?.filename]);

  async function submit(correct: boolean) {
    if (!current || !noticedFirst) return;
    const fd = new FormData();
    fd.append("correct", String(correct));
    fd.append("noticed_first", noticedFirst);
    if (adjustedBox) fd.append("bbox", JSON.stringify(adjustedBox.map((n) => Math.round(n))));
    await fetch(`${API}/api/feedback/${current.case_id}/${current.filename}/review`, { method: "POST", body: fd });
    setQueue((q) => q.slice(1));
    onReviewed();
  }

  function imgPos(e: React.MouseEvent<HTMLImageElement>): [number, number] {
    const img = imgRef.current!;
    const rect = img.getBoundingClientRect();
    const scaleX = imgNatural.w / rect.width, scaleY = imgNatural.h / rect.height;
    return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY];
  }
  function handleMouseDown(e: React.MouseEvent<HTMLImageElement>) { setDragStart(imgPos(e)); setAdjustedBox(null); }
  function handleMouseMove(e: React.MouseEvent<HTMLImageElement>) {
    if (!dragStart) return;
    const [x, y] = imgPos(e);
    setAdjustedBox([Math.min(dragStart[0], x), Math.min(dragStart[1], y), Math.max(dragStart[0], x), Math.max(dragStart[1], y)]);
  }
  function handleMouseUp() { setDragStart(null); }

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-950 border border-gray-800 rounded-2xl p-5 max-w-2xl w-full space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">
            {t("Review queue")} {queue.length > 0 && `(${queue.length})`}
          </h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-sm">{t("Close")}</button>
        </div>

        {loading && <p className="text-sm text-gray-500">{t("Loading…")}</p>}

        {!loading && !current && (
          <p className="text-sm text-gray-500 py-10 text-center">{t("Nothing waiting for review.")}</p>
        )}

        {current && (
          <>
            <div className="relative w-full rounded-xl overflow-hidden border border-gray-800 bg-black">
              <img
                ref={imgRef}
                src={`${API}/api/feedback/${current.case_id}/image/${current.filename}`}
                alt=""
                className="w-full h-auto block cursor-crosshair"
                onLoad={(e) => setImgNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
              />
              {!adjustedBox && imgNatural.w > 0 && aiBoxes.map((b, i) => {
                const [x1, y1, x2, y2] = b.bbox;
                const scaleX = 100 / imgNatural.w, scaleY = 100 / imgNatural.h;
                return (
                  <div key={i} className="absolute border-2 border-[#39ff14] pointer-events-none"
                    style={{ left: `${x1 * scaleX}%`, top: `${y1 * scaleY}%`, width: `${(x2 - x1) * scaleX}%`, height: `${(y2 - y1) * scaleY}%` }}>
                    <span className="absolute -top-5 left-0 text-[10px] text-[#39ff14] font-mono">{Math.round(b.conf * 100)}%</span>
                  </div>
                );
              })}
              {adjustedBox && imgNatural.w > 0 && (() => {
                const [x1, y1, x2, y2] = adjustedBox;
                const scaleX = 100 / imgNatural.w, scaleY = 100 / imgNatural.h;
                return (
                  <div className="absolute border-2 border-red-500 pointer-events-none"
                    style={{ left: `${x1 * scaleX}%`, top: `${y1 * scaleY}%`, width: `${(x2 - x1) * scaleX}%`, height: `${(y2 - y1) * scaleY}%` }} />
                );
              })()}
            </div>

            {current.has_video === "True" && (
              <video
                src={`${API}/api/feedback/${current.case_id}/video/${current.filename}`}
                controls
                className="w-full rounded-lg border border-gray-800"
              />
            )}

            <p className="text-xs text-gray-500">
              {t("Green box is what the AI detected. Drag on the image to correct the box if needed, then confirm.")}
            </p>
            {adjustedBox && (
              <button onClick={() => setAdjustedBox(null)} className="text-xs text-gray-500 hover:text-gray-300">
                {t("Reset to AI's box")}
              </button>
            )}

            <div className="space-y-2">
              <p className="text-sm text-gray-300">{t("Who noticed this first?")}</p>
              <div className="flex gap-3">
                <button
                  onClick={() => setNoticedFirst("dr")}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors border-2 ${
                    noticedFirst === "dr" ? "bg-blue-600 border-blue-600 text-white" : "border-gray-700 text-gray-400 hover:border-gray-500"
                  }`}
                >
                  {t("Dr. noticed it")}
                </button>
                <button
                  onClick={() => setNoticedFirst("ai")}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors border-2 ${
                    noticedFirst === "ai" ? "bg-purple-600 border-purple-600 text-white" : "border-gray-700 text-gray-400 hover:border-gray-500"
                  }`}
                >
                  {t("AI caught it, Dr. hadn't noticed yet")}
                </button>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => submit(true)}
                disabled={!noticedFirst}
                className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl text-white font-medium transition-colors"
              >
                {t("Correct — real polyp")}
              </button>
              <button
                onClick={() => submit(false)}
                disabled={!noticedFirst}
                className="flex-1 py-2.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl text-white font-medium transition-colors"
              >
                {t("Incorrect — false alarm")}
              </button>
            </div>
            {!noticedFirst && (
              <p className="text-xs text-gray-600 text-center">{t("Choose who noticed it first before confirming.")}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
