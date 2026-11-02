"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from "@/lib/i18n";
import { indexOfSeq, type RingFrame } from "@/lib/frameRing";

/**
 * Motion, in the same box the review still normally occupies.
 *
 * Plays the frames the model scored, with its boxes drawn on them -- which is
 * the thing a session recording could never provide, since that holds raw video
 * with no detections. Playback is driven frame by frame, dwelling on each for
 * the real gap to the next one (clamped, so a stalled uplink replays as a pause
 * rather than a freeze), so the position reported upward is always a true
 * moment in the procedure.
 *
 * THE CURSOR IS A `seq`, NOT AN INDEX. The store thins itself when it hits its
 * ceiling -- it halves the density of the older half -- so the array gets
 * SHORTER and every index after the thinned region shifts. An index-based
 * cursor survived that by accident for a while and then stopped dead: the first
 * version also only adopted the new array when it had grown, so one thinning
 * pass left it holding a stale snapshot forever, which it played to the end of
 * and then stopped. That is what "it stops after a few minutes" was.
 *
 * `getFrames` is a getter rather than a prop array on purpose: it reads the
 * store live, so following the live edge keeps working as the procedure goes
 * on, and a growing store does not churn this component's props.
 */

const SPEEDS = [0.25, 0.5, 1, 2, 4];
/** A gap longer than this replays as this -- a dead link should not look like
 *  a frozen picture. */
const MAX_DWELL_MS = 500;
const MIN_DWELL_MS = 20;
/** How often to look for a newer frame once playback has caught up to live.
 *  Reaching "now" is not the end of anything: the procedure is still going. */
const FOLLOW_POLL_MS = 250;

