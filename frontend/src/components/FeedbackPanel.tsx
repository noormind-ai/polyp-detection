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
type Lists = { pending: Entry[]; drFound: Entry[]; reviewed: Entry[] };

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

// Two active queues (drive the review card) + one "already reviewed" history
// split the same way. A brand new dr-found capture always jumps to the front
// (FILO — newest reviewed first, then whatever it interrupted). Nothing else
// steals focus from whatever the nurse is currently looking at.
export default function FeedbackPanel({ caseId, refreshSignal }: { caseId: string; refreshSignal?: number }) {
  const { t } = useLanguage();
  const [pending, setPending] = useState<Entry[]>([]);
  const [drFound, setDrFound] = useState<Entry[]>([]);
  const [reviewed, setReviewed] = useState<Entry[]>([]); // confirmed + false_positive (former pending, resolved)
  const [currentKey, setCurrentKey] = useState<string | null>(null); // filename
  const [box, setBox] = useState<UserBox | null>(null);
  const [dragMode, setDragMode] = useState<"move" | "draw" | null>(null);
  const [dragStart, setDragStart] = useState<[number, number] | null>(null); // draw-mode anchor corner
  const [moveOffset, setMoveOffset] = useState<[number, number] | null>(null); // move-mode: cursor offset from box top-left
  const [imgNatural, setImgNatural] = useState({ w: 0, h: 0 });
  // dr_found items never leave the drFound list just from being handled (no
  // status change) — once "saved"/"discarded"/skipped, mark it dismissed so
  // it moves from the active bar into the reviewed one instead of resurfacing.
  const dismissedRef = useRef<Set<string>>(new Set());
  // Filenames (pending or dr_found) we've already seen — lets a genuinely NEW
  // capture be told apart from "same list, routine poll" so only real new
  // arrivals interrupt the current review. Covers both kinds: the nurse wants
  // the review window to always show whichever image was captured most
  // recently, AI-detected or doctor-found alike.
  const seenRef = useRef<Set<string>>(new Set());
  const hasLoadedRef = useRef(false);
  // The box a pending item's editable box STARTED at (the AI's own detection,
  // or null) — compared against the current box at submit time to flag
  // whether the nurse actually corrected it.
  const originalBoxRef = useRef<UserBox | null>(null);

  async function loadAll(): Promise<Lists> {
    try {
      const [q, rest] = await Promise.all([
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

  // Priority: an active (not-yet-dismissed) dr-found capture always outranks
  // a pending AI detection, newest dr-found first.
  function pickNext(lists: Lists, excludeFilename?: string): Entry | null {
    const dr = lists.drFound
      .filter((e) => !dismissedRef.current.has(e.filename) && e.filename !== excludeFilename)
      .sort(byNewest);
    if (dr.length) return dr[0];
    const p = lists.pending.filter((e) => e.filename !== excludeFilename);
    if (p.length) return p[0];
    return null;
  }

  function stillPresent(lists: Lists, filename: string): boolean {
    return lists.pending.some((e) => e.filename === filename)
      || lists.drFound.some((e) => e.filename === filename)
      || lists.reviewed.some((e) => e.filename === filename);
  }

  async function reconcile(lists: Lists) {
    const active = [...lists.pending, ...lists.drFound.filter((e) => !dismissedRef.current.has(e.filename))];
    if (!hasLoadedRef.current) {
      active.forEach((e) => seenRef.current.add(e.filename));
      hasLoadedRef.current = true;
      setCurrentKey((prev) => {
        if (prev && stillPresent(lists, prev)) return prev;
        const next = pickNext(lists);
        return next ? next.filename : null;
      });
      return;
    }
    const fresh = active.filter((e) => !seenRef.current.has(e.filename));
    fresh.forEach((e) => seenRef.current.add(e.filename));
    if (fresh.length > 0) {
      setCurrentKey(fresh.sort(byNewest)[0].filename); // interrupt — always the latest capture wins
      return;
    }
    setCurrentKey((prev) => {
      if (prev && stillPresent(lists, prev)) return prev;
      const next = pickNext(lists);
      return next ? next.filename : null;
    });
  }

  // Poll for new captures.
  useEffect(() => {
    let alive = true;
    async function tick() {
      const lists = await loadAll();
      if (!alive) return;
      await reconcile(lists);
    }
    tick();
    const iv = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  // A capture elsewhere in the app bumps this — refresh right away instead of
  // waiting for the next poll tick.
  useEffect(() => {
    if (refreshSignal === undefined) return;
    (async () => {
      const lists = await loadAll();
      await reconcile(lists);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  const current = useMemo(() => {
    if (!currentKey) return null;
    return [...pending, ...drFound, ...reviewed].find((e) => e.filename === currentKey) ?? null;
  }, [currentKey, pending, drFound, reviewed]);

  const aiBoxes: Box[] = current ? (() => { try { return JSON.parse(current.ai_detections || "[]"); } catch { return []; } })() : [];

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
    let initial: UserBox | null = current ? parseSavedBox(current) : null;
    if (current && current.status === "pending" && !initial && aiBoxes.length > 0) {
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

  async function advanceAfter(entry: Entry) {
    if (entry.status === "dr_found") dismissedRef.current.add(entry.filename);
    const lists = await loadAll();
    const next = pickNext(lists, entry.filename);
    setCurrentKey(next ? next.filename : null);
  }

  // noticed_first is always "ai" here — this queue only ever holds frames the
  // AI itself flagged, so the AI is definitionally what triggered the capture.
  async function submitReview(correct: boolean) {
    if (!current || current.status !== "pending") return;
    const rounded = box ? (box.map((n) => Math.round(n)) as UserBox) : null;
    const origRounded = originalBoxRef.current ? (originalBoxRef.current.map((n) => Math.round(n)) as UserBox) : null;
    const corrected = JSON.stringify(rounded) !== JSON.stringify(origRounded);
    const fd = new FormData();
    fd.append("correct", String(correct));
    fd.append("noticed_first", "ai");
    fd.append("box_corrected", String(corrected));
    if (rounded) fd.append("bbox", JSON.stringify(rounded));
    await fetch(`${API}/api/feedback/${current.case_id}/${current.filename}/review`, { method: "POST", body: fd });
    await advanceAfter(current);
  }

  // Box is optional — saving with none clears any previously saved one (the
  // backend's PATCH treats an absent bbox as "clear").
  async function saveBox() {
    if (!current || current.status === "pending") return;
    const fd = new FormData();
    if (box) fd.append("bbox", JSON.stringify(box.map((n) => Math.round(n))));
    await fetch(`${API}/api/feedback/${current.case_id}/${current.filename}`, { method: "PATCH", body: fd });
    await advanceAfter(current);
  }

  function skip() {
    if (!current) return;
    advanceAfter(current);
  }

  async function deleteCapture(entry: Entry) {
    await fetch(`${API}/api/feedback/${entry.case_id}/${entry.filename}`, { method: "DELETE" });
    await advanceAfter(entry);
  }

  const activeDrFound = drFound.filter((e) => !dismissedRef.current.has(e.filename));
  const reviewedDrFound = drFound.filter((e) => dismissedRef.current.has(e.filename));

  return (
    <div className="space-y-4 bg-gray-900/50 border border-gray-800 rounded-xl p-4">
      <Bar
        title={t("🤖 AI detected")}
        entries={pending}
        emptyText={t("Nothing yet.")}
        currentKey={currentKey}
        onOpen={(e) => setCurrentKey(e.filename)}
        onDelete={deleteCapture}
      />
      <Bar
        title={t("👁 Dr. found, AI missed")}
        entries={activeDrFound}
        emptyText={t("Nothing yet.")}
        currentKey={currentKey}
        onOpen={(e) => setCurrentKey(e.filename)}
        onDelete={deleteCapture}
      />

      <div className="border-t border-gray-800 pt-4">
        {!current ? (
          <p className="text-sm text-gray-500 text-center py-6">{t("✓ All caught up")}</p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-end">
              <button onClick={skip} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">{t("Skip → next")}</button>
            </div>

            <div className="relative w-full max-w-xl mx-auto rounded-xl overflow-hidden border border-gray-800 bg-black">
              <img
                src={`${API}/api/feedback/${current.case_id}/image/${current.filename}`}
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
              {box && imgNatural.w > 0 && (() => {
                const [x1, y1, x2, y2] = box;
                const scaleX = 100 / imgNatural.w, scaleY = 100 / imgNatural.h;
                return (
                  <div className="absolute border-2 border-red-500 pointer-events-none"
                    style={{ left: `${x1 * scaleX}%`, top: `${y1 * scaleY}%`, width: `${(x2 - x1) * scaleX}%`, height: `${(y2 - y1) * scaleY}%` }} />
                );
              })()}
            </div>

            {current.status === "pending" ? (
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => submitReview(true)} className="py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-white font-medium text-sm transition-colors">
                  {t("✓ Confirm polyp")}
                </button>
                <button onClick={() => submitReview(false)} className="py-2.5 bg-amber-600 hover:bg-amber-500 rounded-xl text-white font-medium text-sm transition-colors">
                  {t("✗ Not a polyp")}
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <button onClick={saveBox} className="py-2.5 bg-sky-600 hover:bg-sky-500 rounded-xl text-white font-medium text-sm transition-colors">
                  {t("💾 Save")}
                </button>
                <button onClick={() => deleteCapture(current)} className="py-2.5 bg-gray-800 hover:bg-gray-700 rounded-xl text-red-400 font-medium text-sm transition-colors">
                  {t("🗑 Discard")}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-gray-800 pt-4 space-y-3">
        <p className="text-xs text-gray-500 uppercase tracking-wide">{t("Already reviewed")}</p>
        <Bar
          title={t("🤖 AI detected")}
          entries={reviewed}
          emptyText={t("Nothing yet.")}
          currentKey={currentKey}
          onOpen={(e) => setCurrentKey(e.filename)}
          onDelete={deleteCapture}
        />
        <Bar
          title={t("👁 Dr. found, AI missed")}
          entries={reviewedDrFound}
          emptyText={t("Nothing yet.")}
          currentKey={currentKey}
          onOpen={(e) => setCurrentKey(e.filename)}
          onDelete={deleteCapture}
        />
      </div>
    </div>
  );
}

function Bar({ title, entries, emptyText, currentKey, onOpen, onDelete }: {
  title: string; entries: Entry[]; emptyText: string; currentKey: string | null;
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
            const isCurrent = currentKey === e.filename;
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
