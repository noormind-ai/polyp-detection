"use client";

/**
 * /spectator — the lobby: which live sessions exist right now, so watching
 * one is "open this page and click it" instead of "wait for someone in the
 * room to copy you a link". The room still surfaces its own link too (see
 * LiveCameraPlayer.tsx's "Copy spectator link") for the case where sending a
 * link is faster than asking someone to go find this page.
 *
 * Polls GET /api/spectate/rooms, which re-checks sign-in + the spectator
 * allowlist on every call — this page's own gating below is UX only, same
 * relationship as everywhere else spectator mode checks auth twice.
 */

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useLanguage } from "@/lib/i18n";

const API = process.env.NEXT_PUBLIC_API_URL || "";
const POLL_MS = 4000;

interface Room { case_id: string; started_at: number; engine: string; }

export default function SpectatorLobbyPage() {
  const { t, lang, toggleLang } = useLanguage();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) window.location.replace("/login?next=/spectator");
  }, [loading, user]);

  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [, forceTick] = useState(0); // re-renders "started Ns ago" once a second

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/spectate/rooms`, { credentials: "include" });
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) return;
      setForbidden(false);
      const data = await res.json();
      setRooms(data.rooms ?? []);
    } catch { /* transient — keep showing the last known list */ }
  }, []);

  useEffect(() => {
    if (!user) return;
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [user, poll]);

  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  function agoText(startedAt: number): string {
    const s = Math.max(0, Math.round(Date.now() / 1000 - startedAt));
    if (s < 60) return t("started {s}s ago", { s });
    return t("started {m}m ago", { m: Math.floor(s / 60) });
  }

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-3xl mx-auto p-4 sm:p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between mb-6 sm:mb-10">
          <div>
            <h1 className="text-xl sm:text-2xl font-semibold mb-1">{t("Spectate a live session")}</h1>
            <p className="text-gray-500 text-sm">{t("Sessions running right now, on any computer")}</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <a href="/" className="text-sm px-3 py-2 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors">
              {t("Home")}
            </a>
            <button onClick={toggleLang} className="text-sm px-3 py-2 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors">
              {lang === "fa" ? "English" : "فارسی"}
            </button>
          </div>
        </div>

        {!user ? (
          <p className="text-center text-gray-600 py-10">{t("Please wait…")}</p>
        ) : forbidden ? (
          <div className="bg-red-950 border border-red-800 rounded-lg px-3 py-2 text-red-300 text-sm">
            {t("This account is not on the spectator allowlist for this server. Ask an administrator to add it.")}
          </div>
        ) : rooms === null ? (
          <p className="text-center text-gray-600 py-10">{t("Loading…")}</p>
        ) : rooms.length === 0 ? (
          <p className="text-center text-gray-600 py-10">{t("No active sessions right now.")}</p>
        ) : (
          <div className="space-y-2">
            {rooms.map((r) => (
              <a
                key={r.case_id}
                href={`/spectator/${r.case_id}`}
                className="flex items-center justify-between gap-3 bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 hover:border-gray-600 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
                  <span className="font-mono text-sm">{r.case_id}</span>
                </div>
                <span className="text-xs text-gray-500">{agoText(r.started_at)}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
