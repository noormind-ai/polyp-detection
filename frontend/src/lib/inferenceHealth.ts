/** Is AI detection actually running right now? Drives the "no AI detection"
 *  banner on the doctor's screen (components/NoInferenceBanner.tsx).
 *
 *  Pure function of a few timestamps, so it is unit-tested with plain numbers
 *  (frontend/tests/inferenceHealth.test.ts). The player samples it twice a
 *  second.
 *
 *  The trap it avoids: "no boxes" is normal (no polyp), and "no results" is
 *  ALSO normal while the scope is outside the body -- JPEG mode's in-body gate
 *  deliberately sends nothing then. So silence only counts as a fault while
 *  frames are actually being SENT. A doctor who learns to ignore a banner
 *  that cries wolf on every withdrawal would also ignore the real one.
 */

/** The state belongs to the whole live session's AI pipeline, not to one
 *  frame or one connection attempt:
 *    null          detection is running (or nothing is owed: stopped / out of body)
 *    "starting"    session started, no first result yet (model or GPU warming up)
 *    "reconnecting" the connection to the server is down; it is being retried
 *    "no-results"  connected and sending frames, but nothing has come back */
export type AiDown = null | "starting" | "reconnecting" | "no-results";

export const AI_HEALTH = {
  /** Silence this long while sending = fault. ~3 frames' worth of patience
   *  at the slowest rate the clinic runs at, short enough to matter. */
  NO_RESULT_MS: 3_000,
  /** A frame sent within this window counts as "currently sending". */
  SENDING_WINDOW_MS: 3_000,
  /** Don't flash "starting" for the normal first-second warm-up. */
  START_GRACE_MS: 1_500,
};

export function aiHealth(s: {
  now: number;
  /** A live session is running (camera open, loop started). */
  streaming: boolean;
  /** The transport to the server is up (JPEG socket open / WebRTC "open"). */
  connected: boolean;
  /** When this session started inferring. */
  startedAt: number;
  /** Last moment a result was owed: a frame handed to the server, or one
   *  still awaiting its answer (JPEG mode stops sending while it waits, so a
   *  frozen server must not look like "nothing to send"). 0 = never. */
  lastSentAt: number;
  /** Start of the current unbroken stretch of sending (e.g. scope just went
   *  back in the body). Silence is measured from here at the earliest, so the
   *  first frame after a minute out of body isn't judged by a minute-old
   *  result. */
  sendingSince: number;
  /** Last SUCCESSFUL result (an error reply doesn't count); 0 = none yet. */
  lastOkAt: number;
}): AiDown {
  if (!s.streaming) return null;
  const neverWorked = s.lastOkAt < s.startedAt;
  const warmingUp = s.now - s.startedAt < AI_HEALTH.START_GRACE_MS;
  if (!s.connected) {
    // Not connected YET at the start of a session is warm-up, not an outage.
    if (neverWorked) return warmingUp ? null : "starting";
    return "reconnecting";
  }
  const sending = s.lastSentAt > 0 && s.now - s.lastSentAt < AI_HEALTH.SENDING_WINDOW_MS;
  if (!sending) return null; // nothing owed: out of body, or skipped by a gate
  if (neverWorked) return warmingUp ? null : "starting";
  const silentSince = Math.max(s.lastOkAt, s.sendingSince);
  return s.now - silentSince >= AI_HEALTH.NO_RESULT_MS ? "no-results" : null;
}
