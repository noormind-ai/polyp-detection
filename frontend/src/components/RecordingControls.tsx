"use client";

/**
 * Start/stop control for recording the whole session to the server.
 *
 * Sits at the top of the live player's left column, next to the "Dr. found a
 * polyp" button, because both are pressed mid-procedure by someone who should
 * not have to go looking for them.
 *
 * Recording needs an account. Live camera and screen share themselves are open
 * (see backend/auth.py), but a recording writes patient video to this server's
 * disk and serves it back afterwards, so it sits behind the same login as
 * playback rather than being available to anyone who opens the page.
 */

import { useLanguage } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import { SessionRecorder } from "@/lib/useSessionRecorder";

/** mm:ss, or h:mm:ss once a procedure runs past the hour. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function RecordingControls({ recorder, ready }: { recorder: SessionRecorder; ready: boolean }) {
  const { t } = useLanguage();
  const { user, loading } = useAuth();

  // Nothing at all until auth has answered — flashing "sign in to record" at
  // someone who IS signed in is worse than a moment of empty space.
  if (loading) return null;

  if (!user) {
    // Telling someone they need an account and then offering no way to get one
    // is a dead end. The button opens the same login panel the header does.
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-800 bg-gray-900/40 px-3 py-2 text-xs text-gray-500">
        <span>{t("🔒 Sign in to record this session and play it back later.")}</span>
        {(
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("polyp:signin"))}
            className="rounded-lg border border-blue-500/60 bg-blue-600/20 px-2.5 py-1 font-medium text-blue-200 hover:bg-blue-600/30"
          >
            {t("Sign in")}
          </button>
        )}
      </div>
    );
  }

  if (!recorder.supported) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/40 px-3 py-2 text-xs text-gray-500">
        {t("This browser cannot record video. Use Chrome or Edge to save a session.")}
      </div>
    );
  }

  const recording = recorder.status === "recording";
  const busy = recorder.status === "starting" || recorder.status === "stopping";

  return (
    <div className="space-y-1.5">
      <button
        onClick={recording ? recorder.stop : recorder.start}
        disabled={busy || (!recording && !ready)}
        className={`w-full py-2.5 px-4 rounded-xl text-white font-medium text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
          recording ? "bg-red-700 hover:bg-red-600" : "bg-gray-800 hover:bg-gray-700"
        }`}
      >
        {recorder.status === "starting" ? t("Starting recording…")
          : recorder.status === "stopping" ? t("Saving recording…")
          : recording ? t("■ Stop recording")
          : t("● Record this session")}
      </button>

      {recording && (
        <div className="flex items-center justify-between gap-2 px-1 text-xs font-mono">
          <span className="flex items-center gap-1.5 text-red-400">
            <span className="w-2 h-2 rounded-full bg-red-500 inline-block animate-pulse" />
            {t("REC {time}", { time: formatDuration(recorder.elapsedMs) })}
          </span>
          <span className="text-gray-500">
            {t("{size} saved", { size: formatBytes(recorder.uploadedBytes) })}
          </span>
        </div>
      )}

      {recorder.error && (
        <p className="px-1 text-xs text-red-400 break-words">{recorder.error}</p>
      )}
    </div>
  );
}
