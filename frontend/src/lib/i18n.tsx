"use client";
import { createContext, useContext, useEffect, useState, useCallback, useMemo, ReactNode } from "react";
import { FA } from "./translations";

type Lang = "fa" | "en";
interface LanguageContextValue {
  lang: Lang;
  toggleLang: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>("fa");

  useEffect(() => {
    // ?lang=fa / ?lang=en in the URL beats whatever this browser last stored.
    //
    // The clinic PC came up in English because somebody toggled it once,
    // months ago, and localStorage remembered. Nobody reconfigures that
    // machine by hand, so its language has to be a property of how it is
    // launched rather than of a click nobody remembers making. The kiosk
    // launcher passes ?lang=fa, the same way it passes ?kiosk=1.
    //
    // Stored as well as applied, so the override survives in-app navigation
    // that drops the query string.
    try {
      const q = new URLSearchParams(window.location.search).get("lang");
      if (q === "fa" || q === "en") {
        setLang(q);
        localStorage.setItem("polyp_lang", q);
        return;
      }
    } catch { /* no URL/storage: fall through to the stored value */ }
    const stored = localStorage.getItem("polyp_lang");
    if (stored === "fa" || stored === "en") setLang(stored);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "fa" ? "rtl" : "ltr";
  }, [lang]);

  // Stable across renders (useCallback) so that any consumer using t or
  // toggleLang as a dependency -- useMemo, useCallback, React.memo -- can
  // actually skip work instead of recomputing every render just because
  // these were new function references each time. See the recordings
  // dropdown in LiveCameraPlayer.tsx for why this mattered in practice: its
  // option list is pure JSX work keyed off t, and without this fix every
  // unrelated HUD state update (multiple times a second during live
  // inference) silently forced the whole list to be rebuilt.
  const toggleLang = useCallback(() => {
    setLang((prev) => {
      const next: Lang = prev === "fa" ? "en" : "fa";
      localStorage.setItem("polyp_lang", next);
      return next;
    });
  }, []);

  const t = useCallback((key: string, vars?: Record<string, string | number>) => {
    let s = lang === "fa" && FA[key] ? FA[key] : key;
    if (vars) for (const k in vars) s = s.split(`{${k}}`).join(String(vars[k]));
    return s;
  }, [lang]);

  // Same reasoning one level up: without this, the context value object
  // itself is a new reference every render regardless of t/toggleLang being
  // stable, which still breaks React.memo on any direct context consumer.
  const value = useMemo(() => ({ lang, toggleLang, t }), [lang, toggleLang, t]);

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used within LanguageProvider");
  return ctx;
}
