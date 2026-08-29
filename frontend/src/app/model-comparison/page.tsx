"use client";

/**
 * /model-comparison — what every detector scores on our own studies.
 *
 * The front page carries one summary line and a compact panel, which is the
 * right amount for someone about to start a procedure. Choosing between models
 * is a different job and needs the whole table at once, so it gets a real route
 * — something to send a colleague, and somewhere the numbers can be argued with.
 *
 * No sign-in gate, unlike /tutorials. These are aggregate measurements with no
 * patient frame anywhere in them, and being able to hand someone the URL is most
 * of the point.
 */

import ModelComparison from "@/components/ModelComparison";
import { useLanguage } from "@/lib/i18n";

export default function ModelComparisonPage() {
  const { t, lang, toggleLang } = useLanguage();

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-5xl mx-auto p-4 sm:p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between mb-6 sm:mb-10">
          <div>
            <h1 className="text-xl sm:text-2xl font-semibold mb-1">{t("Model comparison")}</h1>
            <p className="text-gray-500 text-sm">
              {t("Measured on our own studies, against the endoscopist's report")}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <a href="/"
               className="text-sm px-3 py-1.5 rounded-lg border border-gray-800 text-gray-400 hover:text-white hover:border-gray-600 transition-colors">
              {t("← Back")}
            </a>
            <button onClick={toggleLang}
                    className="text-sm px-3 py-1.5 rounded-lg border border-gray-800 text-gray-400 hover:text-white hover:border-gray-600 transition-colors">
              {lang === "fa" ? "English" : "فارسی"}
            </button>
          </div>
        </div>

        <ModelComparison />
      </div>
    </main>
  );
}
