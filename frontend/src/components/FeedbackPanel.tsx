"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/lib/i18n";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8001";

interface Box { bbox: [number, number, number, number]; conf: number; }
interface Entry {
  case_id: string;
  filename: string;
  timestamp: string;
  status?: string;
  ai_detections: string;
}

// Always-visible feedback panel — no buttons to click through to see
// anything. Two bars: frames the AI flagged (needs a yes/no from staff),
// and frames the doctor flagged that the AI missed. Click a thumbnail to
// review/edit it right here, no separate modal-behind-a-modal navigation.
export default function FeedbackPanel({ caseId }: { caseId: string }) {
  const { t } = useLanguage();
  const [pending, setPending] = useState<Entry[]>([]);
  const [drFound, setDrFound] = useState<Entry[]>([]);
  const [openEntry, setOpenEntry] = useState<{ entry: Entry; kind: "pending" | "dr_found" } | null>(null);
  const [box, setBox] = useState<[number, number, number, number] | null>(null);
  const [dragStart, setDragStart] = useState<[number, number] | null>(null);
  const [imgNatural, setImgNatural] = useState({ w: 0, h: 0 });

  async function loadAll() {
    try {
      const [q, d] = await Promise.all([
        fetch(`${API}/api/feedback/queue?case_id=${caseId}`).then((r) => r.json()),
        fetch(`${API}/api/feedback/list?status=dr_found&case_id=${caseId}`).then((r) => r.json()),
      ]);
      setPending(q); setDrFound(d);
    } catch { /* best-effort */ }
  }
  useEffect(() => { loadAll(); const iv = setInterval(loadAll, 5000); return () => clearInterval(iv); }, [caseId]); // eslint-disable-line react-hooks/exhaustive-deps

  function openItem(entry: Entry, kind: "pending" | "dr_found") {
    setOpenEntry({ entry, kind });
    setBox(null);
    setImgNatural({ w: 0, h: 0 });
  }

  const aiBoxes: Box[] = openEntry ? (() => { try { return JSON.parse(openEntry.entry.ai_detections || "[]"); } catch { return []; } })() : [];

  function imgPos(e: React.MouseEvent<HTMLImageElement>): [number, number] {
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    const scaleX = imgNatural.w / rect.width, scaleY = imgNatural.h / rect.height;
    return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY];
  }
  function handleMouseDown(e: React.MouseEvent<HTMLImageElement>) { setDragStart(imgPos(e)); setBox(null); }
  function handleMouseMove(e: React.MouseEvent<HTMLImageElement>) {
    if (!dragStart) return;
    const [x, y] = imgPos(e);
    setBox([Math.min(dragStart[0], x), Math.min(dragStart[1], y), Math.max(dragStart[0], x), Math.max(dragStart[1], y)]);
  }
  function handleMouseUp() { setDragStart(null); }

  async function submitReview(correct: boolean, noticedFirst: "dr" | "ai") {
    if (!openEntry) return;
    const fd = new FormData();
    fd.append("correct", String(correct));
    fd.append("noticed_first", noticedFirst);
    if (box) fd.append("bbox", JSON.stringify(box.map((n) => Math.round(n))));
    await fetch(`${API}/api/feedback/${openEntry.entry.case_id}/${openEntry.entry.filename}/review`, { method: "POST", body: fd });
    setOpenEntry(null);
    loadAll();
  }

  async function deleteEntry() {
    if (!openEntry) return;
    await fetch(`${API}/api/feedback/${openEntry.entry.case_id}/${openEntry.entry.filename}`, { method: "DELETE" });
    setOpenEntry(null);
    loadAll();
  }

  return (
    <div className="space-y-4 bg-gray-900/50 border border-gray-800 rounded-xl p-4">
      <Bar
        title={t("🤖 AI detected — needs review")}
        entries={pending}
        emptyText={t("Nothing yet.")}
        onOpen={(e) => openItem(e, "pending")}
      />
      <Bar
        title={t("👁 Dr. found, AI missed")}
        entries={drFound}
        emptyText={t("Nothing yet.")}
        onOpen={(e) => openItem(e, "dr_found")}
      />

      {openEntry && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-950 border border-gray-800 rounded-2xl p-5 max-w-2xl w-full space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-gray-300">
                {openEntry.kind === "pending" ? t("Review AI detection") : t("Dr. found, AI missed")}
              </h3>
              <button onClick={() => setOpenEntry(null)} className="text-gray-500 hover:text-gray-300 text-sm">{t("Close")}</button>
            </div>

            <div className="relative w-full rounded-xl overflow-hidden border border-gray-800 bg-black">
              <img
                src={`${API}/api/feedback/${openEntry.entry.case_id}/image/${openEntry.entry.filename}`}
                alt=""
                className="w-full h-auto block cursor-crosshair"
                onLoad={(e) => setImgNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
              />
              {!box && imgNatural.w > 0 && aiBoxes.map((b, i) => {
                const [x1, y1, x2, y2] = b.bbox;
                const scaleX = 100 / imgNatural.w, scaleY = 100 / imgNatural.h;
                return (
                  <div key={i} className="absolute border-2 border-[#39ff14] pointer-events-none"
                    style={{ left: `${x1 * scaleX}%`, top: `${y1 * scaleY}%`, width: `${(x2 - x1) * scaleX}%`, height: `${(y2 - y1) * scaleY}%` }}>
                    <span className="absolute -top-5 left-0 text-[10px] text-[#39ff14] font-mono">{Math.round(b.conf * 100)}%</span>
                  </div>
                );
              })}
              {box && imgNatural.w > 0 && (() => {
                const [x1, y1, x2, y2] = box;
                const scaleX = 100 / imgNatural.w, scaleY = 100 / imgNatural.h;
                return (
                  <div className="absolute border-2 border-red-500 pointer-events-none"
                    style={{ left: `${x1 * scaleX}%`, top: `${y1 * scaleY}%`, width: `${(x2 - x1) * scaleX}%`, height: `${(y2 - y1) * scaleY}%` }} />
                );
              })()}
            </div>
            <p className="text-xs text-gray-500">
              {t("Green box is the AI's detection. Drag on the image to correct it if needed.")}
            </p>
            {box && (
              <button onClick={() => setBox(null)} className="text-xs text-gray-500 hover:text-gray-300">{t("Reset to AI's box")}</button>
            )}

            {openEntry.kind === "pending" ? (
              <div className="grid grid-cols-1 gap-2">
                <button onClick={() => submitReview(true, "dr")} className="py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-white font-medium text-sm transition-colors">
                  {t("✓ Dr. already found this")}
                </button>
                <button onClick={() => submitReview(true, "ai")} className="py-2.5 bg-sky-600 hover:bg-sky-500 rounded-xl text-white font-medium text-sm transition-colors">
                  {t("✓ Dr. didn't notice at first — confirms correct")}
                </button>
                <button onClick={() => submitReview(false, "ai")} className="py-2.5 bg-amber-600 hover:bg-amber-500 rounded-xl text-white font-medium text-sm transition-colors">
                  {t("✗ Dr. says this is wrong")}
                </button>
              </div>
            ) : (
              <button onClick={deleteEntry} className="text-xs text-red-400 hover:text-red-300 transition-colors">
                {t("Delete this capture")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Bar({ title, entries, emptyText, onOpen }: { title: string; entries: Entry[]; emptyText: string; onOpen: (e: Entry) => void }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-300 font-medium">{title} {entries.length > 0 && `(${entries.length})`}</p>
      {entries.length === 0 ? (
        <p className="text-xs text-gray-600">{emptyText}</p>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {entries.map((e) => (
            <button
              key={e.filename}
              onClick={() => onOpen(e)}
              className="flex-shrink-0 w-24 h-16 rounded-lg overflow-hidden border border-gray-800 hover:border-blue-500 transition-colors"
            >
              <img src={`${API}/api/feedback/${e.case_id}/image/${e.filename}`} alt="" className="w-full h-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
