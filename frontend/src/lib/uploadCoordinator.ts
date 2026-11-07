"use client";

/**
 * Keeps a still-uploading recording from a finished procedure off the wire
 * while the NEXT procedure's live inference is running in the same tab.
 *
 * A plain module-level singleton on purpose, not React state or context: the
 * scenario this exists for is procedure 1 ends and its recording starts
 * uploading (can take minutes on a slow uplink), then procedure 2 starts a
 * few minutes later -- a fresh `LiveCameraPlayer` mount, a fresh
 * `useSessionRecorder` instance. React state scoped to either component
 * would not survive that remount; this module does, because it isn't tied to
 * any component's lifetime at all.
 *
 * Reference-counted rather than a boolean so a double-invocation (e.g. React
 * 18 StrictMode's double-effect in dev) can't leave it stuck open or closed.
 *
 * This needs zero backend changes. `backend/routes/recordings.py` still
 * enforces strict chunk ordering; all this does is have the *client* pace
 * itself, holding the next chunk until no live session is sending frames.
 * Scoped to one browser tab deliberately -- each procedure room is already a
 * separate tab/device, so there is nothing to coordinate across tabs.
 */

let liveCount = 0;
const waiters = new Set<() => void>();

/** Call when a live-inference send loop starts. Call the returned function
 *  exactly once when it stops (put it in a `finally`, not just the happy
 *  path, so a thrown error can't leave the counter stuck above zero). */
export function beginLiveInference(): () => void {
  liveCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    liveCount = Math.max(0, liveCount - 1);
    if (liveCount === 0) {
      const pending = Array.from(waiters);
      waiters.clear();
      pending.forEach((resolve) => resolve());
    }
  };
}

export function isLiveInferenceActive(): boolean {
  return liveCount > 0;
}

// KNOWN GAP (2026-11-07, not yet fixed -- see useSessionRecorder.ts pause()
// and LiveCameraPlayer.tsx's applyAutoRecord for the two callers involved):
//
// Observed in practice: procedure 1 ends and finalize() is draining its
// backlog in the background. Procedure 2 starts in the same tab -- correctly
// blocks procedure 1's backlog (liveCount > 0), per design. But then
// procedure 2 itself goes out of body for a SHORT stretch (under its own
// getOutOfBodyStopMs() threshold): no frames are sent during that stretch
// (the in-body gate drops them before they'd ever reach a websocket), so the
// link is genuinely idle right then -- yet procedure 1's backlog still does
// NOT resume, because procedure 2's own liveInferenceReleaseRef hold is
// deliberately NOT released until its full (user-tunable) threshold passes.
// That threshold is calibrated for "is this a new patient yet", which is the
// right question for procedure 2's OWN pause/stop/finalize decision -- but
// it is the WRONG question for "can some other already-queued recording use
// this instant", which should be near-immediate, not patient-threshold-slow.
//
// This file conflates those two questions into one signal (liveCount). A
// real fix needs two separate things, not a tweak to this one:
//   1. A fast, non-debounced "are frames actually being sent RIGHT NOW"
//      signal (toggles the moment a send loop starts/stops, no grace period)
//      that gates whether ANY pending recording's backlog may send a chunk
//      this instant -- independent of any patient-boundary decision.
//   2. An actual queue/ordering among multiple pending backlogs. Today, if
//      N recordings are all blocked on waitForZero() and the gate opens, ALL
//      of their waiters resolve at once (see the `pending.forEach` below) and
//      they race their next PUT concurrently -- fine at N=1, untested and
//      uncoordinated at N>1 (procedure 1's tail end overlapping an orphan
//      recovery upload, say).
// Until this is split, a short out-of-body dip mid-procedure will keep
// starving any older backlog even though nothing is actually being sent.

function waitForZero(): Promise<void> {
  if (liveCount === 0) return Promise.resolve();
  return new Promise((resolve) => waiters.add(resolve));
}

/** Resolves once no live-inference loop is running in this tab, and stays
 *  resolved-worthy at the moment the caller actually proceeds -- not just at
 *  the moment it was woken up. A single wait-then-go has a narrow race: the
 *  count can hit zero, wake every waiter, and then tick back up again (the
 *  next procedure starting) before a woken caller's own next line of code
 *  runs. Re-checking after each wake closes that window instead of letting a
 *  chunk slip out right as the next procedure's inference is spinning up. */
export async function waitUntilInferenceIdle(): Promise<void> {
  while (liveCount > 0) {
    await waitForZero();
  }
}
