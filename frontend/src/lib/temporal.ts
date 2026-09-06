// Temporal persistence: require a detection to appear on several of the last
// few frames before it is shown.
//
// WHY THIS AND NOT ANOTHER THRESHOLD
// A confidence threshold cannot separate our false positives from our true
// ones: measured on the reviewer-labelled set, every false-positive class
// (folds, glare, lumen recess, the anal canal) tops out at 0.7-0.9, the same
// range as real polyps. Raising the threshold loses lesions before it loses
// artefacts.
//
// Persistence is a different axis entirely. A polyp stays in view for seconds
// while the scope moves over it; glare off a wet fold, a blurred smear during a
// fast sweep, and the dark centre of the lumen all flicker. So the question
// "was this here a moment ago" carries information that "how confident is the
// model" does not, and it costs nothing to ask -- no model, no labels, no
// measurable compute.
//
// WHAT IT COSTS
// Latency. At 3-of-5 and ~4 inferences/second a real polyp appears about a
// second late. That is the whole trade and it is why the default here is the
// mildest setting and why the operator can switch it off mid-procedure.

export interface TBox {
  bbox: [number, number, number, number];
  conf: number;
  // Present when the backend's tracker ran (it always does, as of the
  // ByteTrack option below) -- ignored by this file's own IoU matching,
  // which tracks state independently client-side. See useTemporalGate.ts.
  track_id?: number;
  persistent?: boolean;
}

export const LEVELS = [
  { key: "gentle", need: 2, of: 3 },
  { key: "medium", need: 3, of: 5 },
  { key: "strong", need: 4, of: 7 },
] as const;

export type TLevelKey = (typeof LEVELS)[number]["key"];
export const DEFAULT_LEVEL: TLevelKey = "gentle";

// Off: every detection shown immediately, no persistence check.
// Heuristic: this file's own IoU-matching gate (the class below) -- self
//   authored, no motion model, unvalidated against labels (see file header).
// Bytetrack: trusts the `persistent` flag the real, vendored ByteTrack
//   computes server-side (backend/services/tracker.py) -- a real MOT library,
//   but with its low-confidence recovery pass currently inert at this app's
//   serving threshold (see that file's docstring).
// Both real mechanisms are offered side by side, deliberately, rather than
// picking one -- see the plan discussion for why.
export const MODES = ["off", "heuristic", "bytetrack"] as const;
export type Mode = (typeof MODES)[number];
export const DEFAULT_MODE: Mode = "heuristic";

// Two boxes count as the same lesion above this overlap. Deliberately loose:
// between frames the scope moves, so the same polyp can shift a long way, and
// a strict value would break the track exactly when the view is worst -- which
// is when the gate matters most.
const IOU_MATCH = 0.25;

function iou(a: TBox["bbox"], b: TBox["bbox"]): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

interface Track {
  box: TBox;
  hits: boolean[]; // most recent last
  seen: number;    // total frames this track has been hit
}

export class TemporalGate {
  private tracks: Track[] = [];
  private level: TLevelKey;
  /** Detections withheld so far because they had not yet persisted. */
  held = 0;
  /** Detections released after they did persist. */
  passed = 0;

  constructor(level: TLevelKey = DEFAULT_LEVEL) {
    this.level = level;
  }

  setLevel(l: TLevelKey) {
    if (l !== this.level) {
      this.level = l;
      this.reset();
    }
  }

  reset() {
    this.tracks = [];
    this.held = 0;
    this.passed = 0;
  }

  private cfg() {
    return LEVELS.find((l) => l.key === this.level) ?? LEVELS[0];
  }

  /**
   * Feed one frame's detections; get back only those that have persisted.
   *
   * Every incoming box updates or starts a track. Tracks that got no box this
   * frame record a miss rather than being dropped immediately -- a lesion that
   * blinks out for one frame is still the same lesion, and dropping the track
   * would restart its count from zero and hide it for another N frames.
   */
  filter(boxes: TBox[]): TBox[] {
    const { need, of } = this.cfg();
    const matched = new Array(this.tracks.length).fill(false);

    for (const b of boxes) {
      let best = -1;
      let bestIou = IOU_MATCH;
      for (let i = 0; i < this.tracks.length; i++) {
        if (matched[i]) continue;
        const v = iou(this.tracks[i].box.bbox, b.bbox);
        if (v >= bestIou) {
          bestIou = v;
          best = i;
        }
      }
      if (best >= 0) {
        matched[best] = true;
        const t = this.tracks[best];
        t.box = b;               // keep the newest geometry, not the first
        t.hits.push(true);
        t.seen++;
      } else {
        this.tracks.push({ box: b, hits: [true], seen: 1 });
        matched.push(true);
      }
    }

    for (let i = 0; i < this.tracks.length; i++) {
      if (!matched[i]) this.tracks[i].hits.push(false);
      if (this.tracks[i].hits.length > of) this.tracks[i].hits.shift();
    }

    // Retire a track once its whole window is misses.
    this.tracks = this.tracks.filter((t) => t.hits.some(Boolean));

    const out: TBox[] = [];
    for (const b of boxes) {
      const t = this.tracks.find((tr) => iou(tr.box.bbox, b.bbox) >= IOU_MATCH);
      const hits = t ? t.hits.filter(Boolean).length : 1;
      if (hits >= need) {
        out.push(b);
        this.passed++;
      } else {
        this.held++;
      }
    }
    return out;
  }

  /** How close the strongest not-yet-shown track is to being released. */
  pending(): { hits: number; need: number; of: number } | null {
    const { need, of } = this.cfg();
    let best: Track | null = null;
    for (const t of this.tracks) {
      const h = t.hits.filter(Boolean).length;
      if (h < need && (!best || h > best.hits.filter(Boolean).length)) best = t;
    }
    if (!best) return null;
    return { hits: best.hits.filter(Boolean).length, need, of };
  }
}
