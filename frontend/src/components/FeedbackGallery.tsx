"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/lib/i18n";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8001";

type Status = "confirmed" | "false_positive" | "dr_found";

interface Entry {
  case_id: string;
  filename: string;
  has_video: string;
  timestamp: string;
  status: Status;
  noticed_first: string;
  bbox_x1: string; bbox_y1: string; bbox_x2: string; bbox_y2: string;
  ai_detections: string;
}

const STATUSES: Status[] = ["confirmed", "false_positive", "dr_found"];

// caseId: scope to the current session, or omit (Feedback mode) to browse
// everything ever captured, across all cases.
export default function FeedbackGallery({ caseId, onClose }: { caseId?: string; onClose: () => void }) {
  const { t } = useLanguage();
  const [status, setStatus] = useState<Status>("confirmed");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [loading, setLoading] = useState(true);
  const [imgNatural, setImgNatural] = useState({ w: 0, h: 0 });

  useEffect(() => { setImgNatural({ w: 0, h: 0 }); }, [selected]);

  async function load() {
    setLoading(true);
    try {
      const url = `${API}/api/feedback/list?status=${status}${caseId ? `&case_id=${caseId}` : ""}`;
      const res = await fetch(url);
      setEntries(await res.json());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { setSelected(null); load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleDelete(entry: Entry) {
    await fetch(`${API}/api/feedback/${entry.case_id}/${entry.filename}`, { method: "DELETE" });
    setSelected(null);
    load();
  }

  const aiBoxes = selected ? (() => { try { return JSON.parse(selected.ai_detections || "[]"); } catch { return []; } })() : [];
  const hasBox = selected && selected.bbox_x1 !== "";

  const statusLabels: Record<Status, string> = {
    confirmed: t("Confirmed polyps"),
    false_positive: t("False alarms"),
    dr_found: t("Dr. found, AI missed"),
  };
  const noticedLabels: Record<string, string> = {
    dr: t("Dr. noticed first"),
    ai: t("AI caught it first"),
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-950 border border-gray-800 rounded-2xl p-5 max-w-4xl w-full max-h-[85vh] overflow-y-auto space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">{t("Saved captures")}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-sm">{t("Close")}</button>
        </div>

        <div className="flex gap-1 border-b border-gray-800">
          {STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                status === s ? "border-blue-500 text-white" : "border-transparent text-gray-500 hover:text-gray-300"
              }`}
            >
              {statusLabels[s]}
            </button>
          ))}
        </div>

        {loading && <p className="text-sm text-gray-500">{t("Loading…")}</p>}
        {!loading && entries.length === 0 && <p className="text-sm text-gray-500">{t("No captures saved yet.")}</p>}

        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
          {entries.map((e) => (
            <button
              key={e.filename}
              onClick={() => setSelected(e)}
              className="aspect-video rounded-lg overflow-hidden border border-gray-800 hover:border-blue-500 transition-colors relative"
            >
              <img src={`${API}/api/feedback/${e.case_id}/image/${e.filename}`} alt="" className="w-full h-full object-cover" />
              {e.bbox_x1 !== "" && (
                <span className="absolute top-1 right-1 text-[10px] bg-red-600 text-white px-1.5 rounded">{t("box")}</span>
              )}
            </button>
          ))}
        </div>

        {selected && (
          <div className="border-t border-gray-800 pt-4 space-y-3">
            <div className="relative w-full rounded-xl overflow-hidden border border-gray-800 bg-black">
              <img
                src={`${API}/api/feedback/${selected.case_id}/image/${selected.filename}`}
                alt=""
                className="w-full h-auto block"
                onLoad={(e) => setImgNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              />
              {hasBox && imgNatural.w > 0 && (
                <div className="absolute border-2 border-red-500 pointer-events-none"
                  style={{
                    left: `${(+selected.bbox_x1 / imgNatural.w) * 100}%`,
                    top: `${(+selected.bbox_y1 / imgNatural.h) * 100}%`,
                    width: `${((+selected.bbox_x2 - +selected.bbox_x1) / imgNatural.w) * 100}%`,
                    height: `${((+selected.bbox_y2 - +selected.bbox_y1) / imgNatural.h) * 100}%`,
                  }} />
              )}
            </div>
            {selected.has_video === "True" && (
              <video
                src={`${API}/api/feedback/${selected.case_id}/video/${selected.filename}`}
                controls
                className="w-full rounded-lg border border-gray-800"
              />
            )}
            <p className="text-xs text-gray-500">
              {new Date(+selected.timestamp * 1000).toLocaleString()}
              {" · "} {t("Case")}: <span className="font-mono">{selected.case_id}</span>
              {selected.noticed_first && <> {" · "} {noticedLabels[selected.noticed_first]}</>}
              {" · "}
              {hasBox ? t("Box: {x1},{y1} → {x2},{y2}", {
                x1: selected.bbox_x1, y1: selected.bbox_y1, x2: selected.bbox_x2, y2: selected.bbox_y2,
              }) : t("No box drawn")}
            </p>
            <p className="text-xs text-gray-500">
              {aiBoxes.length > 0
                ? t("AI detected {n} box(es) on this exact frame at capture time.", { n: aiBoxes.length })
                : t("AI detected nothing on this exact frame at capture time.")}
            </p>
            <button
              onClick={() => handleDelete(selected)}
              className="text-xs text-red-400 hover:text-red-300 transition-colors"
            >
              {t("Delete this capture")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
