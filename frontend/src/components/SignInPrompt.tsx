"use client";

/**
 * Shown in place of a mode that needs an account, and the only way the app
 * itself asks anyone to sign in.
 *
 * It is a signpost, not a form. The site has exactly ONE login form, at
 * /login — the same one /review sends people to — because when there were two
 * they drifted apart, and an account that worked on one page was told its
 * password was wrong on the other.
 */

import { useLanguage } from "@/lib/i18n";

/** Send the browser to the login page, and back here afterwards. */
export function goToLogin() {
  const here = window.location.pathname + window.location.search;
  window.location.assign("/login?next=" + encodeURIComponent(here));
}

export default function SignInPrompt({ onOpenDemos }: { onOpenDemos?: () => void }) {
  const { t } = useLanguage();

  return (
    <div className="max-w-md mx-auto space-y-5 py-6 text-center">
      <p className="text-3xl">🔒</p>
      <h2 className="text-lg font-medium text-white">{t("Sign in to analyse your own video")}</h2>
      <p className="text-sm text-gray-500">
        {t("Uploading runs the model on a GPU, so it needs an account. Live camera, screen share and the demo clips are open to everyone.")}
      </p>

      <button
        onClick={() => goToLogin()}
        className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
      >
        {t("Sign in")}
      </button>

      {onOpenDemos && (
        <button
          onClick={onOpenDemos}
          className="w-full text-sm text-gray-500 hover:text-gray-300 transition-colors"
        >
          {t("← Try a demo clip instead (no account needed)")}
        </button>
      )}
    </div>
  );
}
