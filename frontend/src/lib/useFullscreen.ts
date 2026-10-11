import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

/** Put one video panel on the whole screen and bring it back.
 *
 *  The native Fullscreen API is the primary path on purpose: fullscreening an
 *  element leaves it exactly where it sits in the DOM, so the <video> holding
 *  the MediaStream and the <canvas> the capture loop draws into are never
 *  reparented. Reparenting a ref'd element makes React remount it and destroys
 *  the attached stream -- see the comment above detectedPanel/livePanel in
 *  LiveCameraPlayer for the earlier "side by side" toggle that did exactly
 *  that and hung the capture loop. The CSS fallback below is the same element
 *  with different classes, so it keeps that property too.
 *
 *  Escape-to-exit is free on the native path; the fallback binds its own key
 *  listener so both behave identically. */
export function useFullscreen() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [native, setNative] = useState(false);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    const doc = document as FsDocument;
    // Listened for on document rather than the element: an exit can come from
    // anywhere (Escape, F11, another panel taking the screen) and this panel's
    // flag has to clear even when it was not the one that asked.
    const sync = () => {
      const current = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
      setNative(!!ref.current && current === ref.current);
    };
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);

  // Fallback only -- the native path already closes on Escape, and binding
  // this unconditionally would race it.
  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPinned(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinned]);

  const toggle = useCallback(() => {
    const el = ref.current as FsElement | null;
    if (!el) return;
    const doc = document as FsDocument;
    const current = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;

    if (current === el) {
      const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
      if (exit) Promise.resolve(exit.call(doc)).catch(() => setNative(false));
      return;
    }
    if (pinned) { setPinned(false); return; }

    const req = el.requestFullscreen ?? el.webkitRequestFullscreen;
    // No element-level fullscreen (iOS Safari allows it on <video> only), a
    // stale gesture, or an iframe without allow="fullscreen": cover the
    // viewport with CSS instead. A button that silently does nothing is worse.
    if (!req) { setPinned(true); return; }
    Promise.resolve(req.call(el)).catch(() => setPinned(true));
  }, [pinned]);

  return { ref, active: native || pinned, toggle };
}

/** Classes for the panel's show/hide wrapper while it owns the screen. One
 *  string covers both paths: on the native path the UA has already sized the
 *  element to the display and these are redundant-but-harmless; on the
 *  fallback path they are what does the covering. */
export const fsWrapClass = "fixed inset-0 z-50 bg-black flex items-center justify-center";

export const fsExitBtnClass =
  "absolute top-3 right-3 z-10 text-xs px-2.5 py-1 rounded-md bg-black/70 backdrop-blur-sm " +
  "border border-gray-600 text-gray-200 hover:bg-black hover:text-white transition-colors";

/** Size the panel box to the largest rectangle with the frame's own aspect
 *  ratio that still fits the screen, centred by the wrapper's flex.
 *
 *  Not simply "fill the screen": every child in these panels is positioned as
 *  a *fraction of this box* -- the Live panel's crop zoom (liveStyle's
 *  100/cropW widths and negative offsets) and the FOV overlay rectangle both
 *  assume box ratio == frame ratio, and letterboxing the box against a
 *  differently-shaped display silently misframes both. `ratio` is the same
 *  "W/H" string the panel already carries in aspectRatio. 100vw/100vh are
 *  exact units here because the wrapper is the whole screen. */
export function fsBoxStyle(ratio: string): CSSProperties {
  const [w, h] = ratio.split("/").map(Number);
  if (!w || !h) return { aspectRatio: ratio };
  return {
    aspectRatio: ratio,
    width: `min(100vw, calc(100vh * ${(w / h).toFixed(6)}))`,
    height: `min(100vh, calc(100vw * ${(h / w).toFixed(6)}))`,
  };
}
