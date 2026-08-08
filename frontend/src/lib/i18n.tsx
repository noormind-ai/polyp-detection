"use client";
import { createContext, useContext, useEffect, useState, ReactNode } from "react";
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
    const stored = localStorage.getItem("polyp_lang");
    if (stored === "fa" || stored === "en") setLang(stored);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "fa" ? "rtl" : "ltr";
  }, [lang]);

  const toggleLang = () => {
    const next: Lang = lang === "fa" ? "en" : "fa";
    setLang(next);
    localStorage.setItem("polyp_lang", next);
  };

  const t = (key: string, vars?: Record<string, string | number>) => {
    let s = lang === "fa" && FA[key] ? FA[key] : key;
    if (vars) for (const k in vars) s = s.split(`{${k}}`).join(String(vars[k]));
    return s;
  };

  return (
    <LanguageContext.Provider value={{ lang, toggleLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used within LanguageProvider");
  return ctx;
}
