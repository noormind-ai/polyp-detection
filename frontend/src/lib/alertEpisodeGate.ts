/** Tier 3's trigger, and nothing else: the rising and falling edge of "is a box
 *  on the video right now".
 *
 *  Deliberately has no timing bar of its own -- no minimum duration, no hit
 *  count, no confidence floor. Tier 3 announces exactly what tier 1 decided to
 *  draw, so "what counts as a box" is defined in one place (lib/temporal.ts)
 *  instead of three.
 *
 *  That also means there is no dropout tolerance here, and none is needed:
 *  TemporalGate.filter() records a *miss* against a track rather than dropping
 *  it, so at the default gentle 2-of-3 a lesion that blinks out for a single
 *  frame stays on screen -- this gate never sees an "end", and the room does
 *  not hear a second beep for the same lesion. Switch tier 1 off and the beep
 *  follows raw per-frame detections, which is the honest consequence of tying
 *  the two together.
 *
 *  Feed it every inferred frame, including the ones with no detections --
 *  a gate that only hears about non-empty frames can never see an edge. */

export type AlertEdge = "start" | "end" | null;

export interface AlertGate {
  /** Feed the box state actually rendered this frame. Returns "start" on the
   *  frame a box appears, "end" on the frame the last one goes away, else null. */
  update: (hasBox: boolean) => AlertEdge;
  /** Forget the current state -- for a session stop, so the next session opens
   *  on a clean edge rather than inheriting the last frame of the old one. */
  reset: () => void;
}

export function createAlertGate(): AlertGate {
  let hadBox = false;

  return {
    update(hasBox: boolean): AlertEdge {
      if (hasBox === hadBox) return null;
      hadBox = hasBox;
      return hasBox ? "start" : "end";
    },
    reset() {
      hadBox = false;
    },
  };
}
