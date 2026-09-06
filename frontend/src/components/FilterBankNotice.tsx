"use client";

import { useLanguage } from "@/lib/i18n";
import type { Term } from "@/lib/inBody";
import type { TemporalGateState } from "@/lib/useTemporalGate";
import { LEVELS as T_LEVELS } from "@/lib/temporal";
import ScoreChips from "./ScoreChips";

/**
 * The noise filters, itemised the same way the out-of-body score is.
 *
 * Same component, same chips, same reading: each one shows what it measured and
 * what that did to the verdict. The difference is what the number means. The
 * in-body panel's contribution is a weighted z-score summing to one probability;
 * here each filter is independent and its contribution is the MARGIN to its own
 * fitted cut, in units of that cut. So +2.4 means "this frame is nowhere near
 * that filter's threshold" and -0.1 means "it only just tripped it".
 *
 * Margin rather than the raw value, because the raw values are on wildly
 * different scales -- gra1 is tens, lapv is hundreds, ipr is a fraction -- and
 * nothing can be compared across them until each is divided by its own cut.
 *
 * The persistence gate is shown as one more chip. It is not a frame-quality
 * measure and does not belong with the others mathematically, but it is the
 * other reason a detection may not be on screen, and an operator asking "why am
 * I not seeing a box" should find both answers in one place.
 */

export interface GateFilter {
  value: number;
  cut: number;
  fired: boolean;
  label: string;
}
export interface GateState {
  filter: string;
  fired: boolean;
  enforce: boolean;
  filters?: Record<string, GateFilter>;
}

// Four, not nine: gra1 and teng are the same Sobel gradient with and without
// the square root, so showing both would look like two filters agreeing when it
// is one filter counted twice. One survivor per mechanism, best by AUC:
// gra1 0.816 (first derivative) · lapv 0.759 (second) · ipr 0.692 (edge
// continuity) · wavelet 0.634 (multi-scale).
const ORDER = ["gra1", "lapv", "ipr", "wavelet"];

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 1000 || a < 0.01) return v.toExponential(1);
  return a >= 100 ? v.toFixed(0) : a >= 1 ? v.toFixed(1) : v.toFixed(3);
}

/** Distance from the cut in units of the cut. Positive = passing. */
function margin(d: GateFilter): number {
  const span = Math.abs(d.cut) || 1;
  const slack = Math.abs(d.value - d.cut);
  return (d.fired ? -slack : slack) / span;
}

export default function FilterBankNotice({
  gate, temporal, show, onToggle,
}: {
  gate: GateState | null;
  temporal?: TemporalGateState;
  show: boolean;
  onToggle: () => void;
}) {
  const { t } = useLanguage();
  const toggleBtn =
    "text-xs px-2 py-0.5 rounded-md border border-gray-800 text-gray-500 hover:text-gray-300 hover:border-gray-600 transition-colors flex-shrink-0";

  const f = gate?.filters;
  const keys = f ? ORDER.filter((k) => f[k]) : [];
  const fired = keys.filter((k) => f![k].fired).length;

  const terms: Term[] = keys.map((k) => ({
    key: k,
    value: fmt(f![k].value),
    contribution: margin(f![k]),
  }));

  if (temporal) {
    const cfg = T_LEVELS.find((l) => l.key === temporal.level) ?? T_LEVELS[0];
    const pend = temporal.pending;
    // ByteTrack mode has no "level" of its own -- it's fixed at 2-of-3
    // server-side (backend/services/tracker.py) -- and reports no per-frame
    // "how close" readout, so pend is always null there (see useTemporalGate).
    const value =
      temporal.mode === "off" ? "off" :
      temporal.mode === "bytetrack" ? "2/3" :
      `${pend ? pend.hits : cfg.need}/${cfg.need}`;
    terms.push({
      key: "persist",
      value,
      // Negative while a detection is still being confirmed, since that is the
      // gate actively withholding a box; neutral-positive once nothing is held.
      contribution: temporal.mode === "off" ? 0 : pend ? -(cfg.need - pend.hits) : 1,
    });
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-gray-500 uppercase tracking-wide truncate">
          {t("Noise filters")}
          {keys.length > 0 && (
            <span className={fired ? "text-amber-300 ml-1" : "text-emerald-400/70 ml-1"}>
              {" · "}{fired}/{keys.length} {t("firing")}
            </span>
          )}
        </p>
        <button onClick={onToggle} className={toggleBtn}>
          {show ? t("Hide") : t("Show")}
        </button>
      </div>

      {keys.length === 0 ? (
        <p className="text-xs text-gray-600 truncate">{t("Waiting for a frame…")}</p>
      ) : !show ? null : (
        <ScoreChips
          terms={terms}
          summary={
            <>
              {fired === 0
                ? t("no filter would reject this frame")
                : t("{n} of {m} would reject this frame", { n: fired, m: keys.length })}
              <span className={`ml-2 ${fired === 0 ? "text-emerald-400/70" : "text-amber-400/70"}`}>
                {gate?.enforce ? t("enforcing") : t("reporting only")}
              </span>
            </>
          }
          legend={t("green = clear of the cut · amber = would reject · number is margin to the cut")}
        />
      )}
    </div>
  );
}