export default function ReplaySurface({
  getFrames, startAtMs, onPos, onExit,
}: {
  getFrames: () => RingFrame[];
  /** Where to open. Changing this re-arms the surface. */
  startAtMs: number;
  /** The true moment now on screen, for the timeline's playhead. */
  onPos: (atMs: number) => void;
  /** Back to the captured still, where the review buttons live. */
  onExit: () => void;
}) {
  const { t } = useLanguage();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [caughtUp, setCaughtUp] = useState(false);
  const [empty, setEmpty] = useState(false);

  // The cursor lives in a ref as a seq: playback must not re-render this
  // component once per frame, and the timer callback needs the current value
  // rather than whatever it was when the effect ran.
  const seqRef = useRef(-1);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speedRef = useRef(speed);
  useEffect(() => { speedRef.current = speed; }, [speed]);
  const onPosRef = useRef(onPos);
  useEffect(() => { onPosRef.current = onPos; }, [onPos]);
  const getFramesRef = useRef(getFrames);
  useEffect(() => { getFramesRef.current = getFrames; }, [getFrames]);

  const drawingRef = useRef(false);
  const drawnSeqRef = useRef(-1);

  const draw = useCallback(async (f: RingFrame) => {
    const canvas = canvasRef.current;
    // One decode in flight at a time. A frame that cannot be decoded before the
    // next is due is skipped, never queued -- the alternative is a backlog that
    // keeps decoding long after the operator has moved on.
    if (!canvas || drawingRef.current || drawnSeqRef.current === f.seq) return;
    drawingRef.current = true;
    try {
      const bmp = await createImageBitmap(f.jpeg);
      if (canvas.width !== f.w || canvas.height !== f.h) { canvas.width = f.w; canvas.height = f.h; }
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(bmp, 0, 0);
        ctx.lineWidth = Math.max(2, Math.round(f.w / 240));
        ctx.strokeStyle = "#39ff14";
        ctx.fillStyle = "#39ff14";
        ctx.font = `${Math.max(11, Math.round(f.w / 30))}px ui-monospace, monospace`;
        for (const b of f.boxes) {
          const [x1, y1, x2, y2] = b.bbox;
          ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
          ctx.fillText(`${Math.round(b.conf * 100)}%`, x1, Math.max(12, y1 - 4));
        }
      }
      bmp.close();
      drawnSeqRef.current = f.seq;
    } catch { /* an undecodable frame is skipped, not fatal */ }
    drawingRef.current = false;
  }, []);

  /** Put frame `i` of `frames` on screen and remember it by seq. */
  const show = useCallback((frames: RingFrame[], i: number) => {
    if (i < 0 || i >= frames.length) return;
    seqRef.current = frames[i].seq;
    onPosRef.current(frames[i].atMs);
    void draw(frames[i]);
  }, [draw]);

  // Arm: find where startAtMs lands and show it.
  useEffect(() => {
    const frames = getFramesRef.current();
    if (frames.length === 0) { setEmpty(true); return; }
    setEmpty(false);
    setCaughtUp(false);
    let i = frames.findIndex((f) => f.atMs >= startAtMs);
    if (i < 0) i = frames.length - 1;
    drawnSeqRef.current = -1;
    show(frames, i);
    setPlaying(true);
  }, [startAtMs, show]);

  // The clock. One rescheduling timer rather than requestAnimationFrame,
  // because the dwell on each frame is the real gap to the next one and varies.
  useEffect(() => {
    if (!playing || empty) return;
    let cancelled = false;

    const step = () => {
      if (cancelled) return;
      // Always adopt the current array. It can be SHORTER than last time --
      // see the note on thinning at the top of this file.
      const frames = getFramesRef.current();
      if (frames.length === 0) { timerRef.current = setTimeout(step, FOLLOW_POLL_MS); return; }

      const here = indexOfSeq(frames, seqRef.current);
      // Every held frame is older than the cursor: the store was cleared under
      // us (a new patient). Nothing sensible to play.
      if (here < 0) { setCaughtUp(true); timerRef.current = setTimeout(step, FOLLOW_POLL_MS); return; }

      // If that frame is still ours, advance past it; if it was thinned away,
      // the one we landed on IS the next frame.
      const next = frames[here].seq === seqRef.current ? here + 1 : here;

      if (next >= frames.length) {
        // Caught up to live. Not an ending -- the procedure is still running,
        // so keep looking for the next frame instead of stopping dead.
        setCaughtUp(true);
        timerRef.current = setTimeout(step, FOLLOW_POLL_MS);
        return;
      }

      setCaughtUp(false);
      const prevAt = frames[Math.max(0, next - 1)].atMs;
      const dwell = Math.min(MAX_DWELL_MS, Math.max(MIN_DWELL_MS, frames[next].atMs - prevAt))
                    / speedRef.current;
      timerRef.current = setTimeout(() => { show(frames, next); step(); }, dwell);
    };
    step();

    return () => {
      cancelled = true;
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    };
  }, [playing, empty, show]);

  const stepBy = useCallback((d: -1 | 1) => {
    setPlaying(false);
    setCaughtUp(false);
    const frames = getFramesRef.current();
    const here = indexOfSeq(frames, seqRef.current);
    if (here < 0) return;
    show(frames, Math.max(0, Math.min(frames.length - 1, here + d)));
  }, [show]);

  const nudge = useCallback((ms: number) => {
    setPlaying(false);
    setCaughtUp(false);
    const frames = getFramesRef.current();
    const here = indexOfSeq(frames, seqRef.current);
    if (here < 0) return;
    const target = frames[here].atMs + ms;
    let i = frames.findIndex((f) => f.atMs >= target);
    if (i < 0) i = frames.length - 1;
    show(frames, i);
  }, [show]);

  const transportBtn = "px-2.5 py-1 rounded-md bg-gray-800 hover:bg-gray-700 text-gray-300 font-mono transition-colors";
  const chip = "text-xs px-2 py-0.5 rounded-md border border-gray-800 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors";

  return (
    <div className="space-y-2">
      <div className="relative w-full rounded-xl overflow-hidden border border-gray-800 bg-black">
        <canvas ref={canvasRef} className="w-full h-auto block" />
        {empty && (
          <p className="absolute inset-0 flex items-center justify-center text-xs text-gray-400 text-center px-4">
            {t("No video is held for that moment — only the captured frame.")}
          </p>
        )}
      </div>

      {/* dir=ltr: the signs carry the direction, not the page. */}
      <div dir="ltr" className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
        <button onClick={() => setPlaying((p) => !p)} className={transportBtn}>
          {playing ? "⏸" : "▶"}
        </button>
        <button onClick={() => stepBy(-1)} className={transportBtn} title={t("One frame back")}>{"◀|"}</button>
        <button onClick={() => stepBy(1)} className={transportBtn} title={t("One frame forward")}>{"|▶"}</button>
        <button onClick={() => nudge(-3000)} className={transportBtn}>{"−3s"}</button>
        <button onClick={() => nudge(-1000)} className={transportBtn}>{"−1s"}</button>
        {SPEEDS.map((s) => (
          <button
            key={s}
            onClick={() => setSpeed(s)}
            className={`px-2 py-1 rounded-md font-mono transition-colors ${
              speed === s ? "bg-green-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
            }`}
          >
            {s}x
          </button>
        ))}
        <span className="flex-1" />
        {playing && caughtUp && (
          <span className="text-gray-400 font-mono" title={t("Following the live view")}>
            {t("· live")}
          </span>
        )}
        <button onClick={onExit} className={chip}>{t("← Back to the captured frame")}</button>
      </div>
    </div>
  );
}
