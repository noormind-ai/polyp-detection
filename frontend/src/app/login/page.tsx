"use client";

/**
 * /login — the site's single sign-in page.
 *
 * Everything that needs an account sends people here: the app's own upload
 * modes, and the clinical review panel, which redirects to /login?next=/review
 * when nobody is signed in and is returned to the moment they are. There is no
 * other login form on the site, which is the point — when there were two, an
 * account could be accepted by one and told its password was wrong by the other.
 *
 * The search string is read from `window.location` in an effect rather than
 * with useSearchParams(), which would force this page out of static rendering
 * and demand a Suspense boundary for no gain: there is one query parameter and
 * it only matters once the page is interactive.
 */

import { useCallback, useEffect, useState } from "react";
import LoginPanel from "@/components/LoginPanel";
import { useAuth } from "@/lib/auth";
import { useLanguage } from "@/lib/i18n";

/**
 * Where to go once signed in.
 *
 * Same-origin paths only. To a browser "//evil.com" and "https://evil.com" are
 * both absolute URLs, and an open redirect on a login page is exactly how a
 * phishing link borrows a domain people trust.
 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

/**
 * Remembers the destination we last bounced to, per tab.
 *
 * /review sends signed-out visitors here, and this page sends them back once
 * they are signed in. If the panel refuses them anyway the two would volley
 * forever, so a destination is only ever attempted once per signed-in session;
 * the second request to try it stops and explains instead. Cleared whenever
 * this page finds nobody signed in, which is a genuinely fresh start.
 */
const BOUNCE = "polyp_login_bounce";

export default function LoginPage() {
  const { t, lang, toggleLang } = useLanguage();
  const { user, loading, reviewer, logout } = useAuth();
  const [next, setNext] = useState<string | null>(null);
  /** Signed in, but `next` is somewhere this account cannot go. */
  const [refused, setRefused] = useState(false);
  /** Arrived here because a session timed out, not because they clicked "sign in". */
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setNext(safeNext(q.get("next")));
    setExpired(q.get("expired") === "1");
  }, []);

  const navigate = useCallback((target: string) => {
    if (sessionStorage.getItem(BOUNCE) === target) {
      // Already sent them there once this session and here they are again.
      sessionStorage.removeItem(BOUNCE);
      setRefused(true);
      return;
    }
    sessionStorage.setItem(BOUNCE, target);
    window.location.replace(target);
  }, []);

  useEffect(() => {
    if (loading || next === null) return;
    if (!user) { sessionStorage.removeItem(BOUNCE); return; }
    if (next === "/") return;
    // The panel decides for itself, but we already know the answer for an
    // account that has no reviewer record — so say so here instead of sending
    // them to a door that will shut in their face.
    if (next.startsWith("/review") && !reviewer) { setRefused(true); return; }
    navigate(next);
  }, [loading, user, next, reviewer, navigate]);

  const go = () => navigate(next ?? "/");

  const heading = (
    <div className="flex items-start justify-between mb-10">
      <div>
        <h1 className="text-2xl font-semibold mb-1">{t("Polyp Detection AI")}</h1>
        <p className="text-gray-500 text-sm">{t("NoorMind")}</p>
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
  );

  let body;
  if (loading || next === null) {
    body = <p className="text-center text-gray-600 py-10">{t("Please wait…")}</p>;
  } else if (user && refused) {
    body = (
      <div className="max-w-md mx-auto text-center space-y-4 py-10">
        <p className="text-3xl">🚫</p>
        <p className="text-white">
          {reviewer
            ? t("Could not open the clinical review panel. Sign in again.")
            : t("This account cannot open the clinical review panel.")}
        </p>
        <p className="text-sm text-gray-500">
          {t("You are signed in as {user}. Review access is issued by an administrator.", { user })}
        </p>
        <div className="flex gap-2 justify-center">
          <a
            href="/"
            className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
          >
            {t("Continue")}
          </a>
          <button
            onClick={async () => { await logout(); setRefused(false); }}
            className="px-4 py-2 rounded-xl border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors"
          >
            {t("Sign in as someone else")}
          </button>
        </div>
      </div>
    );
  } else if (user && next === "/") {
    // Signed in with nowhere particular to be: say so and offer the way on,
    // rather than showing a form to someone who has already used it.
    body = (
      <div className="max-w-md mx-auto text-center space-y-4 py-10">
        <p className="text-3xl">✅</p>
        <p className="text-white">{t("Signed in as {user}", { user })}</p>
        <a
          href="/"
          className="inline-block px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
        >
          {t("Continue")}
        </a>
      </div>
    );
  } else {
    body = (
      <>
        {expired && (
          <div className="max-w-md mx-auto mb-2 rounded-lg border border-amber-800 bg-amber-950 px-4 py-3 text-sm text-amber-200">
            {t("Your session expired. Sign in again.")}
          </div>
        )}
        <LoginPanel standalone onSignedIn={go} />
      </>
    );
  }

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-4xl mx-auto p-8">
        {heading}
        {body}
        <p className="text-center mt-8">
          <a href="/" className="text-sm text-gray-600 hover:text-gray-400 transition-colors">
            {t("← Back")}
          </a>
        </p>
      </div>
    </main>
  );
}
