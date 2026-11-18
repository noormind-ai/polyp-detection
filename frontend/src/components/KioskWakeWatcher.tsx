"use client";

import { useEffect } from "react";

/**
 * Notices when the clinic PC wakes up from Sleep and sends it back through
 * the exact same URL the kiosk already launches at boot (same as
 * kiosk-loop.ps1's own Chrome command line) - a full navigation, not a
 * state reset, so every already-working cold-start step (sign-in,
 * auto-open camera, calibration) just runs again from scratch instead of
 * trying to patch three different half-resumed states individually.
 *
 * While the PC is asleep NOTHING runs, not even this timer - so the next
 * tick after waking always sees a much bigger gap than the ~2s it expects.
 * That gap is what we watch for, not any particular duration, which is
 * why this catches a short sleep just as reliably as an overnight one.
 */
const TICK_MS = 2000;
const GAP_THRESHOLD_MS = 6000; // 3x TICK_MS - normal jitter never gets close

export default function KioskWakeWatcher() {
  useEffect(() => {
    let kiosk = false;
    try {
      kiosk = localStorage.getItem("polyp_kiosk") === "1";
    } catch { /* private mode: just skip the watcher */ }
    if (!kiosk) return;

    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const gap = now - last;
      last = now;
      if (gap > GAP_THRESHOLD_MS) {
        window.location.href = "/?kiosk=1&lang=fa";
      }
    }, TICK_MS);

    return () => clearInterval(id);
  }, []);

  return null;
}
