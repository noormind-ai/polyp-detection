"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "@/lib/i18n";
import { features, explain } from "@/lib/inBody";
import ScoreChips from "./ScoreChips";
import SessionTimeline, { type Spot, type SpotState } from "./SessionTimeline";
import ReplaySurface from "./ReplaySurface";
import type { RingFrame } from "@/lib/frameRing";

/** Everything the live player has to lend this panel for the timeline to
 *  exist: how long the procedure is, how far back there is video for, where a
 *  given capture sits on that axis, and the frames themselves.
 *
 *  Optional, and absent on purpose for the spectator page and the standalone
 *  feedback mode -- neither has a frame store, so neither gets a bar. They keep
 *  the thumbnail strips instead. */
export interface TimelineSource {
  totalMs: number;
  /** Oldest moment with video. Spots before it still open their still frame. */
  playableFromMs: number;
  atMsOf: (e: { filename: string; timestamp: string }) => number | null;
  getFrames: () => RingFrame[];
}

function parseBoxes(raw?: string): Box[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as Box[]) : [];
  } catch { return []; }
}

function bestConf(e: Entry): number {
  let best = 0;
  for (const b of parseBoxes(e.ai_detections)) if (b.conf > best) best = b.conf;
  return best;
}

function spotState(e: Entry): SpotState {
  if (e.status === "dr_found") return "dr";
  if (e.status === "pending") return "pending";
  if (e.status === "confirmed") return "confirmed";
  return "rejected";
}

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
  /** "" until the recording covering this capture finishes and a clip-cut is
   *  attempted, "ready" once servable, "failed" if ffmpeg couldn't produce
   *  one -- either way offsetLabel() below is still shown as a fallback. */
  review_clip_status?: string;
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
export default function FeedbackPanel({ caseId, refreshSignal, timeline }: {
  caseId: string;
  refreshSignal?: number;
  timeline?: TimelineSource;
}) {
  const { t } = useLanguage();
  const [pending, setPending] = useState<Entry[]>([]);
  const [drFound, setDrFound] = useState<Entry[]>([]);
  const [reviewed, setReviewed] = useState<Entry[]>([]);
  // Noise experiment: one question per pass. Asking "is it a polyp" and "is
  // it readable" in the same sitting is exactly how the clinical panel ended
  // up with a `noisy` label that means five different things.
  const [noiseMode, setNoiseMode] = useState(false);
  useEffect(() => {
    setNoiseMode(window.localStorage.getItem("polyp_noise_mode") === "on");
  }, []);
  function toggleNoiseMode() {
    setNoiseMode((v) => {
      window.localStorage.setItem("polyp_noise_mode", v ? "off" : "on");
      return !v;
    });
  } // confirmed + false_positive (ex-pending)
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

  // noticedFirst defaults to "ai" for the auto-capture flow; dr_found review
  // passes "dr" explicitly -- same verdict, same endpoint, just recording who
  // actually spotted it first, which is the whole reason noticed_first exists.
  async function submitReview(entry: Entry, correct: boolean, box: UserBox | null, corrected: boolean,
                              morphology?: "flat", noticedFirst: "ai" | "dr" = "ai") {
    const fd = new FormData();
    fd.append("correct", String(correct));
    fd.append("noticed_first", noticedFirst);
    fd.append("box_corrected", String(corrected));
    if (box) fd.append("bbox", JSON.stringify(box.map((n) => Math.round(n))));
    if (morphology) fd.append("morphology", morphology);
    await fetch(`${API}/api/feedback/${entry.case_id}/${entry.filename}/review`, { method: "POST", body: fd });
    // The server changes its status, so it leaves the queue on its own.
    await advance(entry, false);
  }

  /** Records what the frame is, rather than whether its box was a polyp. */
  async function labelFrame(entry: Entry, label: "out_of_body" | "noisy" | "clean") {
    const fd = new FormData();
    fd.append("label", label);
    await fetch(`${API}/api/feedback/${entry.case_id}/${entry.filename}/label`,
                { method: "POST", body: fd });
    await advance(entry, true);
  }

  async function deleteCapture(entry: Entry) {
    await fetch(`${API}/api/feedback/${entry.case_id}/${entry.filename}`, { method: "DELETE" });
    await advance(entry, true);
  }

  // The switch rides in the lane title so it is visible without opening
  // anything: which question this pass is answering has to be obvious, or
  // half the labels end up answering the other one.
  const laneTitle = (
    <span data-testid="noise-mode-switch" className="flex items-center justify-between gap-2 w-full">
      <span>{noiseMode ? t("Noise experiment · noisy vs not") : t("Review · newest first")}</span>
      <button
        onClick={toggleNoiseMode}
        className={`text-xs px-2 py-0.5 rounded-md border transition-colors ${
          noiseMode
            ? "border-orange-700/60 bg-orange-900/40 text-orange-300"
            : "border-gray-800 text-gray-500 hover:text-gray-300 hover:border-gray-600"
        }`}
      >
        {noiseMode ? t("Noise mode: on") : t("Noise mode: off")}
      </button>
    </span>
  );

  return (
    <Lane
      title={laneTitle}
      timeline={timeline}
      activeEntries={activeEntries}
      current={current}
      onOpen={(e) => setCurrentKey(e.filename)}
      onDelete={deleteCapture}
      onSkip={(e) => advance(e, true)}
      renderActions={(entry, box, corrected) => (
        <div className="space-y-2">
        {entry.status === "dr_found" ? (
          // Same verdict options as an auto-capture review -- a dr_found
          // capture still needs someone to confirm it's genuinely a polyp
          // (and note morphology) before it means anything for reporting;
          // noticed_first="dr" is the only thing that differs from the AI
          // flow below. Discard stays as the "I flagged this by mistake" exit.
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => submitReview(entry, true, box, corrected, undefined, "dr")} className="py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-white font-medium text-sm transition-colors">
                {t("✓ Confirm polyp")}
              </button>
              <button onClick={() => submitReview(entry, false, box, corrected, undefined, "dr")} className="py-2.5 bg-amber-600 hover:bg-amber-500 rounded-xl text-white font-medium text-sm transition-colors">
                {t("✗ Not a polyp")}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => submitReview(entry, true, box, corrected, "flat", "dr")} className="py-2 bg-gray-800 hover:bg-gray-700 rounded-xl text-sky-300 font-medium text-xs transition-colors">
                {t("▭ Flat lesion")}
              </button>
              <button onClick={() => deleteCapture(entry)} className="py-2 bg-gray-800 hover:bg-gray-700 rounded-xl text-red-400 font-medium text-xs transition-colors">
                {t("🗑 Discard")}
              </button>
            </div>
          </div>
        ) : noiseMode ? null : (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => submitReview(entry, true, box, corrected)} className="py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-white font-medium text-sm transition-colors">
                {t("✓ Confirm polyp")}
              </button>
              <button onClick={() => submitReview(entry, false, box, corrected)} className="py-2.5 bg-amber-600 hover:bg-amber-500 rounded-xl text-white font-medium text-sm transition-colors">
                {t("✗ Not a polyp")}
              </button>
            </div>
            {/* Still a confirmed polyp -- just morphology, not a third verdict --
                so this stays visually secondary to the two buttons above it. */}
            <button onClick={() => submitReview(entry, true, box, corrected, "flat")} className="w-full py-2 bg-gray-800 hover:bg-gray-700 rounded-xl text-sky-300 font-medium text-xs transition-colors">
              {t("▭ Flat lesion")}
            </button>
          </div>
        )}

          {noiseMode ? (
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => labelFrame(entry, "noisy")} className="py-3 bg-orange-600 hover:bg-orange-500 rounded-xl text-white font-semibold text-sm transition-colors">
                {t("🌫 Noisy")}
              </button>
              <button onClick={() => labelFrame(entry, "clean")} className="py-3 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-white font-semibold text-sm transition-colors">
                {t("✓ Not noisy")}
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => labelFrame(entry, "out_of_body")} className="py-2 bg-gray-800 hover:bg-gray-700 rounded-xl text-amber-300 font-medium text-xs transition-colors">
                {t("🚫 Out of body")}
              </button>
              <button onClick={() => labelFrame(entry, "noisy")} className="py-2 bg-gray-800 hover:bg-gray-700 rounded-xl text-orange-300 font-medium text-xs transition-colors">
                {t("🌫 Too noisy")}
              </button>
            </div>
          )}
        </div>
      )}
      reviewedTitle={t("Already reviewed")}
      reviewedEntries={reviewedEntries}
      onOpenReviewed={(e) => setCurrentKey(e.filename)}
    />
  );
}

