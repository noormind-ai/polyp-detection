"use client";

import { memo, useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/lib/i18n";
import { fsBoxStyle } from "@/lib/useFullscreen";
import { mirrorLanguage } from "@/lib/useDoctorWindow";
import CaptureStrip, { StripChooser, type Shot, type StripPos,
         type StripReplay } from "./CaptureStrip";
import LatencyHud, { type LatencyStats } from "./LatencyHud";

export interface DoctorScreenProps {
  /** The popup this is portalled into. Every global in here is the OPENER's,
   *  so anything window- or document-shaped has to come through this. */
  win: Window;
  /** Getters, not values. The mirror loop runs at the doctor monitor's
   *  refresh rate; re-rendering this subtree to hand it a new canvas
   *  reference every inference frame would put the strip, the overlay and the
   *  HUD on the hot path for nothing. */
  mirrorSource: () => HTMLCanvasElement | null;
  generation: () => number;
  aspect: string;
  shots: Shot[];
  stripPos: StripPos;
  onStripPos: (p: StripPos) => void;
  stripSize: number;
  onStripSize: (n: number) => void;
  openShotId: string | null;
  onOpenShot: (id: string | null) => void;
  /** Lets the doctor window play forward from a capture, not just show it. */
  replay?: StripReplay;
  hudStats: LatencyStats;
  hudOn: boolean;
  /** The session ended but the window is deliberately left open -- see the
   *  note in LiveCameraPlayer. Shutting the doctor's monitor off mid-sentence
   *  is worse than a frozen last frame with a label on it. */
  stopped: boolean;
}

/** What the doctor's monitor shows: the annotated picture, the recent
 *  captures, and nothing else that is not asked for.
 *
 *  THE PICTURE IS A COPY, NOT THE ORIGINAL. <canvas ref={analyzedRef}> stays
 *  exactly where it is in the opener's tree and this draws its pixels into a
 *  second canvas each frame. Portalling the real panel across would reparent
 *  a ref'd element, React would remount it, and the capture loop would carry
 *  on drawing into a canvas nobody can see -- the failure this codebase
 *  already hit once with a "side by side" toggle (see the comment above
 *  detectedPanel, and lib/useFullscreen's header). */
function DoctorScreenInner({
  win, mirrorSource, generation, aspect, shots, stripPos, onStripPos,
  stripSize, onStripSize, openShotId, onOpenShot, hudStats, hudOn, stopped, replay,
}: DoctorScreenProps) {
  const { t, lang } = useLanguage();
  const [dst, setDst] = useState<HTMLCanvasElement | null>(null);
  const [full, setFull] = useState(false);

  useEffect(() => { mirrorLanguage(win, lang); }, [win, lang]);

  const goFullscreen = useCallback(() => {
    try {
      // Chrome's `fullscreen` window feature was an origin trial that was
      // abandoned in 2024, and window.open() consumes the opener's user
      // activation, so fullscreen cannot be chained onto the click that
      // created this window. One gesture in here is the only way.
      void win.document.documentElement.requestFullscreen?.();
    } catch { /* user will press it again */ }
  }, [win]);

  useEffect(() => {
    const sync = () => setFull(!!win.document.fullscreenElement);
    const onKey = (e: KeyboardEvent) => { if (e.key === "f" || e.key === "F") goFullscreen(); };
    win.document.addEventListener("fullscreenchange", sync);
    win.addEventListener("keydown", onKey);
    sync();
    return () => {
      win.document.removeEventListener("fullscreenchange", sync);
      win.removeEventListener("keydown", onKey);
    };
  }, [win, goFullscreen]);

  // The mirror. Driven by the POPUP's rAF, so it paces to the doctor
  // monitor's refresh rather than to the inference rate, and stops on its own
  // the moment that window goes away. It also means the mirror freezes while
  // the window is minimised or its display is asleep -- correct, but worth
  // knowing before someone reports it as a hang.
  useEffect(() => {
    if (!dst) return;
    let handle = 0;
    let lastGen = -1;
    const ctx = dst.getContext("2d");
    if (!ctx) return;
    const tick = () => {
      if (win.closed) return;
      const src = mirrorSource();
      const gen = generation();
      if (src && gen !== lastGen && src.width > 0 && src.height > 0) {
        try {
          if (dst.width !== src.width) dst.width = src.width;
          if (dst.height !== src.height) dst.height = src.height;
          ctx.drawImage(src, 0, 0);
          lastGen = gen;
        } catch {
          // A source canvas detached mid-teardown. Skipping this frame is the
          // whole recovery: the next one either works or the window is gone.
        }
      }
      handle = win.requestAnimationFrame(tick);
    };
    handle = win.requestAnimationFrame(tick);
    return () => { try { win.cancelAnimationFrame(handle); } catch { /* gone */ } };
  }, [dst, win, mirrorSource, generation]);

  return (
    <div className="fixed inset-0 bg-black flex items-center justify-center">
      {/* Same geometry the in-page fullscreen uses. 100vw/100vh inside this
          document are the popup's own viewport, which is exactly right. */}
      <div className="relative overflow-hidden bg-black" style={fsBoxStyle(aspect)}>
        <canvas ref={setDst} className="absolute inset-0 w-full h-full object-contain" />

        <CaptureStrip
          shots={shots}
          position={stripPos}
          openId={openShotId}
          onOpen={onOpenShot}
          onClose={() => onOpenShot(null)}
          size={stripSize}
          win={win}
          replay={replay}
        />
        <StripChooser position={stripPos} onChange={onStripPos}
                      size={stripSize} onSize={onStripSize} win={win} />
        {hudOn && <LatencyHud stats={hudStats} compact className="absolute top-3 start-3 z-40" />}

        {!full && (
          <button
            autoFocus
            onDoubleClick={goFullscreen}
            onClick={goFullscreen}
            className="absolute top-3 end-3 z-40 text-sm px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium shadow-lg"
          >
            {t("Full screen")}
          </button>
        )}

        {stopped && (
          <div className="absolute top-3 inset-x-0 z-30 flex justify-center pointer-events-none">
            <span className="text-xs px-3 py-1 rounded-md bg-black/80 border border-gray-600 text-gray-300">
              {t("Session stopped")}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Memoised because the opener re-renders on every inference reply (~12-20
 *  times a second) and this subtree has no reason to reconcile that often. */
const DoctorScreen = memo(DoctorScreenInner);
export default DoctorScreen;
