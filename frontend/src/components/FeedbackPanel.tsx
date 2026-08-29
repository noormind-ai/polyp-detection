"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "@/lib/i18n";

const API = process.env.NEXT_PUBLIC_API_URL || "";

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
  recording_id?: string;
  video_offset_ms?: string;
}

/** Position of this frame inside the session recording, as mm:ss. Captures no
 *  longer carry their own clip — this is how a reviewer finds the moment in the
 *  full recording instead. */
function offsetLabel(e: Entry): string | null {
  const ms = Number(e.video_offset_ms);
  if (!e.video_offset_ms || Number.isNaN(ms)) return null;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
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

// One merged review lane, newest first.
//
// This replaced two independent lanes -- AI-detected and Dr-found -- which
// showed the same kind of thing, split the available width in half, and meant
// the newest capture could be in either column. Each card still carries the
// actions belonging to its own kind, so nothing that could be done before is
// gone; only the two windows became one.
//
// A newly-arrived capture takes over the open card. Both lanes already did that
// separately, so merging does not introduce it -- and the strip above keeps the
// older ones one click away.
export default function FeedbackPanel({ caseId, refreshSignal }: { caseId: string; refreshSignal?: number }) {
  const { t } = useLanguage();
  const [pending, setPending] = useState<Entry[]>([]);
  const [drFound, setDrFound] = useState<Entry[]>([]);
  const [reviewed, setReviewed] = useState<Entry[]>([]); // confirmed + false_positive (ex-pending)
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  // Filenames are unique across both kinds, so one dismissed set covers both.
  // A dr_found item never changes status server-side, so dismissing is the only
  // thing that moves it from the active strip to the reviewed one; a skipped
  // pending item would otherwise resurface on the very next poll.
  const dismissedRef = useRef<Set<string>>(new Set());
  const seenRef = useRef<Set<string>>(new Set());
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

  function reconcile(lists: Lists) {
    const active = [...lists.pending, ...lists.drFound]
      .filter((e) => !dismissedRef.current.has(e.filename));
    const newest = () => [...active].sort(byNewest)[0]?.filename ?? null;
    const stillValid = (k: string) =>
      active.some((e) => e.filename === k) || lists.reviewed.some((e) => e.filename === k);

    if (!hasLoadedRef.current) {
      active.forEach((e) => seenRef.current.add(e.filename));
      hasLoadedRef.current = true;
      setCurrentKey((prev) => (prev && stillValid(prev) ? prev : newest()));
      return;
    }

    const fresh = active.filter((e) => !seenRef.current.has(e.filename));
    fresh.forEach((e) => seenRef.current.add(e.filename));
    if (fresh.length > 0) {
      setCurrentKey(fresh.sort(byNewest)[0].filename);
      return;
    }
    setCurrentKey((prev) => (prev && stillValid(prev) ? prev : newest()));
  }

  useEffect(() => {
    let alive = true;
    async function tick() {
      const lists = await loadAll();
      if (!alive) return;
      reconcile(lists);
    }
    tick();
    const iv = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  useEffect(() => {
    if (refreshSignal === undefined) return;
    (async () => reconcile(await loadAll()))();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  // Computed inline rather than memoised: dismissal happens through a ref, which
  // a dependency array cannot see, and these lists are tens of items at most.
  const activeEntries = [...pending, ...drFound]
    .filter((e) => !dismissedRef.current.has(e.filename))
    .sort(byNewest);
  const reviewedEntries = [...reviewed, ...drFound.filter((e) => dismissedRef.current.has(e.filename))]
    .sort(byNewest);
  const current = [...pending, ...drFound, ...reviewed]
    .find((e) => e.filename === currentKey) ?? null;

  /** Moves off `entry`, unless something else is open and still valid. */
  async function advance(entry: Entry, dismiss: boolean) {
    if (dismiss) dismissedRef.current.add(entry.filename);
    const lists = await loadAll();
    setCurrentKey((prev) => {
      const pool = [...lists.pending, ...lists.drFound]
        .filter((e) => !dismissedRef.current.has(e.filename));
      const stillOpenElsewhere = prev && prev !== entry.filename
        && (pool.some((e) => e.filename === prev) || lists.reviewed.some((e) => e.filename === prev));
      if (stillOpenElsewhere) return prev;
      return pool.filter((e) => e.filename !== entry.filename).sort(byNewest)[0]?.filename ?? null;
    });
  }

  async function submitReview(entry: Entry, correct: boolean, box: UserBox | null, corrected: boolean) {
    const fd = new FormData();
    fd.append("correct", String(correct));
    fd.append("noticed_first", "ai");
    fd.append("box_corrected", String(corrected));
    if (box) fd.append("bbox", JSON.stringify(box.map((n) => Math.round(n))));
    await fetch(`${API}/api/feedback/${entry.case_id}/${entry.filename}/review`, { method: "POST", body: fd });
    // The server changes its status, so it leaves the queue on its own.
    await advance(entry, false);
  }

  async function saveDrFoundBox(entry: Entry, box: UserBox | null) {
    const fd = new FormData();
    if (box) fd.append("bbox", JSON.stringify(box.map((n) => Math.round(n))));
    await fetch(`${API}/api/feedback/${entry.case_id}/${entry.filename}`, { method: "PATCH", body: fd });
    await advance(entry, true);
  }

  async function deleteCapture(entry: Entry) {
    await fetch(`${API}/api/feedback/${entry.case_id}/${entry.filename}`, { method: "DELETE" });
    await advance(entry, true);
  }

  return (
    <Lane
      title={t("Review · newest first")}
      activeEntries={activeEntries}
      current={current}
      onOpen={(e) => setCurrentKey(e.filename)}
      onDelete={deleteCapture}
      onSkip={(e) => advance(e, true)}
      renderActions={(entry, box, corrected) =>
        entry.status === "dr_found" ? (
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => saveDrFoundBox(entry, box)} className="py-2.5 bg-sky-600 hover:bg-sky-500 rounded-xl text-white font-medium text-sm transition-colors">
              {t("💾 Save")}
            </button>
            <button onClick={() => deleteCapture(entry)} className="py-2.5 bg-gray-800 hover:bg-gray-700 rounded-xl text-red-400 font-medium text-sm transition-colors">
              {t("🗑 Discard")}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => submitReview(entry, true, box, corrected)} className="py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-white font-medium text-sm transition-colors">
              {t("✓ Confirm polyp")}
            </button>
            <button onClick={() => submitReview(entry, false, box, corrected)} className="py-2.5 bg-amber-600 hover:bg-amber-500 rounded-xl text-white font-medium text-sm transition-colors">
              {t("✗ Not a polyp")}
            </button>
          </div>
        )
      }
      reviewedTitle={t("Already reviewed")}
      reviewedEntries={reviewedEntries}
      onOpenReviewed={(e) => setCurrentKey(e.filename)}
    />
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
    <div className="space-y-3 bg-gray-900/50 border border-gray-800 rounded-xl p-3">
      <p className="text-sm text-gray-300 font-medium">{title}</p>

      {current ? (
        <ReviewCard entry={current} onSkip={() => onSkip(current)} renderActions={renderActions} />
      ) : (
        <p className="text-sm text-gray-500 text-center py-6">{t("✓ All caught up")}</p>
      )}

      <div className="border-t border-gray-800 pt-3">
        <Bar title={t("Queue")} entries={activeEntries} emptyText={t("Nothing yet.")} currentFilename={current?.filename ?? null} onOpen={onOpen} onDelete={onDelete} />
      </div>

      {reviewedEntries.length > 0 && (
        <div className="border-t border-gray-800 pt-3 space-y-2">
          <Bar title={reviewedTitle} entries={reviewedEntries} emptyText="" currentFilename={current?.filename ?? null} onOpen={onOpenReviewed} onDelete={onDelete} />
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
      <div className="flex items-center justify-between gap-2">
        {offsetLabel(entry)
          ? <span className="text-xs text-gray-500 font-mono" title={t("Position in the session recording")}>
              🎞 {offsetLabel(entry)}
            </span>
          : <span />}
        <button onClick={onSkip} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">{t("Skip → next")}</button>
      </div>

      {/* Fills the lane, no width cap — the captured frame has the same ratio as
          the live video, so at equal column widths it renders at the same size. */}
      <div className="relative w-full rounded-xl overflow-hidden border border-gray-800 bg-black">
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
                  {/* The merged strip mixes both kinds; without this the only
                      way to tell them apart is to open the card. */}
                  <span className={`absolute bottom-0 inset-x-0 text-[9px] leading-tight text-white text-center ${
                    e.status === "dr_found" ? "bg-sky-600/90" : "bg-emerald-700/90"
                  }`}>
                    {e.status === "dr_found" ? "Dr" : "AI"}
                  </span>
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
