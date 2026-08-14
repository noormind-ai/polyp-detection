"use client";

/**
 * Browse and play back sessions that were recorded to the server.
 *
 * Used twice: scoped to one case inside the live player (what did we just
 * record?), and unscoped as its own mode from the landing screen (everything
 * on this server). Both need an account — the list endpoint 401s otherwise,
 * and that is rendered as a sign-in prompt rather than an error.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import { formatBytes, formatDuration } from "./RecordingControls";

const API = process.env.NEXT_PUBLIC_API_URL || "";

interface Recording {
  id: string;
  case_id: string;
  user: string;
  source: "camera" | "screen";
  mime: string;
  ext: string;
  width: number;
  height: number;
  started_at: number;
  ended_at: number | null;
  duration_ms: number;
  chunks: number;
  bytes: number;
  status: "recording" | "complete" | "truncated" | "interrupted";
}

const videoUrl = (r: Recording) => `${API}/api/recordings/${r.case_id}/${r.id}/video`;

/**
 * A WebM written by MediaRecorder in streaming mode carries no duration in its
 * header, so the browser reports Infinity and the seek bar is dead. Seeking
 * absurdly far past the end forces it to scan to the last cluster and resolve
 * the real duration; then we put the playhead back at the start. Without this,
 * playback works but scrubbing does not — which is most of the point of having
 * the recording at all.
 */
function useDurationFix(video: HTMLVideoElement | null) {
  useEffect(() => {
    if (!video) return;
    let scanning = false;

    const onMeta = () => {
      if (scanning || Number.isFinite(video.duration)) return;
      scanning = true;
      video.currentTime = 1e101;
    };

    // Keyed on durationchange rather than on seeked. A seeked event cannot be
    // told apart from one the viewer caused, so watching for it meant a scrub
    // that landed while the scan was still running got yanked back to zero —
    // which is exactly when someone is most likely to grab the scrub bar.
    // durationchange fires once, when the scan teaches the browser the real
    // length, and clearing the flag before restoring the playhead means every
    // later seek is left alone.
    const onDurationChange = () => {
      if (!scanning || !Number.isFinite(video.duration)) return;
      scanning = false;
      video.currentTime = 0;
      video.removeEventListener("durationchange", onDurationChange);
    };

    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("durationchange", onDurationChange);
    return () => {
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("durationchange", onDurationChange);
    };
  }, [video]);
}

