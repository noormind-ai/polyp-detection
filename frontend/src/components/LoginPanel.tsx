"use client";

/**
 * Shown in place of an upload mode when nobody is signed in.
 *
 * It explains what the account is actually for and points at the modes that
 * need no account — someone who just wants to see the detector work should
 * not hit a wall here, because the demos and the live camera are open.
 */

import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { useLanguage } from "@/lib/i18n";

export default function LoginPanel({ onOpenDemos }: { onOpenDemos?: () => void }) {
  const { t } = useLanguage();
  const { login, register, registrationOpen, inviteRequired } = useAuth();
  const [tab, setTab] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const registering = tab === "register";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (registering) await register(username, password, invite);
      else await login(username, password);
      // On success the provider sets `user`, which unmounts this panel.
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const field =
    "w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-700 text-white " +
    "placeholder-gray-600 focus:border-blue-500 focus:outline-none transition-colors";

  return (
    <div className="max-w-md mx-auto space-y-5 py-6">
      <div className="text-center space-y-2">
        <p className="text-3xl">🔒</p>
        <h2 className="text-lg font-medium text-white">{t("Sign in to analyse your own video")}</h2>
        <p className="text-sm text-gray-500">
          {t("Uploading runs the model on a GPU, so it needs an account. Live camera, screen share and the demo clips are open to everyone.")}
        </p>
      </div>

      {registrationOpen && (
        <div className="flex gap-1 border-b border-gray-800">
          {(["login", "register"] as const).map((key) => (
            <button
              key={key}
              onClick={() => { setTab(key); setError(""); }}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                tab === key ? "border-blue-500 text-white" : "border-transparent text-gray-500 hover:text-gray-300"
              }`}
            >
              {key === "login" ? t("Sign in") : t("Create account")}
            </button>
          ))}
        </div>
      )}

      <form onSubmit={submit} className="space-y-3">
        <input
          className={field}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t("Username")}
          autoComplete="username"
          autoFocus
        />
        <input
          className={field}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t("Password")}
          autoComplete={registering ? "new-password" : "current-password"}
        />
        {registering && inviteRequired && (
          <input
            className={field}
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            placeholder={t("Invite code")}
          />
        )}

        <button
          type="submit"
          disabled={busy || !username || !password}
          className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? t("Please wait…") : registering ? t("Create account") : t("Sign in")}
        </button>
      </form>

      {error && (
        <div className="bg-red-950 border border-red-800 rounded-lg px-4 py-3 text-red-300 text-sm">
          {error}
        </div>
      )}

      {!registrationOpen && (
        <p className="text-xs text-gray-600 text-center">
          {t("Accounts are issued by an administrator.")}
        </p>
      )}

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
