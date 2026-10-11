"use client";

import { useEffect, useRef, useState } from "react";
import DemoVideoPicker from "./DemoVideoPicker";
import FeedbackPanel from "./FeedbackPanel";
import LoginPanel from "./LoginPanel";
import { useAuth } from "@/lib/auth";
import { useLanguage } from "@/lib/i18n";
import { useInBodyGate } from "@/lib/useInBodyGate";
import InBodyGateNotice from "./InBodyGateNotice";
import { useQualityGate } from "@/lib/useQualityGate";
import { frameQuality } from "@/lib/frameQuality";
import QualityGateNotice from "./QualityGateNotice";
import FilterBankNotice, { type GateState } from "./FilterBankNotice";
import { useTemporalGate } from "@/lib/useTemporalGate";
import TemporalGateNotice from "./TemporalGateNotice";
import { useAlertSound } from "@/lib/useAlertSound";
import { detectFovRect, unionRect, trimmedFraction, NEGLIGIBLE_TRIM, type Rect } from "@/lib/fov";
import { useFullscreen, fsWrapClass, fsExitBtnClass, fsBoxStyle } from "@/lib/useFullscreen";
import { combRatio, looksInterlaced, createDeinterlacer } from "@/lib/interlace";

const API = process.env.NEXT_PUBLIC_API_URL || "";
// Resolve the socket origin explicitly rather than leaning on a relative
// WebSocket URL: the spec allows it, but an absolute ws:// is unambiguous and
// still follows the page from an IP to a domain with no rebuild.
const API_WS = (process.env.NEXT_PUBLIC_API_URL
  || (typeof window !== "undefined" ? window.location.origin : "")).replace(/^http/, "ws");
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const INFER_TIMEOUT_MS = 6000;
// Resize frames to this width before sending — faster inference, smaller payload.
// data/precompute_demos.py encodes the saved demo results at this same width, so
// replayed boxes land in the same coordinate space as live ones. Change both together.
const INFER_WIDTH = 320;
// Frames measured at the start of a clip to find its picture area. See
// lib/fov.ts — the union of several beats one, and the border does not move.
const FOV_SAMPLE_FRAMES = 8;
// Comb only shows where something moved, so deciding the scan type needs a
// far longer run of frames than finding a static border does. See
// sampleInterlace, and lib/interlace.ts for the measure itself.
const INTERLACE_SAMPLE_FRAMES = 60;
const SPEEDS = [0.1, 0.25, 0.5, 0.7, 1, 1.5, 2];
// A polyp that is STILL on screen is re-filed, but the wait between
// refreshes doubles each time (8s, 16s, 32s, ...) up to this ceiling -- a
// long look shouldn't flood the queue at a flat rate. See
// documents/adr/0003-auto-capture-refresh-throttle.md.
const AUTO_CAPTURE_REFRESH_MS = 8000;
const AUTO_CAPTURE_REFRESH_MAX_MS = 64000; // 8s doubled 3x
// A detection gap shorter than this counts as the same episode. The detector
// drops the odd frame on a lesion that never left the screen, and treating that
// as "gone" would re-trigger a capture on the very next frame.
const DETECTION_GAP_MS = 1000;

// ---------------------------------------------------------------------------
// Three tiers of response. Two have their own bar; the third has none of its
// own by design. Kept identical to the tier table in LiveCameraPlayer.tsx --
// if you change one, change the other.
//
//   tier 1  box on screen   temporal gate, 2-of-3 (~0.5 s)   lib/temporal.ts
//   tier 2  filed capture   FILE_MIN_MS + FILE_MIN_HITS
//   tier 3  audible alert   tier 1's bar exactly -- lib/useAlertSound.ts
//
// Tier 1's threshold is the operating point Holzwanger et al. (Endoscopy 2021)
// measured for how long a CADe detection has to last before it carries
// information -- CADe specificity/accuracy 93.2%/97.8% at >=0.5 s, 98.6%/99.5%
// at >=1 s, 99.8%/99.9% at >=2 s. The same work found over 95% of per-frame
// false positives are ignored by endoscopists outright, which is why a single
// frame triggers nothing here. Tier 2 waits longer again before spending a
// reviewer's time on a frame.
//
// Tier 3 announces exactly what tier 1 drew: the alert sounds the moment a box
// appears on the video and stops when it goes, for at most the operator's
// chosen duration (default 0.5 s). It has no timing bar, hit count or
// confidence floor of its own.
//
// It used to live inside flushBest(), which meant it beeped once per filed
// capture -- including every refresh capture while a single lesion stayed on
// screen, so one long look was announced repeatedly. That was an attempt to
// define "worth announcing" separately from tier 1, which already defines it.
// See documents/adr/0004-alert-mirrors-box.md.
// ---------------------------------------------------------------------------

// Tier 2 -- file a capture. Both bars must be cleared: an appearance has to
// have lasted this long AND been seen on this many inferred frames, so neither
// a slow frame rate nor a burst of frames on its own can carry it.
const FILE_MIN_MS   = 1000;
const FILE_MIN_HITS = 2;

// FILE_MIN_MS is also the window over which the best frame of an appearance is
// chosen, which is not a coincidence: the delay spent making sure is the same
// delay spent finding a better picture, so waiting costs nothing twice.
//
// Why the best frame and not the first: a lesion "appears" precisely because
// the scope is moving, so the rising-edge frame is systematically the worst of
// the encounter -- blurred, half out of frame, or partly occluded. What a
// reviewer needs is the clearest look, not the earliest one.
const BEST_W_SHARP = 0.5, BEST_W_CONF = 0.3, BEST_W_SIZE = 0.2;
// Mean Sobel gradient saturates around here on an in-focus frame; see the
// operating-point table in lib/frameQuality.ts.
const SHARP_REF = 30;
// Longest edge of a filed frame. The inference canvas is INFER_WIDTH (320) --
// enough for the model, not enough for a human, and the doctor-found path has
// always saved 960. Both paths now agree.
const CAPTURE_EDGE = 960;

interface Box { bbox: [number, number, number, number]; conf: number; }
interface Timing { recv_ms: number; modal_ms: number; total_ms: number; }

/** A demo clip's detections, precomputed once by data/precompute_demos.py. */
interface PredData {
  fps: number;
  width: number;    // capture size the boxes are in — INFER_WIDTH at bake time
  height: number;
  frames: Box[][];  // index IS the frame number
}

