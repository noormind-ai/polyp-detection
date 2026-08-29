"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useLanguage } from "@/lib/i18n";

/**
 * The reviewer's way in, on the landing screen.
 *
 * A reviewer signs in here for one reason -- the work waiting in the panel at
 * /review -- but everything else on this page is about running inference, which
 * is not their job. The header link to the panel was a small button among five
 * others; this puts the panel above the mode picker, at the size of the thing
 * they actually came for, and tells them how far through their session they are
 * before they click.
 *
 * Rendered only for an account the backend recognised as a panel account
 * (`reviewer`); everyone else sees the page exactly as before.
 */

/** {session, done, total} for an open session; session === null when there is none. */
interface CurrentSession {
  session: string | null;
  done?: number;
  total?: number;
}

export default function ReviewCallout() {
  const { t } = useLanguage();
  const { reviewer, reviewRole } = useAuth();
  const [current, setCurrent] = useState<CurrentSession | null>(null);

  // Same-origin (nginx puts the panel at /review), so the panel session cookie
  // rides along. A failure here is not worth surfacing -- a reviewer who still
  // has to replace their one-time password is refused by the panel, and the
  // callout just shows its plain form and lets them go and do that.
  useEffect(() => {
    if (!reviewer) return;
    let live = true;
    fetch("/review/api/session/current", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live && d) setCurrent(d); })
      .catch(() => { /* panel unreachable, or session not ready */ });
    return () => { live = false; };
  }, [reviewer]);

  if (!reviewer) return null;

  const open = current?.session ? current : null;
  const done = open?.done ?? 0;
  const total = open?.total ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <a
      href="/review"
      className="block p-6 rounded-2xl border-2 border-emerald-600/70 bg-emerald-950/25 hover:border-emerald-400 hover:bg-emerald-950/45 transition-colors"
    >
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-5">
        <span className="text-4xl flex-shrink-0">🩺</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-lg font-semibold text-white">{t("Clinical review panel")}</span>
            {reviewRole === "admin" && (
              <span className="text-xs px-2 py-0.5 rounded-md border border-emerald-500/50 text-emerald-300">
                {t("Administrator")}
              </span>
            )}
          </div>
          <p className="text-sm text-emerald-200/70 mt-1">
            {open
              ? t("{done} of {total} studies reviewed in your open session", { done, total })
              : t("Read patient studies and record your findings")}
          </p>
          {open && total > 0 && (
            <div className="mt-3 h-1.5 rounded-full bg-emerald-950/80 overflow-hidden">
              <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
        <span className="text-sm font-medium px-4 py-2.5 rounded-xl bg-emerald-600 text-white flex-shrink-0 whitespace-nowrap text-center w-full sm:w-auto">
          {open ? t("Continue reviewing →") : t("Open the review panel →")}
        </span>
      </div>
    </a>
  );
}
