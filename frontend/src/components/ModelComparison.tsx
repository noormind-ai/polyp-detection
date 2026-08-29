"use client";

/**
 * The full comparison — every variant, every metric, at an operating point you
 * choose.
 *
 * Two decisions shape this page.
 *
 * A "model" here is a model AND the settings it ran with. Resolution and the
 * border crop move the result as much as swapping architecture does — YOLOv5m
 * at 320px scores 58.1% uncropped and 77.4% cropped — so they are selectable
 * axes rather than a footnote, and picking one narrows the others to what was
 * actually measured. Nothing here is interpolated.
 *
 * And the confidence threshold and frame count apply to the WHOLE table, not
 * just the selected row. An operating point is the thing under discussion, and
 * a leaderboard computed at someone else's threshold is not evidence about
 * yours. Move the sliders and the ranking re-sorts underneath you, which is the
 * honest picture: which model wins depends on where you stand.
 */

import { useMemo, useState } from "react";
import { useLanguage } from "@/lib/i18n";
import {
  MODEL_RESULTS, DEPLOYED, CONF_STEPS, MIN_FRAME_STEPS,
  type ModelResult, type SweepPoint,
} from "@/lib/modelResults";

type SortKey = "recall" | "precision" | "f1" | "aucMaxConf" | "specificity" | "noisy" | "speed";

/** Metrics at the chosen operating point, or null if that cell was not swept. */
function at(m: ModelResult, conf: number, minFrames: number): SweepPoint | null {
  return m.sweep.find((s) => s.conf === conf && s.minFrames === minFrames) ?? null;
}

const fastest = (m: ModelResult) => {
  if (!m.speed) return null;
  const vals = Object.values(m.speed);
  return vals.length ? Math.min(...vals.map((v) => v.medianMs)) : null;
};

