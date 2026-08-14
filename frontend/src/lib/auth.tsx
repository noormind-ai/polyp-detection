"use client";

/**
 * Session state for the upload modes.
 *
 * Only the two paths that push a NEW video through the GPU need an account —
 * whole-file upload and the frame-by-frame upload player. Live camera, screen
 * share and the precomputed demos are open, so most of the app never touches
 * this beyond reading `user` to decide what the mode picker shows.
 *
 * The session lives in an httpOnly cookie, which JS deliberately cannot read;
 * `user` here comes from asking the server (/api/me), never from the cookie.
 */

import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "";

interface AuthContextValue {
  user: string | null;
  /** true until the first /api/me answers — lets the UI avoid flashing a login prompt at someone who IS signed in */
  loading: boolean;
  registrationOpen: boolean;
  inviteRequired: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, invite: string) => Promise<void>;
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [inviteRequired, setInviteRequired] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/me`, { credentials: "include" });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setUser(data.user ?? null);
      setRegistrationOpen(!!data.registration_open);
      setInviteRequired(!!data.invite_required);
    } catch {
      // Backend down or unreachable — treat as signed out rather than blocking
      // the whole page, since the open modes still work without it.
      setUser(null);
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
    const data = await res.json();
    setUser(data.user ?? null);
  }

  const login = (username: string, password: string) =>
    submit("/api/login", { username, password }, "Sign-in failed.");

  const register = (username: string, password: string, invite: string) =>
    submit("/api/register", { username, password, invite }, "Registration failed.");

  const logout = async () => {
    try {
      await fetch(`${API}/api/logout`, { method: "POST", credentials: "include" });
    } finally {
      setUser(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{ user, loading, registrationOpen, inviteRequired, login, register, logout }}
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
