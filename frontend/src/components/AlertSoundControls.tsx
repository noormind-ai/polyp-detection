"use client";

import { useLanguage } from "@/lib/i18n";
import { ALERT_DURATIONS_MS, type AlertSoundState } from "@/lib/useAlertSound";

/** Tier 3's controls: the mute toggle, and how long the alert sounds for.
 *
 *  Shared by the room player and the spectator view so the two offer the
 *  identical control over identical behaviour. The real-time file player
 *  deliberately has no controls of its own -- it reads the same stored settings
 *  so that a demo behaves like the room it is demonstrating. */
export default function AlertSoundControls({ alert }: { alert: AlertSoundState }) {
  const { t } = useLanguage();
  const { enabled, setEnabled, durationMs, setDurationMs } = alert;

  return (
    <span className="inline-flex items-center gap-1.5">
      {/* Off unless asked for: turning on audio in a procedure room is the
          operator's call, not a default. */}
      <button
        onClick={() => setEnabled(!enabled)}
        title={t("Sound a short alert the moment a detection appears on screen, and stop when it goes — the same trigger as the box itself.")}
        className={`text-xs px-2 py-0.5 rounded-md border transition-colors ${
          enabled
            ? "border-emerald-700 bg-emerald-950/40 text-emerald-300"
            : "border-gray-800 text-gray-500 hover:text-gray-300 hover:border-gray-600"
        }`}
      >
        {enabled ? t("Sound on") : t("Sound off")}
      </button>
      {/* Only shown once the sound is on — a duration for a muted alert is a
          control with nothing to control. */}
      {enabled && (
        <span className="inline-flex items-center gap-1 text-xs">
          <span
            className="text-gray-500"
            title={t("How long the alert sounds. It stops early if the detection leaves the screen first.")}
          >
            {t("for")}
          </span>
          {ALERT_DURATIONS_MS.map((ms) => (
            <button
              key={ms}
              onClick={() => setDurationMs(ms)}
              className={`px-1.5 py-0.5 rounded-md font-mono transition-colors ${
                durationMs === ms ? "bg-emerald-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
              }`}
            >
              {`${ms / 1000}s`}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
