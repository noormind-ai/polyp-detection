"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "@/lib/i18n";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8001";

interface Box { bbox: [number, number, number, number]; conf: number; }
interface Entry {
  case_id: string;
  filename: string;
  timestamp: string;
  status?: string;
  ai_detections: string;
  bbox_x1?: string;
  bbox_y1?: string;
  bbox_x2?: string;
  bbox_y2?: string;
}

type Kind = "pending" | "dr_found" | "false_positive";
type UserBox = [number, number, number, number];

function keyOf(kind: Kind, filename: string) { return `${kind}:${filename}`; }

function parseSavedBox(e: Entry): UserBox | null {
  const vals = [e.bbox_x1, e.bbox_y1, e.bbox_x2, e.bbox_y2];
  if (vals.some((v) => v === undefined || v === null || v === "")) return null;
  const nums = vals.map(Number);
  return nums.some(Number.isNaN) ? null : (nums as UserBox);
}

function isInsideBox(pt: [number, number], box: UserBox): boolean {
  const [x, y] = pt;
  const [x1, y1, x2, y2] = box;
  return x >= x1 && x <= x2 && y >= y1 && y <= y2;
}

function clampBox(b: UserBox, w: number, h: number): UserBox {
  let [x1, y1, x2, y2] = b;
  const bw = x2 - x1, bh = y2 - y1;
  if (x1 < 0) { x1 = 0; x2 = bw; }
  if (y1 < 0) { y1 = 0; y2 = bh; }
  if (x2 > w) { x2 = w; x1 = w - bw; }
  if (y2 > h) { y2 = h; y1 = h - bh; }
  return [x1, y1, x2, y2];
}

