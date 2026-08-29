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

      {gate.enabled && gate.skipped > 0 && (
        <p className="text-xs text-gray-600">
          {t("{n} frames skipped this session", { n: gate.skipped })}
        </p>
      )}
    </div>
  );
}
