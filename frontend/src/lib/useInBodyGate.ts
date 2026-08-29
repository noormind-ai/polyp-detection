"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { InBodyGate, type InBodyFeatures } from "./inBody";

const STORAGE_KEY = "polyp_inbody_filter";
const MAX_EVENTS = 12;
// The score readout is a diagnostic, not a control. Pushing it into React
// state on every frame re-rendered the entire player at inference rate; the
// eye cannot read it that fast anyway.
const UI_THROTTLE_MS = 400;

export interface InBodyEvent {
  at: number;       // epoch ms
  inside: boolean;  // state entered
  p: number;
}

export interface InBodyGateState {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  inside: boolean;
  p: number;
  skipped: number;      // frames not sent because the scope was out of body
  events: InBodyEvent[];
  /** Call with the frame about to be sent. False => skip it, don't infer. */
  shouldInfer: (source: CanvasImageSource) => boolean;
  reset: () => void;
}

/**
 * Wraps InBodyGate in the state the UI needs: the on/off switch (persisted, so a
 * site that turns the filter off stays off across reloads), the current verdict,
 * a skipped-frame count and a short transition log.
 *
 * The switch is the point: this is a heuristic with a wide but not yet
 * negative-validated margin, so an operator who sees it misbehave must be able to
 * turn it off mid-procedure without restarting the session.
 */
export function useInBodyGate(): InBodyGateState {
  const [enabled, setEnabledState] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(STORAGE_KEY) !== "off";
  });
  const [inside, setInside] = useState(true);
  const [p, setP] = useState(1);
  const [skipped, setSkipped] = useState(0);
  const [events, setEvents] = useState<InBodyEvent[]>([]);
  const gateRef = useRef<InBodyGate | null>(null);
  const lastUi = useRef(0);
  const skippedRef = useRef(0);
  // The send loop captures shouldInfer once, when it starts. Reading `enabled`
  // through a ref is what lets the switch take effect mid-procedure instead of
  // at the next session.
  const enabledRef = useRef(enabled);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, v ? "on" : "off");
    }
    // Re-enabling mid-session must not inherit a stale verdict.
    gateRef.current?.reset(true);
    setInside(true);
    setP(1);
    console.info(`[in-body] filter ${v ? "enabled" : "disabled by user"}`);
  }, []);

  const reset = useCallback(() => {
    gateRef.current?.reset(true);
    setInside(true);
    setP(1);
    setSkipped(0);
    setEvents([]);
  }, []);

  const shouldInfer = useCallback((source: CanvasImageSource) => {
    if (!enabledRef.current) return true;
    if (!gateRef.current) gateRef.current = new InBodyGate();
    const gate = gateRef.current;
    const was = gate.inside;
    const { inside: now, p: prob, f, evaluated } = gate.update(source);

    // Nothing was measured on this frame, so there is nothing new to render.
    if (!evaluated) return now;

    const t = Date.now();
    if (t - lastUi.current > UI_THROTTLE_MS) {
      lastUi.current = t;
      setP(prob);
    }
    if (now !== was) {
      setP(prob);
      setInside(now);
      setEvents((e) => [{ at: Date.now(), inside: now, p: prob }, ...e].slice(0, MAX_EVENTS));
      logTransition(now, prob, f);
    }
    // Counter accumulates in a ref and rides the same throttle as the score —
    // a state update per out-of-body frame re-rendered the whole player.
    if (!now) {
      skippedRef.current += 1;
      if (t - lastUi.current === 0) setSkipped(skippedRef.current);
    }
    return now;
  }, []);

  return { enabled, setEnabled, inside, p, skipped, events, shouldInfer, reset };
}

function logTransition(inside: boolean, p: number, f: InBodyFeatures | null) {
  const detail = f
    ? ` redness=${f.redness.toFixed(3)} hueRed=${f.hueRedFrac.toFixed(3)} sat=${f.satMean.toFixed(3)}`
    : "";
  if (inside) {
    console.info(`[in-body] back inside the colon — inference resumed (p=${p.toFixed(3)})${detail}`);
  } else {
    console.warn(`[in-body] OUT OF BODY detected — inference paused, frames are not being sent (p=${p.toFixed(3)})${detail}`);
  }
}
