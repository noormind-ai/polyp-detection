"use client";

import { useLanguage } from "@/lib/i18n";
import { LEVELS, MODES } from "@/lib/temporal";
import type { TemporalGateState } from "@/lib/useTemporalGate";
import type { Mode } from "@/lib/temporal";

/**
 * Persistence filter, one line, same shape as the other two gate panels.
 *
 * Three real choices, not one on/off switch: Off (nothing withheld),
 * Heuristic (this app's own IoU-matching gate, unvalidated but zero
 * dependencies), and ByteTrack (the real, vendored MOT library). Neither
 * mechanism is presented as "the" answer -- the point of offering both is to
 * compare them on the same footage before picking one for good.
 */

const LEVEL_LABEL: Record<string, string> = {
  gentle: "Gentle",
  medium: "Medium",
  strong: "Strong",
};

const MODE_LABEL: Record<Mode, string> = {
  off: "Off",
  heuristic: "Heuristic",
  bytetrack: "ByteTrack",
};

export default function TemporalGateNotice({ gate }: { gate: TemporalGateState }) {
  const { t } = useLanguage();
  const modeBtn = (active: boolean) =>
    `px-2 py-0.5 rounded-md text-xs transition-colors ${
      active ? "bg-green-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
    }`;
  const active = LEVELS.find((l) => l.key === gate.level) ?? LEVELS[0];

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-gray-500 uppercase tracking-wide truncate">
          {t("Persistence filter")}
        </p>
        <div className="flex gap-1 flex-shrink-0">
          {MODES.map((m) => (
            <button key={m} onClick={() => gate.setMode(m)} className={modeBtn(gate.mode === m)}>
              {t(MODE_LABEL[m])}
            </button>
          ))}
        </div>
      </div>

      {gate.mode === "off" && (
        <p className="text-xs text-gray-600 truncate">
          {t("Off — every detection is drawn the moment it appears.")}
        </p>
      )}

      {gate.mode === "heuristic" && (
        <>
          {gate.pending ? (
            <p className="text-sm font-medium text-amber-300 truncate">
              {t("⏳ Confirming — seen {hits} of {need} frames", {
                hits: gate.pending.hits, need: gate.pending.need,
              })}
            </p>
          ) : (
            <p className="text-sm text-emerald-400/80 truncate">
              {t("Only detections seen {need} times in {of} frames are drawn", {
                need: active.need, of: active.of,
              })}
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
                {t(LEVEL_LABEL[l.key])} <span className="opacity-60">{l.need}/{l.of}</span>
              </button>
            ))}
          </div>

          <p className="text-xs text-gray-600 leading-relaxed">
            {t("Own heuristic, not a published library — no motion model, unvalidated against labels. Costs no polyps: a lesion that stays in view is still shown, about {n} frames later.", {
              n: active.need - 1,
            })}
          </p>

          <div dir="ltr" className="rounded-lg border border-gray-800 bg-black/40 px-2 py-1 font-mono text-[11px] text-gray-500 overflow-x-auto whitespace-nowrap">
            drawn {gate.passed} · held {gate.held}
            {gate.pending && ` · confirming ${gate.pending.hits}/${gate.pending.need}`}
          </div>
        </>
      )}

      {gate.mode === "bytetrack" && (
        <>
          <p className="text-sm text-emerald-400/80 truncate">
            {t("Only detections the tracker confirms across 2 of the last 3 frames are drawn")}
          </p>
          <p className="text-xs text-gray-600 leading-relaxed">
            {t("Real ByteTrack (Zhang et al. 2022), vendored server-side — a Kalman motion model plus a second pass that recovers low-confidence detections. That second pass is currently inert: nothing below this model's own serving threshold ever reaches it.")}
          </p>
          <div dir="ltr" className="rounded-lg border border-gray-800 bg-black/40 px-2 py-1 font-mono text-[11px] text-gray-500 overflow-x-auto whitespace-nowrap">
            drawn {gate.passed} · held {gate.held}
          </div>
        </>
      )}
    </div>
  );
}
