"use client";

/**
 * Session state, and the one sign-in the whole site shares.
 *
 * ONE FORM, TWO ACCOUNT STORES
 * ----------------------------
 * There is a single login form (LoginPanel) and a single page it lives on
 * (/login). Everyone types into it: someone who signed up here, a reviewer, an
 * admin. What differs is what the account can then reach, never the way in.
 *
 * Behind it are two independent stores, and they stay independent on purpose:
 *
 *   this app     backend/auth.py — signup accounts and the operator account.
 *                Unlocks uploading a video.
 *   the panel    /review — accounts an admin issued, holding patient images.
 *                Its own users table, its own Argon2, its own sessions.
 *
 * `POST /api/login` already answers for BOTH (it reads the panel's database
 * read-only), so it alone decides whether the credentials are good. But it
 * cannot mint a panel session — that means writing the panel's session table
 * and issuing its CSRF token, which only the panel may do. So for a reviewer
 * we make a second, quiet call to /review/api/login with the same credentials.
 * The user sees one form and one submit; /review then opens without asking
 * again. Each service still authorises for itself, which is the point: nothing
 * here can talk this app's session into becoming access to patient images.
 *
 * THE ONE-TIME PASSWORD STEP
 * --------------------------
 * A reviewer's first password is issued by an admin and read out to them. The
 * panel insists it be replaced before showing a single image. So /api/login can
 * answer "correct, but choose your own first" — {ok:false, action:
 * "change_password"} — and the form turns that into one extra step instead of a
 * dead end. See setNewPassword.
 *
 * The session lives in an httpOnly cookie, which JS deliberately cannot read;
 * `user` here comes from asking the server (/api/me), never from the cookie.
 */

import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "";

/**
 * The panel is always same-origin at /review — nginx puts it there, and its
 * cookie is scoped to that path. It is deliberately NOT under NEXT_PUBLIC_API_URL:
 * that points at this app's backend, which is a different service.
 */
const PANEL = "/review/api";

/** What a submitted login came back with. */
export type LoginResult =
  | { done: true }
  /** Credentials were right; the account must replace its one-time password. */
  | { done: false; reason: "change_password"; detail: string };

interface PanelMe {
  username: string;
  display_name: string;
  role: string;
  must_change_pw: boolean;
  csrf: string;
}

interface AuthContextValue {
  user: string | null;
  /** true until the first /api/me answers — lets the UI avoid flashing a login prompt at someone who IS signed in */
  loading: boolean;
  registrationOpen: boolean;
  inviteRequired: boolean;
  /** signed-in name is also an account in the clinical review panel */
  reviewer: boolean;
  /** "admin" | "reader" for a panel account, else null. Display only. */
  reviewRole: string | null;
  login: (username: string, password: string) => Promise<LoginResult>;
  register: (username: string, password: string, invite: string) => Promise<LoginResult>;
  /** Replace an admin-issued one-time password, then sign in. */
  setNewPassword: (username: string, current: string, next: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Server sends {detail: "..."} on 4xx; fall back to something readable. */
async function errorFrom(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") return body.detail;
  } catch { /* not JSON */ }
  return fallback;
}

/**
 * Sign in to the review panel, so /review opens without a second login.
 *
 * Succeeds for a must-change account too — the panel issues a session and a
 * CSRF token precisely so the account can change its own password, and blocks
 * everything else until it has.
 */
async function panelLogin(username: string, password: string): Promise<PanelMe> {
  const res = await fetch(`${PANEL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username: username.trim(), password }),
  });
  if (!res.ok) throw new Error(await errorFrom(res, "Sign-in failed."));
  return res.json();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [inviteRequired, setInviteRequired] = useState(false);
  const [reviewer, setReviewer] = useState(false);
  const [reviewRole, setReviewRole] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/me`, { credentials: "include" });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setUser(data.user ?? null);
      setRegistrationOpen(!!data.registration_open);
      setInviteRequired(!!data.invite_required);
      setReviewer(!!data.reviewer);
      setReviewRole(data.review_role ?? null);
    } catch {
      // Backend down or unreachable — treat as signed out rather than blocking
      // the whole page, since the open modes still work without it.
      setUser(null);
      setReviewer(false);
      setReviewRole(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function submit(path: string, fields: Record<string, string>, fallback: string) {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.append(k, v);
    const res = await fetch(`${API}${path}`, { method: "POST", body, credentials: "include" });
    if (!res.ok) throw new Error(await errorFrom(res, fallback));
    return res.json();
  }

  /**
   * Finish a successful sign-in.
   *
   * `review` is the panel role the backend saw for this name, and is the cue to
   * go and mint the panel's own session as well. If that second call fails the
   * sign-in still stands — the app works, and /review will simply ask again.
   */
  async function completeLogin(username: string, password: string, review: string | null) {
    if (review) {
      try { await panelLogin(username, password); } catch { /* /review will ask */ }
    }
    // Ask the server who we are rather than trusting the login reply, so
    // `reviewer` and `reviewRole` are right immediately — the "Clinical review"
    // link used to stay hidden until the next page load.
    await refresh();
    return { done: true } as const;
  }

  const login = async (username: string, password: string): Promise<LoginResult> => {
    const data = await submit("/api/login", { username, password }, "Sign-in failed.");
    if (data?.ok === false && data?.action === "change_password") {
      return {
        done: false,
        reason: "change_password",
        detail: data.detail || "This account uses a one-time password. Choose your own to continue.",
      };
    }
    return completeLogin(username, password, data?.review ?? null);
  };

  const register = async (username: string, password: string, invite: string): Promise<LoginResult> => {
    const data = await submit("/api/register", { username, password, invite }, "Registration failed.");
    // A signup account is never a panel account, so there is nothing to mint.
    return completeLogin(username, password, data?.review ?? null);
  };

  /**
   * Replace an admin-issued one-time password, then sign in properly.
   *
   * The panel owns these accounts, their Argon2 hashes and their password
   * rules, so the change is made there and this app never sees either password
   * in storage. Signing in to the panel first is what yields the session and
   * CSRF token the change needs.
   */
  const setNewPassword = async (username: string, current: string, next: string): Promise<LoginResult> => {
    const me = await panelLogin(username, current);
    const res = await fetch(`${PANEL}/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": me.csrf },
      credentials: "include",
      body: JSON.stringify({ current, new: next }),
    });
    if (!res.ok) throw new Error(await errorFrom(res, "Could not set the new password."));
    // The account is now ordinary, so this app will issue a session for it.
    const data = await submit("/api/login", { username, password: next }, "Sign-in failed.");
    return completeLogin(username, next, data?.review ?? me.role);
  };

  const logout = async () => {
    // Sign out of both, since there was only ever one sign-in. The panel call
    // is best-effort: not being signed in there is not a failure to sign out.
    try { await fetch(`${PANEL}/logout`, { method: "POST", credentials: "include" }); } catch { /* fine */ }
    try {
      await fetch(`${API}/api/logout`, { method: "POST", credentials: "include" });
    } finally {
      setUser(null);
      setReviewer(false);
      setReviewRole(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{ user, loading, registrationOpen, inviteRequired, reviewer, reviewRole,
               login, register, setNewPassword, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
