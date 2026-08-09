"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "@/lib/i18n";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8001";

interface Box { bbox: [number, number, number, number]; conf: number; }
interface Entry {
  case_id: string;
  filename: string;
  timestamp: string;
  status: string;
  ai_detections: string;
  bbox_x1?: string;
  bbox_y1?: string;
  bbox_x2?: string;
  bbox_y2?: string;
}

type UserBox = [number, number, number, number];

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

const byNewest = (a: Entry, b: Entry) => Number(b.timestamp || 0) - Number(a.timestamp || 0);

// Two fully independent lanes — separate queue, separate review window, no
// interaction between them. AI-detected: stable, oldest-first, a new capture
// never interrupts whatever's open. Dr-found: newest-first, a new capture
// always takes over its own window immediately (doctor-caught misses are
// urgent) — but this NEVER touches the AI-detected lane or vice versa.
export default function FeedbackPanel({ caseId, refreshSignal }: { caseId: string; refreshSignal?: number }) {
  const { t } = useLanguage();
  const [pending, setPending] = useState<Entry[]>([]);
  const [drFound, setDrFound] = useState<Entry[]>([]);
  const [reviewed, setReviewed] = useState<Entry[]>([]); // confirmed + false_positive (ex-pending)
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [drKey, setDrKey] = useState<string | null>(null);
  // dr_found items never leave the list just from being handled (no status
  // change) — dismissing moves one from the active bar to the reviewed one.
  const dismissedRef = useRef<Set<string>>(new Set());
  // Skip doesn't change anything server-side, so without this a skipped
  // pending item would just resurface on the very next poll (still oldest).
  const dismissedPendingRef = useRef<Set<string>>(new Set());
  const seenDrRef = useRef<Set<string>>(new Set());
  const hasLoadedRef = useRef(false);

  type Lists = { pending: Entry[]; drFound: Entry[]; reviewed: Entry[] };

  async function loadAll(): Promise<Lists> {
    try {
      const [q, rest]: [Entry[], Entry[]] = await Promise.all([
        fetch(`${API}/api/feedback/queue?case_id=${caseId}`).then((r) => r.json()),
        fetch(`${API}/api/feedback/list?case_id=${caseId}`).then((r) => r.json()),
      ]);
      const dr: Entry[] = rest.filter((e: Entry) => e.status === "dr_found");
      const rev: Entry[] = rest.filter((e: Entry) => e.status !== "dr_found");
      setPending(q); setDrFound(dr); setReviewed(rev);
      return { pending: q, drFound: dr, reviewed: rev };
    } catch {
      return { pending, drFound, reviewed };
    }
  }

  function reconcilePending(pendingList: Entry[], reviewedList: Entry[]) {
    setPendingKey((prev) => {
      if (prev && (pendingList.some((e) => e.filename === prev) || reviewedList.some((e) => e.filename === prev))) return prev;
      return pendingList.find((e) => !dismissedPendingRef.current.has(e.filename))?.filename ?? null;
    });
  }

  function reconcileDrFound(drList: Entry[]) {
    const active = drList.filter((e) => !dismissedRef.current.has(e.filename));
    if (!hasLoadedRef.current) {
      active.forEach((e) => seenDrRef.current.add(e.filename));
      hasLoadedRef.current = true;
      setDrKey((prev) => {
        if (prev && drList.some((e) => e.filename === prev)) return prev;
        return [...active].sort(byNewest)[0]?.filename ?? null;
      });
      return;
    }
    const fresh = active.filter((e) => !seenDrRef.current.has(e.filename));
    fresh.forEach((e) => seenDrRef.current.add(e.filename));
    if (fresh.length > 0) {
      setDrKey(fresh.sort(byNewest)[0].filename); // a new capture always takes over this window
      return;
    }
    setDrKey((prev) => {
      if (prev && drList.some((e) => e.filename === prev)) return prev;
      return [...active].sort(byNewest)[0]?.filename ?? null;
    });
  }

  useEffect(() => {
    let alive = true;
    async function tick() {
      const lists = await loadAll();
      if (!alive) return;
      reconcilePending(lists.pending, lists.reviewed);
      reconcileDrFound(lists.drFound);
    }
    tick();
    const iv = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  useEffect(() => {
    if (refreshSignal === undefined) return;
    (async () => {
      const lists = await loadAll();
      reconcilePending(lists.pending, lists.reviewed);
      reconcileDrFound(lists.drFound);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  const pendingCurrent = useMemo(
    () => [...pending, ...reviewed].find((e) => e.filename === pendingKey) ?? null,
    [pendingKey, pending, reviewed],
  );
  const drCurrent = useMemo(() => drFound.find((e) => e.filename === drKey) ?? null, [drKey, drFound]);

  async function advancePending(entry: Entry, dismiss = false) {
    if (dismiss) dismissedPendingRef.current.add(entry.filename);
    const lists = await loadAll();
    setPendingKey((prev) => {
      const stillOpenElsewhere = prev && prev !== entry.filename
        && (lists.pending.some((e) => e.filename === prev) || lists.reviewed.some((e) => e.filename === prev))
        && !dismissedPendingRef.current.has(prev);
      if (stillOpenElsewhere) return prev;
      return lists.pending.find((e) => !dismissedPendingRef.current.has(e.filename) && e.filename !== entry.filename)?.filename ?? null;
    });
  }

  async function advanceDrFound(entry: Entry, dismiss: boolean) {
    if (dismiss) dismissedRef.current.add(entry.filename);
    const lists = await loadAll();
    setDrKey((prev) => {
      const stillOpenElsewhere = prev && prev !== entry.filename
        && lists.drFound.some((e) => e.filename === prev) && !dismissedRef.current.has(prev);
      if (stillOpenElsewhere) return prev;
      const active = lists.drFound.filter((e) => !dismissedRef.current.has(e.filename) && e.filename !== entry.filename);
      return [...active].sort(byNewest)[0]?.filename ?? null;
    });
  }

  async function submitReview(entry: Entry, correct: boolean, box: UserBox | null, corrected: boolean) {
    const fd = new FormData();
    fd.append("correct", String(correct));
    fd.append("noticed_first", "ai");
    fd.append("box_corrected", String(corrected));
    if (box) fd.append("bbox", JSON.stringify(box.map((n) => Math.round(n))));
    await fetch(`${API}/api/feedback/${entry.case_id}/${entry.filename}/review`, { method: "POST", body: fd });
    await advancePending(entry);
  }

  async function saveDrFoundBox(entry: Entry, box: UserBox | null) {
    const fd = new FormData();
    if (box) fd.append("bbox", JSON.stringify(box.map((n) => Math.round(n))));
    await fetch(`${API}/api/feedback/${entry.case_id}/${entry.filename}`, { method: "PATCH", body: fd });
    await advanceDrFound(entry, true);
  }

  async function deleteCapture(entry: Entry, lane: "pending" | "dr_found") {
    await fetch(`${API}/api/feedback/${entry.case_id}/${entry.filename}`, { method: "DELETE" });
    if (lane === "pending") await advancePending(entry, true);
    else await advanceDrFound(entry, true);
  }

  const reviewedDrFound = drFound.filter((e) => dismissedRef.current.has(e.filename));

  return (
    <div className="space-y-5">
      <Lane
        title={t("🤖 AI detected")}
        activeEntries={pending}
        current={pendingCurrent}
        onOpen={(e) => setPendingKey(e.filename)}
        onDelete={(e) => deleteCapture(e, "pending")}
        onSkip={(e) => advancePending(e, true)}
        renderActions={(entry, box, corrected) => (
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => submitReview(entry, true, box, corrected)} className="py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-white font-medium text-sm transition-colors">
              {t("✓ Confirm polyp")}
            </button>
            <button onClick={() => submitReview(entry, false, box, corrected)} className="py-2.5 bg-amber-600 hover:bg-amber-500 rounded-xl text-white font-medium text-sm transition-colors">
              {t("✗ Not a polyp")}
            </button>
          </div>
        )}
        reviewedTitle={t("Already reviewed")}
        reviewedEntries={reviewed}
        onOpenReviewed={(e) => setPendingKey(e.filename)}
      />

      <Lane
        title={t("👁 Dr. found, AI missed")}
        activeEntries={drFound.filter((e) => !dismissedRef.current.has(e.filename))}
        current={drCurrent}
        onOpen={(e) => setDrKey(e.filename)}
        onDelete={(e) => deleteCapture(e, "dr_found")}
        onSkip={(e) => advanceDrFound(e, true)}
        renderActions={(entry, box) => (
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => saveDrFoundBox(entry, box)} className="py-2.5 bg-sky-600 hover:bg-sky-500 rounded-xl text-white font-medium text-sm transition-colors">
              {t("💾 Save")}
            </button>
            <button onClick={() => deleteCapture(entry, "dr_found")} className="py-2.5 bg-gray-800 hover:bg-gray-700 rounded-xl text-red-400 font-medium text-sm transition-colors">
              {t("🗑 Discard")}
            </button>
          </div>
        )}
        reviewedTitle={t("Already reviewed")}
        reviewedEntries={reviewedDrFound}
        onOpenReviewed={(e) => setDrKey(e.filename)}
      />
    </div>
  );
}

// One self-contained lane: bar of active thumbnails, its own review card
// (with its own box-editing state), and a reviewed-history bar underneath.
function Lane({
  title, activeEntries, current, onOpen, onDelete, onSkip, renderActions, reviewedTitle, reviewedEntries, onOpenReviewed,
}: {
  title: string;
  activeEntries: Entry[];
  current: Entry | null;
  onOpen: (e: Entry) => void;
  onDelete: (e: Entry) => void;
  onSkip: (e: Entry) => void;
  renderActions: (entry: Entry, box: UserBox | null, corrected: boolean) => React.ReactNode;
  reviewedTitle: string;
  reviewedEntries: Entry[];
  onOpenReviewed: (e: Entry) => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="space-y-4 bg-gray-900/50 border border-gray-800 rounded-xl p-4">
      <Bar title={title} entries={activeEntries} emptyText={t("Nothing yet.")} currentFilename={current?.filename ?? null} onOpen={onOpen} onDelete={onDelete} />

      <div className="border-t border-gray-800 pt-4">
        {current ? (
          <ReviewCard entry={current} onSkip={() => onSkip(current)} renderActions={renderActions} />
        ) : (
          <p className="text-sm text-gray-500 text-center py-6">{t("✓ All caught up")}</p>
        )}
      </div>

      {reviewedEntries.length > 0 && (
        <div className="border-t border-gray-800 pt-3 space-y-2">
          <p className="text-xs text-gray-500 uppercase tracking-wide">{reviewedTitle}</p>
          <Bar title="" entries={reviewedEntries} emptyText="" currentFilename={current?.filename ?? null} onOpen={onOpenReviewed} onDelete={onDelete} />
        </div>
      )}
    </div>
  );
}

// The image + editable box + action buttons for whichever entry is current in
// its lane. Owns its own box-editing state so the two lanes never interfere.
function ReviewCard({ entry, onSkip, renderActions }: {
  entry: Entry;
  onSkip: () => void;
  renderActions: (entry: Entry, box: UserBox | null, corrected: boolean) => React.ReactNode;
}) {
  const { t } = useLanguage();
  const [box, setBox] = useState<UserBox | null>(null);
  const [dragMode, setDragMode] = useState<"move" | "draw" | null>(null);
  const [dragStart, setDragStart] = useState<[number, number] | null>(null);
  const [moveOffset, setMoveOffset] = useState<[number, number] | null>(null);
  const [imgNatural, setImgNatural] = useState({ w: 0, h: 0 });
  const originalBoxRef = useRef<UserBox | null>(null);

  const aiBoxes: Box[] = useMemo(() => { try { return JSON.parse(entry.ai_detections || "[]"); } catch { return []; } }, [entry.ai_detections]);

  // Reset only when the entry itself changes — not on re-renders from polling.
  useEffect(() => {
    setDragMode(null); setDragStart(null); setMoveOffset(null);
    let initial = parseSavedBox(entry);
    if (entry.status === "pending" && !initial && aiBoxes.length > 0) initial = [...aiBoxes[0].bbox];
    setBox(initial);
    originalBoxRef.current = initial;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.filename]);

  function imgPos(e: React.MouseEvent<HTMLImageElement>): [number, number] {
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    const scaleX = imgNatural.w / rect.width, scaleY = imgNatural.h / rect.height;
    return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY];
  }
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

  const rounded = box ? (box.map((n) => Math.round(n)) as UserBox) : null;
  const origRounded = originalBoxRef.current ? (originalBoxRef.current.map((n) => Math.round(n)) as UserBox) : null;
  const corrected = JSON.stringify(rounded) !== JSON.stringify(origRounded);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <button onClick={onSkip} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">{t("Skip → next")}</button>
      </div>

      <div className="relative w-full max-w-xl mx-auto rounded-xl overflow-hidden border border-gray-800 bg-black">
        <img
          src={`${API}/api/feedback/${entry.case_id}/image/${entry.filename}`}
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
              style={{ left: `${x1 * scaleX}%`, top: `${y1 * scaleY}%`, width: `${(x2 - x1) * scaleX}%`, height: `${(y2 - y1) * scaleY}%` }} />
          );
        })}
        {rounded && imgNatural.w > 0 && (() => {
          const [x1, y1, x2, y2] = rounded;
          const scaleX = 100 / imgNatural.w, scaleY = 100 / imgNatural.h;
          return (
            <div className="absolute border-2 border-red-500 pointer-events-none"
              style={{ left: `${x1 * scaleX}%`, top: `${y1 * scaleY}%`, width: `${(x2 - x1) * scaleX}%`, height: `${(y2 - y1) * scaleY}%` }} />
          );
        })()}
      </div>

      {renderActions(entry, rounded, corrected)}
    </div>
  );
}

function Bar({ title, entries, emptyText, currentFilename, onOpen, onDelete }: {
  title: string; entries: Entry[]; emptyText: string; currentFilename: string | null;
  onOpen: (e: Entry) => void; onDelete: (e: Entry) => void;
}) {
  return (
    <div className="space-y-2">
      {title && <p className="text-sm text-gray-300 font-medium">{title} {entries.length > 0 && `(${entries.length})`}</p>}
      {entries.length === 0 ? (
        emptyText && <p className="text-xs text-gray-600">{emptyText}</p>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {entries.map((e) => {
            const isCurrent = currentFilename === e.filename;
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
