"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/* The Window Management API is not in TypeScript's lib.dom yet, so the shapes
 * this file relies on are declared here rather than loosened with `any`. */
declare global {
  interface ScreenDetailed extends Screen {
    availLeft: number;
    availTop: number;
    left: number;
    top: number;
    isPrimary: boolean;
    isInternal: boolean;
    label: string;
    devicePixelRatio: number;
  }
  interface ScreenDetails extends EventTarget {
    screens: ScreenDetailed[];
    currentScreen: ScreenDetailed;
    onscreenschange: ((this: ScreenDetails, ev: Event) => unknown) | null;
  }
  interface Window {
    getScreenDetails?: () => Promise<ScreenDetails>;
  }
  interface Screen {
    isExtended?: boolean;
  }
}

export interface DoctorDisplay {
  index: number;
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
  isPrimary: boolean;
  isInternal: boolean;
  isCurrent: boolean;
}

/** Can this browser put a window on a display of the user's choosing?
 *
 *  Chrome and Edge can, behind the window-management permission; Firefox and
 *  Safari cannot and never prompt. Checked before anything is rendered,
 *  because offering a display picker that silently places every window on the
 *  current screen is worse than not offering one. */
export function canPlaceWindows(): boolean {
  return typeof window !== "undefined" && typeof window.getScreenDetails === "function";
}

/** More than one display attached? Needs no permission, so it is safe to call
 *  on every render and use to decide whether the picker is worth showing. */
export function hasSecondDisplay(): boolean {
  return typeof window !== "undefined" && window.screen?.isExtended === true;
}

export type DisplayPermission = "granted" | "prompt" | "denied" | "unsupported";

/** The permission state WITHOUT prompting. Firefox and Safari throw TypeError
 *  on an unknown permission name rather than returning anything, hence the
 *  try/catch -- this must never be the thing that breaks the page. */
export async function displayPermission(): Promise<DisplayPermission> {
  if (!canPlaceWindows()) return "unsupported";
  try {
    const st = await navigator.permissions.query({ name: "window-management" as PermissionName });
    return st.state as DisplayPermission;
  } catch {
    return "prompt";
  }
}

/** Enumerate the attached displays. PROMPTS on first call, so it must be
 *  reached from a user gesture. Resolves to null when the API is missing or
 *  the user said no -- both of which are ordinary, handled outcomes. */
export async function listDisplays(): Promise<DoctorDisplay[] | null> {
  if (!canPlaceWindows()) return null;
  let details: ScreenDetails;
  try {
    details = await window.getScreenDetails!();
  } catch {
    return null; // dismissed or denied; the caller falls back to a plain popup
  }
  return details.screens.map((s, i) => ({
    index: i,
    // The label is usually an empty string unless the permission has been
    // granted AND the OS exposes a monitor name, so it can never be the only
    // thing distinguishing two entries.
    label: s.label || "",
    left: s.availLeft,
    top: s.availTop,
    width: s.availWidth,
    height: s.availHeight,
    isPrimary: s.isPrimary,
    isInternal: s.isInternal,
    isCurrent: s === details.currentScreen,
  }));
}

/** Call `onChange` when a monitor is plugged in or pulled out.
 *
 *  Only ever called after listDisplays has succeeded, so the permission is
 *  already granted and this cannot prompt. Worth having: Chrome relocates a
 *  popup whose display disappears, and a doctor window that silently moved is
 *  better reported than discovered. */
export async function watchDisplays(onChange: () => void): Promise<() => void> {
  if (!canPlaceWindows()) return () => {};
  try {
    const details = await window.getScreenDetails!();
    details.addEventListener("screenschange", onChange);
    return () => details.removeEventListener("screenschange", onChange);
  } catch {
    return () => {};
  }
}

/** Which display to offer first: the one that is neither this window's nor
 *  the built-in panel, i.e. the external monitor the doctor is looking at. */
export function suggestDisplay(displays: DoctorDisplay[]): DoctorDisplay | null {
  return (
    displays.find((d) => !d.isCurrent && !d.isInternal) ??
    displays.find((d) => !d.isCurrent) ??
    displays[0] ??
    null
  );
}

export type DoctorWindowError = "blocked" | null;

/** Everything about owning a second browser window, minus any UI.
 *
 *  The window is a bare about:blank that this hook furnishes, not a second
 *  copy of the app: the caller renders into it with createPortal, so there is
 *  one React tree, one WebSocket and one source of state. A second route
 *  would mean a second inference session, which is the opposite of what a
 *  presenter view is for.
 *
 *  about:blank inherits the opener's origin, so the stylesheets, canvases and
 *  object URLs of the main document are all reachable from inside it. */