// Always-visible feedback panel — three bars of everything captured (AI-flagged
// needing a yes/no from staff; doctor-flagged frames the AI missed; and manually
// flagged false alarms), plus one inline review card (not a popup) that walks
// through them one at a time. Submitting/saving/deleting/skipping the current
// one auto-advances to the next so a nurse can work a whole queue without
// re-clicking a thumbnail each time.
export default function FeedbackPanel({ caseId, refreshSignal }: { caseId: string; refreshSignal?: number }) {
  const { t } = useLanguage();
  const [pending, setPending] = useState<Entry[]>([]);
  const [drFound, setDrFound] = useState<Entry[]>([]);
  const [falsePos, setFalsePos] = useState<Entry[]>([]);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [box, setBox] = useState<UserBox | null>(null);
  const [dragMode, setDragMode] = useState<"move" | "draw" | null>(null);
  const [dragStart, setDragStart] = useState<[number, number] | null>(null); // draw-mode anchor corner
  const [moveOffset, setMoveOffset] = useState<[number, number] | null>(null); // move-mode: cursor offset from box top-left
  const [imgNatural, setImgNatural] = useState({ w: 0, h: 0 });
  // dr_found/false_positive items never leave the backend queue just from being
  // looked at (no further "reviewed" status to move them to) — track locally
  // which ones the nurse already stepped past this session, so auto-advance
  // doesn't loop on the same one forever.
  const dismissedRef = useRef<Set<string>>(new Set());
  // The box a pending item's editable box STARTED at (the AI's own detection,
  // or null) — compared against the current box at submit time to flag
  // whether the nurse actually corrected it.
  const originalBoxRef = useRef<UserBox | null>(null);

  type Lists = { pending: Entry[]; drFound: Entry[]; falsePos: Entry[] };

  async function loadAll(): Promise<Lists> {
    try {
      const [q, d, f] = await Promise.all([
        fetch(`${API}/api/feedback/queue?case_id=${caseId}`).then((r) => r.json()),
        fetch(`${API}/api/feedback/list?status=dr_found&case_id=${caseId}`).then((r) => r.json()),
        fetch(`${API}/api/feedback/list?status=false_positive&case_id=${caseId}`).then((r) => r.json()),
      ]);
      setPending(q); setDrFound(d); setFalsePos(f);
      return { pending: q, drFound: d, falsePos: f };
    } catch {
      return { pending, drFound, falsePos };
    }
  }

  function pickNext(lists: Lists, excludeKey?: string): { kind: Kind; entry: Entry } | null {
    const p = lists.pending.filter((e) => keyOf("pending", e.filename) !== excludeKey);
    if (p.length) return { kind: "pending", entry: p[0] };
    const rest: Array<{ kind: Kind; entry: Entry }> = [
      ...lists.drFound.map((entry) => ({ kind: "dr_found" as Kind, entry })),
      ...lists.falsePos.map((entry) => ({ kind: "false_positive" as Kind, entry })),
    ]
      .filter(({ kind, entry }) => !dismissedRef.current.has(keyOf(kind, entry.filename)) && keyOf(kind, entry.filename) !== excludeKey)
      .sort((a, b) => Number(a.entry.timestamp || 0) - Number(b.entry.timestamp || 0));
    return rest.length ? rest[0] : null;
  }

  function stillPresent(lists: Lists, key: string): boolean {
    return lists.pending.some((e) => keyOf("pending", e.filename) === key)
      || lists.drFound.some((e) => keyOf("dr_found", e.filename) === key)
      || lists.falsePos.some((e) => keyOf("false_positive", e.filename) === key);
  }

  // Poll for new captures. Only auto-pick a "current" entry when there isn't
  // one yet, or the one showing was just removed elsewhere — never yank the
  // panel away from whatever the nurse is actively looking at.
  useEffect(() => {
    let alive = true;
    async function tick() {
      const lists = await loadAll();
      if (!alive) return;
      setCurrentKey((prev) => {
        if (prev && stillPresent(lists, prev)) return prev;
        const next = pickNext(lists);
        return next ? keyOf(next.kind, next.entry.filename) : null;
      });
    }
    tick();
    const iv = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  // A save/capture elsewhere in the app (auto-capture, manual dr-found/FP save)
  // bumps this — refresh right away instead of waiting for the next poll tick.
  useEffect(() => {
    if (refreshSignal === undefined) return;
    (async () => {
      const lists = await loadAll();
      setCurrentKey((prev) => {
        if (prev && stillPresent(lists, prev)) return prev;
        const next = pickNext(lists);
        return next ? keyOf(next.kind, next.entry.filename) : null;
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  const current = useMemo(() => {
    if (!currentKey) return null;
    const sep = currentKey.indexOf(":");
    const kind = currentKey.slice(0, sep) as Kind;
    const filename = currentKey.slice(sep + 1);
    const list = kind === "pending" ? pending : kind === "dr_found" ? drFound : falsePos;
    const entry = list.find((e) => e.filename === filename);
    return entry ? { kind, entry } : null;
  }, [currentKey, pending, drFound, falsePos]);

  const aiBoxes: Box[] = current ? (() => { try { return JSON.parse(current.entry.ai_detections || "[]"); } catch { return []; } })() : [];

  // Reset the edit box only when the SELECTED entry changes — not on every
  // poll refresh, which would otherwise wipe an in-progress edit every 5s.
  // For a pending (AI-detected) item there's no saved box yet — start the
  // editable box AT the AI's own first detection, so there's something to
  // confirm-or-correct rather than an empty frame; originalBoxRef records
  // that starting point so submitReview can tell whether the nurse actually
  // changed it.
  // Deliberately NOT resetting imgNatural here: the <img> node is reused across
  // entries (only its src changes), and its own onLoad race-loses against this
  // effect when the new image is cache-hot — resetting to 0 here would then
  // clobber the correct value onLoad just set, permanently hiding every box
  // overlay. Captured frames share one capture resolution, so the stale
  // dimensions from the previous entry are harmless for the instant before
  // the new onLoad fires anyway.
  useEffect(() => {
    setDragMode(null); setDragStart(null); setMoveOffset(null);
    let initial: UserBox | null = current ? parseSavedBox(current.entry) : null;
    if (current && current.kind === "pending" && !initial && aiBoxes.length > 0) {
      initial = [...aiBoxes[0].bbox];
    }
    setBox(initial);
    originalBoxRef.current = initial;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey]);

  function imgPos(e: React.MouseEvent<HTMLImageElement>): [number, number] {
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    const scaleX = imgNatural.w / rect.width, scaleY = imgNatural.h / rect.height;
    return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY];
  }
  // Shared by mousemove AND mouseup — resolving once more on release (using the
  // release event's own coordinates) means the box always lands exactly where
  // the cursor let go, even if the browser coalesced/dropped intermediate
  // mousemove events during a fast drag (it does this routinely).
  function applyDrag(pt: [number, number], mode: "move" | "draw", startBox: UserBox | null, offset: [number, number] | null, anchor: [number, number] | null) {
    if (mode === "move" && startBox && offset) {
      const w = startBox[2] - startBox[0], h = startBox[3] - startBox[1];
      const nx1 = pt[0] - offset[0], ny1 = pt[1] - offset[1];
      setBox(clampBox([nx1, ny1, nx1 + w, ny1 + h], imgNatural.w, imgNatural.h));
    } else if (mode === "draw" && anchor) {
      setBox([Math.min(anchor[0], pt[0]), Math.min(anchor[1], pt[1]), Math.max(anchor[0], pt[0]), Math.max(anchor[1], pt[1])]);
    }
  }
  function handleMouseDown(e: React.MouseEvent<HTMLImageElement>) {
    const pt = imgPos(e);
    if (box && isInsideBox(pt, box)) {
      setDragMode("move");
      setMoveOffset([pt[0] - box[0], pt[1] - box[1]]);
    } else {
      setDragMode("draw");
      setDragStart(pt);
      setBox(null);
    }
  }
  function handleMouseMove(e: React.MouseEvent<HTMLImageElement>) {
    if (!dragMode) return;
    applyDrag(imgPos(e), dragMode, box, moveOffset, dragStart);
  }
  function handleMouseUp(e: React.MouseEvent<HTMLImageElement>) {
    if (dragMode) applyDrag(imgPos(e), dragMode, box, moveOffset, dragStart);
    setDragMode(null); setDragStart(null); setMoveOffset(null);
  }

  async function advanceAfter(kind: Kind, filename: string) {
    if (kind !== "pending") dismissedRef.current.add(keyOf(kind, filename));
    const lists = await loadAll();
    const next = pickNext(lists, keyOf(kind, filename));
    setCurrentKey(next ? keyOf(next.kind, next.entry.filename) : null);
  }

  async function submitReview(correct: boolean, noticedFirst: "dr" | "ai") {
    if (!current || current.kind !== "pending") return;
    const rounded = box ? (box.map((n) => Math.round(n)) as UserBox) : null;
    const origRounded = originalBoxRef.current ? (originalBoxRef.current.map((n) => Math.round(n)) as UserBox) : null;
    const corrected = JSON.stringify(rounded) !== JSON.stringify(origRounded);
    const fd = new FormData();
    fd.append("correct", String(correct));
    fd.append("noticed_first", noticedFirst);
    fd.append("box_corrected", String(corrected));
    if (rounded) fd.append("bbox", JSON.stringify(rounded));
    await fetch(`${API}/api/feedback/${current.entry.case_id}/${current.entry.filename}/review`, { method: "POST", body: fd });
    await advanceAfter("pending", current.entry.filename);
  }

  // Box is optional here — saving with no box clears any previously saved one
  // (the backend's PATCH treats an absent bbox as "clear"), so this doubles as
  // the "remove the box" action, not just "add/adjust one".
  async function saveBox() {
    if (!current || current.kind === "pending") return;
    const fd = new FormData();
    if (box) fd.append("bbox", JSON.stringify(box.map((n) => Math.round(n))));
    await fetch(`${API}/api/feedback/${current.entry.case_id}/${current.entry.filename}`, { method: "PATCH", body: fd });
    await advanceAfter(current.kind, current.entry.filename);
  }

  function skip() {
    if (!current) return;
    advanceAfter(current.kind, current.entry.filename);
  }

  async function deleteCapture(kind: Kind, entry: Entry) {
    await fetch(`${API}/api/feedback/${entry.case_id}/${entry.filename}`, { method: "DELETE" });
    await advanceAfter(kind, entry.filename);
  }

  return (
    <div className="space-y-4 bg-gray-900/50 border border-gray-800 rounded-xl p-4">
      <Bar
        title={t("🤖 AI detected — needs review")}
        entries={pending}
        kind="pending"
        emptyText={t("Nothing yet.")}
        currentKey={currentKey}
        onOpen={(e) => setCurrentKey(keyOf("pending", e.filename))}
        onDelete={(e) => deleteCapture("pending", e)}
      />
      <Bar
        title={t("👁 Dr. found, AI missed")}
        entries={drFound}
        kind="dr_found"
        emptyText={t("Nothing yet.")}
        currentKey={currentKey}
        onOpen={(e) => setCurrentKey(keyOf("dr_found", e.filename))}
        onDelete={(e) => deleteCapture("dr_found", e)}
      />
      <Bar
        title={t("🚫 False positives")}
        entries={falsePos}
        kind="false_positive"
        emptyText={t("Nothing yet.")}
        currentKey={currentKey}
        onOpen={(e) => setCurrentKey(keyOf("false_positive", e.filename))}
        onDelete={(e) => deleteCapture("false_positive", e)}
      />

      <div className="border-t border-gray-800 pt-4">
        {!current ? (
          <p className="text-sm text-gray-500 text-center py-6">{t("✓ All caught up — nothing waiting for review.")}</p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-gray-300">
                {current.kind === "pending" ? t("Review AI detection") :
                  current.kind === "dr_found" ? t("Dr. found, AI missed") : t("False alarms")}
              </h3>
              <button onClick={skip} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">{t("Skip → next")}</button>
            </div>

            <div className="relative w-full max-w-xl mx-auto rounded-xl overflow-hidden border border-gray-800 bg-black">
              <img
                src={`${API}/api/feedback/${current.entry.case_id}/image/${current.entry.filename}`}
                alt=""
                draggable={false}
                className="w-full h-auto block cursor-crosshair select-none"
                onLoad={(e) => setImgNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                onDragStart={(e) => e.preventDefault()}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
              />
              {imgNatural.w > 0 && aiBoxes.map((b, i) => {
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

            <div className="text-xs text-gray-500 space-y-0.5">
              {aiBoxes.length > 0 && <p>{t("Green shows what the AI detected.")}</p>}
              <p>{t("Click inside the box to move it, or click empty space to draw a new one.")}</p>
            </div>
            {box && (
              <button onClick={() => setBox(null)} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">{t("Clear box")}</button>
            )}

            {current.kind === "pending" ? (
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
              <button onClick={saveBox} className="w-full py-2.5 bg-sky-600 hover:bg-sky-500 rounded-xl text-white font-medium text-sm transition-colors">
                {t("Save box")}
              </button>
            )}
            <button onClick={() => deleteCapture(current.kind, current.entry)} className="w-full text-xs text-red-400 hover:text-red-300 transition-colors py-1">
              {t("Delete this capture")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Bar({ title, entries, kind, emptyText, currentKey, onOpen, onDelete }: {
  title: string; entries: Entry[]; kind: Kind; emptyText: string; currentKey: string | null;
  onOpen: (e: Entry) => void; onDelete: (e: Entry) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-300 font-medium">{title} {entries.length > 0 && `(${entries.length})`}</p>
      {entries.length === 0 ? (
        <p className="text-xs text-gray-600">{emptyText}</p>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {entries.map((e) => {
            const isCurrent = currentKey === keyOf(kind, e.filename);
            return (
              <div key={e.filename} className="relative flex-shrink-0">
                <button
                  onClick={() => onOpen(e)}
                  className={`w-24 h-16 rounded-lg overflow-hidden border-2 transition-colors ${
                    isCurrent ? "border-blue-500" : "border-gray-800 hover:border-blue-500"
                  }`}
                >
                  <img src={`${API}/api/feedback/${e.case_id}/image/${e.filename}`} alt="" className="w-full h-full object-cover" />
                </button>
                <button
                  onClick={(ev) => { ev.stopPropagation(); onDelete(e); }}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-600 hover:bg-red-500 text-white text-xs leading-none flex items-center justify-center shadow"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
