"use client";

import { useLanguage } from "@/lib/i18n";
import type { Term } from "@/lib/inBody";

/**
 * The out-of-body score, itemised.
 *
 * Each cue shows what it measured AND what that did to the verdict, because a
 * cue can read as perfectly ordinary and still dominate: every term is divided
 * by its own sigma and multiplied by its own weight before it counts, so the raw
 * values alone never explain the outcome.
 *
 * Shared by the live panel and the review cards. On a live frame the numbers say
 * why inference is or is not running; on a filed capture they say what the gate
 * would have made of that frame, which is how a capture gets audited after the
 * fact.
 */
export default function ScoreChips({
  terms, z, p, tooDark, note, summary, legend,
}: {
  terms: Term[];
  z?: number;
  p?: number;
  tooDark?: boolean;
  /** Optional caption, e.g. to say motion is unavailable on a still image. */
  note?: string;
  /** Replaces the in-body total/probability line. The chip grid is the reusable
   *  part; what the numbers add up to is not the same question in every panel,
   *  so a caller with a different verdict supplies its own line. */
  summary?: React.ReactNode;
  /** Replaces "green pushes inside · amber pushes outside". */
  legend?: string;
}) {
  const { t } = useLanguage();
  if (terms.length === 0) return null;

  return (
    <div dir="ltr" className="space-y-1">
      <div className="flex flex-wrap gap-1">
        {terms.map((term) => {
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
      {summary !== undefined ? (
        <div className="font-mono text-[10px] text-gray-500">{summary}</div>
      ) : (
        <div className="font-mono text-[10px] text-gray-500">
          {tooDark
            ? t("too dark to judge colour → outside")
            : `total ${(z ?? 0) >= 0 ? "+" : ""}${(z ?? 0).toFixed(1)} → p=${(p ?? 0).toFixed(3)}`}
          <span className={`ml-2 ${(p ?? 0) > 0.5 ? "text-emerald-400/70" : "text-amber-400/70"}`}>
            {(p ?? 0) > 0.5 ? t("in body") : t("out of body")}
          </span>
        </div>
      )}
      <p className="text-[10px] text-gray-700">
        {note ? `${note} · ` : ""}
        {legend ?? t("green pushes inside · amber pushes outside")}
      </p>
    </div>
  );
}
