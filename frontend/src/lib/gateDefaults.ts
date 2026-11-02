"use client";

/** One-time reset of the stored gate switches.
 *
 * The temporal and frame-quality gates remember the operator's choice in
 * localStorage, and a stored value wins over the default. So flipping the
 * defaults off (2026-10-11) would have changed nothing at all for exactly the
 * people who had touched these controls before -- the gates would have stayed
 * on in their browser while the code said off, which is the worst of both.
 *
 * This clears the four stored keys once per browser, then records that it has
 * done so, so a deliberate choice made AFTER this deploy still sticks. Bump
 * VERSION only to force another reset; it is not a general settings-wipe.
 */
const VERSION_KEY = "polyp_gate_reset_v";
const VERSION = "2026-10-11-gates-off";
const KEYS = [
  "polyp_temporal_mode",
  "polyp_temporal_level",
  "polyp_quality_filter",
  "polyp_quality_level",
];

let ran = false;

export function resetStoredGateChoices(): void {
  if (ran || typeof window === "undefined") return;
  ran = true;
  try {
    if (window.localStorage.getItem(VERSION_KEY) === VERSION) return;
    for (const k of KEYS) window.localStorage.removeItem(k);
    window.localStorage.setItem(VERSION_KEY, VERSION);
    console.info("[gates] stored gate choices reset to defaults (" + VERSION + ")");
  } catch {
    // Storage disabled (private mode): the defaults apply anyway, which is the
    // outcome this function exists to produce.
  }
}
