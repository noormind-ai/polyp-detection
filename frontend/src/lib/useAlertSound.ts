"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createAlertGate } from "./alertEpisodeGate";
import { createAlertVoice } from "./alertSound";

/** Tier 3, whole. Every view that can show a detection drives its alert through
 *  this hook and nothing else, so the three of them cannot drift apart again --
 *  which they had: the room player was gating on 2 s plus a confidence floor,
 *  the real-time file player was beeping once per filed capture (including each
 *  8 s refresh), and the spectator view on a 1 s/2-hit bar of its own.
 *
 *  The rule now, everywhere: a box appears on the video, the alert sounds; it
 *  runs for the operator's chosen duration, or stops early if the box goes away
 *  first; a box that disappears and comes back sounds again. The trigger is
 *  tier 1's rendered box state and nothing else -- see alertEpisodeGate.ts. */

// Offered to the operator in the UI. 0.5 s is the default because it is the
// shortest interval Holzwanger et al. (Endoscopy 2021) found a CADe detection
// has to persist to carry information (specificity/accuracy 93.2%/97.8% at
// >=0.5 s), so it is long enough to be heard as a deliberate alert and short
// enough not to talk over the room.
export const ALERT_DURATIONS_MS = [250, 500, 1000, 2000];
export const DEFAULT_ALERT_MS = 500;

// Mute is per device: the room and a remote spectator each decide for
// themselves whether this machine makes noise. Duration is not -- it is part of
// the alerting rule, so it is one shared setting.
export const ROOM_ALERT_KEY = "polyp_alert_sound";
export const SPECTATOR_ALERT_KEY = "polyp_spectator_alert_sound";
const DURATION_KEY = "polyp_alert_ms";

export interface AlertSoundState {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  durationMs: number;
  setDurationMs: (ms: number) => void;
  /** Feed the box state rendered this frame, every frame -- including the
   *  frames with no boxes, or the gate can never see the edge. */
  onBoxState: (hasBox: boolean) => void;
  /** Session stop: silence anything sounding and forget the edge state. */
  reset: () => void;
}

export function useAlertSound(enabledKey: string = ROOM_ALERT_KEY): AlertSoundState {
  const gate = useRef(createAlertGate());
  const voice = useRef(createAlertVoice());

  // Read on the client only. Both of these are deliberately loaded in an
  // effect rather than in a useState initialiser: these components are
  // pre-rendered on the server, where localStorage does not exist, and seeding
  // state from it directly is a hydration mismatch.
  const [enabled, setEnabledState] = useState(false);
  const [durationMs, setDurationMsState] = useState(DEFAULT_ALERT_MS);
  // The inference callback captures onBoxState once, so the live values are
  // read through refs -- changing either mid-procedure has to take effect on
  // the next frame, not the next time the socket happens to be rebuilt.
  const enabledRef = useRef(false);
  const durationRef = useRef(DEFAULT_ALERT_MS);

  useEffect(() => {
    try {
      const on = window.localStorage.getItem(enabledKey) === "1";
      enabledRef.current = on;
      setEnabledState(on);
      const ms = Number(window.localStorage.getItem(DURATION_KEY));
      if (ALERT_DURATIONS_MS.includes(ms)) {
        durationRef.current = ms;
        setDurationMsState(ms);
      }
    } catch { /* a browser that will not give us localStorage still gets defaults */ }
  }, [enabledKey]);

  // Leaving the page mid-alert must not leave a tone running.
  useEffect(() => {
    const v = voice.current;
    return () => { v.stop(); };
  }, []);

  const setEnabled = useCallback((on: boolean) => {
    enabledRef.current = on;
    setEnabledState(on);
    // Muting is immediate, including part-way through an alert -- an operator
    // reaching for the toggle wants it quiet now, not in 2 s.
    if (!on) voice.current.stop();
    try { window.localStorage.setItem(enabledKey, on ? "1" : "0"); } catch { /* ignore */ }
  }, [enabledKey]);

  const setDurationMs = useCallback((ms: number) => {
    durationRef.current = ms;
    setDurationMsState(ms);
    try { window.localStorage.setItem(DURATION_KEY, String(ms)); } catch { /* ignore */ }
  }, []);

  const onBoxState = useCallback((hasBox: boolean) => {
    const edge = gate.current.update(hasBox);
    if (edge === null) return;
    // The gate is fed regardless of the mute, so that un-muting mid-appearance
    // does not fire a beep for a box that appeared minutes ago -- it waits for
    // the next real edge.
    if (edge === "start") {
      if (enabledRef.current) voice.current.start(durationRef.current);
    } else {
      voice.current.stop();
    }
  }, []);

  const reset = useCallback(() => {
    gate.current.reset();
    voice.current.stop();
  }, []);

  return { enabled, setEnabled, durationMs, setDurationMs, onBoxState, reset };
}