export function useDoctorWindow() {
  const winRef = useRef<Window | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Rendering the portal is gated on this rather than on winRef, because a
  // ref change does not re-render and a portal into a container React no
  // longer owns throws on unmount.
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<DoctorWindowError>(null);

  const teardown = useCallback(() => {
    // State first and synchronously: React has to unmount the portal children
    // while the container document is still alive and still ours.
    setReady(false);
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    const w = winRef.current;
    winRef.current = null;
    try { if (w && !w.closed) w.close(); } catch { /* already gone */ }
  }, []);

  const open = useCallback((placement?: { left: number; top: number; width: number; height: number }) => {
    if (winRef.current && !winRef.current.closed) { winRef.current.focus(); return; }
    const feat = placement
      // left/top across a screen boundary are honoured only once
      // window-management has been granted; without it Chrome clamps the
      // popup back onto the current display. That clamping is the whole
      // reason the permission is worth asking for.
      ? `popup=yes,left=${Math.round(placement.left)},top=${Math.round(placement.top)},` +
        `width=${Math.round(placement.width)},height=${Math.round(placement.height)}`
      : "popup=yes,width=1280,height=800";
    const w = window.open("", "noormind-doctor", feat);
    if (!w) { setError("blocked"); return; }
    setError(null);
    winRef.current = w;

    furnish(w);

    // Two triggers, because neither alone is enough: pagehide catches the
    // user closing or reloading it, the poll catches a crashed renderer or an
    // OS-level close that fires nothing.
    w.addEventListener("pagehide", teardown);
    pollRef.current = setInterval(() => {
      if (!winRef.current || winRef.current.closed) teardown();
    }, 500);

    setReady(true);
  }, [teardown]);

  // A popup is NOT closed when its opener navigates away, so without this,
  // leaving the live page leaves a window on the doctor's monitor mirroring a
  // canvas that no longer updates.
  useEffect(() => {
    const onHide = () => { try { winRef.current?.close(); } catch { /* ignore */ } };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  return { win: winRef.current, ready, error, open, close: teardown };
}

/** Make a blank popup look like the app: same stylesheet, same font, same
 *  direction. Everything here is a one-shot at open time except the language,
 *  which the caller re-applies with mirrorLanguage below. */
function furnish(w: Window) {
  const d = w.document;
  if (d.body?.dataset.noormindDoctor === "1") return; // reused an open window

  // about:blank carries no charset, and Farsi mojibakes without one.
  const meta = d.createElement("meta");
  meta.setAttribute("charset", "utf-8");
  d.head.appendChild(meta);

  // Nothing here uses a relative URL today, but about:blank has no document
  // base, so the first one added would silently fail to resolve. Cheaper to
  // set now than to debug during a procedure.
  const base = d.createElement("base");
  base.href = `${window.location.origin}${BASE_PATH}/`;
  d.head.appendChild(base);

  // Black before anything else paints: Tailwind's preflight leaves <body>
  // transparent, and a white flash on the doctor's monitor in a darkened
  // room is its own small disaster.
  d.documentElement.style.background = "#000";
  d.body.style.background = "#000";
  d.body.style.margin = "0";
  d.body.style.overflow = "hidden";
  d.body.dataset.noormindDoctor = "1";

  // The font variable lives on <html>'s class (next/font/local), not in the
  // stylesheet, so copying the sheet alone would give the doctor the system
  // font. The @font-face rules themselves are inside the sheet with absolute
  // /_next/static/media URLs, which resolve fine from a same-origin popup.
  d.documentElement.className = document.documentElement.className;
  d.body.className = document.body.className;

  // Dev serves CSS as <style> and HMR links; production serves one <link>.
  // Both shapes are copied so the popup is not unstyled in development.
  for (const node of Array.from(
    document.head.querySelectorAll('link[rel="stylesheet"], style'),
  )) {
    d.head.appendChild(node.cloneNode(true));
  }

  const root = d.createElement("div");
  root.id = "doctor-root";
  root.style.cssText = "position:fixed;inset:0;background:#000;";
  d.body.appendChild(root);
}

/** The portal container. Separate from <body> so the furnishing above and
 *  React's children never contend for the same parent. */
export function doctorRoot(w: Window | null): HTMLElement | null {
  if (!w || w.closed) return null;
  return w.document.getElementById("doctor-root");
}

/** i18n.tsx sets lang/dir imperatively on the OPENER's documentElement only,
 *  so a Farsi/English toggle would not reach the popup without this. */
export function mirrorLanguage(w: Window | null, lang: string) {
  if (!w || w.closed) return;
  try {
    w.document.documentElement.lang = lang;
    w.document.documentElement.dir = lang === "fa" ? "rtl" : "ltr";
  } catch { /* window went away between the check and the write */ }
}