export default function RecordingsPanel({
  caseId,
  refreshSignal,
  title,
}: {
  caseId?: string;
  refreshSignal?: number;
  title?: string;
}) {
  const { t, lang } = useLanguage();
  const { user, loading: authLoading } = useAuth();
  const [items, setItems] = useState<Recording[]>([]);
  const [selected, setSelected] = useState<Recording | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState("");
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const busyRef = useRef(false);

  useDurationFix(videoEl);

  const load = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    try {
      const qs = caseId ? `?case_id=${encodeURIComponent(caseId)}` : "";
      const res = await fetch(`${API}/api/recordings${qs}`, { credentials: "include" });
      if (res.status === 401) { setDenied(true); setItems([]); return; }
      if (!res.ok) throw new Error(String(res.status));
      setDenied(false);
      setItems(await res.json());
      setError("");
    } catch {
      setError(t("Could not load recordings from the server."));
    } finally {
      setLoading(false);
    }
  }, [caseId, user, t]);

  useEffect(() => { load(); }, [load, refreshSignal]);

  // A recording in progress grows; poll so its size and the "still recording"
  // badge stay honest without the operator reloading the page.
  useEffect(() => {
    if (!items.some((r) => r.status === "recording")) return;
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [items, load]);

  async function remove(r: Recording) {
    if (busyRef.current) return;
    if (!window.confirm(t("Delete this recording permanently? This cannot be undone."))) return;
    busyRef.current = true;
    try {
      const res = await fetch(`${API}/api/recordings/${r.case_id}/${r.id}`,
                              { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error(String(res.status));
      if (selected?.id === r.id) setSelected(null);
      await load();
    } catch {
      setError(t("Could not delete that recording."));
    } finally {
      busyRef.current = false;
    }
  }

  const when = (ts: number) =>
    new Date(ts * 1000).toLocaleString(lang === "fa" ? "fa-IR" : "en-GB", {
      dateStyle: "short", timeStyle: "short",
    });

  const statusBadge = (r: Recording) => {
    if (r.status === "recording") return { text: t("recording…"), cls: "text-red-400 border-red-900 bg-red-950/40" };
    if (r.status === "truncated") return { text: t("size limit"), cls: "text-amber-400 border-amber-900 bg-amber-950/40" };
    if (r.status === "interrupted") return { text: t("interrupted"), cls: "text-amber-400 border-amber-900 bg-amber-950/40" };
    return { text: t("saved"), cls: "text-green-400 border-green-900 bg-green-950/40" };
  };

  if (authLoading) return null;

  if (!user || denied) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3 text-sm text-gray-500">
        {t("🔒 Sign in to watch recorded sessions.")}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm text-gray-400 uppercase tracking-wide">
          {title ?? t("Saved recordings")}
        </h3>
        <button
          onClick={load}
          className="text-xs px-2 py-0.5 rounded-md border border-gray-800 text-gray-500 hover:text-gray-300 hover:border-gray-600 transition-colors"
        >
          {t("Refresh")}
        </button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {selected && (
        <div className="space-y-2 rounded-xl border border-gray-800 bg-black p-2">
          <video
            // Keyed on the recording so switching selection actually reloads the
            // element instead of leaving the previous source attached.
            key={selected.id}
            ref={setVideoEl}
            src={videoUrl(selected)}
            controls
            playsInline
            className="w-full rounded-lg bg-black max-h-[70vh]"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-gray-500">
            <span className="font-mono">
              {t("case {case} · {when}", { case: selected.case_id, when: when(selected.started_at) })}
            </span>
            <span className="flex items-center gap-3">
              <a
                href={videoUrl(selected)}
                download={`${selected.case_id}-${selected.id}${selected.ext}`}
                className="text-gray-400 hover:text-gray-200 underline transition-colors"
              >
                {t("Download")}
              </a>
              <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-200 transition-colors">
                {t("Close player")}
              </button>
            </span>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-600">{t("Loading…")}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-600">
          {caseId
            ? t("Nothing recorded in this session yet. Press “Record this session” to start one.")
            : t("No sessions have been recorded on this server yet.")}
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((r) => {
            const badge = statusBadge(r);
            const isOpen = selected?.id === r.id;
            const playable = r.bytes > 0;
            return (
              <li
                key={`${r.case_id}/${r.id}`}
                className={`rounded-xl border px-3 py-2 transition-colors ${
                  isOpen ? "border-purple-700 bg-purple-950/20" : "border-gray-800 bg-gray-900/40"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <button
                    onClick={() => playable && setSelected(isOpen ? null : r)}
                    disabled={!playable}
                    className="flex-1 min-w-0 text-left disabled:cursor-not-allowed"
                  >
                    <div className="flex items-center gap-2">
                      <span>{r.source === "screen" ? "🖥️" : "📹"}</span>
                      <span className="text-sm text-gray-200 truncate">{when(r.started_at)}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border flex-shrink-0 ${badge.cls}`}>
                        {badge.text}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-gray-500 font-mono truncate">
                      {t("{duration} · {size}", {
                        duration: r.duration_ms ? formatDuration(r.duration_ms) : "—",
                        size: formatBytes(r.bytes),
                      })}
                      {!caseId && ` · ${t("case {case}", { case: r.case_id })}`}
                      {r.user && ` · ${r.user}`}
                    </div>
                  </button>
                  <button
                    onClick={() => remove(r)}
                    className="text-xs text-gray-600 hover:text-red-400 transition-colors flex-shrink-0"
                  >
                    {t("Delete")}
                  </button>
                </div>
                {!playable && (
                  <p className="mt-1 text-xs text-gray-600">{t("No video data was saved for this one.")}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
