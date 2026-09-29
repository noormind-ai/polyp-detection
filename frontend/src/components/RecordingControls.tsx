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

interface RecordingControlsProps {
  recorder: SessionRecorder;
  ready: boolean;
  /** Whole auto-pause/resume-on-body-transition feature, on/off. Persisted by
   *  the caller (localStorage), same pattern as useInBodyGate's own switch. */
  autoRecordEnabled: boolean;
  onAutoRecordEnabledChange: (v: boolean) => void;
  /** "auto" follows in-body/out-of-body; "on"/"off" is a manual override that
   *  holds until the next real transition, then reverts to "auto" on its own —
   *  this component just reflects whichever the caller reports. */
  recordOverride: "auto" | "on" | "off";
  onRecordOverrideChange: (v: "on" | "off") => void;
}

export default function RecordingControls({
  recorder, ready, autoRecordEnabled, onAutoRecordEnabledChange, recordOverride, onRecordOverrideChange,
}: RecordingControlsProps) {
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
        onClick={() => {
          // Both directions are a manual override, same as the Pause/Resume
          // buttons below -- without this, stopping a recording while still
          // inside the body would have auto-record start a brand new one on
          // the very next frame, since nothing else told it the operator
          // meant "done", not "paused". Holds until the next real
          // in/out-of-body transition, same rule as every other override here.
          onRecordOverrideChange(recording ? "off" : "on");
          if (recording) recorder.stop(); else void recorder.start();
        }}
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
          {recorder.capturing ? (
            <span className="flex items-center gap-1.5 text-red-400">
              <span className="w-2 h-2 rounded-full bg-red-500 inline-block animate-pulse" />
              {t("REC {time}", { time: formatDuration(recorder.elapsedMs) })}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-amber-400">
              <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" />
              {t("⏸ paused — out of body")}
            </span>
          )}
          <span className="text-gray-500">
            {t("{size} saved", { size: formatBytes(recorder.uploadedBytes) })}
          </span>
        </div>
      )}

      {/* Recorded (actual captured) time only shown once it has drifted from
          wall clock -- otherwise the two numbers are identical and just noise. */}
      {recording && recorder.recordedMs < recorder.elapsedMs - 1000 && (
        <p className="px-1 text-xs text-gray-500 font-mono">
          {t("recorded {rec} of {el} elapsed", {
            rec: formatDuration(recorder.recordedMs), el: formatDuration(recorder.elapsedMs),
          })}
        </p>
      )}

      {/* Always visible, not just while recording -- it also gates whether a
          recording auto-STARTS in the first place, so if it were hidden
          behind `recording &&` there would be no way back to "on" once it
          got switched off with nothing yet recording (a real deadlock this
          project shipped once already). Not persisted across sessions either,
          for the same reason -- see the comment on autoRecordEnabled. */}
      <label className="flex items-center gap-1.5 px-1 text-[11px] text-gray-500 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={autoRecordEnabled}
          onChange={(e) => onAutoRecordEnabledChange(e.target.checked)}
          className="accent-gray-500"
        />
        {t("auto-record while inside the body")}
      </label>

      {recording && (
        <div className="flex items-center gap-2 px-1">
          <button
            type="button"
            onClick={() => {
              if (recorder.capturing) { recorder.pause(); onRecordOverrideChange("off"); }
              else { recorder.resume(); onRecordOverrideChange("on"); }
            }}
            title={recorder.capturing
              ? t("Pauses now; resumes automatically on the next in/out-of-body change.")
              : t("Resumes immediately; will auto-pause again once the scope leaves the body.")}
            className="rounded-lg border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-white hover:border-gray-500 transition-colors"
          >
            {recorder.capturing ? t("⏸ Pause") : t("▶ Resume now")}
          </button>
          {recordOverride !== "auto" && (
            <span className="text-[11px] text-gray-600">{t("(manual, until next transition)")}</span>
          )}
        </div>
      )}

      {recording && recorder.storageKind === "memory" && (
        <p className="px-1 text-xs text-amber-400">
          {t("⚠ This browser cannot durably save video while recording — closing this tab or a crash will lose everything not yet uploaded. Use Chrome or Edge.")}
        </p>
      )}

      {recorder.localBytes > 0 && (
        <button
          onClick={recorder.downloadLocal}
          className="w-full py-2 px-4 rounded-xl border border-gray-700 text-gray-300 hover:text-white hover:border-gray-500 text-xs font-medium transition-colors"
        >
          {t("⬇ Save to my computer ({size})", { size: formatBytes(recorder.localBytes) })}
        </button>
      )}

      {/* Not just "stopping" anymore -- pause() now fires an opportunistic
          trickle upload during every out-of-body stretch (see
          LiveCameraPlayer.tsx), so upload progress is real and worth showing
          mid-recording too, not only during the final Stop-triggered drain. */}
      {(recorder.status === "stopping" || recorder.waitingForLink
        || (recorder.totalChunks > 0 && recorder.uploadedChunks < recorder.totalChunks)) && (
        <div className="space-y-1 px-1">
          {recorder.waitingForLink ? (
            <p className="text-xs text-amber-400">
              {t("⏳ Waiting — the link is busy with a live procedure right now. Upload will resume the moment it's free.")}
            </p>
          ) : (
            <>
              <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden">
                <div
                  className="h-full bg-sky-500 transition-all"
                  style={{ width: recorder.totalChunks > 0
                    ? `${Math.round((recorder.uploadedChunks / recorder.totalChunks) * 100)}%` : "0%" }}
                />
              </div>
              <p className="text-xs text-gray-500">
                {recorder.totalChunks > 0
                  ? t("Uploading… {done} of {total} pieces ({size} sent)", {
                      done: recorder.uploadedChunks, total: recorder.totalChunks,
                      size: formatBytes(recorder.uploadedBytes),
                    })
                  : t("Uploading to the server…")}
              </p>
            </>
          )}
          <p className="text-[11px] text-gray-600">
            {t("Keep this tab open. Or save it to your computer now; the upload continues either way.")}
          </p>
        </div>
      )}

      {recorder.error && (
        <p className="px-1 text-xs text-red-400 break-words">{recorder.error}</p>
      )}
    </div>
  );
}
