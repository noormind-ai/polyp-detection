"use client";

import { useLanguage } from "@/lib/i18n";
import type { InBodyGateState } from "@/lib/useInBodyGate";

/**
 * Current status of the out-of-body filter. Status only -- no event history.
 * The live score is kept because it is what tells you whether a verdict is
 * marginal or emphatic.
 */
export default function InBodyGateNotice({ gate }: { gate: InBodyGateState }) {
  const { t } = useLanguage();
  const toggleBtn =
    "text-xs px-2 py-0.5 rounded-md border border-gray-800 text-gray-500 hover:text-gray-300 hover:border-gray-600 transition-colors flex-shrink-0";

  const paused = gate.enabled && !gate.inside;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-gray-500 uppercase tracking-wide truncate">
          {t("Out-of-body filter")}
        </p>
        <button onClick={() => gate.setEnabled(!gate.enabled)} className={toggleBtn}>
          {gate.enabled ? t("Turn off") : t("Turn on")}
        </button>
      </div>

      {!gate.enabled ? (
        <p className="text-xs text-gray-600 leading-relaxed">
          {t("Off — every frame is sent for inference, including frames where the camera is outside the patient.")}
        </p>
      ) : paused ? (
        <div className="rounded-xl border border-amber-600/60 bg-amber-950/40 px-3 py-2">
          <p className="text-sm font-medium text-amber-300">
            {t("⏸ Out of body detected — no inference")}
          </p>
          <p className="text-xs text-amber-200/50 font-mono" dir="ltr">p={gate.p.toFixed(3)}</p>
        </div>
      ) : (
        <p className="text-xs text-emerald-400/80">
          {t("Inside the colon · detector running")}
          <span className="text-gray-600" dir="ltr"> · p={gate.p.toFixed(3)}</span>
        </p>
      )}

      {gate.enabled && gate.metrics && (
        <div dir="ltr" className="rounded-lg border border-gray-800 bg-black/40 px-2 py-1 font-mono text-[11px] text-gray-500 overflow-x-auto whitespace-nowrap">
          red {gate.metrics.redness.toFixed(0)} · spread {gate.metrics.hueSpread.toFixed(0)}°
          {" · "}motion {gate.motion === null ? "—" : gate.motion.toExponential(1)}
        </div>
      )}

      {gate.enabled && gate.terms.length > 0 && (
        <div dir="ltr" className="space-y-1">
          {/* Each cue with what it is doing to the verdict, not just what it
              measured: a cue can look ordinary and still dominate, because each
              is divided by its own sigma and weighted before it counts. */}
          <div className="flex flex-wrap gap-1">
            {gate.terms.map((term) => {
              const c = term.contribution;
              const strong = Math.abs(c) >= 1;
              const tone = Math.abs(c) < 0.25
                ? "bg-gray-800/60 text-gray-500 border-gray-800"
                : c > 0
                  ? (strong ? "bg-emerald-900/60 text-emerald-300 border-emerald-700/60"
                            : "bg-emerald-950/40 text-emerald-400/70 border-emerald-900/50")
                  : (strong ? "bg-amber-900/60 text-amber-300 border-amber-700/60"
                            : "bg-amber-950/40 text-amber-400/70 border-amber-900/50");
              return (
                <span key={term.key}
                      className={`px-1.5 py-0.5 rounded border font-mono text-[10px] leading-tight ${tone}`}>
                  {term.key} {term.value}
                  <span className="opacity-70"> {c >= 0 ? "+" : ""}{c.toFixed(1)}</span>
                </span>
              );
            })}
          </div>
          <div className="font-mono text-[10px] text-gray-500">
            {gate.tooDark
              ? t("too dark to judge colour \u2192 outside")
              : `total ${gate.z >= 0 ? "+" : ""}${gate.z.toFixed(1)} \u2192 p=${gate.p.toFixed(3)}`}
          </div>
          <p className="text-[10px] text-gray-700">
            {t("green pushes inside · amber pushes outside")}
          </p>
        </div>
      )}

      {gate.enabled && gate.skipped > 0 && (
        <p className="text-xs text-gray-600">
          {t("{n} frames skipped this session", { n: gate.skipped })}
        </p>
      )}
    </div>
  );
}
