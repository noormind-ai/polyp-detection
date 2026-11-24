"use client";

import { useLanguage } from "@/lib/i18n";
import type { AiDown } from "@/lib/inferenceHealth";

/** Top-of-picture warning that AI detection is NOT running, for the doctor.
 *
 *  Overlay only (absolute, inside the picture box): the fullscreen geometry
 *  from fsBoxStyle must not change, or the crop zoom and FOV overlay misframe
 *  -- see lib/useFullscreen and CaptureStrip's header. pointer-events-none so
 *  it never swallows a click meant for the picture or the strip.
 *
 *  Deliberately loud: the dangerous state is a doctor reading "no box" as
 *  "no polyp" while the AI is not actually looking. */
export default function NoInferenceBanner({ state }: { state: AiDown }) {
  const { t } = useLanguage();
  if (!state) return null;
  const starting = state === "starting";
  const detail =
    state === "starting" ? t("AI is starting…")
    : state === "reconnecting" ? t("Connection lost — reconnecting…")
    : t("No results from the server");
  return (
    <div className="absolute top-3 inset-x-0 z-50 flex justify-center pointer-events-none px-3">
      <div
        role="alert"
        className={`flex items-center gap-3 px-5 py-2.5 rounded-xl border-2 shadow-2xl backdrop-blur-sm ${
          starting
            ? "bg-amber-950/95 border-amber-500 text-amber-100"
            : "bg-red-950/95 border-red-500 text-red-50"
        }`}
      >
        <span className={`text-2xl leading-none ${starting ? "" : "animate-pulse"}`} aria-hidden>⚠</span>
        <div className="leading-tight">
          <div className="text-lg font-bold">{t("No AI detection")}</div>
          <div className="text-sm opacity-90">{detail}</div>
        </div>
      </div>
    </div>
  );
}
