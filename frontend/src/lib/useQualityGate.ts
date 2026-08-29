"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  frameQuality, isInformative, DEFAULTS, LEVELS, DEFAULT_LEVEL,
  type QualityMetrics, type Reason, type LevelKey,
} from "./frameQuality";

const STORAGE_KEY = "polyp_quality_filter";
// On by default at the user's request. At the `medium` level this rejects 3.5%
// of frames a doctor called `polyp` in exchange for 20.4% of the ones a doctor
// called `noisy`. That cost is real and lands on a detector that already has a
// recall gap -- the level selector exists so it can be dialled back.
const DEFAULT_ON = true;
const LEVEL_KEY = "polyp_quality_level";
// Display-only smoothing. The skip decision is per frame -- exactly the bad
// frames are dropped -- but a banner that blinks at inference rate is unreadable,
// so it clears only after this many consecutive good frames.
const CLEAR_AFTER = 3;
// EVERY React state update here re-renders the whole player: video panels,
// feedback lanes, the lot. The first version pushed metrics, a counter and a
// tally object on every rejected frame -- three renders per frame at inference
// rate. Counters now accumulate in refs and are flushed on a timer, so a busy
// stretch of rejections costs the same as a quiet one.
const UI_THROTTLE_MS = 400;

export interface QualityGateState {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  level: LevelKey;
  setLevel: (v: LevelKey) => void;
  blocked: boolean;
  reason: Reason;
  metrics: QualityMetrics | null;
  skipped: number;
  counts: Record<string, number>;
  /** Call with the frame about to be sent. False => too noisy, don't infer. */
  shouldInfer: (cap: HTMLCanvasElement) => boolean;
  reset: () => void;
}

export function useQualityGate(): QualityGateState {
  const [enabled, setEnabledState] = useState<boolean>(() => {
    if (typeof window === "undefined") return DEFAULT_ON;
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === null ? DEFAULT_ON : v === "on";
  });
  const [level, setLevelState] = useState<LevelKey>(() => {
    if (typeof window === "undefined") return DEFAULT_LEVEL;
    const v = window.localStorage.getItem(LEVEL_KEY) as LevelKey | null;
    return LEVELS.some((l) => l.key === v) ? (v as LevelKey) : DEFAULT_LEVEL;
  });
  const [blocked, setBlocked] = useState(false);
  const [reason, setReason] = useState<Reason>("ok");
  const [metrics, setMetrics] = useState<QualityMetrics | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});

  // The send loop captures shouldInfer once, when it starts. Reading `enabled`
  // through a ref is what lets the switch take effect mid-procedure.
  const enabledRef = useRef(enabled);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  // Same reason as `enabled`: the send loop captured shouldInfer once, so a
  // level change has to reach it through a ref to take effect mid-procedure.
  const thresholdRef = useRef(DEFAULTS);
  useEffect(() => {
    const l = LEVELS.find((x) => x.key === level) ?? LEVELS[1];
    thresholdRef.current = { ...DEFAULTS, gradMin: l.gradMin };
  }, [level]);

  const goodStreak = useRef(0);
  const lastUi = useRef(0);
  const blockedRef = useRef(false);
  const reasonRef = useRef<Reason>("ok");
  const metricsRef = useRef<QualityMetrics | null>(null);
  const skippedRef = useRef(0);
  const countsRef = useRef<Record<string, number>>({});

  /** Pushes the accumulated refs into React state. `force` is for the rare
   *  blocked/unblocked transition, which should show immediately. */
  const flush = useCallback((force: boolean) => {
    const t = Date.now();
    if (!force && t - lastUi.current < UI_THROTTLE_MS) return;
    lastUi.current = t;
    setBlocked(blockedRef.current);
    setReason(reasonRef.current);
    setMetrics(metricsRef.current);
    setSkipped(skippedRef.current);
    setCounts({ ...countsRef.current });
  }, []);

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, v ? "on" : "off");
    }
    goodStreak.current = 0;
    blockedRef.current = false;
    reasonRef.current = "ok";
    flush(true);
    console.info(`[quality] filter ${v ? "enabled" : "disabled by user"}`);
  }, [flush]);

  const setLevel = useCallback((v: LevelKey) => {
    setLevelState(v);
    if (typeof window !== "undefined") window.localStorage.setItem(LEVEL_KEY, v);
    console.info(`[quality] level -> ${v}`);
  }, []);

  const reset = useCallback(() => {
    goodStreak.current = 0;
    blockedRef.current = false;
    reasonRef.current = "ok";
    metricsRef.current = null;
    skippedRef.current = 0;
    countsRef.current = {};
    flush(true);
  }, [flush]);

  const shouldInfer = useCallback((cap: HTMLCanvasElement) => {
    if (!enabledRef.current) return true;
    const m = frameQuality(cap);
    // Unmeasurable frame -- fail open. Never suppress inference on no evidence.
    if (!m) return true;
    const { ok, reason: why } = isInformative(m, thresholdRef.current);

    metricsRef.current = m;
    const was = blockedRef.current;

    if (ok) {
      goodStreak.current += 1;
      if (goodStreak.current >= CLEAR_AFTER) blockedRef.current = false;
      flush(was !== blockedRef.current);
      return true;
    }

    goodStreak.current = 0;
    blockedRef.current = true;
    reasonRef.current = why;
    skippedRef.current += 1;
    countsRef.current[why] = (countsRef.current[why] || 0) + 1;
    // One line per rejection episode, not per frame: at inference rate the
    // per-frame version buried everything else in the console.
    if (!was) {
      console.warn(
        `[quality] frames not sent to the AI — ${why} ` +
        `(gradmean=${m.gradmean.toFixed(2)} mean=${m.mean.toFixed(1)} ` +
        `glare=${m.specFrac.toFixed(3)} dark=${m.darkFrac.toFixed(3)})`
      );
    }
    flush(was !== blockedRef.current);
    return false;
  }, [flush]);

  return { enabled, setEnabled, level, setLevel, blocked, reason, metrics,
           skipped, counts, shouldInfer, reset };
}
