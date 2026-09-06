"use client";

import { useCallback, useRef, useState } from "react";
import { TemporalGate, LEVELS, DEFAULT_LEVEL, MODES, DEFAULT_MODE, type TLevelKey, type TBox, type Mode } from "./temporal";

const MODE_KEY = "polyp_temporal_mode";
const LEVEL_KEY = "polyp_temporal_level";
// The counters are a diagnostic, not a control; pushing them into React state
// at inference rate re-rendered the whole player for numbers nobody can read
// that fast.
const UI_THROTTLE_MS = 400;

export interface TemporalGateState {
  mode: Mode;
  setMode: (m: Mode) => void;
  level: TLevelKey;
  setLevel: (l: TLevelKey) => void;
  held: number;
  passed: number;
  pending: { hits: number; need: number; of: number } | null;
  /** Pass a frame's detections through; returns the ones that have persisted
   *  under whichever mode is currently active. */
  filter: (boxes: TBox[]) => TBox[];
  reset: () => void;
}

export function useTemporalGate(): TemporalGateState {
  const [mode, setModeState] = useState<Mode>(() => {
    if (typeof window === "undefined") return DEFAULT_MODE;
    const v = window.localStorage.getItem(MODE_KEY) as Mode | null;
    return (MODES as readonly string[]).includes(v ?? "") ? (v as Mode) : DEFAULT_MODE;
  });
  const [level, setLevelState] = useState<TLevelKey>(() => {
    if (typeof window === "undefined") return DEFAULT_LEVEL;
    const v = window.localStorage.getItem(LEVEL_KEY) as TLevelKey | null;
    return LEVELS.some((l) => l.key === v) ? (v as TLevelKey) : DEFAULT_LEVEL;
  });
  const [held, setHeld] = useState(0);
  const [passed, setPassed] = useState(0);
  const [pending, setPending] = useState<{ hits: number; need: number; of: number } | null>(null);

  const gate = useRef(new TemporalGate(level));
  // The draw callback captures `filter` once, so the switch is read through a
  // ref: flipping it mid-procedure has to take effect on the next frame, not on
  // the next time the socket happens to be rebuilt.
  const modeRef = useRef(mode);
  const lastUi = useRef(0);
  // ByteTrack mode's own running counts -- the heuristic keeps its counters
  // inside the TemporalGate instance, but bytetrack mode never calls it, so
  // it needs its own tally to report through the same held/passed shape.
  const btHeld = useRef(0);
  const btPassed = useRef(0);

  const setMode = useCallback((m: Mode) => {
    modeRef.current = m;
    setModeState(m);
    if (typeof window !== "undefined") window.localStorage.setItem(MODE_KEY, m);
    if (m !== "heuristic") gate.current.reset();
    if (m !== "bytetrack") { btHeld.current = 0; btPassed.current = 0; }
    setHeld(0);
    setPassed(0);
    setPending(null);
  }, []);

  const setLevel = useCallback((l: TLevelKey) => {
    setLevelState(l);
    gate.current.setLevel(l);
    if (typeof window !== "undefined") window.localStorage.setItem(LEVEL_KEY, l);
  }, []);

  const filter = useCallback((boxes: TBox[]): TBox[] => {
    const m = modeRef.current;

    if (m === "off") return boxes;

    if (m === "bytetrack") {
      // Trust the server's own persistence flag rather than re-deriving it --
      // it already ran the real vendored ByteTrack on this exact frame.
      // Absent (e.g. a box from a path that never reaches the tracker) counts
      // as not-yet-persistent, the safer default for an unexpected shape.
      const out = boxes.filter((b) => b.persistent === true);
      btPassed.current += out.length;
      btHeld.current += boxes.length - out.length;
      const now = Date.now();
      if (now - lastUi.current > UI_THROTTLE_MS) {
        lastUi.current = now;
        setHeld(btHeld.current);
        setPassed(btPassed.current);
        // No "how close is it" readout for this mode -- that's the vendored
        // tracker's internal state, not something exposed frame-by-frame here.
        setPending(null);
      }
      return out;
    }

    // heuristic
    const out = gate.current.filter(boxes);
    const now = Date.now();
    if (now - lastUi.current > UI_THROTTLE_MS) {
      lastUi.current = now;
      setHeld(gate.current.held);
      setPassed(gate.current.passed);
      setPending(gate.current.pending());
    }
    return out;
  }, []);

  const reset = useCallback(() => {
    gate.current.reset();
    btHeld.current = 0;
    btPassed.current = 0;
    setHeld(0);
    setPassed(0);
    setPending(null);
  }, []);

  return { mode, setMode, level, setLevel, held, passed, pending, filter, reset };
}
