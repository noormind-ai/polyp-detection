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

import { useEffect, useState } from "react";
import OnScreenKeyboard from "@/components/OnScreenKeyboard";
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
  const { login, register, setNewPassword, registrationOpen, inviteRequired,
          kioskSignin, kioskLogin } = useAuth();
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

  /**
   * Clickable keyboard, for a machine that has a mouse and nothing else.
   *
   * The clinic PC is exactly that, and the kiosk browser keeps its own fresh
   * profile -- so the first thing it ever shows is a login form, with no way
   * to fill it in. Shown there automatically; everywhere else it is a button,
   * because a visitor with no keyboard has no other way to ask for one.
   *
   * It types by calling the focused field's own setter rather than faking
   * input events on the DOM node, which is what usually breaks with React's
   * controlled inputs.
   */
  type Field = "username" | "password" | "password2" | "invite";
  const [kbField, setKbField] = useState<Field>("username");
  const [kbOpen, setKbOpen] = useState(false);
  useEffect(() => {
    try { if (localStorage.getItem("polyp_kiosk") === "1") setKbOpen(true); } catch { /* ignore */ }
  }, []);

  const SETTERS: Record<Field, (fn: (v: string) => string) => void> = {
    username:  (fn) => setUsername(fn),
    password:  (fn) => setPassword(fn),
    password2: (fn) => setPassword2(fn),
    invite:    (fn) => setInvite(fn),
  };
  const FIELD_LABELS: Record<Field, string> = {
    username:  t("Username"),
    password:  t("Password"),
    password2: t("Repeat password"),
    invite:    t("Invite code"),
  };
  const kbType  = (ch: string) => SETTERS[kbField]((v) => v + ch);
  const kbBack  = ()           => SETTERS[kbField]((v) => v.slice(0, -1));
  const kbClear = ()           => SETTERS[kbField](() => "");

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

      {/* The emergency door, and only while the server is holding it open.
          One button because that is all the clinic PC can manage: it has a
          mouse and no keyboard, and its launcher reloads the page every few
          seconds, so anything needing several clicks never completes. */}
      {kioskSignin && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true); setError("");
            try { await kioskLogin(); onSignedIn?.(); }
            catch (e) { setError(e instanceof Error ? e.message : String(e)); }
            finally { setBusy(false); }
          }}
          className="w-full mb-4 py-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-lg font-semibold transition-colors"
        >
          {busy ? t("Please wait…") : t("Sign in as {user} (clinic PC)", { user: kioskSignin })}
        </button>
      )}

      <form onSubmit={submit} className="space-y-3">
        <input
          className={field}
          name="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onFocus={() => setKbField("username")}
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
          onFocus={() => setKbField("password")}
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
            onFocus={() => setKbField("password2")}
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
            onFocus={() => setKbField("invite")}
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

      {kbOpen ? (
        <OnScreenKeyboard
          label={t("Typing into: {field}", { field: FIELD_LABELS[kbField] })}
          onKey={kbType}
          onBackspace={kbBack}
          onClear={kbClear}
          onClose={() => setKbOpen(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setKbOpen(true)}
          className="mt-3 w-full text-sm px-3 py-2 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors"
        >
          {t("⌨ No keyboard? Type with the mouse")}
        </button>
      )}

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
