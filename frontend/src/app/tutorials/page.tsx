"use client";

/**
 * /tutorials — the video guides, on their own URL.
 *
 * They were first built as another `mode` inside the single app page, which
 * meant the address bar never changed and there was nothing to send someone.
 * A guide is the one thing here people forward to a colleague, so it gets a
 * real route — the same shape as /login: its own heading, the language toggle,
 * and a way back. Sign-in required, same as the rest of the app;
 * nothing here starts a session or a GPU.
 */

import { useEffect } from "react";
import TutorialsPanel from "@/components/TutorialsPanel";
import { useAuth } from "@/lib/auth";
import { useLanguage } from "@/lib/i18n";

export default function TutorialsPage() {
  const { t, lang, toggleLang } = useLanguage();
  const { user, loading } = useAuth();

  // Sign-in required. Handled by bouncing through the site's single login page
  // rather than showing a second form here, and with `next` set so signing in
  // lands back on the guide instead of the app's front page.
  useEffect(() => {
    if (!loading && !user) window.location.replace("/login?next=/tutorials");
  }, [loading, user]);

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-4xl mx-auto p-8">
        <div className="flex items-start justify-between mb-10">
          <div>
            <h1 className="text-2xl font-semibold mb-1">{t("Tutorials")}</h1>
            <p className="text-gray-500 text-sm">{t("How to use the feedback panels")}</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <a
              href="/"
              className="text-sm px-3 py-2 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors"
            >
              {t("Home")}
            </a>
            <button
              onClick={toggleLang}
              className="text-sm px-3 py-2 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors"
            >
              {lang === "fa" ? "English" : "فارسی"}
            </button>
          </div>
        </div>

        {user
          ? <TutorialsPanel />
          : <p className="text-center text-gray-600 py-10">{t("Please wait…")}</p>}

        <p className="text-center mt-8">
          <a href="/" className="text-sm text-gray-600 hover:text-gray-400 transition-colors">
            {t("← Back")}
          </a>
        </p>
      </div>
    </main>
  );
}
