"use client";

/**
 * The full comparison — every model, every metric, side by side.
 *
 * The compact panel on the front page answers "how good is the thing I am about
 * to use". This answers "which one should we be running", which needs the whole
 * table at once rather than a dropdown you have to flick between to hold two
 * numbers in your head.
 *
 * Everything here is measured on this deployment's own archive against
 * endoscopists' reports. Published benchmark figures are deliberately absent:
 * they describe the dataset a model was trained on, not this hospital's footage,
 * and quoting them next to these would invite exactly the wrong comparison.
 */

import { useState } from "react";
import { useLanguage } from "@/lib/i18n";
import { MODEL_RESULTS, DEPLOYED, type ModelResult } from "@/lib/modelResults";

type SortKey = "recall" | "precision" | "f1" | "aucMaxConf" | "specificity" | "noisy";

export default function ModelComparison() {
  const { t } = useLanguage();
  const [sort, setSort] = useState<SortKey>("aucMaxConf");
  const [showNoisy, setShowNoisy] = useState(true);
  const [detail, setDetail] = useState<string | null>(DEPLOYED.key);

  const noisyAt = (m: ModelResult, conf = 0.7) =>
    m.noisy?.curve.find((c) => c.conf === conf)?.pct ?? null;

  const sorted = [...MODEL_RESULTS].sort((a, b) => {
    if (sort === "noisy") {
      const av = noisyAt(a), bv = noisyAt(b);
      if (av === null) return 1;
      if (bv === null) return -1;
      return av - bv;                     // fewer false alarms is better
    }
    return (b[sort] as number) - (a[sort] as number);
  });

  // Everything is judged against what we actually run.
  const d = (v: number, base: number, digits = 1, higherBetter = true) => {
    const diff = v - base;
    if (Math.abs(diff) < 10 ** -digits / 2) return null;
    const good = higherBetter ? diff > 0 : diff < 0;
    return (
      <span className={good ? "text-green-400" : "text-red-400"}>
        {" "}{diff > 0 ? "+" : ""}{diff.toFixed(digits)}
      </span>
    );
  };

  const th = "py-2 px-2 font-normal text-start whitespace-nowrap";
  const sortable = (k: SortKey, label: string, hint?: string) => (
    <th className={th}>
      <button onClick={() => setSort(k)}
              className={`hover:text-gray-200 transition-colors ${sort === k ? "text-white font-medium" : ""}`}>
        {t(label)}{sort === k ? " ↓" : ""}
      </button>
      {hint && <span className="block text-[10px] text-gray-600 font-normal">{t(hint)}</span>}
    </th>
  );

  const sel = MODEL_RESULTS.find((m) => m.key === detail);

  return (
    <div className="space-y-6">
      {/* How to read any of this. Without it the table is just numbers. */}
      <section className="rounded-xl border border-gray-800 bg-gray-950/50 p-4 text-sm text-gray-400 leading-relaxed space-y-2">
        <p>
          {t("Every row is the same evaluation: {studies} colonoscopy studies from this archive, scored against the endoscopist's report. A study counts as a detection when the model fires on at least 3 frames at confidence 0.70 or above. {positives} of the studies have a polyp in the report; {negatives} do not.",
             { studies: DEPLOYED.studies, positives: DEPLOYED.positives, negatives: DEPLOYED.negatives })}
        </p>
        <p>
          {t("Published benchmark scores are not shown. A model trained on Kvasir reports its accuracy on Kvasir, which says little about this hospital's footage — the deployed model scores mAP50 0.93 there and finds {recall}% of studies here.",
             { recall: DEPLOYED.recall.toFixed(0) })}
        </p>
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-white">{t("All models")}</h2>
          <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
            <input type="checkbox" checked={showNoisy}
                   onChange={(e) => setShowNoisy(e.target.checked)}
                   className="accent-green-500" />
            {t("Include noisy-frame false alarms")}
          </label>
        </div>

        <div className="overflow-x-auto rounded-xl border border-gray-800">
          <table className="w-full text-sm text-gray-300 min-w-[46rem]">
            <thead className="text-gray-500 bg-gray-900/50">
              <tr>
                <th className={th}>{t("Model")}</th>
                {sortable("recall", "Recall", "studies found")}
                {sortable("precision", "Precision", "of alerts, correct")}
                {sortable("specificity", "Specificity", "clean studies left alone")}
                {sortable("f1", "F1")}
                {sortable("aucMaxConf", "ROC AUC", "threshold-free")}
                {showNoisy && sortable("noisy", "Fires on noise", "lower is better")}
              </tr>
            </thead>
            <tbody>
              {sorted.map((m) => {
                const n = noisyAt(m);
                return (
                  <tr key={m.key}
                      onClick={() => setDetail(m.key)}
                      className={`border-t border-gray-900 cursor-pointer hover:bg-gray-900/40 transition-colors ${
                        m.deployed ? "bg-green-950/20" : ""} ${detail === m.key ? "bg-gray-900/60" : ""}`}>
                    <td className="py-2 px-2">
                      <span className="text-white">{t(m.label)}</span>
                      {m.deployed && (
                        <span className="ms-2 text-[10px] px-1.5 py-0.5 rounded border border-green-800 bg-green-950/40 text-green-300 whitespace-nowrap">
                          {t("in use")}
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-2 tabular-nums">
                      {m.recall.toFixed(1)}%{!m.deployed && d(m.recall, DEPLOYED.recall)}
                    </td>
                    <td className="py-2 px-2 tabular-nums">
                      {m.precision.toFixed(1)}%{!m.deployed && d(m.precision, DEPLOYED.precision)}
                    </td>
                    <td className="py-2 px-2 tabular-nums">{m.specificity.toFixed(1)}%</td>
                    <td className="py-2 px-2 tabular-nums">
                      {m.f1.toFixed(3)}{!m.deployed && d(m.f1, DEPLOYED.f1, 3)}
                    </td>
                    <td className="py-2 px-2 tabular-nums">
                      {m.aucMaxConf.toFixed(3)}{!m.deployed && d(m.aucMaxConf, DEPLOYED.aucMaxConf, 3)}
                    </td>
                    {showNoisy && (
                      <td className="py-2 px-2 tabular-nums">
                        {n === null ? <span className="text-gray-600">{t("not run")}</span> : (
                          <>{n.toFixed(1)}%{!m.deployed && d(n, noisyAt(DEPLOYED) ?? 0, 1, false)}</>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-gray-500">{t("Click a row for the full breakdown. Click a column heading to sort.")}</p>

        {showNoisy && (
          <p className="text-[11px] text-gray-500 leading-relaxed">
            {t("\"Fires on noise\" is a separate frame-level test: {frames} frames the review panel marked noisy and never called a polyp, so their true label is no-polyp and every detection is wrong by construction. It is kept apart from the study numbers because a study needs 3 frames to be called positive — one stray box costs no study, but it does cost attention. These panel frames arrive already tightly cropped, so the border crop is a no-op on this set and cannot be judged by it.",
               { frames: DEPLOYED.noisy?.frames ?? 0 })}
          </p>
        )}
      </section>

      {sel && <Detail m={sel} showNoisy={showNoisy} />}
    </div>
  );
}

function Detail({ m, showNoisy }: { m: ModelResult; showNoisy: boolean }) {
  const { t } = useLanguage();
  const Bar = ({ pct }: { pct: number }) => (
    <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden">
      <div className="h-full rounded-full bg-green-500/70" style={{ width: `${pct}%` }} />
    </div>
  );

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-950/50 p-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-white">{t(m.label)}</h3>
        <p className="text-xs text-gray-400 mt-1 leading-relaxed">{t(m.note)}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
        {([
          ["Found", `${m.tp}/${m.tp + m.fn}`, t("report-positive studies")],
          ["Missed", `${m.fn}`, t("false negatives")],
          ["False alarms", `${m.fp}`, t("of {n} clean studies", { n: m.negatives })],
          ["Youden J", m.youden.toFixed(3), t("sensitivity + specificity − 1")],
        ] as const).map(([l, v, h]) => (
          <div key={l} className="rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2">
            <p className="text-[11px] uppercase tracking-wide text-gray-500">{t(l)}</p>
            <p className="text-lg font-semibold text-white leading-tight">{v}</p>
            <p className="text-[11px] text-gray-500 leading-tight">{h}</p>
          </div>
        ))}
      </div>

      {/* Size is the clinically interesting cut: small lesions are the ones
          missed in practice, and the ones a detector is supposed to help with. */}
      {m.bySize.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-gray-500">{t("Sensitivity by polyp size")}</p>
          <div className="space-y-1.5">
            {m.bySize.map((s) => (
              <div key={s.label} className="grid grid-cols-[7rem_1fr_4.5rem] items-center gap-2 text-xs">
                <span className="text-gray-400">{t(s.label)}</span>
                <Bar pct={s.pct} />
                <span className="tabular-nums text-gray-300 text-end">{s.pct}% ({s.found}/{s.total})</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {m.byMorphology.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-gray-500">{t("Sensitivity by morphology")}</p>
          <div className="space-y-1.5">
            {m.byMorphology.map((s) => (
              <div key={s.label} className="grid grid-cols-[7rem_1fr_4.5rem] items-center gap-2 text-xs">
                <span className="text-gray-400">{t(s.label)}</span>
                <Bar pct={s.pct} />
                <span className="tabular-nums text-gray-300 text-end">{s.pct}% ({s.found}/{s.total})</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* The operating-point table. This is the part that is actually a
          decision: how much extra noise buys how much extra sensitivity. */}
      <div className="overflow-x-auto">
        <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
          {t("Recall against false-alarm burden")}
        </p>
        <table className="w-full text-xs text-gray-300 min-w-[26rem]">
          <thead className="text-gray-500">
            <tr>
              <th className="py-1 pe-3 font-normal text-start">{t("Confidence")}</th>
              <th className="py-1 pe-3 font-normal text-start">{t("Recall")}</th>
              <th className="py-1 pe-3 font-normal text-start">{t("False frames per clean study")}</th>
              <th className="py-1 pe-3 font-normal text-start">{t("Clean studies alerted")}</th>
              {showNoisy && m.noisy && (
                <th className="py-1 font-normal text-start">{t("Noisy frames fired on")}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {m.curve.map((c) => {
              const n = m.noisy?.curve.find((x) => x.conf === c.conf);
              return (
                <tr key={c.conf} className={`border-t border-gray-900 ${c.conf === 0.7 ? "bg-gray-900/40" : ""}`}>
                  <td className="py-1 pe-3 tabular-nums">
                    {c.conf.toFixed(2)}
                    {c.conf === 0.7 && <span className="ms-1 text-[10px] text-gray-500">{t("in use")}</span>}
                  </td>
                  <td className="py-1 pe-3 tabular-nums">{c.recall.toFixed(1)}%</td>
                  <td className="py-1 pe-3 tabular-nums">{c.fpPerClean.toFixed(2)}</td>
                  <td className="py-1 pe-3 tabular-nums">{c.alerted}/{c.clean}</td>
                  {showNoisy && m.noisy && (
                    <td className="py-1 tabular-nums">
                      {n ? `${n.pct.toFixed(1)}% (${n.framesFired}/${m.noisy.frames})` : "—"}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-gray-500 leading-relaxed">
        {t("Measured on {frames} frames across {studies} studies. With only {positives} report-positive studies, one study is worth about {pts} points of recall — treat small differences as noise, and compare models on ROC AUC, which uses every study and needs no threshold.",
           { frames: m.frames.toLocaleString(), studies: m.studies,
             positives: m.positives, pts: (100 / m.positives).toFixed(0) })}
      </p>
    </section>
  );
}
