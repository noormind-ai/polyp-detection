"use client";

/**
 * What each model actually scores on OUR studies.
 *
 * The header used to assert a single number — "mAP50 0.93" — taken from the
 * model's own training benchmark. That number is true and close to useless: it
 * describes performance on Kvasir-SEG, not on this hospital's footage. Measured
 * here against endoscopists' reports, the same model finds 77% of studies, and
 * the honest thing is to publish that rather than the flattering figure.
 *
 * Every row is the identical evaluation — 108 studies, conf >= 0.70, a study
 * called positive at >= 3 frames — so the models can be compared directly.
 */

import { useState } from "react";
import { useLanguage } from "@/lib/i18n";
import { MODEL_RESULTS, DEFAULT_MODEL_KEY, type ModelResult } from "@/lib/modelResults";

export default function ModelPerformance() {
  const { t } = useLanguage();
  const [key, setKey] = useState(DEFAULT_MODEL_KEY);
  const [open, setOpen] = useState(false);
  const m: ModelResult = MODEL_RESULTS.find((r) => r.key === key) ?? MODEL_RESULTS[0];

  // The deployed row is the comparison everything else is judged against, so a
  // reader can see at a glance whether a model is better or merely different.
  const base = MODEL_RESULTS.find((r) => r.deployed);
  const delta = (v: number, b: number, digits = 1) => {
    const d = v - b;
    if (!base || m.deployed || Math.abs(d) < 10 ** -digits) return null;
    return (
      <span className={d > 0 ? "text-green-400" : "text-red-400"}>
        {" "}({d > 0 ? "+" : ""}{d.toFixed(digits)})
      </span>
    );
  };

  const Stat = ({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) => (
    <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-lg font-semibold text-white leading-tight">{value}</p>
      {hint && <p className="text-[11px] text-gray-500 leading-tight mt-0.5">{hint}</p>}
    </div>
  );

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-950/50 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-white">{t("Model performance")}</h2>
          <p className="text-xs text-gray-500">
            {t("{studies} studies from this archive · {positives} with a polyp in the report · {frames} frames",
               { studies: m.studies, positives: m.positives, frames: m.frames.toLocaleString() })}
          </p>
        </div>
        <select
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white max-w-full"
        >
          {MODEL_RESULTS.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}{r.deployed ? ` — ${t("in use")}` : ""}
            </option>
          ))}
        </select>
      </div>

      <p className="text-xs text-gray-400 leading-relaxed">{t(m.note)}</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label={t("Recall")} value={<>{m.recall.toFixed(1)}%{delta(m.recall, base!.recall)}</>}
              hint={t("{tp} of {n} found", { tp: m.tp, n: m.tp + m.fn })} />
        <Stat label={t("Precision")} value={<>{m.precision.toFixed(1)}%{delta(m.precision, base!.precision)}</>}
              hint={t("{fp} false alarms", { fp: m.fp })} />
        <Stat label={t("F1")} value={<>{m.f1.toFixed(3)}{delta(m.f1, base!.f1, 3)}</>} />
        <Stat label={t("Study ROC AUC")} value={<>{m.aucMaxConf.toFixed(3)}{delta(m.aucMaxConf, base!.aucMaxConf, 3)}</>}
              hint={t("threshold-free")} />
      </div>

      <button onClick={() => setOpen(!open)}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
        {open ? t("Hide detail") : t("Show detail")}
      </button>

      {open && (
        <div className="space-y-3 pt-1">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
            <Stat label={t("Specificity")} value={`${m.specificity.toFixed(1)}%`} />
            <Stat label={t("NPV")} value={`${m.npv.toFixed(1)}%`} />
            <Stat label={t("Youden J")} value={m.youden.toFixed(3)} />
            <Stat label={t("Confusion")} value={<span className="text-sm">{m.tp}/{m.fn}/{m.fp}/{m.tn}</span>}
                  hint={t("TP / FN / FP / TN")} />
          </div>

          {/* The curve is the part a clinician can act on: how much extra noise
              buys how much extra sensitivity. */}
          <div className="overflow-x-auto">
            <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
              {t("Recall against false-alarm burden")}
            </p>
            <table className="w-full text-xs text-gray-300 min-w-[22rem]">
              <thead className="text-gray-500">
                <tr className="text-left">
                  <th className="py-1 pe-3 font-normal">{t("Confidence")}</th>
                  <th className="py-1 pe-3 font-normal">{t("Recall")}</th>
                  <th className="py-1 pe-3 font-normal">{t("False frames per clean study")}</th>
                  <th className="py-1 font-normal">{t("Clean studies alerted")}</th>
                </tr>
              </thead>
              <tbody>
                {m.curve.map((c) => (
                  <tr key={c.conf} className="border-t border-gray-900">
                    <td className="py-1 pe-3 tabular-nums">{c.conf.toFixed(2)}</td>
                    <td className="py-1 pe-3 tabular-nums">{c.recall.toFixed(1)}%</td>
                    <td className="py-1 pe-3 tabular-nums">{c.fpPerClean.toFixed(2)}</td>
                    <td className="py-1 tabular-nums">{c.alerted}/{c.clean}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] text-gray-500 leading-relaxed">
            {t("Measured on this deployment's own archive against the endoscopist's report, not on a public benchmark. With only {positives} report-positive studies, one study is worth about {pts} points of recall — treat small differences as noise and compare on ROC AUC, which uses every study and needs no threshold.",
               { positives: m.positives, pts: (100 / m.positives).toFixed(0) })}
          </p>
        </div>
      )}
    </section>
  );
}
