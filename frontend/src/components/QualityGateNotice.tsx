"use client";

import { useLanguage } from "@/lib/i18n";
import type { QualityGateState } from "@/lib/useQualityGate";
import { LEVELS, type Reason } from "@/lib/frameQuality";

/**
 * Current status of the noisy-frame filter, one line. No event history, no
 * banner block -- this sits above the Detected panel during a procedure, and
 * vertical space there is the scarce thing.
 *
 * The strictness row is the substance: every level carries the trade-off
 * measured on the in-house reviewer labels, so picking one is an informed choice
 * rather than a guess at what "strong" means.
 */

const REASON_LABEL: Record<Reason, string> = {
  blurry: "Too blurry",
  dark: "Too dark",
  glare: "Too much glare",
  underexposed: "Underexposed",
  overexposed: "Overexposed",
  ok: "OK",
};

const LEVEL_LABEL: Record<string, string> = {
  gentle: "Gentle",
  medium: "Medium",
  strong: "Strong",
  max: "Maximum",
};

export default function QualityGateNotice({ gate }: { gate: QualityGateState }) {
  const { t } = useLanguage();
  const toggleBtn =
    "text-xs px-2 py-0.5 rounded-md border border-gray-800 text-gray-500 hover:text-gray-300 hover:border-gray-600 transition-colors flex-shrink-0";

  const m = gate.metrics;
  const active = LEVELS.find((l) => l.key === gate.level) ?? LEVELS[1];

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-gray-500 uppercase tracking-wide truncate">
          {t("Noisy-frame filter")}
        </p>
        <button onClick={() => gate.setEnabled(!gate.enabled)} className={toggleBtn}>
          {gate.enabled ? t("Turn off") : t("Turn on")}
        </button>
      </div>

      {!gate.enabled ? (
        <p className="text-xs text-gray-600 truncate">
          {t("Off — every frame is sent to the AI.")}
        </p>
      ) : (
        <>
          {gate.blocked ? (
            <p className="text-sm font-medium text-orange-300 truncate">
              {t("⏸ Too noisy — not sent to the AI")}
              <span className="text-orange-200/60 font-normal">
                {" · "}{t(REASON_LABEL[gate.reason])}
              </span>
            </p>
          ) : (
            <p className="text-sm text-emerald-400/80 truncate">
              {t("Picture usable · every frame going to the AI")}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="text-gray-500">{t("Strictness")}</span>
            {LEVELS.map((l) => (
              <button
                key={l.key}
                onClick={() => gate.setLevel(l.key)}
                className={`px-2 py-0.5 rounded-md transition-colors ${
                  gate.level === l.key
                    ? "bg-green-600 text-white"
                    : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                }`}
              >
                {t(LEVEL_LABEL[l.key])}
              </button>
            ))}
          </div>

          <p className="text-xs text-gray-600 leading-relaxed">
            {t("Catches {noisy}% of noisy frames · also skips {polyp}% of frames with a polyp", {
              noisy: Math.round(active.noisy * 100),
              polyp: (active.polyp * 100).toFixed(1),
            })}
          </p>

          {m && (
            <div dir="ltr" className="rounded-lg border border-gray-800 bg-black/40 px-2 py-1 font-mono text-[11px] text-gray-500 overflow-x-auto whitespace-nowrap">
              sharp {m.gradmean.toFixed(1)} / {active.gradMin} · mean {m.mean.toFixed(0)}
              {" · "}glare {(m.specFrac * 100).toFixed(1)}% · dark {(m.darkFrac * 100).toFixed(1)}%
              {gate.skipped > 0 && ` · skipped ${gate.skipped}`}
            </div>
          )}
        </>
      )}
    </div>
  );
}