export default function ModelComparison() {
  const { t } = useLanguage();
  const [conf, setConf] = useState(0.7);
  const [minFrames, setMinFrames] = useState(3);
  const [showNoisy, setShowNoisy] = useState(true);
  const [sort, setSort] = useState<SortKey>("recall");
  const [detail, setDetail] = useState<string>(DEPLOYED.key);

  // The axes, narrowed to combinations that were actually run.
  const [family, setFamily] = useState(DEPLOYED.family);
  const inFamily = MODEL_RESULTS.filter((m) => m.family === family);
  const sizes = Array.from(new Set(inFamily.map((m) => m.imgsz))).sort((a, b) => a - b);
  const [imgsz, setImgsz] = useState(DEPLOYED.imgsz);
  const effSize = sizes.includes(imgsz) ? imgsz : sizes[0];
  const crops = Array.from(new Set(inFamily.filter((m) => m.imgsz === effSize).map((m) => m.crop)));
  const [crop, setCrop] = useState(DEPLOYED.crop);
  const effCrop = crops.includes(crop) ? crop : crops[0];
  const picked = inFamily.find((m) => m.imgsz === effSize && m.crop === effCrop) ?? inFamily[0];

  const noisyAt = (m: ModelResult) =>
    m.noisy?.curve.find((c) => Math.abs(c.conf - conf) < 1e-6)?.pct ?? null;

  const rows = useMemo(() => {
    const withPoint = MODEL_RESULTS.map((m) => ({ m, p: at(m, conf, minFrames) }));
    return withPoint.sort((a, b) => {
      if (sort === "noisy") {
        const av = noisyAt(a.m), bv = noisyAt(b.m);
        return av === null ? 1 : bv === null ? -1 : av - bv;   // fewer is better
      }
      if (sort === "speed") {
        const av = fastest(a.m), bv = fastest(b.m);
        return av === null ? 1 : bv === null ? -1 : av - bv;    // faster is better
      }
      if (sort === "aucMaxConf") return b.m.aucMaxConf - a.m.aucMaxConf;
      if (!a.p) return 1;
      if (!b.p) return -1;
      return (b.p[sort] as number) - (a.p[sort] as number);
    });
  }, [conf, minFrames, sort]);

  const basePoint = at(DEPLOYED, conf, minFrames);
  const d = (v: number, base: number | undefined, digits = 1, higherBetter = true) => {
    if (base === undefined) return null;
    const diff = v - base;
    if (Math.abs(diff) < 10 ** -digits / 2) return null;
    const good = higherBetter ? diff > 0 : diff < 0;
    return <span className={good ? "text-green-400" : "text-red-400"}>
      {" "}{diff > 0 ? "+" : ""}{diff.toFixed(digits)}</span>;
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
  const pill = (active: boolean) =>
    `px-3 py-1 rounded-lg text-sm border transition-colors ${
      active ? "border-green-700 bg-green-950/40 text-green-200"
             : "border-gray-800 text-gray-400 hover:text-gray-200 hover:border-gray-600"}`;

  const sel = MODEL_RESULTS.find((m) => m.key === detail) ?? DEPLOYED;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-gray-800 bg-gray-950/50 p-4 text-sm text-gray-400 leading-relaxed space-y-2">
        <p>{t("Every row is the same evaluation: {studies} colonoscopy studies from this archive, scored against the endoscopist's report. {positives} have a polyp in the report; {negatives} do not.",
              { studies: DEPLOYED.studies, positives: DEPLOYED.positives, negatives: DEPLOYED.negatives })}</p>
        <p>{t("Published benchmark scores are not shown. A model trained on Kvasir reports its accuracy on Kvasir, which says little about this hospital's footage — the deployed model scores mAP50 0.93 there and finds {recall}% of studies here.",
              { recall: DEPLOYED.recall.toFixed(0) })}</p>
      </section>

      {/* ---- the knobs ---- */}
      <section className="rounded-xl border border-gray-800 bg-gray-950/50 p-4 space-y-4">
        <h2 className="text-sm font-semibold text-white">{t("Settings")}</h2>

        <div className="space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-gray-500">{t("Model")}</p>
          <div className="flex flex-wrap gap-2">
            {Array.from(new Set(MODEL_RESULTS.map((m) => m.family))).map((f) => (
              <button key={f} onClick={() => { setFamily(f); setDetail(
                (MODEL_RESULTS.find((m) => m.family === f) ?? DEPLOYED).key); }}
                      className={pill(f === family)}>
                {MODEL_RESULTS.find((m) => m.family === f)!.familyLabel}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-6">
          <div className="space-y-2">
            <p className="text-[11px] uppercase tracking-wide text-gray-500">{t("Input size")}</p>
            <div className="flex gap-2">
              {sizes.map((s) => (
                <button key={s} onClick={() => { setImgsz(s); }} className={pill(s === effSize)}>
                  {s}px
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-[11px] uppercase tracking-wide text-gray-500">{t("Border crop")}</p>
            <div className="flex gap-2">
              {[false, true].map((c) => (
                <button key={String(c)} onClick={() => setCrop(c)}
                        disabled={!crops.includes(c)}
                        className={`${pill(c === effCrop && crops.includes(c))} ${
                          crops.includes(c) ? "" : "opacity-30 cursor-not-allowed"}`}>
                  {c ? t("on") : t("off")}
                </button>
              ))}
            </div>
          </div>
        </div>
        {crops.length === 1 && (
          <p className="text-[11px] text-gray-600">
            {t("Only one crop setting was measured for this combination — the greyed option was never run, and is not estimated here.")}
          </p>
        )}

        <div className="grid sm:grid-cols-2 gap-4 pt-1">
          <label className="space-y-1 block">
            <span className="text-[11px] uppercase tracking-wide text-gray-500">
              {t("Confidence threshold")}: <span className="text-white tabular-nums">{conf.toFixed(2)}</span>
            </span>
            <input type="range" min={0} max={CONF_STEPS.length - 1} step={1}
                   value={CONF_STEPS.indexOf(conf) < 0 ? 8 : CONF_STEPS.indexOf(conf)}
                   onChange={(e) => setConf(CONF_STEPS[Number(e.target.value)])}
                   className="w-full accent-green-500" />
            <span className="text-[11px] text-gray-600">{t("Only detections at or above this score count.")}</span>
          </label>
          <label className="space-y-1 block">
            <span className="text-[11px] uppercase tracking-wide text-gray-500">
              {t("Frames to call a study positive")}: <span className="text-white tabular-nums">{minFrames}</span>
            </span>
            <input type="range" min={0} max={MIN_FRAME_STEPS.length - 1} step={1}
                   value={Math.max(0, MIN_FRAME_STEPS.indexOf(minFrames))}
                   onChange={(e) => setMinFrames(MIN_FRAME_STEPS[Number(e.target.value)])}
                   className="w-full accent-green-500" />
            <span className="text-[11px] text-gray-600">{t("A lone flagged frame is usually noise; several is a finding.")}</span>
          </label>
        </div>

        <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
          <input type="checkbox" checked={showNoisy} onChange={(e) => setShowNoisy(e.target.checked)}
                 className="accent-green-500" />
          {t("Include noisy-frame false alarms")}
        </label>

        {(conf !== 0.7 || minFrames !== 3) && (
          <button onClick={() => { setConf(0.7); setMinFrames(3); }}
                  className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
            {t("Reset to what is deployed (0.70, 3 frames)")}
          </button>
        )}
      </section>

      {/* ---- the selected variant ---- */}
      <Selected m={picked} conf={conf} minFrames={minFrames} showNoisy={showNoisy} />

      {/* ---- everything, at the same operating point ---- */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-white">
          {t("All variants at confidence {conf} and {n} frames", { conf: conf.toFixed(2), n: minFrames })}
        </h2>
        <div className="overflow-x-auto rounded-xl border border-gray-800">
          <table className="w-full text-sm text-gray-300 min-w-[52rem]">
            <thead className="text-gray-500 bg-gray-900/50">
              <tr>
                <th className={th}>{t("Variant")}</th>
                {sortable("recall", "Recall", "studies found")}
                {sortable("precision", "Precision", "of alerts, correct")}
                {sortable("specificity", "Specificity", "clean left alone")}
                {sortable("f1", "F1")}
                {sortable("aucMaxConf", "ROC AUC", "threshold-free")}
                {sortable("speed", "Speed", "best backend")}
                {showNoisy && sortable("noisy", "Fires on noise", "lower is better")}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ m, p }) => {
                const n = noisyAt(m), ms = fastest(m);
                return (
                  <tr key={m.key} onClick={() => setDetail(m.key)}
                      className={`border-t border-gray-900 cursor-pointer hover:bg-gray-900/40 transition-colors ${
                        m.deployed ? "bg-green-950/20" : ""} ${detail === m.key ? "bg-gray-900/60" : ""}`}>
                    <td className="py-2 px-2">
                      <span className="text-white">{m.label}</span>
                      {m.deployed && <span className="ms-2 text-[10px] px-1.5 py-0.5 rounded border border-green-800 bg-green-950/40 text-green-300 whitespace-nowrap">{t("in use")}</span>}
                    </td>
                    {p ? (
                      <>
                        <td className="py-2 px-2 tabular-nums">{p.recall.toFixed(1)}%{!m.deployed && d(p.recall, basePoint?.recall)}</td>
                        <td className="py-2 px-2 tabular-nums">{p.precision.toFixed(1)}%{!m.deployed && d(p.precision, basePoint?.precision)}</td>
                        <td className="py-2 px-2 tabular-nums">{p.specificity.toFixed(1)}%</td>
                        <td className="py-2 px-2 tabular-nums">{p.f1.toFixed(3)}{!m.deployed && d(p.f1, basePoint?.f1, 3)}</td>
                      </>
                    ) : (
                      <td colSpan={4} className="py-2 px-2 text-gray-600">{t("not swept at this point")}</td>
                    )}
                    <td className="py-2 px-2 tabular-nums">{m.aucMaxConf.toFixed(3)}{!m.deployed && d(m.aucMaxConf, DEPLOYED.aucMaxConf, 3)}</td>
                    <td className="py-2 px-2 tabular-nums">
                      {ms === null ? <span className="text-gray-600">{t("not benchmarked")}</span> : `${ms.toFixed(0)} ms`}
                    </td>
                    {showNoisy && (
                      <td className="py-2 px-2 tabular-nums">
                        {n === null ? <span className="text-gray-600">{t("not run")}</span>
                                    : <>{n.toFixed(1)}%{!m.deployed && d(n, noisyAt(DEPLOYED) ?? undefined, 1, false)}</>}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-gray-500">{t("Click a row to select it. Click a column heading to sort. Deltas are against the deployed variant at the same operating point.")}</p>
      </section>

      <Detail m={sel} conf={conf} showNoisy={showNoisy} />
    </div>
  );
}

/** The variant the axes above resolve to, at the chosen operating point. */
function Selected({ m, conf, minFrames, showNoisy }:
                  { m: ModelResult; conf: number; minFrames: number; showNoisy: boolean }) {
  const { t } = useLanguage();
  const p = at(m, conf, minFrames);
  const n = m.noisy?.curve.find((c) => Math.abs(c.conf - conf) < 1e-6)?.pct ?? null;

  const Stat = ({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) => (
    <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-lg font-semibold text-white leading-tight">{value}</p>
      {hint && <p className="text-[11px] text-gray-500 leading-tight mt-0.5">{hint}</p>}
    </div>
  );

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-950/50 p-4 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">{m.label}</h2>
        {m.deployed && <span className="text-[11px] text-green-400">{t("this is what runs today")}</span>}
      </div>
      <p className="text-xs text-gray-400 leading-relaxed">{t(m.note)}</p>

      {p ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label={t("Recall")} value={`${p.recall.toFixed(1)}%`} hint={t("{tp} of {n} found", { tp: p.tp, n: p.tp + p.fn })} />
          <Stat label={t("Precision")} value={`${p.precision.toFixed(1)}%`} hint={t("{fp} false alarms", { fp: p.fp })} />
          <Stat label={t("F1")} value={p.f1.toFixed(3)} />
          <Stat label={t("Study ROC AUC")} value={m.aucMaxConf.toFixed(3)} hint={t("threshold-free")} />
        </div>
      ) : (
        <p className="text-xs text-gray-500">{t("This combination was not swept at that operating point.")}</p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {m.speed ? Object.entries(m.speed).map(([backend, s]) => (
          <Stat key={backend} label={backend} value={`${s.medianMs.toFixed(0)} ms`}
                hint={t("{fps} fps · p90 {p90} ms", { fps: s.fps.toFixed(1), p90: s.p90Ms.toFixed(0) })} />
        )) : (
          <p className="text-xs text-gray-500 col-span-full">
            {t("Speed was not benchmarked for this input size.")}
          </p>
        )}
      </div>
      {m.speed && (
        <p className="text-[11px] text-gray-500 leading-relaxed">
          {t("Measured on the development laptop, one frame at a time. The deployed server is a different machine and slower — quote its own logs, not these, for what a clinic will see.")}
        </p>
      )}

      {showNoisy && n !== null && (
        <p className="text-[11px] text-gray-500">
          {t("Fires on {pct}% of the {frames} reviewer-labelled noisy frames at this threshold — every one of those is a false alarm.",
             { pct: n.toFixed(1), frames: m.noisy!.frames })}
        </p>
      )}
    </section>
  );
}

function Detail({ m, conf, showNoisy }: { m: ModelResult; conf: number; showNoisy: boolean }) {
  const { t } = useLanguage();
  const Bar = ({ pct }: { pct: number }) => (
    <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden">
      <div className="h-full rounded-full bg-green-500/70" style={{ width: `${pct}%` }} />
    </div>
  );
  const slice = (title: string, rows: typeof m.bySize) => rows.length > 0 && (
    <div className="space-y-2">
      <p className="text-[11px] uppercase tracking-wide text-gray-500">{t(title)}</p>
      {rows.map((s) => (
        <div key={s.label} className="grid grid-cols-[7rem_1fr_4.5rem] items-center gap-2 text-xs">
          <span className="text-gray-400">{t(s.label)}</span>
          <Bar pct={s.pct} />
          <span className="tabular-nums text-gray-300 text-end">{s.pct}% ({s.found}/{s.total})</span>
        </div>
      ))}
    </div>
  );

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-950/50 p-4 space-y-4">
      <h3 className="text-sm font-semibold text-white">{t("Breakdown")} — {m.label}</h3>

      {slice("Sensitivity by polyp size", m.bySize)}
      {slice("Sensitivity by morphology", m.byMorphology)}
      {(m.bySize.length > 0 || m.byMorphology.length > 0) && (
        <p className="text-[11px] text-gray-600">
          {t("These two breakdowns are computed at the deployed operating point (0.70, 3 frames) and do not follow the sliders.")}
        </p>
      )}

      <div className="overflow-x-auto">
        <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">{t("Recall against false-alarm burden")}</p>
        <table className="w-full text-xs text-gray-300 min-w-[26rem]">
          <thead className="text-gray-500">
            <tr>
              <th className="py-1 pe-3 font-normal text-start">{t("Confidence")}</th>
              <th className="py-1 pe-3 font-normal text-start">{t("Recall")}</th>
              <th className="py-1 pe-3 font-normal text-start">{t("False frames per clean study")}</th>
              <th className="py-1 pe-3 font-normal text-start">{t("Clean studies alerted")}</th>
              {showNoisy && m.noisy && <th className="py-1 font-normal text-start">{t("Noisy frames fired on")}</th>}
            </tr>
          </thead>
          <tbody>
            {m.curve.map((c) => {
              const n = m.noisy?.curve.find((x) => x.conf === c.conf);
              return (
                <tr key={c.conf} className={`border-t border-gray-900 ${
                  Math.abs(c.conf - conf) < 1e-6 ? "bg-green-950/25 text-white" : ""}`}>
                  <td className="py-1 pe-3 tabular-nums">{c.conf.toFixed(2)}</td>
                  <td className="py-1 pe-3 tabular-nums">{c.recall.toFixed(1)}%</td>
                  <td className="py-1 pe-3 tabular-nums">{c.fpPerClean.toFixed(2)}</td>
                  <td className="py-1 pe-3 tabular-nums">{c.alerted}/{c.clean}</td>
                  {showNoisy && m.noisy && (
                    <td className="py-1 tabular-nums">{n ? `${n.pct.toFixed(1)}% (${n.framesFired}/${m.noisy.frames})` : "—"}</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-gray-500 leading-relaxed">
        {t("Measured on {frames} frames across {studies} studies. With only {positives} report-positive studies, one study is worth about {pts} points of recall — treat small differences as noise, and compare models on ROC AUC, which uses every study and needs no threshold.",
           { frames: m.frames.toLocaleString(), studies: m.studies, positives: m.positives,
             pts: (100 / m.positives).toFixed(0) })}
      </p>
    </section>
  );
}