// One self-contained lane: bar of active thumbnails, its own review card
// (with its own box-editing state), and a reviewed-history bar underneath.
function Lane({
  title, timeline, activeEntries, current, onOpen, onDelete, onSkip, renderActions, reviewedTitle, reviewedEntries, onOpenReviewed,
}: {
  title: React.ReactNode;
  timeline?: TimelineSource;
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

  // Every capture, as a spot on the procedure's own timeline. This is what
  // replaces the thumbnail strips below when a timeline is available: a spot
  // says WHEN, which is the question actually being asked in the room.
  const all = [...activeEntries, ...reviewedEntries];
  const spots: Spot[] = timeline
    ? all.flatMap((e) => {
        const atMs = timeline.atMsOf(e);
        return atMs === null ? [] : [{ id: e.filename, atMs, state: spotState(e), conf: bestConf(e) }];
      })
    : [];
  const selectSpot = (id: string) => {
    const hit = activeEntries.find((e) => e.filename === id);
    if (hit) { onOpen(hit); return; }
    const old = reviewedEntries.find((e) => e.filename === id);
    if (old) onOpenReviewed(old);
  };

  return (
    <div className="space-y-3 bg-gray-900/50 border border-gray-800 rounded-xl p-3">
      <div className="text-sm text-gray-300 font-medium">{title}</div>

      {current ? (
        <ReviewCard
          entry={current}
          onSkip={() => onSkip(current)}
          renderActions={renderActions}
          timeline={timeline}
          spots={spots}
          onSelectSpot={selectSpot}
        />
      ) : (
        <p className="text-sm text-gray-500 text-center py-6">{t("✓ All caught up")}</p>
      )}

      {/* The strips are what the spots replace. Kept for the views that have no
          timeline to replace them with -- the spectator page and the
          standalone feedback mode, neither of which holds any frames. */}
      {!timeline && (
        <div className="border-t border-gray-800 pt-3">
          <Bar title={t("Queue")} entries={activeEntries} emptyText={t("Nothing yet.")} currentFilename={current?.filename ?? null} onOpen={onOpen} onDelete={onDelete} />
        </div>
      )}

      {!timeline && reviewedEntries.length > 0 && (
        <div className="border-t border-gray-800 pt-3 space-y-2">
          <Bar title={reviewedTitle} entries={reviewedEntries} emptyText="" currentFilename={current?.filename ?? null} onOpen={onOpenReviewed} onDelete={onDelete} />
        </div>
      )}
    </div>
  );
}

// The image + editable box + action buttons for whichever entry is current in
// its lane. Owns its own box-editing state so the two lanes never interfere.
function ReviewCard({ entry, onSkip, renderActions, timeline, spots, onSelectSpot }: {
  entry: Entry;
  onSkip: () => void;
  renderActions: (entry: Entry, box: UserBox | null, corrected: boolean) => React.ReactNode;
  timeline?: TimelineSource;
  spots: Spot[];
  onSelectSpot: (id: string) => void;
}) {
  const { t } = useLanguage();
  // Null means the captured still is showing -- which is the frame the review
  // buttons below apply to. A number means motion is playing from that moment.
  const [playFromMs, setPlayFromMs] = useState<number | null>(null);
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);
  const selfAtMs = timeline ? timeline.atMsOf(entry) : null;
  // A newly arrived capture takes over this card. Drop out of motion when it
  // does: the buttons underneath would now refer to a different frame than the
  // one on screen, which is how someone confirms the wrong thing.
  useEffect(() => { setPlayFromMs(null); setPlayheadMs(null); }, [entry.filename]);
  const [box, setBox] = useState<UserBox | null>(null);
  const [dragMode, setDragMode] = useState<"move" | "draw" | null>(null);
  const [dragStart, setDragStart] = useState<[number, number] | null>(null);
  const [moveOffset, setMoveOffset] = useState<[number, number] | null>(null);
  const [imgNatural, setImgNatural] = useState({ w: 0, h: 0 });
  // What the out-of-body gate makes of this filed frame. Computed here rather
  // than stored at capture time so old captures get it too, and so it always
  // reflects the gate as it is now rather than as it was that day.
  const [gateScore, setGateScore] = useState<ReturnType<typeof explain> | null>(null);
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
        <div className="flex items-center gap-2 min-w-0">
          {/* Review happens inside the full session recording now, not in a
              separate cut-out: "Play from here" below opens the recording at
              this frame's own offset. The server no longer cuts the little
              per-capture clips (see routes/recordings.py), and recordings are
              remuxed with a real duration and cue index, so seeking straight
              to the moment works instead of needing a whole-file scan. */}
          {offsetLabel(entry) ? (
            <span className="text-xs text-gray-500 font-mono" title={t("Position in the session recording")}>
              🎞 {offsetLabel(entry)}
            </span>
          ) : <span />}
        </div>
        <button onClick={onSkip} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">{t("Skip → next")}</button>
      </div>

      {/* One media box, two states. Motion and the captured still share it
          rather than sitting in separate panels -- the still IS a moment on the
          bar below, so splitting them into two surfaces made one thing look
          like two. */}
      {playFromMs !== null && timeline ? (
        <ReplaySurface
          getFrames={timeline.getFrames}
          startAtMs={playFromMs}
          onPos={setPlayheadMs}
          onExit={() => { setPlayFromMs(null); setPlayheadMs(null); }}
        />
      ) : (
      <div className="relative w-full rounded-xl overflow-hidden border border-gray-800 bg-black">
        <img
          src={`${API}/api/feedback/${entry.case_id}/image/${entry.filename}`}
          alt=""
          draggable={false}
          className="w-full h-auto block cursor-crosshair select-none"
          onLoad={(e) => {
            const img = e.currentTarget;
            setImgNatural({ w: img.naturalWidth, h: img.naturalHeight });
            // Same-origin, so the canvas stays readable.
            try {
              const c = document.createElement("canvas");
              c.width = img.naturalWidth;
              c.height = img.naturalHeight;
              c.getContext("2d")!.drawImage(img, 0, 0);
              const f = features(c);
              setGateScore(f ? explain(f) : null);
            } catch {
              setGateScore(null);
            }
          }}
          onDragStart={(e) => e.preventDefault()}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        />
        {imgNatural.w > 0 && aiBoxes.map((b, i) => {
          const [x1, y1, x2, y2] = b.bbox;
          const scaleX = 100 / imgNatural.w, scaleY = 100 / imgNatural.h;
          // The model's confidence on this box, in the same neon-green badge the
          // live view burns in (lib/drawBoxes.ts) -- so a reviewer reads the same
          // number, in the same place, that the room saw during the procedure.
          // It was always stored (ai_detections carries conf per box); only the
          // panel never drew it, so a reviewer was judging a box with no idea
          // whether the model was at 32% or 95% on it.
          //
          // Sits above the box, and flips to inside the top edge when the box is
          // too close to the top of the frame for the badge to fit -- a polyp at
          // the very top of the picture is common, and a label clipped off the
          // image is the same as no label.
          const labelInside = y1 * scaleY < 7;
          return (
            <div key={i} className="absolute border-2 border-[#39ff14] pointer-events-none"
              style={{ left: `${x1 * scaleX}%`, top: `${y1 * scaleY}%`, width: `${(x2 - x1) * scaleX}%`, height: `${(y2 - y1) * scaleY}%` }}>
              <span
                className="absolute left-0 bg-[#39ff14] text-black font-mono font-bold text-[11px] leading-none px-1 py-0.5 whitespace-nowrap"
                style={labelInside ? { top: 0 } : { bottom: "100%" }}>
                {t("polyp  {conf}%", { conf: Math.round(b.conf * 100) })}
              </span>
            </div>
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
      )}

      {timeline && (
        <div className="space-y-1.5">
          <SessionTimeline
            totalMs={timeline.totalMs}
            playableFromMs={timeline.playableFromMs}
            spots={spots}
            selectedId={entry.filename}
            playheadMs={playFromMs !== null ? playheadMs : selfAtMs}
            onSelectSpot={(id) => { setPlayFromMs(null); setPlayheadMs(null); onSelectSpot(id); }}
            onSeek={(atMs) => setPlayFromMs(atMs)}
          />
          {playFromMs === null && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <button
                onClick={() => selfAtMs !== null && setPlayFromMs(Math.max(0, selfAtMs - 3000))}
                disabled={selfAtMs === null}
                title={t("Play from a few seconds before this frame, forward to now")}
                className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                  selfAtMs === null
                    ? "bg-gray-800 text-gray-600 cursor-not-allowed"
                    : "bg-blue-600 hover:bg-blue-500 text-white"
                }`}
              >
                {t("▶ Play from here")}
              </button>
              {spots.length > 1 && (
                <button
                  onClick={() => {
                    const newest = spots.reduce((a, b) => (b.atMs > a.atMs ? b : a));
                    onSelectSpot(newest.id);
                  }}
                  className="px-2.5 py-1 rounded-md border border-gray-800 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
                >
                  {t("Latest detection")}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {gateScore && (
        <ScoreChips
          terms={gateScore.terms}
          z={gateScore.z}
          p={gateScore.p}
          tooDark={gateScore.tooDark}
          note={t("still image, so no motion")}
        />
      )}

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
