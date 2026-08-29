"use client";

/**
 * The site's only sign-in form.
 *
 * It is used in two places and is the same component in both: full-page at
 * /login (where /review sends anyone who is not signed in), and inline in the
 * app where an upload mode needs an account. There is deliberately no second
 * login form anywhere — the review panel used to have its own, which is how a
 * reviewer could end up able to sign in on one page and not the other.
 *
 * Everyone uses it: an account made by the signup form, a reader, an admin.
 * What the account can reach afterwards is decided by the servers, not here.
 *
 * Two steps, and the second is usually skipped:
 *
 *   credentials  username + password, or the signup tab when it is open.
 *   newPassword  only for a reviewer still holding the one-time password an
 *                admin issued. The panel will not show an image until it is
 *                replaced, so we ask here rather than sending them elsewhere.
 */

import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { useLanguage } from "@/lib/i18n";

export default function LoginPanel({
  onOpenDemos,
  onSignedIn,
  standalone = false,
}: {
  onOpenDemos?: () => void;
  /** Called once the session is live. The inline use needs nothing — the provider unmounts this. */
  onSignedIn?: () => void;
  /** Full-page at /login: own heading, no "try a demo instead" escape hatch by default. */
  standalone?: boolean;
}) {
  const { t } = useLanguage();
  const { login, register, setNewPassword, registrationOpen, inviteRequired } = useAuth();
  const [step, setStep] = useState<"credentials" | "newPassword">("credentials");
  const [tab, setTab] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [invite, setInvite] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const registering = tab === "register";

  /**
   * What is really in the fields, whatever React thinks.
   *
   * A browser restoring saved credentials writes them into the DOM without
   * firing the events React listens for, so state can still be empty while the
   * form on screen is visibly complete. Reading the form itself is the only
   * account of it that is true either way -- and it is why the button below is
   * never disabled for looking empty: that made a filled-in form look dead.
   */
  function read(form: HTMLFormElement) {
    const fd = new FormData(form);
    const of = (name: string, fallback: string) =>
      ((fd.get(name) as string | null) ?? "") || fallback;
    return {
      u: of("username", username).trim(),
      p: of("password", password),
      p2: of("password2", password2),
      inv: of("invite", invite).trim(),
    };
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const { u, p, p2, inv } = read(e.currentTarget as HTMLFormElement);
    // An empty form is answered with a sentence rather than with a control
    // nobody can press.
    if (!u || !p) {
      setError(t("Enter your username and password."));
      return;
    }
    // The change-password step needs the credentials that just worked, and it
    // reads them from state -- which autofill may never have reached.
    setUsername(u);
    setPassword(p);
    // Only on signup. Signing IN needs no confirmation: a wrong password there
    // just fails and can be retried, and a second field would be friction.
    if (registering && p !== p2) {
      setError(t("Passwords do not match."));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = registering
        ? await register(u, p, inv)
        : await login(u, p);
      if (!result.done) {
        // Password was right; it is just the one an admin issued. Keep it in
        // state — the change needs it as the current password, and making
        // someone retype what they just typed is friction for no security.
        //
        // result.detail is deliberately NOT shown. The server sends one string
        // carrying both languages, because other clients see it as an API
        // error; on screen that reads as Farsi and English at once and ignores
        // the language toggle. Say it here instead, in one language.
        setStep("newPassword");
        return;
      }
      onSignedIn?.();
      // Inline, the provider sets `user`, which unmounts this.
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitNewPassword(e: React.FormEvent) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget as HTMLFormElement);
    const a = ((fd.get("newPassword") as string | null) ?? "") || newPw;
    const b = ((fd.get("newPassword2") as string | null) ?? "") || newPw2;
    // Two blanks would "match", so emptiness is checked before equality.
    if (!a || !b) { setError(t("Choose a password, twice.")); return; }
    if (a !== b) { setError(t("Passwords do not match.")); return; }
    setNewPw(a);
    setNewPw2(b);
    setBusy(true);
    setError("");
    try {
      await setNewPassword(username, password, a);
      onSignedIn?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const field =
    "w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-700 text-white " +
    "placeholder-gray-600 focus:border-blue-500 focus:outline-none transition-colors";
  const button =
    "w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium " +
    "transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

  const errorBox = error && (
    <div className="bg-red-950 border border-red-800 rounded-lg px-4 py-3 text-red-300 text-sm">
      {error}
    </div>
  );

  if (step === "newPassword") {
    return (
      <div className="max-w-md mx-auto space-y-5 py-6">
        <div className="text-center space-y-2">
          <p className="text-3xl">🔑</p>
          <h2 className="text-lg font-medium text-white">{t("Choose your own password")}</h2>
          <p className="text-sm text-gray-500">
            {t("This account uses a one-time password. Choose your own to continue.")}
          </p>
        </div>

        <form onSubmit={submitNewPassword} className="space-y-3">
          <input
            className={field}
            name="newPassword"
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            placeholder={t("New password")}
            autoComplete="new-password"
            autoFocus
          />
          <input
            className={field}
            name="newPassword2"
            type="password"
            value={newPw2}
            onChange={(e) => setNewPw2(e.target.value)}
            placeholder={t("Repeat new password")}
            autoComplete="new-password"
          />
          <p className="text-xs text-gray-600">
            {t("At least 12 characters, using three of: lower case, upper case, digits, symbols.")}
          </p>
          <button type="submit" disabled={busy} className={button}>
            {busy ? t("Please wait…") : t("Save and continue")}
          </button>
        </form>

        {errorBox}
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto space-y-5 py-6">
      <div className="text-center space-y-2">
        <p className="text-3xl">🔒</p>
        {/* With the tabs up, a heading reading "Sign in" above a tab reading
            "Sign in" above a button reading "Sign in" is just the same word
            three times. The tabs name the choice; let them. */}
        {!(standalone && registrationOpen) && (
          <h2 className="text-lg font-medium text-white">
            {standalone ? t("Sign in") : t("Sign in to analyse your own video")}
          </h2>
        )}
        <p className="text-sm text-gray-500">
          {standalone
            ? t("Sign in to continue.")
            : t("Uploading runs the model on a GPU, so it needs an account. Live camera, screen share and the demo clips are open to everyone.")}
        </p>
      </div>

      {registrationOpen && (
        <div className="flex gap-1 border-b border-gray-800">
          {(["login", "register"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => { setTab(key); setError(""); setPassword2(""); }}
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
          name="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t("Username")}
          autoComplete="username"
          autoFocus
        />
        <input
          className={field}
          name="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t("Password")}
          autoComplete={registering ? "new-password" : "current-password"}
        />
        {registering && (
          <input
            className={field}
            name="password2"
            type="password"
            value={password2}
            onChange={(e) => setPassword2(e.target.value)}
            placeholder={t("Repeat password")}
            autoComplete="new-password"
          />
        )}
        {registering && inviteRequired && (
          <input
            className={field}
            name="invite"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            placeholder={t("Invite code")}
          />
        )}

        <button
          type="submit"
          disabled={busy}
          className={button}
        >
          {busy ? t("Please wait…") : registering ? t("Create account") : t("Sign in")}
        </button>
      </form>

      {errorBox}

      {registering ? (
        <p className="text-xs text-gray-600 text-center">
          {t("An account here lets you upload and analyse video. Access to the clinical review panel is issued by an administrator.")}
        </p>
      ) : (
        !registrationOpen && (
          <p className="text-xs text-gray-600 text-center">
            {t("Accounts are issued by an administrator.")}
          </p>
        )
      )}

      {onOpenDemos && (
        <button
          type="button"
          onClick={onOpenDemos}
          className="w-full text-sm text-gray-500 hover:text-gray-300 transition-colors"
        >
          {t("← Try a demo clip instead (no account needed)")}
        </button>
      )}
    </div>
  );
}