export default function RealtimePlayer({
  caseId, onStop, onActivity, wsPath = "/api/ws/infer-file", backend, cpuOnly = false,
}: { caseId: string; onStop: () => void; onActivity?: () => void; wsPath?: string; backend?: string; cpuOnly?: boolean }) {
  const { user } = useAuth();
  const { t } = useLanguage();
  // Cheap colour gate in front of the detector: while the camera is outside the
  // patient there is nothing to detect, so the frame is never sent. The operator
  // can switch it off from the panel without restarting the session.
  const inBody = useInBodyGate();
  // Second, independent gate: too blurry / too dark / too much glare to be
  // worth inferring. Its own switch, because unlike the out-of-body gate it
  // has a measured cost in true polyps and is off until someone opts in.
  const quality = useQualityGate();
  // Third gate, and the only one that costs no lesions: a detection has to
  // survive several consecutive frames before it is drawn. Artefacts flicker;
  // a polyp in view does not.
  const temporal = useTemporalGate();
  // Exact test window, in seconds. The comparison this exists for -- same
  // footage with persistence on and off -- is only a comparison if both runs
  // cover identical frames, and "I pressed stop at about the same place" is
  // not identical.
  const [winStart, setWinStart] = useState("");
  const [winStop, setWinStop] = useState("");
  const winRef = useRef<{ a: number; b: number } | null>(null);
  // The engine is pinned for the life of the socket — the server reads it once,
  // so the latency average never blends two very different backends.
  const [isDemo, setIsDemo] = useState(false);
  // A demo on a CPU-only box streams live like any other clip. The sign-in gate
  // on /api/ws/infer-file guards GPU spend, and there is none here — so demos
  // take the open socket rather than forcing a login just to watch one.
  const demoLive = isDemo && cpuOnly;
  const WS_URL = `${API_WS}${demoLive ? "/api/ws/infer" : wsPath}${backend ? `?backend=${encodeURIComponent(backend)}` : ""}`;
  const videoRef    = useRef<HTMLVideoElement>(null);
  const analyzedRef = useRef<HTMLCanvasElement>(null); // last frame actually sent to the model, with boxes burned on
  const wsRef       = useRef<WebSocket | null>(null);
  const scanRef     = useRef(false); // capture loop running?
  const lastAutoCaptureRef = useRef(0);
  const refreshMsRef = useRef(AUTO_CAPTURE_REFRESH_MS); // grows each refresh; reset per episode
  const lastDetectionRef   = useRef(0);     // when a box was last seen
  const inEpisodeRef       = useRef(false); // inside one continuous appearance?
  // One capture upload at a time. A rolling clip plus its frame is megabytes and
  // a clinic uplink is not fast: without this, a run of detections queues a dozen
  // multi-megabyte POSTs that compete with the websocket carrying frames for the
  // same upstream, inference stalls, and the uploads themselves get abandoned
  // (nginx logged 81 x 499 and 15 x 408 in one day). Skipping a capture costs
  // little — an episode that is still on screen files one on the next refresh.
  const uploadingRef       = useRef(false);

  // One appearance of a lesion, as a small state machine. `hits` and `start`
  // decide which tier has been earned; `best` holds the best frame seen so far,
  // and `filed` makes tier 2 (and, with it, tier 3 -- see flushBest) fire once
  // rather than once per frame.
  const episodeStartRef   = useRef(0);
  const episodeHitsRef    = useRef(0);
  const episodeFiledRef   = useRef(false);
  const bestRef = useRef<{ score: number; boxes: Box[] } | null>(null);
  // Two scratch canvases, reused for the life of the session: the frame being
  // considered, and the best one held so far. A fresh 960px canvas per inferred
  // frame would be megabytes a second of garbage on a clinic PC.
  const hiScratchRef  = useRef<HTMLCanvasElement | null>(null);
  const bestCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // At most one capture may wait behind an in-flight upload. More than one and
  // we are back to queueing POSTs against the same upstream the frame stream
  // uses; none at all and a capture that merely coincided with a busy uplink is
  // lost outright — which is a lesion the reviewer never sees.
  const deferredRef = useRef<{ blob: Blob; boxes: Box[] } | null>(null);
  // Tier 3. The controls live in the live player and the spectator view; here we
  // only consume the stored settings — mute and duration both — so a demo
  // behaves like the room it is demonstrating.
  const alert = useAlertSound();
  // Replay reuses one scratch canvas instead of allocating per animation frame —
  // the live loop can get away with allocating because it runs at inference
  // speed (a few per second), replay runs at frame rate.
  const replayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastReplayIdxRef = useRef(-1);

  // Pending response promise resolver — one in-flight request at a time
  const pendingRef = useRef<((v: { boxes: Box[]; timing: Timing } | null) => void) | null>(null);

  const [videoUrl, setVideoUrl]   = useState<string | null>(null);
  // Non-null => this clip replays saved detections and never opens a socket.
  // The bundled demos always take this path: their footage never changes, so
  // inferring it again on every visit was paying a GPU to recompute a constant.
  const [pred, setPred]           = useState<PredData | null>(null);
  const [loadingDemo, setLoadingDemo] = useState<string | null>(null);
  const [tab, setTab]             = useState<"upload" | "demo">("demo");
  const [dragging, setDragging]   = useState(false);
  const [wsStatus, setWsStatus]   = useState<"connecting" | "open" | "error" | "closed">("connecting");
  const [closeCode, setCloseCode] = useState<number | null>(null);
  const [polyp, setPolyp]         = useState(false);
  // 0.5x for live demos: fast enough to read as a procedure, slow enough that
  // the CPU (~58ms/frame, ~17fps) keeps up with 25fps footage without skipping
  // much. Must stay a member of SPEEDS or no button renders as selected.
  const [speed, setSpeed]         = useState(0.5);
  const [stats, setStats]         = useState({ sent: 0, received: 0, avgMs: 0, rttMs: 0, netMs: 0 });
  // Whole filter bank as reported by the backend for the last frame that
  // came back, so the panel answers "which paper filter fired on THIS
  // scene" rather than showing one operator's raw numbers.
  const [gate, setGate] = useState<GateState | null>(null);
  const [showBank, setShowBank] = useState(true);
  const [lastError, setLastError] = useState("");
  const [duration, setDuration]   = useState(0);
  const [curTime, setCurTime]     = useState(0);
  const [feedbackRefreshKey, setFeedbackRefreshKey] = useState(0);
  const [videoEnded, setVideoEnded]   = useState(false);
  const [aspect, setAspect]           = useState("560/480"); // replaced with the clip's real ratio on load
  // Confidence gate, client-side and live-adjustable. The server runs the model
  // at its own low threshold (0.30) and reports every box with its score, so
  // moving this mid-procedure costs nothing — no round trip, no restart, and it
  // applies to what is drawn and what is auto-captured alike. A scope that is
  // noisy today can be tightened without redeploying anything.
  const [confMin, setConfMin] = useState(0.30);
  // The capture loop closes over the render it started in and cannot see the
  // state above.
  const confMinRef = useRef(0.30);
  const [showDetected, setShowDetected] = useState(true);
  const [showLive, setShowLive]         = useState(true);
  const msHistory = useRef<number[]>([]);
  // Client-side round trip, so the panel can split what the server spent from
  // what the wire cost. Safe as a single ref because only one frame is ever in
  // flight at a time (pendingRef) — see the capture loop.
  const rttHistory = useRef<number[]>([]);
  const sentAtRef = useRef<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastBoxesRef = useRef<Box[]>([]); // AI's most recent detections — attached as context to manual captures


  /** True while showing a clip whose detections come from the GPU, live. */
  const liveInference = videoUrl !== null && pred === null;

  // WebSocket — opened only for a clip that actually needs the GPU, and torn
  // down as soon as one isn't loaded. Connecting on mount (as this used to)
  // meant merely opening Real-time held a socket against the GPU backend even
  // if all you ever did was watch a demo.
  useEffect(() => {
    if (!liveInference) return;
    setWsStatus("connecting");
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen  = () => setWsStatus("open");
    ws.onerror = () => setWsStatus("error");
    ws.onclose = (e) => { setWsStatus("closed"); setCloseCode(e.code); pendingRef.current?.(null); };

    ws.onmessage = (e) => {
      let data: unknown;
      try { data = JSON.parse(e.data); } catch { return; }

      if (data && typeof data === "object" && "error" in data) {
        const err = (data as { error: string }).error;
        setLastError(err);
        pendingRef.current?.(null);
        pendingRef.current = null;
        return;
      }

      const { boxes, timing } = data as { boxes: Box[]; timing: Timing };
      const g = (data as { timing?: { gate?: GateState } }).timing?.gate;
      if (g) setGate(g);
      onActivity?.();
      msHistory.current.push(timing.modal_ms);
      if (msHistory.current.length > 10) msHistory.current.shift();
      const avg = Math.round(msHistory.current.reduce((a, b) => a + b, 0) / msHistory.current.length);
      // Round trip as the operator actually experiences it: stamped just before
      // ws.send, read here. timing.modal_ms is server-side only (the name is a
      // misnomer kept for UI compatibility — on this box there is no Modal, it
      // is CPU time), so the difference is everything the wire and the browser
      // cost on top. Clamped at 0: a sub-millisecond LAN can round negative.
      const rtt = sentAtRef.current ? performance.now() - sentAtRef.current : 0;
      if (rtt > 0) {
        rttHistory.current.push(rtt);
        if (rttHistory.current.length > 10) rttHistory.current.shift();
      }
      const avgRtt = rttHistory.current.length
        ? Math.round(rttHistory.current.reduce((a, b) => a + b, 0) / rttHistory.current.length)
        : 0;
      setStats((s) => ({
        sent: s.sent, received: s.received + 1, avgMs: avg,
        rttMs: avgRtt, netMs: avgRtt ? Math.max(0, avgRtt - avg) : 0,
      }));

      pendingRef.current?.({ boxes, timing });
      pendingRef.current = null;
    };

    return () => { ws.close(); scanRef.current = false; };
  }, [liveInference, WS_URL]);

  // Apply the chosen playback speed to whatever video is currently loaded
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed, videoUrl]);

  // Picture area inside the frame — the same measurement the live camera path
  // makes, for the same reasons (lib/fov.ts). Only the live-inference loop uses
  // it; replaying a demo's precomputed boxes deliberately does not, because
  // those were baked against the whole frame and cropping would put them in the
  // wrong coordinate space.
  const [fovRect, setFovRectState] = useState<Rect | null>(null);
  const fovRectRef = useRef<Rect | null>(null);
  const fovSamplesRef = useRef(0);
  // Null until decided; nothing is deinterlaced while it is null, because
  // dropping a field from a progressive clip is pure loss. See lib/interlace.ts.
  const interlacedRef = useRef<boolean | null>(null);
  const deintRef = useRef(createDeinterlacer());
  const interlaceSamplesRef = useRef(0);
  const combPeakRef = useRef(0);
  const [fovFrame, setFovFrame] = useState<{ w: number; h: number } | null>(null);
  const [fovEnabled, setFovEnabledState] = useState(true);
  const fovEnabledRef = useRef(true);
  const [showFovOverlay, setShowFovOverlay] = useState(false);
  const FOV_KEY = "polyp_fov_enabled";

  function setFovEnabled(on: boolean) {
    fovEnabledRef.current = on;
    setFovEnabledState(on);
    try { localStorage.setItem(FOV_KEY, on ? "1" : "0"); } catch { /* ignore */ }
  }

  useEffect(() => {
    try {
      const raw = localStorage.getItem(FOV_KEY);
      if (raw !== null) { const on = raw === "1"; fovEnabledRef.current = on; setFovEnabledState(on); }
    } catch { /* ignore */ }
  }, []);

  // A new clip is a new source, so the border has to be measured again.
  useEffect(() => {
    fovRectRef.current = null;
    fovSamplesRef.current = 0;
    setFovRectState(null);
    setFovFrame(null);
    setShowFovOverlay(false);
    // And a new clip can be a different scan type: the bundled demos are
    // progressive, an uploaded clinic recording is interlaced.
    interlacedRef.current = null;
    interlaceSamplesRef.current = 0;
    combPeakRef.current = 0;
    deintRef.current.reset();
  }, [videoUrl]);

  /** Snap to even scanlines so field parity cannot change. The FOV rect is
   *  auto-detected and can land on an odd line, and a parity flip mid-clip is
   *  a half-scanline jump -- or, if it keeps flipping, bob judder. Snapping
   *  down only ever shrinks the rect. See LiveCameraPlayer for the long form. */
  function evenScanlines(r: Rect): Rect {
    return { ...r, y: r.y & ~1, h: r.h & ~1 };
  }

  function sourceRect(video: HTMLVideoElement): Rect {
    const vw = video.videoWidth, vh = video.videoHeight;
    const full = { x: 0, y: 0, w: vw, h: vh };
    const fov = fovEnabledRef.current ? fovRectRef.current : null;
    if (!fov || trimmedFraction(fov, vw, vh) < NEGLIGIBLE_TRIM) return evenScanlines(full);
    return evenScanlines(fov.w > 0 && fov.h > 0 ? fov : full);
  }

  /** Latches on the first frame showing comb and stops looking; only running
   *  out of frames concludes "progressive". See LiveCameraPlayer.sampleInterlace. */
  function sampleInterlace(video: HTMLVideoElement) {
    if (interlacedRef.current !== null) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const ratio = combRatio(video, vw, vh);
    if (ratio !== null && ratio > combPeakRef.current) combPeakRef.current = ratio;
    if (looksInterlaced(ratio)) {
      interlacedRef.current = true;
      console.info(`[interlace] clip is interlaced (comb ratio ${ratio!.toFixed(2)}) — deinterlacing`);
      return;
    }
    if (ratio === null) return;
    if (++interlaceSamplesRef.current >= INTERLACE_SAMPLE_FRAMES) {
      interlacedRef.current = false;
      console.info(`[interlace] clip looks progressive (peak ${combPeakRef.current.toFixed(2)}) — drawing frames whole`);
    }
  }

  function sampleFov(video: HTMLVideoElement) {
    if (fovSamplesRef.current >= FOV_SAMPLE_FRAMES) return;
    fovSamplesRef.current += 1;
    const vw = video.videoWidth, vh = video.videoHeight;
    const found = detectFovRect(video, vw, vh);
    if (!found) return;
    const merged = unionRect(fovRectRef.current, found);
    fovRectRef.current = merged;
    setFovFrame((prev) => (prev && prev.w === vw && prev.h === vh ? prev : { w: vw, h: vh }));
    setFovRectState((prev) =>
      prev && merged && prev.x === merged.x && prev.y === merged.y
        && prev.w === merged.w && prev.h === merged.h ? prev : merged);
  }

  // Draws the exact frame that was sent to the model, with boxes at native (capture)
  // resolution — pixel-accurate for that frame, unlike overlaying on the live video
  // (which has moved on by the time the result comes back).
  // Draws `hi` when there is one. Both canvases are the same region of the same
  // video frame, so the boxes describe either equally; `cap` is only 320px wide
  // because that is all the model needs, and sizing this canvas from it made the
  // panel a thumbnail that CSS then stretched to full width. Boxes arrive in cap
  // space, so they are scaled by the ratio between the two.
  function drawAnalyzedFrame(cap: HTMLCanvasElement, hi: HTMLCanvasElement | null, boxes: Box[]) {
    const canvas = analyzedRef.current;
    if (!canvas) return;
    const source = hi ?? cap;
    const k = cap.width > 0 ? source.width / cap.width : 1;
    if (canvas.width !== source.width)   canvas.width  = source.width;
    if (canvas.height !== source.height) canvas.height = source.height;

    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(source, 0, 0);

    for (const det of boxes) {
      const [x1, y1, x2, y2] = det.bbox.map((v) => v * k) as [number, number, number, number];
      ctx.shadowColor = "#39ff14";
      ctx.shadowBlur  = 10;
      ctx.strokeStyle = "#39ff14";
      ctx.lineWidth   = 3;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.shadowBlur  = 0;
      const label = t("polyp  {conf}%", { conf: Math.round(det.conf * 100) });
      ctx.font = "bold 13px monospace";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "#39ff14";
      ctx.fillRect(x1, y1 - 20, tw + 8, 20);
      ctx.fillStyle = "#000";
      ctx.fillText(label, x1 + 4, y1 - 5);
    }
  }

  // The single writer of "what is on screen right now" — the indicator, the
  // boxes a manual capture attaches, and tier 3. See the identical comment in
  // LiveCameraPlayer: hanging the alert here rather than off maybeAutoCapture is
  // what makes it mean "a box is being drawn" and nothing else.
  function updateBoxes(b: Box[]) {
    setPolyp(b.length > 0);
    lastBoxesRef.current = b;
    alert.onBoxState(b.length > 0);
  }

  // Instant, no-dialog manual capture — grabs whatever frame is on screen
  // right now (staff can scrub the seek bar above first to line up an exact
  // moment) and drops it straight into the side-panel queue. Any box
  // drawing/correction happens there, not in a popup.
  function captureDrFound() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    // Downscale before encoding: a full-resolution JPEG at 0.9 is a synchronous
    // encode on the same thread as the inference loop, and a bigger upload
    // behind the frames. A review does not need more than a 960 px edge.
    const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
    const cap = document.createElement("canvas");
    cap.width = Math.round(video.videoWidth * scale);
    cap.height = Math.round(video.videoHeight * scale);
    drawDeinterlaced(video, 0, 0, video.videoWidth & ~1, video.videoHeight & ~1, cap, cap.width, cap.height);
    cap.toBlob(async (blob) => {
      if (!blob) return;
      const fd = new FormData();
      fd.append("file", blob, "frame.jpg");
      fd.append("ai_detections", JSON.stringify(lastBoxesRef.current));
      // No clip: for a played file the position in that file is the whole
      // answer, and it costs nothing to send.
      const v = videoRef.current;
      if (v) fd.append("video_offset_ms", String(Math.round(v.currentTime * 1000)));
      try {
        await fetch(`${API}/api/feedback/${caseId}/dr-found/capture`, { method: "POST", body: fd });
        setFeedbackRefreshKey((k) => k + 1);
      } catch { /* best-effort */ }
    }, "image/jpeg", 0.82);
  }

  /** Score one candidate frame of an appearance; higher is the better keepsake.
   *  Measured on the 320px inference canvas, which is what the thresholds in
   *  lib/frameQuality were calibrated against. */
  function frameScore(cap: HTMLCanvasElement, boxes: Box[]): number {
    const m = frameQuality(cap);
    const sharp = m ? Math.min(1, m.gradmean / SHARP_REF) : 0.5;
    let conf = 0, area = 0;
    for (const b of boxes) {
      if (b.conf > conf) conf = b.conf;
      const a = Math.max(0, b.bbox[2] - b.bbox[0]) * Math.max(0, b.bbox[3] - b.bbox[1]);
      if (a > area) area = a;
    }
    const frameArea = cap.width * cap.height;
    // Square-rooted so this reads as "how far across the frame", not as area.
    const size = frameArea > 0 ? Math.min(1, Math.sqrt(area / frameArea)) : 0;
    return BEST_W_SHARP * sharp + BEST_W_CONF * conf + BEST_W_SIZE * size;
  }

  /** Draw a region of `video` into `dst`, progressive. Motion-adaptive, so
   *  still areas keep every real scanline; no-ops into a plain draw when the
   *  clip is progressive. See lib/interlace.ts for why the motion test is
   *  temporal rather than spatial. */
  function drawDeinterlaced(
    video: HTMLVideoElement, sx: number, sy: number, sw: number, sh: number,
    dst: HTMLCanvasElement, dw: number, dh: number,
  ) {
    if (interlacedRef.current !== true) {
      const ctx = dst.getContext("2d")!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
      return;
    }
    deintRef.current.draw(video, sx, sy, sw, sh, dst, dw, dh, video.currentTime);
  }

  /** Grab the frame a reviewer will look at, from the SAME video frame the
   *  model was given. Re-grabbing after the inference round trip would file an
   *  image the boxes no longer describe -- on CPU that trip is a couple of
   *  hundred milliseconds, and the scope moves in that time. */
  function grabCapture(video: HTMLVideoElement, sx: number, sy: number, sw: number, sh: number) {
    const scale = Math.min(1, CAPTURE_EDGE / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
    const c = hiScratchRef.current ?? (hiScratchRef.current = document.createElement("canvas"));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    drawDeinterlaced(video, sx, sy, sw, sh, c, w, h);
    return c;
  }

  /** Keep this frame if it is the best of the appearance so far. */
  function considerBest(cap: HTMLCanvasElement, hi: HTMLCanvasElement | null, boxes: Box[]) {
    const score = frameScore(cap, boxes);
    if (bestRef.current && score <= bestRef.current.score) return;
    const src = hi ?? cap;
    const dst = bestCanvasRef.current ?? (bestCanvasRef.current = document.createElement("canvas"));
    if (dst.width !== src.width) dst.width = src.width;
    if (dst.height !== src.height) dst.height = src.height;
    dst.getContext("2d")!.drawImage(src, 0, 0);
    // FeedbackPanel reads ai_detections as pixels of the image it draws them
    // over (it scales by naturalWidth), and the filed image is no longer the
    // inference canvas -- so the boxes have to be carried into its space.
    const k = cap.width > 0 ? src.width / cap.width : 1;
    const scaled = k === 1 ? boxes : boxes.map((b) => ({
      ...b,
      bbox: [
        Math.round(b.bbox[0] * k), Math.round(b.bbox[1] * k),
        Math.round(b.bbox[2] * k), Math.round(b.bbox[3] * k),
      ] as [number, number, number, number],
    }));
    bestRef.current = { score, boxes: scaled };
  }

  function resetEpisode() {
    inEpisodeRef.current = false;
    episodeHitsRef.current = 0;
    episodeFiledRef.current = false;
    bestRef.current = null;
    refreshMsRef.current = AUTO_CAPTURE_REFRESH_MS;
  }

  // Auto-capture — one filed frame per appearance, chosen for being the
  // clearest frame of that appearance rather than the first one. The tier table
  // at the top of this file says why each bar is where it is.
  function maybeAutoCapture(boxes: Box[], cap: HTMLCanvasElement | null, hi: HTMLCanvasElement | null) {
    const now = Date.now();

    if (boxes.length === 0 || !cap) {
      // The appearance is over once the detector has been quiet for longer than
      // a single dropped frame. Flush whatever the best frame of it was: an
      // appearance that ended before FILE_MIN_MS elapsed is still real, so the
      // window only ever DELAYS a capture -- FILE_MIN_HITS is the only thing
      // that suppresses one outright.
      if (inEpisodeRef.current && now - lastDetectionRef.current > DETECTION_GAP_MS) {
        if (episodeHitsRef.current >= FILE_MIN_HITS) flushBest(now);
        resetEpisode();
      }
      return;
    }
    lastDetectionRef.current = now;

    if (!inEpisodeRef.current) {
      inEpisodeRef.current = true;
      episodeStartRef.current = now;
      episodeHitsRef.current = 0;
      episodeFiledRef.current = false;
      bestRef.current = null;
      refreshMsRef.current = AUTO_CAPTURE_REFRESH_MS;
    }
    episodeHitsRef.current += 1;
    considerBest(cap, hi, boxes);

    const age = now - episodeStartRef.current;

    // Tier 2 — the capture. First filing waits for the window to close; after
    // that a lesion still on screen is refreshed occasionally, so a long look is
    // not represented by one frame. Tier 3 (the alert) rides along with every
    // capture this produces -- see flushBest.
    if (episodeHitsRef.current < FILE_MIN_HITS) return;
    const isRefresh = episodeFiledRef.current;
    const due = isRefresh
      ? now - lastAutoCaptureRef.current >= refreshMsRef.current
      : age >= FILE_MIN_MS;
    if (!due) return;
    if (isRefresh) {
      refreshMsRef.current = Math.min(refreshMsRef.current * 2, AUTO_CAPTURE_REFRESH_MAX_MS);
    }
    flushBest(now);
  }

  /** Tier 2. Hand the best frame of this appearance to the uploader. Silent --
   *  tier 3 fires off the drawn box, not off filing. */
  function flushBest(now: number) {
    const best = bestRef.current;
    const canvas = bestCanvasRef.current;
    if (!best || !canvas) return;
    episodeFiledRef.current = true;
    lastAutoCaptureRef.current = now;
    const boxes = best.boxes;
    bestRef.current = null;  // a refresh picks a fresh best, not this one again
    canvas.toBlob((blob) => { if (blob) sendCapture(blob, boxes); }, "image/jpeg", 0.82);
  }

  /** One upload at a time, with a single holding slot behind it.
   *
   *  The old code checked "is an upload in flight" and simply returned — after
   *  it had already marked the appearance as handled. That combination is what
   *  lost whole lesions: the next frame saw an appearance that had supposedly
   *  been filed and throttled it for a full refresh window, measured against
   *  the PREVIOUS appearance's timestamp, so a lesion that came and went inside
   *  that window was never filed at all. Deferring instead of dropping means
   *  the bookkeeping above can be honest — the capture really will be sent. */
  function sendCapture(blob: Blob, boxes: Box[]) {
    if (uploadingRef.current) { deferredRef.current = { blob, boxes }; return; }
    uploadingRef.current = true;
    const fd = new FormData();
    fd.append("file", blob, "frame.jpg");
    fd.append("ai_detections", JSON.stringify(boxes));
    // No clip: for a played file the position in that file is the whole
    // answer, and it costs nothing to send.
    const v = videoRef.current;
    if (v) fd.append("video_offset_ms", String(Math.round(v.currentTime * 1000)));
    void (async () => {
      try {
        await fetch(`${API}/api/feedback/${caseId}/auto-capture`, { method: "POST", body: fd });
        setFeedbackRefreshKey((k) => k + 1);
      } catch {
        /* best-effort — never interrupt the live loop over this */
      } finally {
        uploadingRef.current = false;
        const next = deferredRef.current;
        deferredRef.current = null;
        if (next) sendCapture(next.blob, next.boxes);
      }
    })();
  }



  // Live loop — send whatever frame is currently playing → wait for result → send next.
  // The video plays continuously (at the chosen speed); we just grab whatever frame is
  // current each time, same pattern as the live-camera mode.
  async function startLoop(video: HTMLVideoElement) {
    if (scanRef.current) return;
    scanRef.current = true;
    video.loop = false;
    video.playbackRate = speed;

    // Seek before playing, so the first inferred frame is inside the window
    // rather than wherever the scrub bar happened to be left.
    const a = parseFloat(winStart), b = parseFloat(winStop);
    winRef.current = (isFinite(a) || isFinite(b))
      ? { a: isFinite(a) ? a : 0, b: isFinite(b) ? b : Infinity }
      : null;
    if (winRef.current) {
      video.currentTime = winRef.current.a;
      await new Promise<void>((res) => {
        const done = () => { video.removeEventListener("seeked", done); res(); };
        video.addEventListener("seeked", done);
      });
      temporal.reset();   // no carry-over of confirmations between runs
    }
    await video.play();

    while (scanRef.current) {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !video.videoWidth) {
        await new Promise<void>((res) => requestAnimationFrame(() => res()));
        continue;
      }

      if (winRef.current && video.currentTime >= winRef.current.b) {
        scanRef.current = false;
        video.pause();
        break;
      }

      sampleFov(video);
      // Both draws below ask whether this clip is interlaced, so answer first.
      sampleInterlace(video);
      const { x: srcX, y: srcY, w: srcW, h: srcH } = sourceRect(video);
      setAspect(`${srcW}/${srcH}`);

      const scale = INFER_WIDTH / srcW;
      const capW  = INFER_WIDTH;
      const capH  = Math.round(srcH * scale);
      const cap   = document.createElement("canvas");
      cap.width   = capW;
      cap.height  = capH;
      // Not deinterlaced: the shrink to ~213 lines averages neighbouring lines
      // and cancels the comb on its own. Measured clean (0.60-0.65) drawn
      // straight. Full-size paths are handled properly -- see grabCapture.
      const capCtx = cap.getContext("2d")!;
      capCtx.imageSmoothingEnabled = true;
      capCtx.imageSmoothingQuality = "high";
      capCtx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, capW, capH);
      // Grabbed now, from this same video frame, so a filed capture and the boxes
      // drawn on it describe the same instant. See grabCapture.
      const hi = grabCapture(video, srcX, srcY, srcW, srcH);

      // Out of body: no JPEG encode, no round trip, no inference. The panel keeps
      // showing the real frame with no boxes, so it stays obvious that the feed is
      // live and the detector is simply not being asked. Paced at roughly the
      // inference cadence rather than spinning a tight while loop.
      if (!inBody.shouldInfer(cap)) {
        updateBoxes([]);
        drawAnalyzedFrame(cap, hi, []);
        // Let the appearance state machine see the quiet frame — see the else
        // branch below the inference call for why this matters.
        maybeAutoCapture([], null, null);
        await new Promise<void>((res) => setTimeout(res, 100));
        continue;
      }

      // Second gate: inside the patient, but the picture is too poor to be worth a
      // forward pass. Same contract as the first -- nothing is encoded or sent.
      // ON by default at level "medium" (useQualityGate.ts), which by the table
      // in lib/frameQuality also rejects ~3.5% of frames a doctor labelled as
      // containing a polyp. That is a real cost, paid before inference runs.
      if (!quality.shouldInfer(cap)) {
        updateBoxes([]);
        drawAnalyzedFrame(cap, hi, []);
        maybeAutoCapture([], null, null);
        await new Promise<void>((res) => setTimeout(res, 100));
        continue;
      }

      const blob: Blob = await new Promise((res) => cap.toBlob((b) => res(b!), "image/jpeg", 0.85));
      const buf = await blob.arrayBuffer();

      const result = await new Promise<{ boxes: Box[]; timing: Timing } | null>((resolve) => {
        pendingRef.current = resolve;
        sentAtRef.current = performance.now();
        ws.send(buf);
        setStats((s) => ({ ...s, sent: s.sent + 1 }));
        setTimeout(() => {
          if (pendingRef.current === resolve) { pendingRef.current = null; resolve(null); }
        }, INFER_TIMEOUT_MS);
      });

      // Draw the frame + its boxes together, win or lose (a timeout leaves the last good frame up)
      if (result) {
        // One gate for both what is shown and what is kept.
        const shown = temporal.filter(
          result.boxes.filter((b) => b.conf >= confMinRef.current));
        updateBoxes(shown);
        drawAnalyzedFrame(cap, hi, shown);
        maybeAutoCapture(shown, cap, hi);
      } else {
        // A timed-out frame is not evidence the lesion left, but it is not
        // evidence it is still there either. maybeAutoCapture is the only writer
        // of the gap timer, so a stretch of skipped frames used to freeze the
        // state machine mid-appearance and throttle the NEXT lesion against a
        // stale timestamp. Feeding the quiet frame through lets it close.
        maybeAutoCapture([], null, null);
      }
    }
  }

  // Replay loop — the saved-results counterpart of startLoop.
  //
  // It deliberately reproduces what the live path puts on screen rather than
  // taking a shortcut: the frame is downscaled to the same capture size the
  // detections were computed at, and drawn through the same drawAnalyzedFrame,
  // so the overlay is pixel-identical to a live run. Auto-capture still fires,
  // because reviewing demo footage is a real workflow and it costs no GPU.
  //
  // The only honest difference: there is no round trip, so the "Detected" panel
  // does not lag behind the source. The status bar says so instead of inventing
  // a latency figure.
  async function startReplayLoop(video: HTMLVideoElement, data: PredData) {
    if (scanRef.current) return;
    scanRef.current = true;
    lastReplayIdxRef.current = -1;
    video.loop = false;
    video.playbackRate = speed;
    await video.play();

    if (!replayCanvasRef.current) replayCanvasRef.current = document.createElement("canvas");
    const cap = replayCanvasRef.current;
    cap.width = data.width;
    cap.height = data.height;
    const ctx = cap.getContext("2d")!;

    while (scanRef.current) {
      await new Promise<void>((res) => requestAnimationFrame(() => res()));
      if (!video.videoWidth) continue;

      // The frame index IS the array index — that is the contract the bake
      // script writes to. Clamp so the final frame holds rather than blanking.
      const idx = Math.min(data.frames.length - 1, Math.floor(video.currentTime * data.fps));
      if (idx === lastReplayIdxRef.current) continue;
      lastReplayIdxRef.current = idx;

      const boxes = data.frames[idx] ?? [];
      ctx.drawImage(video, 0, 0, cap.width, cap.height);
      updateBoxes(boxes);
      // Hoisted out of the maybeAutoCapture call below so the panel and the
      // filed frame are the same canvas, grabbed once from this video frame.
      const hi = grabCapture(video, 0, 0, video.videoWidth & ~1, video.videoHeight & ~1);
      drawAnalyzedFrame(cap, hi, boxes);
      maybeAutoCapture(boxes, cap, hi);
      // Replay has no socket: nothing is sent, so there is no round trip to split.
      setStats((s) => ({ sent: s.sent + 1, received: s.received + 1, avgMs: 0, rttMs: 0, netMs: 0 }));
    }
  }

  function handleVideoLoad() {
    const video = videoRef.current;
    if (!video) return;
    setDuration(video.duration || 0);
    // Size the panels to the clip's own shape — a fixed guess letterboxes
    // anything that isn't exactly that ratio.
    if (video.videoWidth && video.videoHeight) setAspect(`${video.videoWidth}/${video.videoHeight}`);
    if (pred) startReplayLoop(video, pred);
    else startLoop(video);
  }

  function handleTimeUpdate() {
    if (videoRef.current) setCurTime(videoRef.current.currentTime);
  }

  function seekTo(newTime: number) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(duration, newTime));
    setCurTime(video.currentTime);
  }

  // Restarts the current clip from the top — playback no longer loops on its
  // own, so this is how staff re-watch it (e.g. right after it finished).
  function replay() {
    const video = videoRef.current;
    if (!video) return;
    setVideoEnded(false);
    video.currentTime = 0;
    setCurTime(0);
    if (pred) startReplayLoop(video, pred);
    else startLoop(video);
  }

  /** Counters and the detection flag describe ONE clip; carrying them across
   *  clips leaves a stale "Polyp detected" lit over footage that has none. */
  function resetClipState() {
    setIsDemo(false);
    resetEpisode();
    // Changing clips bypasses updateBoxes, so tier 3 is told separately —
    // otherwise an alert from the old clip can outlive it.
    alert.reset();
    lastDetectionRef.current = 0;
    scanRef.current = false;
    setPolyp(false);
    setStats({ sent: 0, received: 0, avgMs: 0, rttMs: 0, netMs: 0 });
    msHistory.current = [];
    rttHistory.current = [];
    sentAtRef.current = 0;
    lastBoxesRef.current = [];
    lastReplayIdxRef.current = -1;
    setVideoEnded(false);
    setLastError("");
  }

  /** Back to the picker: no clip, so nothing is running and nothing is connected. */
  function unloadClip() {
    resetClipState();
    setVideoUrl(null);
    setPred(null);
  }

  /** A user-supplied clip always means live GPU inference — clear any saved set. */
  function loadUserFile(file: File) {
    resetClipState();
    setPred(null);
    setVideoUrl(URL.createObjectURL(file));
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) loadUserFile(file);
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) loadUserFile(file);
  }

  // Demos load their saved detections and play back from those. If the saved
  // file is missing we deliberately do NOT silently fall back to live
  // inference — that would quietly reintroduce exactly the GPU cost this
  // removes, and the fix (re-run the bake script) belongs to whoever deploys.
  async function handleDemoSelect(filename: string) {
    resetClipState();
    setLoadingDemo(filename);
    try {
      setIsDemo(true);
      if (cpuOnly) {
        // The saved results were baked by yolov5m on Modal. Replaying them here
        // would show a different model's output than the one this deployment
        // serves, so run the clip through this server's CPU instead.
        setVideoUrl(`${BASE_PATH}/demos/${filename}`);
        return;
      }
      const stem = filename.replace(/\.mp4$/, "");
      const res = await fetch(`${BASE_PATH}/demos/pred/${stem}_pred.json`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as PredData;
      if (!data?.frames?.length) throw new Error("empty");
      setPred(data);
      setVideoUrl(`${BASE_PATH}/demos/${filename}`);
    } catch {
      setLastError(t("Saved results for this clip are missing. Run data/precompute_demos.py to generate them."));
    } finally {
      setLoadingDemo(null);
    }
  }

  const wsOk = wsStatus === "open";
  // Both panels show the same frame at the same size — one just carries the AI
  // mask and trails by the inference round-trip. Hiding one hands its height to
  // the other. Hidden panels are clipped, never unmounted: the <video> has to
  // keep decoding and the <canvas> has to keep being drawn into for inference
  // to continue while it's out of sight.
  // Panels fill their column and take their height from the clip's own ratio —
  // the column is one of three equal thirds, so a video panel and a feedback
  // image (same frame, same ratio) come out exactly the same size.
  // One per panel: either can take the screen on its own, and coming back
  // must not disturb the other.
  const detectedFs = useFullscreen();
  const liveFs = useFullscreen();
  const panelBox = "relative w-full rounded-xl overflow-hidden border border-gray-800 bg-black";
  const toggleBtn = "text-xs px-2 py-0.5 rounded-md border border-gray-800 text-gray-500 hover:text-gray-300 hover:border-gray-600 transition-colors flex-shrink-0";
  const fovNorm = fovRect && fovFrame
    ? { x: fovRect.x / fovFrame.w, y: fovRect.y / fovFrame.h,
        w: fovRect.w / fovFrame.w, h: fovRect.h / fovFrame.h }
    : null;
  const fovTrim = fovRect && fovFrame ? trimmedFraction(fovRect, fovFrame.w, fovFrame.h) : 0;
  const fovWorthIt = !!fovNorm && fovTrim >= NEGLIGIBLE_TRIM;
  // The panel carries the native ratio while the overlay is up, so the video
  // fills it exactly and the overlay percentages line up with the picture.
  const liveAspect = showFovOverlay && fovFrame ? `${fovFrame.w}/${fovFrame.h}` : aspect;

  const wsStatusText =
    wsStatus === "open" ? t("connected") :
    wsStatus === "closed" ? t("closed ({code})", { code: closeCode ?? "" }) :
    t(wsStatus);

  // Replay has no socket and no GPU, so reporting a connection state (or a
  // latency) would be describing something that isn't happening. Say what it
  // actually is instead — the numbers below stay, they just count replayed
  // frames rather than round trips.
  const replaying = pred !== null;

  return (
    <div className="space-y-3">
      {/* Status bar */}
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-3">
          {!videoUrl ? (
            // Nothing loaded: no socket, no GPU. Showing the websocket's state
            // here would report "connecting" at a moment when, by design,
            // nothing is connecting at all.
            <span className="flex items-center gap-1.5 text-gray-500">
              <span className="w-2 h-2 rounded-full inline-block bg-gray-600" />
              {t("idle · nothing running")}
            </span>
          ) : replaying ? (
            <span className="flex items-center gap-1.5 text-cyan-400">
              <span className="w-2 h-2 rounded-full inline-block bg-cyan-400" />
              {t("saved results · no GPU")}
            </span>
          ) : (
            <span className={`flex items-center gap-1.5 ${wsOk ? "text-green-400" : "text-yellow-400"}`}>
              <span className={`w-2 h-2 rounded-full inline-block ${wsOk ? "bg-green-400 animate-pulse" : "bg-yellow-400"}`} />
              {wsStatusText}
            </span>
          )}
          {polyp && <span className="text-[#39ff14] font-medium animate-pulse">{t("Polyp detected")}</span>}
        </div>
        <button onClick={onStop} className="text-sm text-red-400 hover:text-red-300 transition-colors">{t("Stop")}</button>
      </div>

      {/* Debug panel — one compact row, so it costs height only once */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 font-mono text-xs flex flex-wrap items-center gap-x-5 gap-y-1">
        <span><span className="text-gray-500">{replaying ? t("Frames replayed") : t("Frames sent")} </span><span className="text-white">{stats.sent}</span></span>
        {!replaying && (
          <>
            <span><span className="text-gray-500">{t("Responses back")} </span><span className="text-white">{stats.received}</span></span>
            {/* Round trip split into the half we control and the half we do not.
                Server is timing.modal_ms (CPU time on this box, despite the name);
                network is whatever the round trip costs beyond it. */}
            <span>
              <span className="text-gray-500">{t("Round trip (avg)")} </span>
              <span className={stats.rttMs > 800 ? "text-red-400" : "text-green-400"}>
                {stats.rttMs > 0 ? t("{ms} ms", { ms: stats.rttMs }) : "—"}
              </span>
            </span>
            <span>
              <span className="text-gray-500">{t("server")} </span>
              <span className="text-white">
                {stats.avgMs > 0 ? t("{ms} ms", { ms: stats.avgMs }) : "—"}
              </span>
              <span className="text-gray-600"> + </span>
              <span className="text-gray-500">{t("network")} </span>
              <span className="text-white">
                {stats.rttMs > 0 ? t("{ms} ms", { ms: stats.netMs }) : "—"}
              </span>
            </span>
            <span>
              <span className="text-gray-500">{t("Analysed")} </span>
              <span className="text-white">
                {stats.rttMs > 0 ? t("{fps} fps", { fps: (1000 / stats.rttMs).toFixed(1) }) : "—"}
              </span>
            </span>
          </>
        )}
        {replaying && (
          <span className="text-gray-500">{t("Detections precomputed once — this clip costs no GPU time")}</span>
        )}
        {lastError && (
          <span className="min-w-0">
            <span className="text-gray-500">{t("Error")} </span>
            <span className="text-red-400">{lastError}</span>
          </span>
        )}
      </div>

      {!videoUrl && (
        <div className="space-y-4">
          {/* Tab switcher */}
          <div className="flex gap-1 border-b border-gray-800">
            {(["demo", "upload"] as const).map((tabKey) => (
              <button
                key={tabKey}
                onClick={() => setTab(tabKey)}
                className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                  tab === tabKey
                    ? "border-green-500 text-white"
                    : "border-transparent text-gray-500 hover:text-gray-300"
                }`}
              >
                {tabKey === "upload" ? t("Upload video") : t("Try a demo")}
                {tabKey === "upload" && !user && <span className="ms-1.5 text-gray-600">🔒</span>}
              </button>
            ))}
          </div>

          {/* Your own clip means real per-frame GPU inference, so it needs an
              account — unlike the demo tab next to it, which is free to run. */}
          {tab === "upload" && !user && <LoginPanel onOpenDemos={() => setTab("demo")} />}

          {tab === "upload" && user && (
            <div
              onDrop={handleDrop}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-20 text-center cursor-pointer transition-colors ${
                dragging ? "border-green-400 bg-green-950/20" : "border-gray-700 hover:border-gray-500"
              }`}
            >
              <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={handleFile} />
              <p className="text-gray-200 text-lg">{t("Drop a colonoscopy video here")}</p>
              <p className="text-gray-500 text-sm mt-2">{t("Plays continuously — right panel shows the last analyzed frame")}</p>
            </div>
          )}

          {tab === "demo" && (
            <DemoVideoPicker onSelect={handleDemoSelect} loading={loadingDemo} />
          )}
        </div>
      )}

      {/* Desktop: three equal columns — video on the left, the two feedback
          lanes taking the other two. Equal tracks (plus the same card padding
          on every one) are what make the live panels and the feedback images
          render at identical size. Stacks on narrow screens. */}
      {videoUrl && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
          {/* Session controls. Pressed between moments rather than read during
              one, so they span the top of the grid instead of sitting on the
              video column -- which is what lets the Detected panel and the
              review lane start at the same height. */}
          <div className="xl:col-span-2 min-w-0 bg-gray-900/50 border border-gray-800 rounded-xl p-3
                          flex flex-col md:flex-row md:flex-wrap md:items-center gap-3 [&>*]:min-w-0">
            {/* The one case auto-capture can't cover on its own: a doctor pointing
                out something the model missed. Everything else shows up on its
                own in the side panel, no button needed to go look for it.
                Kept at the top of the column — it's pressed mid-procedure, so it
                should never be somewhere you have to look for or scroll to. */}
            <div className="rounded-xl border border-gray-800 bg-gray-900/60 px-3 py-2 space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-400">{t("Confidence threshold")}</span>
                <span className="font-mono text-gray-200">{Math.round(confMin * 100)}%</span>
              </div>
              <input
                type="range"
                min={0.05}
                max={0.95}
                step={0.05}
                value={confMin}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setConfMin(v);
                  confMinRef.current = v;
                }}
                className="w-full accent-blue-500 cursor-pointer"
              />
              <p className="text-xs text-gray-500">
                {t("Only detections at or above this score are boxed and filed.")}
              </p>
            </div>

            <button
              onClick={captureDrFound}
              className="w-full md:w-auto py-2.5 px-4 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-medium text-sm transition-colors"
            >
              {t("👁 Dr. found a polyp AI missed")}
            </button>
          </div>
          <div className="space-y-2 min-w-0 bg-gray-900/50 border border-gray-800 rounded-xl p-3">
            {/* Detected next — it's the panel being read during the procedure */}
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-gray-500 uppercase tracking-wide truncate">
                  {replaying
                    ? t("Detected · saved result, in sync")
                    : t("Detected · ~{avgMs}ms behind live", { avgMs: stats.avgMs || 250 })}
                </p>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {showDetected && (
                    <button onClick={detectedFs.toggle} className={toggleBtn}>
                      {t("Full screen")}
                    </button>
                  )}
                  <button onClick={() => setShowDetected(!showDetected)} className={toggleBtn}>
                    {showDetected ? t("Hide") : t("Show")}
                  </button>
                </div>
              </div>
              {/* The show/hide wrapper doubles as the fullscreen element, so nothing
                  new is introduced around the ref'd <video>/<canvas>. */}
              <div
                ref={detectedFs.ref}
                className={!showDetected ? "h-0 overflow-hidden opacity-0" : detectedFs.active ? fsWrapClass : ""}
              >
                <div className={panelBox} style={detectedFs.active ? fsBoxStyle(aspect) : { aspectRatio: aspect }}>
                  <canvas ref={analyzedRef} className="absolute inset-0 w-full h-full object-contain" />
                  {detectedFs.active && (
                    <button onClick={detectedFs.toggle} className={fsExitBtnClass}>
                      {t("Exit full screen")}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* The gate sits directly above Detected: when it fires, this is the
                explanation for why that panel has stopped updating. */}
            <InBodyGateNotice gate={inBody} />

            <QualityGateNotice gate={quality} />

            {/* Exact seconds to replay. The whole point of the persistence
                experiment is running identical frames twice, which eyeballing
                the scrub bar cannot deliver. */}
            <div data-testid="test-window" className="space-y-1">
              <p className="text-xs text-gray-500 uppercase tracking-wide">{t("Test window")}</p>
              <div dir="ltr" className="flex items-center gap-2 text-xs">
                <input value={winStart} onChange={(e) => setWinStart(e.target.value)}
                       placeholder="start s" inputMode="decimal"
                       className="w-20 px-2 py-1 rounded-md bg-gray-800 border border-gray-700 text-gray-200 font-mono" />
                <span className="text-gray-600">→</span>
                <input value={winStop} onChange={(e) => setWinStop(e.target.value)}
                       placeholder="stop s" inputMode="decimal"
                       className="w-20 px-2 py-1 rounded-md bg-gray-800 border border-gray-700 text-gray-200 font-mono" />
                {(winStart || winStop) && (
                  <button onClick={() => { setWinStart(""); setWinStop(""); }}
                          className="text-xs px-2 py-0.5 rounded-md border border-gray-800 text-gray-500 hover:text-gray-300">
                    {t("Clear")}
                  </button>
                )}
              </div>
              <p className="text-[11px] text-gray-600">
                {winStart || winStop
                  ? t("Seeks to the start on play and stops at the end. Persistence counters reset each run.")
                  : t("Empty = play the whole clip. Set both to replay identical frames with persistence on and off.")}
              </p>
            </div>

            <TemporalGateNotice gate={temporal} />

            <FilterBankNotice gate={gate} temporal={temporal} show={showBank} onToggle={() => setShowBank(!showBank)} />

            {/* Live source underneath, as the reference feed */}
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-gray-500 uppercase tracking-wide truncate">
                  {videoEnded ? t("Finished · {speed}x", { speed }) : t("Live · {speed}x · no lag", { speed })}
                </p>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {showLive && (
                    <button onClick={liveFs.toggle} className={toggleBtn}>
                      {t("Full screen")}
                    </button>
                  )}
                  <button onClick={() => setShowLive(!showLive)} className={toggleBtn}>
                    {showLive ? t("Hide") : t("Show")}
                  </button>
                </div>
              </div>
              {/* The show/hide wrapper doubles as the fullscreen element, so nothing
                  new is introduced around the ref'd <video>/<canvas>. */}
              <div
                ref={liveFs.ref}
                className={!showLive ? "h-0 overflow-hidden opacity-0" : liveFs.active ? fsWrapClass : ""}
              >
                <div className={panelBox} style={liveFs.active ? fsBoxStyle(liveAspect) : { aspectRatio: liveAspect }}>
                  <video
                    ref={videoRef}
                    src={videoUrl}
                    muted
                    onCanPlay={handleVideoLoad}
                    onTimeUpdate={handleTimeUpdate}
                    onLoadedMetadata={handleVideoLoad}
                    onEnded={() => { scanRef.current = false; setVideoEnded(true); }}
                    className="absolute inset-0 w-full h-full object-contain"
                  />
                  {showFovOverlay && fovNorm && (
                    <div className="absolute inset-0 pointer-events-none">
                      <div
                        className="absolute border-2 border-[#39ff14]"
                        style={{
                          left:   `${fovNorm.x * 100}%`,
                          top:    `${fovNorm.y * 100}%`,
                          width:  `${fovNorm.w * 100}%`,
                          height: `${fovNorm.h * 100}%`,
                          boxShadow: "0 0 0 9999px rgba(239,68,68,0.5)",
                        }}
                      />
                      <p className="absolute bottom-1 inset-x-1 text-center text-[11px] leading-tight text-white bg-black/75 rounded px-1 py-0.5">
                        {t("Red is dropped before inference — {pct}% of the frame", { pct: Math.round(fovTrim * 100) })}
                      </p>
                    </div>
                  )}
                  {liveFs.active && (
                    <button onClick={liveFs.toggle} className={fsExitBtnClass}>
                      {t("Exit full screen")}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Field of view — only on the live-inference path. A demo replaying
                precomputed boxes is not cropped, so offering the control there
                would promise something that does not happen. */}
            {liveInference && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <label className="flex items-center gap-2 text-gray-400 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={fovEnabled}
                    onChange={(e) => setFovEnabled(e.target.checked)}
                    className="accent-green-500"
                  />
                  {t("Crop to the picture area")}
                </label>
                {fovWorthIt ? (
                  <>
                    <span className="text-xs text-gray-500">
                      {t("{pct}% of the frame is border", { pct: Math.round(fovTrim * 100) })}
                    </span>
                    <button onClick={() => setShowFovOverlay(!showFovOverlay)} className={toggleBtn}>
                      {showFovOverlay ? t("Hide what is cropped") : t("Show what is cropped")}
                    </button>
                  </>
                ) : (
                  <span className="text-xs text-gray-600">
                    {fovRect
                      ? t("No border to crop — measured {pct}%, needs {min}%", {
                          pct: (fovTrim * 100).toFixed(1), min: Math.round(NEGLIGIBLE_TRIM * 100) })
                      : t("measuring…")}
                  </span>
                )}
              </div>
            )}

            {/* Seek — for lining up the exact moment before a manual capture */}
            <input
              type="range" min={0} max={duration || 0} step={0.1} value={curTime}
              onChange={(e) => seekTo(parseFloat(e.target.value))}
              className="w-full"
            />

            {/* Transport + speed on one row — vertical space is the scarce thing here */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
              <button onClick={() => seekTo(curTime - 3)} className="px-2.5 py-1 rounded-md bg-gray-800 hover:bg-gray-700 text-gray-300 font-mono transition-colors">{t("← 3s")}</button>
              <button onClick={() => seekTo(curTime - 1)} className="px-2.5 py-1 rounded-md bg-gray-800 hover:bg-gray-700 text-gray-300 font-mono transition-colors">{t("← 1s")}</button>
              <button onClick={replay} className="px-2.5 py-1 rounded-md bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium transition-colors">{t("↺ Replay")}</button>
              <span className="text-gray-500 font-mono">{curTime.toFixed(1)}s / {duration.toFixed(1)}s</span>
              <span className="w-px h-4 bg-gray-800" />
              <span
                className="text-gray-500"
                title={t("slower playback = less motion between frames = the two panels drift apart less")}
              >
                {t("Playback speed")}
              </span>
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  onClick={() => setSpeed(s)}
                  className={`px-2.5 py-1 rounded-md font-mono transition-colors ${
                    speed === s ? "bg-green-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                  }`}
                >
                  {s}x
                </button>
              ))}
            </div>

            <button
              onClick={unloadClip}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              {t("← Load different video")}
            </button>
          </div>

          {/* Feedback box — spans the remaining two tracks (one per lane) and
              scrolls internally so it never lengthens the page. No padding or
              border of its own: each lane brings the same card chrome as the
              video column, so all three line up. */}
          <div className="min-w-0 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto">
            <FeedbackPanel caseId={caseId} refreshSignal={feedbackRefreshKey} />
          </div>
        </div>
      )}

      <p className="text-xs text-gray-600">
        {replaying
          ? t("Replaying detections computed once at {width}px — identical to a live run, without the GPU", { width: pred?.width ?? INFER_WIDTH })
          : t("Frames scaled to {width}px before sending · one frame in flight at a time", { width: INFER_WIDTH })}
      </p>
    </div>
  );
}
