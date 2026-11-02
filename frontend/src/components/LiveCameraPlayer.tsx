"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import FeedbackPanel from "./FeedbackPanel";
import RecordingControls from "./RecordingControls";
import RecordingRecoveryBanner from "./RecordingRecoveryBanner";
import RecordingsPanel from "./RecordingsPanel";
import { DEMO_VIDEOS } from "./demos";
import { useLanguage } from "@/lib/i18n";
import { useInBodyGate } from "@/lib/useInBodyGate";
import InBodyGateNotice from "./InBodyGateNotice";
import { useQualityGate } from "@/lib/useQualityGate";
import { frameQuality } from "@/lib/frameQuality";
import QualityGateNotice from "./QualityGateNotice";
import FilterBankNotice, { type GateState } from "./FilterBankNotice";
import { useTemporalGate } from "@/lib/useTemporalGate";
import TemporalGateNotice from "./TemporalGateNotice";
import { useSessionRecorder } from "@/lib/useSessionRecorder";
import { useAuth } from "@/lib/auth";
import { beginLiveInference } from "@/lib/uploadCoordinator";
import { detectFovRect, unionRect, intersectRect, trimmedFraction, NEGLIGIBLE_TRIM, type Rect } from "@/lib/fov";
import { negotiateCameraMode, describeMode, type ModeAttempt } from "@/lib/cameraMode";
import { combRatio, looksInterlaced, createDeinterlacer } from "@/lib/interlace";
import { drawBoxes, type Box } from "@/lib/drawBoxes";
import { createGLEnhancer, type GLEnhancer } from "@/lib/enhanceGL";
import { createGLDeinterlacer, DEINT_MODES, type GLDeinterlacer, type DeintMode } from "@/lib/deinterlaceGL";
import { readProcAmpCaps, readProcAmpValues, measureLevels, autoTuneProcAmp,
         type ProcAmpCaps } from "@/lib/procAmp";
import { useFullscreen, fsWrapClass, fsExitBtnClass, fsBoxStyle } from "@/lib/useFullscreen";
import { useAlertSound } from "@/lib/useAlertSound";
import AlertSoundControls from "./AlertSoundControls";
import CaptureStrip, { StripChooser, STRIP_SIZE_DEFAULT, clampStripSize,
         type Shot, type StripPos, type StripReplay } from "./CaptureStrip";
import LatencyHud, { type LatencyStats } from "./LatencyHud";
import DoctorScreen from "./DoctorScreen";
import { useDoctorWindow, doctorRoot, canPlaceWindows, hasSecondDisplay,
         listDisplays, suggestDisplay, watchDisplays,
         type DoctorDisplay } from "@/lib/useDoctorWindow";
import { Rolling } from "@/lib/rolling";
import { FrameStore } from "@/lib/frameRing";
import type { TimelineSource } from "./FeedbackPanel";

const API = process.env.NEXT_PUBLIC_API_URL || "";
// Where the captured-frame strip sits in the fullscreen view. Same
// remember-the-operator's-choice convention as the gate switches.
const STRIP_POS_KEY = "polyp_strip_pos";
const STRIP_SIZE_KEY = "polyp_strip_size";
// Enough to glance back over the last minute or so of an appearance-heavy
// stretch; small enough that the object URLs behind them stay trivial.
const SHOT_RING = 12;
// Whether the developer readout is drawn over the fullscreen picture.
const HUD_KEY = "polyp_hud_on";
// Long enough to be a baseline for "is this frame unusual", as opposed to
// the 10/20-sample display averages, which a spike pollutes in three
// frames. ~4s of a 15 fps session.
const BASELINE_N = 60;
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
// Resolve the socket origin explicitly rather than leaning on a relative
// WebSocket URL: the spec allows it, but an absolute ws:// is unambiguous and
// still follows the page from an IP to a domain with no rebuild.
const API_WS = (process.env.NEXT_PUBLIC_API_URL
  || (typeof window !== "undefined" ? window.location.origin : "")).replace(/^http/, "ws");
const INFER_TIMEOUT_MS = 6000;
// Resize frames to this width before sending — faster inference, smaller payload
const INFER_WIDTH = 320;

/** Fixed-320 view of a larger capture, for the gates whose thresholds were
 *  fitted at 320px (lib/frameQuality resamples from the capture size, so
 *  feeding it a 640 capture shifts its statistics; see useQualityGate). */
function downscaleForGates(src: HTMLCanvasElement): HTMLCanvasElement {
  const w = INFER_WIDTH;
  const h = Math.max(1, Math.round((src.height * w) / src.width));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, h);
  return c;
}
// Reconnect backoff for the inference socket. The clinic PC is unattended, so
// a dropped socket has to heal itself -- a backend restart, an nginx reload or
// a brief network outage must not end the day's detection. Doubles from 1s to
// a 15s ceiling and then keeps trying at that rate indefinitely: there is
// nobody there to reload the page, so giving up is never the right answer.
const WS_RETRY_BASE_MS = 1_000;
const WS_RETRY_MAX_MS  = 15_000;

// Kiosk watchdog (autoStart only). How often to check that the capture card is
// still open and still producing frames, and how long the picture may be
// frozen before the device is re-opened. A card that is unplugged fires an
// `ended` event and is handled the moment it happens; this is for the other
// case -- a driver that keeps the track "live" while sending nothing, which
// looks exactly like a quiet procedure to everything else in this file.
const KIOSK_WATCH_MS  = 15_000;
const KIOSK_FROZEN_MS = 45_000;
// Re-opening the device has not helped this many times in a row -> reload the
// page. Safe, and the last thing left to try: kiosk mode rebuilds the whole
// session from localStorage, so the page comes back into live camera by itself.
const KIOSK_MAX_RECOVERIES = 3;

// How long out-of-body has to persist before auto-record treats it as the
// procedure actually ending (finalize + upload) rather than a brief
// withdrawal (pause, ready to resume the same recording). Past the threshold
// the recording is finalized and the next re-entry opens a NEW one, so this
// is what decides whether one procedure is one video or several.
//
// Was 5s, on the reasoning that anything shorter is "just a brief withdrawal"
// and anything longer is probably the next patient. The clinic sessions of
// 2026-09-30 showed 5s is far too short in practice: case 7fa0f49b became 9
// separate recordings across 31 minutes, four of them holding under 10s of
// video each (0.3s and 1.2s among them), and 2026-10-07 and 2026-10-08
// sessions split the same way. Those short fragments also show the gate
// bouncing in and out rather than the scope leaving: one held 0.3s of video
// inside 5.5s of wall clock, i.e. it was called out-of-body for most of its
// life. Either way a 5s fuse fires mid-procedure, cutting footage.
// 1 minute out is the user's call and is still well short of the gap between
// two patients (minutes), which is the case this threshold exists to separate.
const OUT_OF_BODY_STOP_MS = 60_000;
// Same ladder RealtimePlayer offers, so the two players behave alike. Only
// meaningful for a file-backed source; a camera runs at whatever rate it runs.
const SPEEDS = [0.1, 0.25, 0.5, 0.7, 1, 1.5, 2];
// Demo clips are watched slowed down: less motion between frames, so the raw
// and annotated panels drift apart less. Only the demos -- a saved recording
// or the operator's own file starts at 1x. Must be a member of SPEEDS or no
// button renders as selected.
const DEMO_SPEED = 0.7;
// How many of the first frames of a session are measured to find the picture
// area. The border does not move, so this is a fixed startup cost, not a
// per-frame one. Several rather than one because the union of several frames
// cannot be fooled by a single dark frame — see lib/fov.ts.
const FOV_SAMPLE_FRAMES = 8;
// How many frames to spend deciding whether the source is interlaced before
// concluding it is not. Far more generous than the FOV budget above, and for a
// different reason: a border shows up in any frame, but comb only appears where
// something MOVED. A scope sitting still at the start of a session is not
// evidence of a progressive source, so this has to outlast a quiet opening —
// roughly two seconds at inference rate. A single moving frame settles it;
// see sampleInterlace.
const INTERLACE_SAMPLE_FRAMES = 60;
// How many frames may be awaiting a reply at once.
//
// At 1, the loop is strictly send -> wait -> send, so every millisecond the
// network costs is a millisecond no frame is being inferred. Measured against
// the clinic link that is not a rounding error: round trip is a median 9ms but
// a p90 of 27ms and a p99 of 44ms, so at the tail the wire was costing about a
// third of the frame budget -- and because the loop is serialised, each stall
// drops frames directly rather than being absorbed.
//
// At 1 frame in flight the next frame is encoded and sent while the previous
// one is still being inferred, which hides the wire behind the model instead of
// adding to it. Deliberately not higher: every extra frame in flight is one
// more frame of staleness between the picture and its boxes, and for a CADe
// overlay that is a clinical cost, not just a latency figure.
const MAX_IN_FLIGHT = 1;
// One slot for the frame being prepared, plus one per frame awaiting a reply.
const HI_RING_SLOTS = MAX_IN_FLIGHT + 1;
// A polyp that is STILL on screen is re-filed at most this often, so a long
// look is not represented in the queue by a single frame.
const AUTO_CAPTURE_REFRESH_MS = 8000;
// A detection gap shorter than this counts as the same episode. The detector
// drops the odd frame on a lesion that never left the screen, and treating that
// as "gone" would re-trigger a capture on the very next frame.
const DETECTION_GAP_MS = 1000;

// ---------------------------------------------------------------------------
// Three tiers of response. Two have their own bar; the third has none of its
// own by design.
//
//   tier 1  box on screen   temporal gate, 2-of-3 (~0.5 s)   lib/temporal.ts
//   tier 2  filed capture   first frame at once, then best of the window
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
// It twice did. It gated on 2 s plus conf >= 0.5, which on the current model
// meant the room almost never heard anything; then it rode along inside
// flushBest() and beeped once per filed capture, including every 8 s refresh
// capture while one lesion stayed on screen. Both were attempts to define
// "worth announcing" a second time, separately from tier 1, which already
// defines it. So the question "is there a box on the video" is now answered in
// one place and tiers 1 and 3 both read the answer -- see
// documents/adr/0004-alert-mirrors-box.md.
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

// A demo clip is a third source alongside the two real ones, and a recording
// already on this server is a fourth. Neither is a separate playback mode: the
// frames go through the identical capture loop, socket, FOV crop, auto-capture
// and session-recording path, so from here down both behave like a camera.
// That is the point of replaying a recording — it is not a preview, it is the
// live pipeline fed from a file instead of from the capture card.
type CaptureMode = "camera" | "screen" | "demo" | "recording" | "local";
// Demo entries share the device <select> with real cameras, so their option
// values have to be distinguishable from a deviceId.
const DEMO_PREFIX = "demo:";
// Recordings share the same <select>, so their option values have to be
// distinguishable from both a deviceId and a demo filename.
const REC_PREFIX = "rec:";
// Smallest saved recording the picker offers. The list had grown to 45 entries,
// most of them seconds long -- wreckage from when a brief withdrawal from the
// body finalized the recording and started a new one (see OUT_OF_BODY_STOP_MS),
// plus four with a duration but zero bytes, which 404 on play. Replaying any of
// them is pointless, and they buried the handful of real procedures.
//
// Measured in bytes rather than seconds because that is what correlates with
// footage: at the VIDEO_BITS_PER_SECOND the recorder asks for (~150 KB/s), this
// is about ten seconds of video, and it excludes the zero-byte ones for free.
// Nothing becomes unreachable -- the per-case panel inside a session still
// lists every recording, filtered or not.
const MIN_CLIP_BYTES = 1_500_000;
// A clip the operator picked off their own machine. It joins the same list
// as the bundled demos rather than getting a control of its own: from the
// pipeline's point of view the three file sources are indistinguishable.
const LOCAL_PREFIX = "local:";

/** Just the fields the source picker needs — RecordingsPanel owns the full shape. */
interface ServerRecording {
  id: string;
  case_id: string;
  // "joined" is a recording assembled on the server out of the fragments one
  // procedure was split into -- see the out-of-body stop threshold. It is read
  // and played like any other, it just was never uploaded by a browser.
  source: "camera" | "screen" | "joined" | "replay";
  width: number;
  height: number;
  started_at: number;
  duration_ms: number;
  status: string;
  /** Size on disk as the server sees it right now -- filled in per request,
   *  not stored. The only honest measure of how much footage a recording
   *  actually holds: duration_ms is wall clock and counts paused out-of-body
   *  stretches, so a 6s entry can hold 0.2s of video. */
  bytes: number;
  /** The day the procedure actually happened, as YYYY-MM-DD. Read off the
   *  endoscope's own burnt-in overlay and written by
   *  backend/scripts/triage_recordings.py -- NOT derivable from started_at,
   *  which is when the server wrote the file and can be weeks later for
   *  anything that was replayed. Absent on recordings made since, where
   *  started_at is honest again. */
  clinic_date?: string;
  /** Ids this recording was stitched together from, so the parts can be
   *  dropped from the picker instead of listed alongside the whole thing. */
  joined_from?: string[];
}

/** m:ss under an hour, h:mm:ss past it -- a raw seconds count (e.g. "973.1s")
 *  is unreadable for anything longer than a short clip. */
function formatClock(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** The day a recording belongs to, as YYYY-MM-DD. The endoscope's own overlay
 *  wins where the cleanup recorded it; otherwise fall back to when the server
 *  wrote the file, which is right for anything captured live. */
function clinicDayKey(r: ServerRecording): string {
  if (r.clinic_date) return r.clinic_date;
  const d = new Date(r.started_at * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Label for one option inside a day's optgroup. The date is deliberately
 *  left out -- the group heading already carries it, and repeating it on every
 *  row is what made the old flat list unreadable. */
function describeRecordingInDay(r: ServerRecording): string {
  const when = new Date(r.started_at * 1000);
  const stamp = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const secs = Math.round((r.duration_ms || 0) / 1000);
  const dur = secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s` : `${secs}s`;
  const mb = r.bytes > 0 ? ` · ${Math.round(r.bytes / 1e6)} MB` : "";
  const whole = r.source === "joined" ? "🎬 " : "";
  return `${whole}${stamp} · ${dur}${mb}`;
}

/** Enough to tell two recordings apart on their own, outside any grouping --
 *  the "now replaying…" banner, where there is no heading to lean on. */
function describeRecording(r: ServerRecording): string {
  const when = new Date(r.started_at * 1000);
  const stamp = `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const secs = Math.round((r.duration_ms || 0) / 1000);
  const dur = secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s` : `${secs}s`;
  const mb = r.bytes > 0 ? ` · ${Math.round(r.bytes / 1e6)} MB` : "";
  return `${stamp} · ${dur} · ${r.source}${mb}`;
}

interface Timing { recv_ms: number; modal_ms: number; total_ms: number; }

/**
 * Which of these devices is the endoscope capture card?
 *
 * The label is the only signal a browser gives — enumerateDevices reports no
 * device class and no USB id — so this is a guess, and it is written to
 * abstain rather than guess wrong. The thing a wrong answer would pick is the
 * machine's own webcam, pointed at the room, so built-in cameras are ruled OUT
 * first and a grabber-shaped name is preferred among whatever is left. When
 * neither signal settles it the operator still gets the dropdown.
 *
 * Only ever consulted when nothing has been remembered yet — see
 * preselectRemembered. After the first explicit pick on a machine, that pick
 * is what comes back, whatever its name looks like.
 */
const BUILTIN_CAMERA_RE = /integrated|built[- ]?in|facetime|webcam|front|rear|user[- ]?facing|laptop/i;
/** The clinic's card is an ezcap/Somagic SMI-2021 (see lib/cameraMode.ts);
 *  the rest are the names the common USB/HDMI grabbers enumerate under. */
const CAPTURE_CARD_RE = /capture|grabber|ezcap|somagic|smi[- ]?2021|stk1160|usb ?video|av ?to ?usb|hdmi|utv\d|elgato|cam ?link/i;

function pickCaptureCard(cams: MediaDeviceInfo[]): MediaDeviceInfo | undefined {
  // Unlabelled devices carry no evidence either way; permission has not been
  // granted yet and there is nothing to read.
  const named = cams.filter((d) => d.label);
  const grabber = named.find((d) => CAPTURE_CARD_RE.test(d.label) && !BUILTIN_CAMERA_RE.test(d.label));
  if (grabber) return grabber;
  // No recognisable name. One single non-webcam device is still unambiguous —
  // two or more is not, and that is the case to leave alone.
  const rest = named.filter((d) => !BUILTIN_CAMERA_RE.test(d.label));
  return rest.length === 1 ? rest[0] : undefined;
}

export default function LiveCameraPlayer({ caseId, onStop, onActivity, wsPath = "/api/ws/infer", initialMode = "camera", backend, inferWidth = INFER_WIDTH, initialConf = 0.30, autoStart = false, onCaseEnd, uplinkMbps = null }: { caseId: string; onStop: () => void; onActivity?: () => void; wsPath?: string; initialMode?: "camera" | "screen" | "demo"; backend?: string; inferWidth?: number; initialConf?: number; /** Open the preselected camera on mount, with no click, and keep it open. Kiosk only — see the watchdog next to listDevicesQuietly. */ autoStart?: boolean; /** One procedure has ended (scope out of the body past OUT_OF_BODY_STOP_MS). The owner rotates the case id; see applyAutoRecord. */ onCaseEnd?: () => void; /** The uplink speed measured at session start (see page.tsx openMode), in Mbps -- carried through to the room-stats report so it lands in the server netstat log, and used here to warn if it looks too slow for the frame stream. Null until the probe resolves, or if it never ran (e.g. a replay with no real session start). */ uplinkMbps?: number | null }) {
  const { t, lang } = useLanguage();
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
  // Exact test window, in seconds. The comparison this exists for -- the same
  // footage with persistence on and off -- is only a comparison if both runs
  // cover identical frames, and "I pressed stop at about the same place" is
  // not identical. Only a file-backed source has a timeline to hold to: a
  // camera runs once, forwards, and cannot be asked for the same seconds twice.
  const [winStart, setWinStart] = useState("");
  const [winStop, setWinStop] = useState("");
  const winRef = useRef<{ a: number; b: number } | null>(null);
  // Set when the loop has stopped itself at the end of the window, so play
  // means "run it again" rather than "resume past what was being measured".
  const [winDone, setWinDone] = useState(false);
  // The engine is pinned for the life of the socket — the server reads it once,
  // so the latency average never blends two very different backends.
  // case_id lets the backend fan this session's frames out to spectator mode
  // (see app/spectator/[caseId]/page.tsx) -- harmless to include even when
  // nobody is watching, since the backend only does the extra work once a
  // spectator has actually subscribed to this exact id.
  const WS_URL = `${API_WS}${wsPath}?case_id=${encodeURIComponent(caseId)}`
    + (backend ? `&backend=${encodeURIComponent(backend)}` : "");
  // The socket outlives the render that opened it -- it reconnects on its own
  // and is deliberately re-opened when the case id rotates -- so the URL and
  // the case id are read from refs at connect time rather than captured in the
  // mount-time closure, which would pin a reconnect to the previous patient.
  const wsUrlRef  = useRef(WS_URL);
  const caseIdRef = useRef(caseId);
  useEffect(() => { wsUrlRef.current = WS_URL; caseIdRef.current = caseId; }, [WS_URL, caseId]);
  // Same reason: the room-stats POST runs inside the socket's own message
  // handler, not a render, so it must read the probe's result through a ref
  // rather than close over the uplinkMbps prop at mount time -- the probe in
  // page.tsx's openMode resolves after this component is already mounted.
  const uplinkMbpsRef = useRef(uplinkMbps);
  useEffect(() => { uplinkMbpsRef.current = uplinkMbps; }, [uplinkMbps]);
  /** Drop the current socket so it comes straight back on the current URL.
   *  Set by the socket effect; used when the case id rotates. */
  const reopenSocketRef = useRef<(() => void) | null>(null);
  const videoRef    = useRef<HTMLVideoElement | null>(null);
  const analyzedRef = useRef<HTMLCanvasElement>(null); // last frame actually sent to the model, with boxes burned on
  const wsRef       = useRef<WebSocket | null>(null);
  const scanRef     = useRef(false); // capture loop running?
  const streamRef   = useRef<MediaStream | null>(null);
  const lastAutoCaptureRef = useRef(0);
  const lastDetectionRef   = useRef(0);     // when a box was last seen
  const inEpisodeRef       = useRef(false); // inside one continuous appearance?
  // One capture upload at a time. A rolling clip plus its frame is megabytes and
  // a clinic uplink is not fast: without this, a run of detections queues a dozen
  // multi-megabyte POSTs that compete with the websocket carrying frames for the
  // same upstream, inference stalls, and the uploads themselves get abandoned
  // (nginx logged 81 x 499 and 15 x 408 in one day). Skipping a capture costs
  // little — an episode that is still on screen files one on the next refresh.
  const uploadingRef       = useRef(false);
  const lastBoxesRef = useRef<Box[]>([]); // AI's most recent detections — attached as context to manual captures

  // One appearance of a lesion, as a small state machine. `hits` and `start`
  // decide whether tier 2 has been earned; `best` holds the best frame seen so
  // far, and `filed` makes it file once rather than once per frame. Tier 3 is
  // not in here any more -- it tracks the drawn box, not the capture.
  const episodeStartRef   = useRef(0);
  const episodeHitsRef    = useRef(0);
  const episodeFiledRef   = useRef(false);
  // Appearances kept so "where was it?" has an answer -- see
  // lib/replaySource.ts. The ref is the source of truth and is mutated per
  // inferred frame; the state is a snapshot published only when an appearance
  // opens or closes, because re-rendering this component (both video panels,
  // the overlays, the gates) several times a second is not free.
  // Every frame of this patient that the model scored, so the review panel's
  // timeline can be scrubbed and played. NOT the session recording: a
  // MediaRecorder WebM cannot be played from the middle at all -- see
  // lib/frameRing.ts for the three routes that were measured and rejected.
  const frameStoreRef     = useRef<FrameStore>(new FrameStore());
  // Wall clock at which the current procedure started. The timeline's axis is
  // milliseconds from here, which works whether or not anything is recording.
  const procStartRef      = useRef(0);
  // Capture filename -> its moment on that axis, recorded when the upload comes
  // back with the name the server gave it. This is what puts a reviewable
  // capture at an exact point on the bar, rather than at its server timestamp,
  // which is only second-resolution and on the server's clock.
  const captureAtRef      = useRef<Map<string, number>>(new Map());
  // The bar gets longer while a procedure runs, so the panel needs a heartbeat.
  const [timelineTick, setTimelineTick] = useState(0);
  const bestRef = useRef<{ score: number; boxes: Box[] } | null>(null);
  // Two scratch canvases, reused for the life of the session: the frame being
  // considered, and the best one held so far. A fresh 960px canvas per inferred
  // frame would be megabytes a second of garbage on a clinic PC.
  // A ring, not one canvas. With a frame in flight while the next is being
  // prepared, a single scratch would be overwritten by frame N+1 before frame
  // N's boxes came back -- and those boxes would then be drawn over, and filed
  // against, the wrong picture. That is exactly the guarantee grabCapture
  // exists to provide. Two slots is the minimum for MAX_IN_FLIGHT = 1 and must
  // grow with it: a slot has to survive from its grab until its reply settles.
  const hiRingRef = useRef<HTMLCanvasElement[]>([]);
  const hiSlotRef = useRef(0);
  const bestCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // At most one capture may wait behind an in-flight upload. More than one and
  // we are back to queueing POSTs against the same upstream the frame stream
  // uses; none at all and a capture that merely coincided with a busy uplink is
  // lost outright — which is a lesion the reviewer never sees.
  const deferredRef = useRef<{ blob: Blob; boxes: Box[]; kind: "first" | "best"; shotId?: string } | null>(null);
  // The last few filed captures, kept as object URLs so the doctor can glance
  // back at them without leaving the live view -- see components/CaptureStrip.
  // A ring and not a list: 12 x 960px JPEG is ~1.5 MB worst case, a whole
  // procedure's worth would not be.
  // Longer-window means, used ONLY to decide whether the current sample is a
  // spike worth colouring. Deliberately separate from the display averages
  // below, whose window lengths are a compatibility surface -- they are what
  // gets posted to room-stats and rendered in spectator mode.
  // Bumped once per annotated repaint. The doctor window's mirror loop runs
  // on its own clock and uses this to tell "there is a new frame" from "the
  // same frame again", so it copies pixels at most once per inference reply
  // instead of once per monitor refresh.
  const analyzedGenRef = useRef(0);
  const doctor = useDoctorWindow();
  // Getters, not values: handing the mirror loop a fresh closure on every
  // inference reply would restart it 15 times a second.
  const mirrorSource = useCallback(() => analyzedRef.current, []);
  const mirrorGeneration = useCallback(() => analyzedGenRef.current, []);
  const [displays, setDisplays] = useState<DoctorDisplay[] | null>(null);
  const [chosenDisplay, setChosenDisplay] = useState(0);
  const [doctorNote, setDoctorNote] = useState<string | null>(null);
  const [doctorManual, setDoctorManual] = useState(false);

  const rttBase    = useRef(new Rolling(BASELINE_N));
  const serverBase = useRef(new Rolling(BASELINE_N));
  const netBase    = useRef(new Rolling(BASELINE_N));
  const fpsBase    = useRef(new Rolling(BASELINE_N));
  // This frame's raw numbers. The grid shows the averages; only the spike
  // test looks at these.
  const [cur, setCur] = useState({ rtt: 0, server: 0, net: 0, fps: 0 });
  const [hudOn, setHudOnState] = useState(false);
  const setHudOn = useCallback((v: boolean) => {
    setHudOnState(v);
    try { localStorage.setItem(HUD_KEY, v ? "1" : "0"); } catch { /* private mode */ }
  }, []);
  useEffect(() => {
    try { if (localStorage.getItem(HUD_KEY) === "1") setHudOnState(true); } catch { /* private mode */ }
  }, []);

  const [shots, setShots] = useState<Shot[]>([]);
  const shotSeqRef = useRef(0);
  const shotsRef = useRef<Shot[]>([]);
  // Read inside pushShot's eviction, which runs from a toBlob callback and so
  // cannot see the current render's state.
  const openShotIdRef = useRef<string | null>(null);
  const [openShotId, setOpenShotIdState] = useState<string | null>(null);
  const setOpenShotId = useCallback((id: string | null) => {
    openShotIdRef.current = id;
    setOpenShotIdState(id);
  }, []);
  // Where the strip sits over the fullscreen picture, and whether it is shown
  // at all. Seeded from localStorage in an effect rather than in the
  // initialiser so the server and the first client render agree.
  const [stripPos, setStripPosState] = useState<StripPos>("bottom");
  const setStripPos = useCallback((p: StripPos) => {
    setStripPosState(p);
    try { localStorage.setItem(STRIP_POS_KEY, p); } catch { /* private mode */ }
  }, []);
  // How big the strip's tiles are. A bigger tile means fewer fit in the same
  // band, which is the trade -- the band never grows, so the picture never
  // shrinks whatever this is set to.
  const [stripSize, setStripSizeState] = useState(STRIP_SIZE_DEFAULT);
  const setStripSize = useCallback((n: number) => {
    const v = clampStripSize(n);
    setStripSizeState(v);
    try { localStorage.setItem(STRIP_SIZE_KEY, String(v)); } catch { /* private mode */ }
  }, []);
  useEffect(() => {
    try {
      const v = localStorage.getItem(STRIP_SIZE_KEY);
      if (v !== null && v !== "" && Number.isFinite(Number(v))) setStripSizeState(clampStripSize(Number(v)));
    } catch { /* private mode */ }
  }, []);

  useEffect(() => { shotsRef.current = shots; }, [shots]);
  useEffect(() => {
    try {
      const v = localStorage.getItem(STRIP_POS_KEY);
      if (v === "bottom" || v === "top" || v === "right" || v === "off") setStripPosState(v);
    } catch { /* private mode */ }
  }, []);
  // "Copied" confirmation for the spectator-link button, cleared a moment
  // after the click so a stale "Copied" never lingers on screen.
  const [spectatorLinkCopied, setSpectatorLinkCopied] = useState(false);
  // Tier 3, whole: opt-in and remembered like the other gates, plus how long it
  // sounds for. Driven from updateBoxes below, so it says exactly what tier 1
  // draws.
  const alert = useAlertSound();

  /** One entry per frame handed to the socket and not yet answered.
   *
   *  A FIFO rather than a single resolver, because more than one frame is now
   *  in flight (see MAX_IN_FLIGHT). Nothing correlates a reply to its request
   *  explicitly and nothing needs to: _stream_frames receives, infers and
   *  replies strictly one frame at a time, and the socket preserves order, so
   *  the Nth reply always belongs to the Nth request. Shifting off the front
   *  is the correlation.
   *
   *  `done` is what keeps that true across a timeout. A frame we gave up on
   *  stays in the queue as a tombstone, because the server has not given up
   *  and its reply is still coming; dropping the entry outright would make
   *  every later reply answer the wrong frame. */
  interface Pending {
    resolve: (v: { boxes: Box[]; timing: Timing } | null) => void;
    sentAt: number;
    done: boolean;
  }
  const pendingQueueRef = useRef<Pending[]>([]);

  /** Hand one frame to the socket and return a promise for its boxes. Does NOT
   *  wait: the caller decides when to settle it, which is what lets the next
   *  frame be prepared and sent while this one is still being inferred. */
  function sendForInference(ws: WebSocket, buf: ArrayBuffer) {
    return new Promise<{ boxes: Box[]; timing: Timing } | null>((resolve) => {
      const entry: Pending = { resolve, sentAt: performance.now(), done: false };
      pendingQueueRef.current.push(entry);
      ws.send(buf);
      sentCountRef.current += 1;
      setStats((st) => ({ ...st, sent: st.sent + 1 }));
      setTimeout(() => {
        // Leave the entry in the queue as a tombstone -- the server has not
        // given up and its reply still has to consume a slot. See Pending.
        if (!entry.done) { entry.done = true; resolve(null); }
      }, INFER_TIMEOUT_MS);
    });
  }

  /** Fail every outstanding frame — on socket close, or when the loop stops.
   *  Without this a caller stays awaited forever on a socket that will never
   *  answer. */
  function flushPending() {
    const q = pendingQueueRef.current;
    pendingQueueRef.current = [];
    for (const e of q) if (!e.done) { e.done = true; e.resolve(null); }
  }

  const [devices, setDevices]             = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedId] = useState("");
  const selectedDeviceIdRef = useRef("");
  useEffect(() => { selectedDeviceIdRef.current = selectedDeviceId; }, [selectedDeviceId]);
  const [permission, setPermission]       = useState<"idle" | "requesting" | "granted" | "denied">("idle");
  // What the capture device actually handed back, and whether any of it was
  // unwritten padding. Surfaced to the operator because a card that has
  // quietly come up in the wrong mode looks exactly like one that has not --
  // see lib/cameraMode.ts for why the browser cannot be left to choose.
  const [sourceMode, setSourceMode]       = useState<{ text: string; padded: boolean } | null>(null);
  const [modeScan, setModeScan]           = useState<ModeAttempt[] | null>(null);
  const [scanningModes, setScanningModes] = useState(false);
  // Negotiation adjusts the track two or three times and measures a frame
  // after each, which is a couple of seconds of apparently nothing. Without
  // this the operator is left watching a dead panel wondering whether their
  // click registered -- reported from the clinic, not hypothetical.
  const [negotiating, setNegotiating]     = useState("");
  // Mirrors for the kiosk watchdog, which runs off a setTimeout chain and so
  // cannot see the render that produced them.
  const negotiatingRef = useRef("");
  useEffect(() => { negotiatingRef.current = negotiating; }, [negotiating]);
  // Frame shape of the last stream, so a change of shape can invalidate the
  // things measured against the old one.
  const lastFrameSizeRef                  = useRef<{ w: number; h: number } | null>(null);
  const [streaming, setStreaming]         = useState(false);
  // "closed" now means closed for good (the component is going away);
  // an unexpected drop is "reconnecting", because it is about to come back.
  const [wsStatus, setWsStatus]           = useState<"connecting" | "open" | "error" | "reconnecting" | "closed">("connecting");
  const [closeCode, setCloseCode]         = useState<number | null>(null);
  const [polyp, setPolyp]                 = useState(false);
  const [stats, setStats]                 = useState({ sent: 0, received: 0, avgMs: 0, rttMs: 0, netMs: 0, fps: 0 });
  // Whole filter bank as reported by the backend for the last frame that
  // came back, so the panel answers "which paper filter fired on THIS
  // scene" rather than showing one operator's raw numbers.
  const [gate, setGate] = useState<GateState | null>(null);
  const [showBank, setShowBank] = useState(true);
  const [lastError, setLastError]         = useState("");
  const [cameraBusy, setCameraBusy]       = useState(false); // device held by another app — offer screen-share fallback
  const [captureMode, setCaptureMode]     = useState<CaptureMode>("camera");
  // Only meaningful for the file-backed sources — see `seekable` below.
  const [duration, setDuration]           = useState(0);
  const [curTime, setCurTime]             = useState(0);
  // While the thumb is held the input renders scrubValue, not curTime: a seek
  // on a cue-less WebM takes a moment, and letting curTime drive the thumb
  // makes it jump backwards under the user's finger.
  const [paused, setPaused]               = useState(false);
  const [speed, setSpeed]                 = useState(1);
  // Set once the operator picks a speed themselves, after which their choice
  // sticks for the session and no source overrides it with its own default.
  const speedChosenRef                    = useRef(false);
  const [scrubbing, setScrubbing]         = useState(false);
  const [scrubValue, setScrubValue]       = useState(0);
  const pendingSeekRef                    = useRef<number | null>(null);
  // Mirrored into a ref because the capture loop is a long-running closure that
  // would otherwise read whatever the mode was when it started.
  const captureModeRef = useRef<CaptureMode>("camera");
  const [demoFile, setDemoFile]           = useState<string | null>(null);
  // A clip from the operator's own machine, held as an object URL for as long
  // as it stays in the source list. Same-origin, so the canvas stays readable
  // and the FOV probe keeps working.
  const [localFile, setLocalFile]         = useState<{ url: string; name: string } | null>(null);
  // Recordings already on this server, offered as a capture source so a past
  // session can be pushed back through the live pipeline exactly as it ran.
  const [recordings, setRecordings]       = useState<ServerRecording[]>([]);
  const [recordingLabel, setRecordingLabel] = useState<string | null>(null);
  const [feedbackRefreshKey, setFeedbackRefreshKey] = useState(0);
  const [aspect, setAspect]               = useState("560/480"); // replaced with the stream's real ratio once it starts
  // Auto-capture is off until the procedure is explicitly started. Before the
  // scope is in, the camera shows the trolley, the floor, a gloved hand — the
  // model flags things in all of it and the review queue fills with frames no
  // one wants. That used to be the doctor's call, made by pressing Start; the
  // out-of-body gate now answers it directly, so filing runs by default and
  // stops on its own whenever the camera leaves the patient. The button is
  // only a way to stop early -- during a break, or a stretch nobody wants kept.
  const [procedureStarted, setProcedureStarted] = useState(true);
  // The capture loop is started once and closes over the render it began in, so
  // it cannot read the state above; it reads this instead.
  const procedureStartedRef = useRef(true);
  // Confidence gate, client-side and live-adjustable. The server runs the model
  // at its own per-model threshold and reports every box with its score, so
  // moving this mid-procedure costs nothing — no round trip, no restart, and it
  // applies to what is drawn and what is auto-captured alike. A scope that is
  // noisy today can be tightened without redeploying anything. Starts at the
  // selected model's own serving threshold: confidence scales differ per
  // model -- the 640 export serves at 0.20 where the 320 serves at 0.30.
  const [confMin, setConfMin] = useState(initialConf);
  // The capture loop closes over the render it started in and cannot see the
  // state above.
  const confMinRef = useRef(initialConf);
  const [showDetected, setShowDetected]   = useState(true);
  const [showLive, setShowLive]           = useState(true);
  const msHistory = useRef<number[]>([]);
  // Client-side round trip, so the panel can split what the server spent from
  // what the wire cost. The send timestamp lives on each queue entry rather
  // than in one ref: with several frames in flight a single ref would be
  // overwritten by the next send before the previous reply arrived, and every
  // round trip would read as far shorter than it was.
  const rttHistory = useRef<number[]>([]);
  // Gaps between arriving results. This is THROUGHPUT, and it is deliberately
  // not derived from the round trip: pipelining works by overlapping frames,
  // not by shortening any one of them, so 1000/rtt cannot show its effect at
  // all -- it reported the same number before and after the change while the
  // real frame rate had risen by half. Measure the thing being claimed.
  const arrivalHistory = useRef<number[]>([]);
  const lastArrivalRef = useRef(0);
  // Mirrors of stats.sent/received kept outside React state purely so the
  // throttled report to spectator mode (below) always reads the current
  // count synchronously, instead of racing a stale closure over state.
  const sentCountRef = useRef(0);
  const receivedCountRef = useRef(0);
  const roomStatsLastPostRef = useRef(0);

  // Only starts recording once there's actually a stream on the element —
  // captureStream() on an empty <video> yields no tracks and MediaRecorder refuses it.

  // The capture stream as STATE as well as a ref: streamRef is read inside the
  // long-running capture loop, but the session recorder is a hook and has to
  // re-run when the stream is replaced (a device switch, or camera → screen).
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);
  // A file played through the pipeline -- demo clip, local file, or a recording
  // already on this server -- records as "replay", not "camera". It used to
  // record as "camera", and the result was a server full of second copies of
  // its own footage that nothing in the metadata could distinguish from real
  // procedures. Most of what the 2026-10-11 cleanup had to archive was that.
  const recorder = useSessionRecorder(
    caseId,
    captureMode === "screen" ? "screen" : captureMode === "camera" ? "camera" : "replay",
    activeStream,
  );
  // The recorder, reachable from the long-running capture loop.
  //
  // useSessionRecorder's callbacks are bound to the caseId/source/stream they
  // were created with, and the loop holds whichever object existed when
  // startLoop ran. That was harmless while a case id lasted exactly as long as
  // the loop -- but the clinic PC now rotates the case id per patient without
  // reloading the page (see onCaseEnd), and a stale recorder filed every later
  // patient under the FIRST patient's case. Measured, not theorised:
  // e2e-case-rotate.js caught three recordings in a row going to the wrong one.
  const recorderRef = useRef(recorder);
  useEffect(() => { recorderRef.current = recorder; });

  const [showRecordings, setShowRecordings] = useState(false);
  // Read through a ref inside applyAutoRecord for the same reason every other
  // per-frame flag in the capture loop is -- startLoop's closure is captured
  // once and long-running, so a plain destructured value here would be
  // whatever it was when the loop started, not the true current sign-in state.
  const { user: authUser } = useAuth();
  const authUserRef = useRef(authUser);
  useEffect(() => { authUserRef.current = authUser; }, [authUser]);

  // Auto on/off recording based on in-body/out-of-body (inBody.shouldInfer's
  // own verdict, already debounced -- see inBody.ts's InBodyGate.update --
  // so this does not add a second debounce layer on top of it). A manual
  // override holds only until the next real transition, then auto-control
  // resumes: lower risk than "sticks for the rest of the procedure", which
  // could silently leave the remainder of a long case unrecorded if forgotten.
  //
  // Deliberately NOT persisted (localStorage) the way useInBodyGate's own
  // switch is. That seemed like the right precedent to copy, but it created a
  // real deadlock: this flag also gates the very first auto-START of a
  // recording, and its own checkbox only renders once a recording is already
  // active -- so a browser where it was ever switched off (this one included,
  // while building/testing this feature) had no way back to on, and every
  // future session on that browser would silently never auto-record with no
  // visible reason why. Defaulting fresh to true every mount means every new
  // procedure starts from the documented "on by default" behavior; the
  // checkbox (now always visible, not just while recording) is still there to
  // turn it off for just this session if it's ever misbehaving.
  const [autoRecordEnabled, setAutoRecordEnabled] = useState(true);
  const autoRecordEnabledRef = useRef(autoRecordEnabled);
  useEffect(() => { autoRecordEnabledRef.current = autoRecordEnabled; }, [autoRecordEnabled]);
  // Replaying a file is a rehearsal, not a procedure, so whether it gets
  // written to the server is asked rather than assumed. Auto-record stays on
  // by default for a real camera, where losing the video is unrecoverable; a
  // replay would otherwise quietly file a second copy of a clip this server
  // often already holds, which is most of the one- and two-second recordings
  // cluttering the list. Asked per file source rather than per session
  // because the answer genuinely differs clip to clip.
  //
  // The prompt text is state (it has to render); the promise resolver is a
  // ref (it must not be replaced by a re-render).
  const [saveAsk, setSaveAsk] = useState<{ label: string } | null>(null);
  const saveAskResolveRef = useRef<((save: boolean) => void) | null>(null);
  // Whether the live auto-record default is currently overridden by an answer
  // that was about a replay -- see startStream/startScreenShare, which put it
  // back. Without that, answering "don't save" to a demo clip would silently
  // leave the next real procedure unrecorded.
  const replayAnswerRef = useRef(false);

  function askSaveVideo(label: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      // A second ask while one is still open (the operator changed the
      // dropdown again) must not leave the first caller awaiting forever.
      saveAskResolveRef.current?.(false);
      saveAskResolveRef.current = resolve;
      setSaveAsk({ label });
    });
  }

  function answerSaveVideo(save: boolean) {
    const resolve = saveAskResolveRef.current;
    saveAskResolveRef.current = null;
    setSaveAsk(null);
    // Ref as well as state: the capture loop reads the ref, and its first
    // iteration can come before React has processed the state update.
    autoRecordEnabledRef.current = save;
    setAutoRecordEnabled(save);
    replayAnswerRef.current = true;
    resolve?.(save);
  }
  const recordOverrideRef = useRef<"auto" | "on" | "off">("auto");
  const [recordOverride, setRecordOverrideState] = useState<"auto" | "on" | "off">("auto");
  const lastInsideRef = useRef<boolean | null>(null);
  // When the current out-of-body stretch started (null while inside), and
  // whether it's already been auto-stopped -- see OUT_OF_BODY_STOP_MS above.
  const outsideStartRef = useRef<number | null>(null);
  const autoStoppedRef = useRef(false);
  // Bandwidth-arbitration hold for this session's own frame-sending activity
  // (see uploadCoordinator.ts) -- acquired/released on insideNow transitions
  // in applyAutoRecord, not for the whole loop's lifetime. Tracked here (not
  // just a local var in startLoop) so it can also be released as a safety
  // net on loop-end/unmount without leaking if the loop stops mid-hold.
  const liveInferenceReleaseRef = useRef<(() => void) | null>(null);
  // When the current out-of-body stretch (that still holds the gate) started
  // -- null once released, or while inside. Mirrors outsideStartRef's shape
  // but is tracked separately: that ref only exists below autoRecordEnabled's
  // early return, while the gate must apply unconditionally. See
  // applyAutoRecord's gate block.
  const gateOutsideSinceRef = useRef<number | null>(null);
  function setRecordOverride(v: "on" | "off") {
    recordOverrideRef.current = v;
    setRecordOverrideState(v);
  }
  /** Called once per loop iteration with this frame's in-body verdict. Applies
   *  the auto pause/resume decision to the session recorder, if one is
   *  running, and clears a manual override the moment a real transition
   *  happens (see comment above). */
  // Deliberately reads nothing off `recorder` except the two stable
  // (useCallback, empty-deps) functions pause/resume -- not recorder.status
  // or recorder.capturing. This function is called every iteration of
  // startLoop's long-running while loop, whose closure was captured once
  // when the loop started; `recorder` there is a snapshot from that moment,
  // so its React *state* fields (status, capturing) never update for the
  // life of the loop, while start()/pause()/resume() themselves stay correct
  // because they read the real MediaRecorder through a ref internally.
  // Calling start() when a recording already exists (or is already being
  // created -- see startingRef in useSessionRecorder.ts), resume() when
  // nothing is recording or already recording, and pause() when already
  // paused are all safe no-ops.
  //
  // "On by default inside the body" means auto-record has to be able to
  // START the recording itself, not just pause/resume one the operator
  // already started by hand -- a session that begins already inside the body
  // (the normal case: insertion happens before Start is ever clicked) would
  // otherwise never record anything until someone remembers to press Record.
  function applyAutoRecord(insideNow: boolean) {
    // Bandwidth-arbitration signal: tracks whether THIS session is actually
    // sending frames right now, not just "a live session is open" -- runs
    // unconditionally, even if autoRecordEnabled is off, because it answers
    // "is the link busy", which matters regardless of whether auto-record
    // itself is in use. Out of body, the branch below never calls ws.send, so
    // the link is genuinely free; releasing it is what lets a still-uploading
    // recording (this session's own paused one, or a leftover from the
    // previous patient) use that window instead of purely waiting for Stop.
    // See uploadCoordinator.ts.
    //
    // Released only after OUT_OF_BODY_STOP_MS of CONTINUOUS out-of-body --
    // the same grace period the video auto-stop below uses -- not on the
    // first out-of-body frame. A one-frame release used to be enough to open
    // the gate to a multi-hundred-KB recording upload mid-procedure (measured
    // on clinic logs: 471 of 1,094 chunk uploads started while frames were
    // still flowing, each one measurably slowing every frame sent while it
    // was in flight).
    if (insideNow) {
      gateOutsideSinceRef.current = null;
      if (!liveInferenceReleaseRef.current) {
        liveInferenceReleaseRef.current = beginLiveInference();
      }
    } else if (liveInferenceReleaseRef.current) {
      if (gateOutsideSinceRef.current === null) {
        gateOutsideSinceRef.current = Date.now();
      } else if (Date.now() - gateOutsideSinceRef.current >= OUT_OF_BODY_STOP_MS) {
        liveInferenceReleaseRef.current();
        liveInferenceReleaseRef.current = null;
        gateOutsideSinceRef.current = null;
      }
    }

    // Auto-record is for live sources only. Replaying a file through the
    // pipeline looks identical to the gate -- scope goes "inside the body" and
    // it starts saving -- but the bytes are already on disk, so all it produces
    // is a duplicate. The manual Record button still works for anyone who
    // deliberately wants a copy of a replay.
    const liveSource = captureModeRef.current === "camera" || captureModeRef.current === "screen";
    if (!autoRecordEnabledRef.current || !liveSource) { lastInsideRef.current = insideNow; return; }
    const prevInside = lastInsideRef.current;
    lastInsideRef.current = insideNow;
    if (prevInside === true && !insideNow) { outsideStartRef.current = Date.now(); autoStoppedRef.current = false; }
    if (prevInside === false && insideNow) { outsideStartRef.current = null; autoStoppedRef.current = false; }
    if (prevInside !== null && insideNow !== prevInside && recordOverrideRef.current !== "auto") {
      recordOverrideRef.current = "auto";
      setRecordOverrideState("auto");
    }
    const want = recordOverrideRef.current === "auto" ? insideNow : recordOverrideRef.current === "on";

    // Distinguish a brief withdrawal (pause, ready to resume the SAME
    // recording -- the normal case below) from the procedure actually ending
    // (a doctor finishing one patient and starting the next some minutes
    // later, with nobody touching Start/Stop in between). Past the
    // threshold, finalize this recording instead of leaving it paused; a
    // fresh one auto-starts the instant the scope goes back in, via the
    // ordinary `want` branch below -- no separate code path needed for that.
    if (!want && !autoStoppedRef.current && outsideStartRef.current !== null
        && Date.now() - outsideStartRef.current >= OUT_OF_BODY_STOP_MS) {
      autoStoppedRef.current = true;
      recorderRef.current.stop("out-of-body");
      // Same moment, one level up: this patient is over, so the next captures
      // and the next recording belong to a new case. Safe to rotate while the
      // finalize above is still uploading -- useSessionRecorder snapshots the
      // case id into the session (sess.caseId), so chunks already in flight
      // keep filing under the case they started in.
      onCaseEnd?.();
      return;
    }

    if (want) {
      // Recording needs an account (see RecordingControls.tsx) -- without
      // this check a signed-out operator would see a failed /start POST
      // retried every frame for as long as the scope stays inside the body.
      if (authUserRef.current) void recorderRef.current.start();
      recorderRef.current.resume();
    } else {
      recorderRef.current.pause();
    }
  }

  // Surface the list the moment a recording finishes — the operator has just
  // saved something and the next thing they want is to confirm it is there.
  useEffect(() => {
    if (recorder.finishedCount > 0) setShowRecordings(true);
  }, [recorder.finishedCount]);

  // Crop applied before sending, for any source (normalized 0..1, relative to
  // native frame size): boxing just the video-feed area out of a shared app
  // window's toolbars/chrome, or out a capture card's own border/band.
  // Stamped with the mode it was drawn in and only ever applied in that same
  // mode — a rect drawn while screen-sharing describes that window's framing,
  // which has nothing to do with the capture card's, so one must never leak
  // into the other just because they share this one stored value.
  const [cropRect, setCropRectState] = useState<{ x: number; y: number; w: number; h: number; mode: string; fw?: number; fh?: number } | null>(null);

  /** A stored crop describes one particular frame shape. The capture card can
   *  legitimately come back in a different mode than the one the rect was
   *  drawn in (720x576 vs 720x480 -- see lib/cameraMode.ts), and the same
   *  normalized rect then frames the wrong part of the picture, silently.
   *  Rects stored before this was recorded carry no dimensions; those are
   *  trusted, because back then the shape could not change underneath them. */
  function cropValidFor(rect: typeof cropRect, mode: string, vw: number, vh: number) {
    if (!rect || rect.mode !== mode) return null;
    if (rect.fw && rect.fh && vw && vh && (rect.fw !== vw || rect.fh !== vh)) return null;
    return rect;
  }
  const cropRectRef = useRef<typeof cropRect>(null);
  const [selectingRegion, setSelectingRegion] = useState(false);
  const [dragBox, setDragBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const snapshotCanvasRef = useRef<HTMLCanvasElement>(null);
  const CROP_KEY = "polyp_screen_crop_rect";

  // The picture area inside the signal, measured from the first frames of the
  // session (lib/fov.ts explains why this is worth doing). Native pixels.
  const [fovRect, setFovRectState] = useState<Rect | null>(null);
  const fovRectRef  = useRef<Rect | null>(null);
  const fovSamplesRef = useRef(0);
  // Whether this source is interlaced, and how far we have got towards knowing.
  // Null means "not decided yet", and while it is null nothing is deinterlaced
  // -- the safe default, since treating a progressive source as interlaced
  // throws away half its vertical resolution. See sampleInterlace.
  const interlacedRef = useRef<boolean | null>(null);
  // Owns the frame history the motion test needs, so it is per-component and
  // reset whenever the source changes. See lib/interlace.ts.
  const deintRef = useRef(createDeinterlacer());
  // The Live panel paints through this canvas rather than showing the <video>
  // directly -- see the effect below. Null until the element mounts.
  const liveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Set false if the canvas path ever fails, which un-hides the <video> again.
  // A combed picture is bad; a black panel mid-procedure is worse.
  const [liveCanvasOk, setLiveCanvasOk] = useState(true);

  // --- display enhancement (operator's view only) -------------------------
  // The capture-software chain the clinic's own viewer applies and a browser
  // does not: a choice of deinterlacer, temporal denoise, unsharp, and the
  // 4:3 correction SD pixels need. All of it runs on the GPU (lib/enhanceGL)
  // AFTER the frame the model and the recorder already received, so turning
  // any of it on cannot change a detection or a saved file.
  const [enhOpen, setEnhOpen] = useState(false);
  const [denoise, setDenoise] = useState(0);
  const [sharpen, setSharpen] = useState(0);
  const [aspect43, setAspect43] = useState(false);
  // Not persisted (no localStorage) -- see FOV_KEY etc. nearby for the
  // pattern this deliberately skips. "weave" (no GPU shader work beyond a
  // flat blit) is the default rather than "adaptive" so a weak clinic PC
  // never pays for motion-adaptive deinterlacing unless an operator
  // deliberately turns picture quality up -- see Picture settings. That
  // per-frame GPU/CPU cost runs on the same main thread that prepares the
  // next inference frame, so a heavy default here can show up as inference
  // latency, not just a softer picture.
  const [deintMode, setDeintMode] = useState<DeintMode>("weave");
  const [slowNote, setSlowNote] = useState("");
  const glDeintRef = useRef<GLDeinterlacer | null>(null);
  const glDeintTriedRef = useRef(false);
  const costSamplesRef = useRef<number[]>([]);
  const denoiseRef = useRef(0);
  const sharpenRef = useRef(0);
  const deintModeRef = useRef<DeintMode>("weave");
  useEffect(() => { denoiseRef.current = denoise; }, [denoise]);
  useEffect(() => { sharpenRef.current = sharpen; }, [sharpen]);
  useEffect(() => { deintModeRef.current = deintMode; }, [deintMode]);
  const enhanceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const glEnhRef = useRef<GLEnhancer | null>(null);
  const glTriedRef = useRef(false);
  const enhanceOn = denoise > 0 || sharpen > 0;
  const enhanceOnRef = useRef(false);
  useEffect(() => { enhanceOnRef.current = enhanceOn; }, [enhanceOn]);

  // Proc-amp: the card's OWN controls, when its driver exposes them through
  // the browser. Not a filter -- applyConstraints retunes the analog front
  // end, so unlike everything above it legitimately affects all three lines.
  // Absent on most webcams and on many grabber drivers; the UI simply does
  // not render what is not there.
  const [procAmpCaps, setProcAmpCaps] = useState<ProcAmpCaps | null>(null);
  const [procAmp, setProcAmp] = useState<Record<string, number>>({});
  const [tuneNote, setTuneNote] = useState("");
  const procAmpRef = useRef<Record<string, number>>({});
  useEffect(() => { procAmpRef.current = procAmp; }, [procAmp]);

  /** Push one control to the card and remember what we asked for. */
  const applyProcAmp = useCallback(async (key: string, value: number) => {
    setProcAmp((p) => ({ ...p, [key]: value }));
    const track = streamRef.current?.getVideoTracks()[0];
    try {
      await track?.applyConstraints({ advanced: [{ [key]: value }] } as MediaTrackConstraints);
    } catch (err) {
      console.warn("[proc-amp] rejected", key, err);
    }
  }, []);

  /** Set the card's levels from the picture. Runs itself once on connect --
   *  a clinic should not have to know these controls exist to benefit from
   *  them -- and stays available as a button afterwards. */
  const runAutoTune = useCallback(async (caps: ProcAmpCaps) => {
    setTuneNote(t("Tuning the capture card…"));
    await autoTuneProcAmp({
      caps,
      values: { ...procAmpRef.current },
      measure: () => measureLevels(liveCanvasRef.current),
      apply: applyProcAmp,
      onProgress: (msg) => setTuneNote(msg),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyProcAmp]);
  const interlaceSamplesRef = useRef(0);
  const combPeakRef = useRef(0);
  // The region the FOV was measured INSIDE, in native frame pixels. With a
  // screen-share crop active that is the crop, not the frame — and "how much
  // does this trim" only means anything relative to it.
  const [fovBase, setFovBase] = useState<Rect | null>(null);
  const fovBaseRef = useRef<Rect | null>(null);
  // Scratch canvas for measuring the picture area inside the crop.
  const fovProbeRef = useRef<HTMLCanvasElement | null>(null);
  // Native frame size the rect was measured against — needed to express it as a
  // fraction for the overlay, and not the same as the analyzed `aspect`.
  const [fovFrame, setFovFrame] = useState<{ w: number; h: number } | null>(null);
  // On by default, but the operator can turn it off — a processor we have not
  // seen could confuse the detector, and being able to switch it off in the
  // room beats having to redeploy.
  const [fovEnabled, setFovEnabledState] = useState(true);
  const fovEnabledRef = useRef(true);
  // Shows exactly which pixels the crop discards, over the live panel.
  const [showFovOverlay, setShowFovOverlay] = useState(false);
  const FOV_KEY = "polyp_fov_enabled";

  function setFovEnabled(on: boolean) {
    fovEnabledRef.current = on;
    setFovEnabledState(on);
    try { localStorage.setItem(FOV_KEY, on ? "1" : "0"); } catch { /* ignore */ }
  }

  // Forget the measurement so the next session measures again. The border
  // belongs to the source, so anything that changes the source invalidates it.
  /** Decide, once per source, whether frames are interlaced.
   *
   *  Latches on the FIRST frame that clears the threshold and stops looking:
   *  comb is proof of interlacing, but its absence proves nothing while the
   *  picture is still, so "no comb yet" must never be allowed to overwrite a
   *  "yes" seen earlier. Only running out of frames concludes "progressive".
   *
   *  Measured on the WHOLE frame rather than inside the crop. Interlacing is a
   *  property of the signal, not of the region we happen to be sending, and
   *  the full frame gives the measure more lines and more chance of catching
   *  something in motion. */
  function sampleInterlace(video: HTMLVideoElement) {
    if (interlacedRef.current !== null) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;

    const ratio = combRatio(video, vw, vh);
    if (ratio !== null && ratio > combPeakRef.current) combPeakRef.current = ratio;

    if (looksInterlaced(ratio)) {
      interlacedRef.current = true;
      console.info(`[interlace] source is interlaced (comb ratio ${ratio!.toFixed(2)}) — deinterlacing`);
      return;
    }
    // A frame we could not read at all (tainted canvas, flat picture) is not
    // evidence either way, so it must not burn budget.
    if (ratio === null) return;
    if (++interlaceSamplesRef.current >= INTERLACE_SAMPLE_FRAMES) {
      interlacedRef.current = false;
      console.info(`[interlace] source looks progressive (peak comb ratio ${combPeakRef.current.toFixed(2)}) — drawing frames whole`);
    }
  }

  function resetInterlaceDetection() {
    interlacedRef.current = null;
    interlaceSamplesRef.current = 0;
    combPeakRef.current = 0;
    // Motion measured against a different video means nothing.
    deintRef.current.reset();
  }

  function resetFovDetection() {
    fovRectRef.current = null;
    fovSamplesRef.current = 0;
    fovBaseRef.current = null;
    setFovBase(null);
    setFovRectState(null);
    setFovFrame(null);
    setShowFovOverlay(false);
  }

  useEffect(() => {
    try {
      const raw = localStorage.getItem(FOV_KEY);
      if (raw !== null) { const on = raw === "1"; fovEnabledRef.current = on; setFovEnabledState(on); }
    } catch { /* ignore */ }
  }, []);

  // Recordings on this server, for the source picker. Only the finished ones:
  // a recording still being written has no reliable duration and replaying it
  // would race the writer. A failure here is not worth surfacing — the picker
  // simply offers the cameras and demos it already has.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API}/api/recordings`, { credentials: "include" });
        if (!res.ok) return;
        const all: ServerRecording[] = await res.json();
        // A stitched recording stands in for the fragments it was built from.
        // Listing both put a single procedure in the picker eight times.
        const stitched = new Set(all.flatMap((r) => r.joined_from ?? []));
        if (!cancelled) {
          // Gate on whether there is usable footage, NOT on how it ended. A
          // recording cut off mid-procedure ("interrupted"), or one still
          // draining its backlog ("closing"), holds real playable video all
          // the same -- and filtering on status alone is what hid 29.5
          // minutes of clinic capture across 2026-10-14 and 2026-10-21.
          // duration_ms is only ever written once a real length is known, so
          // a recording with nothing in it still cannot slip through.
          setRecordings(all.filter((r) => r.status !== "recording" && r.duration_ms > 0
                                          && (r.bytes ?? 0) >= MIN_CLIP_BYTES
                                          // Offering a replay as a source would be
                                          // offering a copy of something already in
                                          // this very list.
                                          && r.source !== "replay"
                                          && !stitched.has(r.id)));
        }
      } catch { /* leave the list empty */ }
    })();
    return () => { cancelled = true; };
  }, [recorder.finishedCount]);

  function switchCaptureMode(mode: CaptureMode) {
    captureModeRef.current = mode;
    setCaptureMode(mode);
    // The old clip's timeline must not survive into the new source, or the
    // scrubber briefly renders the previous duration against a new video.
    setDuration(0);
    setCurTime(0);
  }

  function setCropRect(rect: typeof cropRect) {
    cropRectRef.current = rect;
    setCropRectState(rect);
    // The FOV is measured inside the crop, so changing the crop invalidates it.
    // Without this the rect in force stayed the one measured on the uncropped
    // desktop, before the operator had drawn anything — and it was never
    // re-measured, because sampling stops after FOV_SAMPLE_FRAMES.
    resetFovDetection();
    try {
      if (rect) localStorage.setItem(CROP_KEY, JSON.stringify(rect));
      else localStorage.removeItem(CROP_KEY);
    } catch { /* ignore */ }
  }

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CROP_KEY);
      if (raw) { const r = JSON.parse(raw); cropRectRef.current = r; setCropRectState(r); }
    } catch { /* ignore */ }
  }, []);

  // Show the picker straight away when we already have permission. Asks for
  // nothing and opens nothing; it simply succeeds on every visit after the
  // first, which is what removes the access step from the clinic's workflow.
  useEffect(() => { void listDevicesQuietly(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Kiosk: get the capture card open, and keep it open, with nobody watching.
   *
   * Off by default, and the comments on preselectRemembered and requestDevices
   * say at length why: on an ordinary machine "first camera in the list" is
   * whatever the OS enumerated first, and starting it unasked points a webcam
   * at the room. The clinic PC is the one place with no operator to decide --
   * it is powered on and expected to be showing the endoscope by the time the
   * first patient is in the room, and to still be showing it eight hours later.
   *
   * One timer chain does three jobs, because they are the same job:
   *
   *   open      nothing is streaming -> list devices and start the selected
   *             one. Retried with backoff rather than attempted once: USB
   *             enumeration on a cold boot routinely lags the browser by
   *             several seconds, and a single attempt loses the whole day.
   *   re-open   the device died (unplugged, driver reset). stopCamera has
   *             already cleared streamRef, so that is the same "nothing is
   *             streaming" case and needs no separate path.
   *   unfreeze  the track is still live but the picture has stopped. Nothing
   *             else in this file can tell that apart from a quiet procedure,
   *             so it is measured here, on the one thing that cannot lie:
   *             whether the <video> element's clock is still moving.
   *
   * Camera permission must already have been granted, or the device labels are
   * blank and there is nothing to recognise. That is a once-per-browser-profile
   * click -- or, on the clinic PC, a Chrome policy, so it is never clicked.
   */
  useEffect(() => {
    if (!autoStart) return;
    let cancelled = false;
    let attempt = 0;
    let recoveries = 0;
    let lastTime = -1;
    let frozenFor = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;

      if (!streamRef.current && !negotiatingRef.current) {
        frozenFor = 0;
        lastTime = -1;
        // Re-list every round rather than trusting the one listing done at
        // mount: on a cold boot the card may not have existed yet then.
        await listDevicesQuietly();
        if (cancelled) return;
        const id = selectedDeviceIdRef.current;
        // A demo clip, a saved recording or a local file is not something to
        // "start the camera" on; those arrive through handleDeviceChange.
        if (id && !id.startsWith(DEMO_PREFIX) && !id.startsWith(REC_PREFIX)
            && !id.startsWith(LOCAL_PREFIX)) {
          await startStream(id);
        }
        if (cancelled) return;
        attempt = streamRef.current ? 0 : attempt + 1;
      } else if (streamRef.current && !negotiatingRef.current) {
        attempt = 0;
        const now = videoRef.current?.currentTime ?? -1;
        // The element's clock advances with the stream, so a clock that has
        // not moved means no frames arrived -- whatever the track says about
        // itself. Out-of-body does NOT look like this: the gate stops frames
        // being SENT to the model, it does not stop them arriving.
        frozenFor = now === lastTime ? frozenFor + KIOSK_WATCH_MS : 0;
        lastTime = now;
        if (frozenFor >= KIOSK_FROZEN_MS) {
          frozenFor = 0;
          recoveries += 1;
          if (recoveries > KIOSK_MAX_RECOVERIES) {
            window.location.reload();
            return;
          }
          setLastError(t("No picture from the capture device — reopening it."));
          stopCamera();   // the next tick finds nothing streaming and re-opens
        }
      }

      if (cancelled) return;
      timer = setTimeout(() => { void tick(); }, streamRef.current
        ? KIOSK_WATCH_MS
        // Backoff while it will not open, capped -- there is nobody here to
        // reload the page, so this never gives up, it only slows down.
        : Math.min(WS_RETRY_MAX_MS, WS_RETRY_BASE_MS * 2 ** Math.min(attempt, 4)));
    };

    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [autoStart]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Paint the Live panel through the deinterlacer instead of letting the browser
  // show the <video> directly.
  //
  // The <video> element STAYS in the DOM and keeps playing -- it holds the
  // MediaStream and is what the capture loop grabs frames from. Only its
  // pixels are hidden (opacity, never display:none, which would stop it
  // producing frames at all). This just draws the same frames, deinterlaced.
  //
  // Driven by requestVideoFrameCallback, so it runs once per decoded video
  // frame rather than once per display refresh -- no wasted work repainting a
  // frame that has not changed, and no fixed 60fps cost. At ~0.1ms a frame
  // (see lib/interlace.ts) this is cheap enough to sit alongside inference.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !showLive || !liveCanvasOk) return;
    // Older Safari has no rVFC. Nothing breaks: the canvas simply never paints,
    // and the fallback below reveals the <video> as it was before.
    const anyVid = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (h: number) => void;
    };
    if (typeof anyVid.requestVideoFrameCallback !== "function") {
      setLiveCanvasOk(false);
      return;
    }
    let handle = 0, cancelled = false;
    const paint = () => {
      if (cancelled) return;
      const canvas = liveCanvasRef.current;
      const vw = video.videoWidth, vh = video.videoHeight;
      if (canvas && vw && vh) {
        try {
          // Whole frame, not sourceRect: the panel's crop is applied in CSS
          // (liveStyle) exactly as it was for the <video>, so the canvas must
          // carry the same full-frame geometry for that crop to still line up.
          // Even dimensions keep field parity stable -- see evenScanlines.
          const w = vw & ~1, h = vh & ~1;
          if (canvas.width !== w) canvas.width = w;
          if (canvas.height !== h) canvas.height = h;
          const mode = deintModeRef.current;
          if (!glDeintTriedRef.current) {
            glDeintTriedRef.current = true;
            glDeintRef.current = createGLDeinterlacer();
          }
          // A progressive source needs none of this, whatever the menu says:
          // every mode here reconstructs rows that are only missing when the
          // signal is interlaced.
          const out = interlacedRef.current === true
            ? glDeintRef.current?.process(video, w, h, mode) : null;
          if (out) {
            canvas.getContext("2d")!.drawImage(out.canvas, 0, 0);
          } else if ((mode === "adaptive" || mode === "legacy") && interlacedRef.current === true) {
            deintRef.current.draw(video, 0, 0, w, h, canvas, w, h, video.currentTime);
          } else {
            const ctx = canvas.getContext("2d")!;
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(video, 0, 0, w, h, 0, 0, w, h);
          }

          // Enhancement is a second, independent canvas stacked over this
          // one: the deinterlaced result stays intact underneath, so
          // dropping the sliders to zero reveals it again with no rebuild.
          const enh = enhanceCanvasRef.current;
          if (enh && enhanceOnRef.current) {
            if (!glTriedRef.current) {
              glTriedRef.current = true;
              glEnhRef.current = createGLEnhancer(enh);
              if (!glEnhRef.current) console.warn("[enhance] no WebGL2 — enhancement unavailable");
            }
            const ms = glEnhRef.current?.process(canvas, w, h,
              { denoise: denoiseRef.current, sharpen: sharpenRef.current }) ?? 0;
            // Switches itself off rather than stutter through a procedure:
            // 15 ms of a 33 ms frame is where the chain starts costing frames
            // instead of improving them.
            const s = costSamplesRef.current;
            s.push(ms);
            if (s.length > 60) s.shift();
            if (s.length === 60 && s.slice().sort((a, b) => a - b)[30] > 15) {
              s.length = 0;
              setDenoise(0); setSharpen(0);
              setSlowNote(t("Enhancement switched off — it was too slow on this computer."));
            }
          }
        } catch (err) {
          console.error("[live] canvas paint failed, falling back to the raw video", err);
          setLiveCanvasOk(false);
          return;
        }
      }
      handle = anyVid.requestVideoFrameCallback!(paint);
    };
    handle = anyVid.requestVideoFrameCallback(paint);
    return () => {
      cancelled = true;
      try { anyVid.cancelVideoFrameCallback?.(handle); } catch { /* already gone */ }
    };
  }, [showLive, liveCanvasOk, streaming, captureMode, enhanceOn]);

  const insecure = typeof window !== "undefined" && !window.isSecureContext;

  // Maps raw getUserMedia() failures to messages a non-technical user can act on.
  function describeCameraError(err: unknown): string {
    const name = err instanceof DOMException ? err.name : "";
    switch (name) {
      case "NotReadableError":
      case "TrackStartError":
        return t("Camera is already in use by another app on this computer (e.g. ColnoSpy). Close that app's connection to the device, or use a different capture device, then try again.");
      case "NotFoundError":
      case "OverconstrainedError":
        return t("Selected camera is no longer available — it may have been unplugged or disabled. Reopen the device list and pick again.");
      case "NotAllowedError":
        return t("Camera access was denied. Allow camera permission for this site in the browser settings and reload.");
      default:
        return err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * The inference socket: opened on mount, and re-opened by itself afterwards.
   *
   * Reconnecting is enough on its own to resume detection — the capture loop
   * does NOT exit when the socket goes away, it spins on requestAnimationFrame
   * waiting for `readyState === OPEN` (see startLoop) and picks straight back
   * up. So the reconnect path must never touch `scanRef`; only the unmount
   * cleanup stops the loop.
   *
   * `connect` is defined inside the effect so one closure serves every attempt.
   * Anything that must be CURRENT rather than mount-time is read from a ref —
   * see wsUrlRef.
   */
  useEffect(() => {
    // Set by the cleanup. Distinguishes "the socket dropped" from "this player
    // is going away", which is the difference between reconnecting and not.
    let gone = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (gone) return;
      const ws = new WebSocket(wsUrlRef.current);
      wsRef.current = ws;

      ws.onopen  = () => { retry = 0; setWsStatus("open"); };
      ws.onerror = () => setWsStatus("error");
      ws.onclose = (e) => {
        setCloseCode(e.code);
        // Every frame still awaiting a reply is now never going to get one.
        flushPending();
        if (gone) { setWsStatus("closed"); return; }
        setWsStatus("reconnecting");
        const wait = Math.min(WS_RETRY_MAX_MS, WS_RETRY_BASE_MS * 2 ** retry);
        retry += 1;
        timer = setTimeout(connect, wait);
      };

      ws.onmessage = (e) => {
        let data: unknown;
        try { data = JSON.parse(e.data); } catch { return; }

        // An error reply still answers exactly one request, so it must consume
        // exactly one queue slot -- otherwise every later reply is off by one.
        if (data && typeof data === "object" && "error" in data) {
          const err = (data as { error: string }).error;
          setLastError(err);
          const failed = pendingQueueRef.current.shift();
          if (failed && !failed.done) { failed.done = true; failed.resolve(null); }
          return;
        }

        // Front of the queue is this reply's request -- see Pending. Taken before
        // anything else so an early return cannot leave the queue misaligned.
        const entry = pendingQueueRef.current.shift();

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
        const rtt = entry ? performance.now() - entry.sentAt : 0;
        if (rtt > 0) {
          rttHistory.current.push(rtt);
          if (rttHistory.current.length > 10) rttHistory.current.shift();
        }
        const avgRtt = rttHistory.current.length
          ? Math.round(rttHistory.current.reduce((a, b) => a + b, 0) / rttHistory.current.length)
          : 0;
        receivedCountRef.current += 1;
        const nowMs = performance.now();
        if (lastArrivalRef.current) {
          arrivalHistory.current.push(nowMs - lastArrivalRef.current);
          if (arrivalHistory.current.length > 20) arrivalHistory.current.shift();
        }
        lastArrivalRef.current = nowMs;
        const avgGap = arrivalHistory.current.length
          ? arrivalHistory.current.reduce((a, b) => a + b, 0) / arrivalHistory.current.length
          : 0;
        const liveFps = avgGap > 0 ? Math.round((1000 / avgGap) * 10) / 10 : 0;
        setStats((s) => ({
          sent: s.sent, received: s.received + 1, avgMs: avg,
          rttMs: avgRtt, netMs: avgRtt ? Math.max(0, avgRtt - avg) : 0, fps: liveFps,
        }));

        // Raw samples and their long baselines, for the HUD's spike colouring.
        // Everything above is untouched: the averages the grid shows and the
        // room-stats POST sends are computed exactly as before.
        const curNet = rtt > 0 ? Math.max(0, rtt - timing.modal_ms) : 0;
        const curFps = avgGap > 0 ? 1000 / avgGap : 0;
        if (rtt > 0) { rttBase.current.push(rtt); netBase.current.push(curNet); }
        serverBase.current.push(timing.modal_ms);
        if (curFps > 0) fpsBase.current.push(curFps);
        setCur({ rtt, server: timing.modal_ms, net: curNet, fps: curFps });

        // Best-effort, throttled report so spectator mode can show these same
        // numbers (see spectate_bus.py's _room_stats) -- fire-and-forget, never
        // awaited, must never be able to slow this handler down. Throttled
        // (not per-frame) because nothing downstream needs sub-2s freshness
        // and a report every inference frame would just be needless traffic.
        if (caseIdRef.current !== "no-case") {
          const now = performance.now();
          if (now - roomStatsLastPostRef.current > 2000) {
            roomStatsLastPostRef.current = now;
            const netMs = avgRtt ? Math.max(0, avgRtt - avg) : 0;
            const fps = liveFps;
            void fetch(`${API}/api/spectate/${encodeURIComponent(caseIdRef.current)}/room-stats`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                sent: sentCountRef.current, received: receivedCountRef.current,
                avg_ms: avg, rtt_ms: avgRtt, net_ms: netMs, fps,
                uplink_mbps: uplinkMbpsRef.current ?? 0,
              }),
            }).catch(() => { /* best-effort — never interrupt the live loop over this */ });
          }
        }

        // A frame we already timed out on still gets its reply eventually. The
        // loop has long moved past it, so the data is dropped -- the tombstone's
        // only job was to keep the queue aligned, and the shift above did that.
        if (entry && !entry.done) { entry.done = true; entry.resolve({ boxes, timing }); }
      };

    };

    connect();
    // Rotating the case id means a new patient and a new spectator room, and
    // the backend reads case_id from the query string once per connection --
    // so the only way to move it is a fresh socket. Closing is enough: onclose
    // schedules the reconnect, which reads the new URL out of wsUrlRef.
    reopenSocketRef.current = () => { retry = 0; wsRef.current?.close(); };

    return () => {
      gone = true;
      if (timer) clearTimeout(timer);
      reopenSocketRef.current = null;
      wsRef.current?.close();
      scanRef.current = false;
    };
  }, []);

  // Follow a case-id rotation onto a new socket. Skips the first run, which is
  // the id the socket was just opened with.
  const lastCaseIdRef = useRef(caseId);
  useEffect(() => {
    if (lastCaseIdRef.current === caseId) return;
    lastCaseIdRef.current = caseId;
    reopenSocketRef.current?.();
  }, [caseId]);

  // Stop camera tracks on unmount
  useEffect(() => {
    return () => {
      scanRef.current = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      // Second safety net (startLoop's own try/finally is the first) for the
      // bandwidth-arbitration hold -- unmounting while still marked "inside"
      // must not leak it, or every future upload in this tab stays blocked.
      if (liveInferenceReleaseRef.current) {
        liveInferenceReleaseRef.current();
        liveInferenceReleaseRef.current = null;
      }
      gateOutsideSinceRef.current = null;
      // Read through the ref: this cleanup runs once with the mount-time
      // closure, so the state variable here would be the empty first array.
      for (const s of shotsRef.current) URL.revokeObjectURL(s.url);
    };
  }, []);

  // Draws the frame that was sent to the model, with its boxes — pixel-accurate
  // for that frame, unlike overlaying on the live video (which has moved on by
  // the time the result comes back).
  //
  // Draws `hi`, not `cap`. Both are the same region of the same video frame, so
  // the boxes describe both equally; `cap` is just 320px wide because that is
  // all the model needs, and drawBoxes sizes the canvas from its source, so
  // passing `cap` meant the panel was a 320px thumbnail that CSS then stretched
  // to full width. `hi` is already grabbed every frame for filed captures and
  // costs nothing extra here. Boxes come back in cap space, so they are scaled
  // by the ratio between the two -- the same transform considerBest already
  // applies for the same reason.
  //
  // Only correct because `hi` is deinterlaced (see grabCapture): at native
  // resolution the comb is NOT averaged away by any downscale, so drawing it
  // raw would have shown the doctor more combing than the 320px panel did.
  function drawAnalyzedFrame(cap: HTMLCanvasElement, hi: HTMLCanvasElement | null, boxes: Box[]) {
    const canvas = analyzedRef.current;
    if (!canvas) return;
    const source = hi ?? cap;
    const k = cap.width > 0 ? source.width / cap.width : 1;
    const scaled = k === 1 ? boxes : boxes.map((b) => ({
      ...b,
      bbox: [b.bbox[0] * k, b.bbox[1] * k, b.bbox[2] * k, b.bbox[3] * k] as [number, number, number, number],
    }));
    drawBoxes(canvas, source, scaled, (det) => t("polyp  {conf}%", { conf: Math.round(det.conf * 100) }));
    // Exactly one statement, and nothing that can throw: this runs on the
    // synchronous settle path inside the scan loop's try/finally, where a
    // throw stops scanning for the rest of the session.
    analyzedGenRef.current++;
  }

  // The single writer of "what is on screen right now" -- the indicator, the
  // boxes a manual capture attaches, and tier 3. The alert hangs off this and
  // not off maybeAutoCapture precisely so that it cannot mean anything other
  // than "a box is being drawn": a timed-out frame leaves the last good boxes
  // up and does not call this, so a dropped round trip never silences an alert
  // for a lesion still visible on the panel.
  function updateBoxes(b: Box[]) {
    setPolyp(b.length > 0);
    lastBoxesRef.current = b;
    alert.onBoxState(b.length > 0);
  }

  // The region of the live frame that actually gets sent to the model — the
  // operator's hand-drawn crop if one is set, the whole frame otherwise.
  // Manual captures use the same region so a saved frame matches what the AI
  // was looking at. Applies to every source, camera included: a fixed
  // capture card has a border/band an operator can't fix by re-aiming a lens
  // the way they could a real camera, so the same manual crop this app
  // already offered for screen-share is the right tool there too.
  /** Snap a rect to even scanlines.
   *
   *  Field parity is defined by the ABSOLUTE scanline number, so a rect
   *  starting on an odd line extracts the opposite field from one starting on
   *  an even line. Both inputs to sourceRect can land anywhere: the crop is
   *  hand-drawn, and the FOV rect is auto-detected from the first frames. Both
   *  can also change mid-session. A parity flip mid-procedure shows up as a
   *  half-scanline jump, or -- if it keeps flipping -- as alternating fields,
   *  which is bob judder: the exact artifact field extraction exists to remove.
   *
   *  Which field we land on is arbitrary. That it never changes is the point.
   *  Snapping DOWN only ever shrinks the rect, so it stays inside whatever the
   *  crop and FOV already clipped it to. */
  function evenScanlines(r: Rect): Rect {
    return { ...r, y: r.y & ~1, h: r.h & ~1 };
  }

  function sourceRect(video: HTMLVideoElement) {
    return evenScanlines(sourceRectRaw(video));
  }

  function sourceRectRaw(video: HTMLVideoElement): Rect {
    const vw = video.videoWidth, vh = video.videoHeight;
    // Any source that plays a picture can carry an edge worth trimming:
    // browser chrome around a shared window, a capture-card border or sync
    // line, a recording. The operator draws this once (see openRegionSelector)
    // and it's persisted (CROP_KEY) and reused until they change or reset it
    // — but only in the mode it was drawn for (see the cropRect declaration).
    const crop = cropValidFor(cropRectRef.current, captureModeRef.current, vw, vh);
    const base = {
      x: crop ? Math.round(crop.x * vw) : 0,
      y: crop ? Math.round(crop.y * vh) : 0,
      w: crop ? Math.round(crop.w * vw) : vw,
      h: crop ? Math.round(crop.h * vh) : vh,
    };
    // The hand-drawn region and the detected picture area are both constraints
    // on what is worth sending, so both apply. Intersecting also means a region
    // drawn tightly inside the picture is never widened back out by this.
    const fov = fovEnabledRef.current ? fovRectRef.current : null;
    if (!fov) return base;
    const r = intersectRect(base, fov);
    if (r.w <= 0 || r.h <= 0) return base;
    // A frame that arrived already cropped trims a percent or two; applying that
    // buys nothing and only adds a coordinate transform to every capture.
    //
    // Measured against what we would OTHERWISE send, not against the whole
    // signal. With a screen-share crop those are very different numbers: a real
    // border inside the crop looked like nothing next to the full frame, so it
    // was discarded as negligible every time.
    if (1 - (r.w * r.h) / (base.w * base.h) < NEGLIGIBLE_TRIM) return base;
    return r;
  }

  // Measure the picture area from the first frames of the session, then leave
  // it alone. Cheap (a 160px-wide probe) and it stops after FOV_SAMPLE_FRAMES,
  // so this costs nothing for the rest of the procedure.
  function sampleFov(video: HTMLVideoElement) {
    if (fovSamplesRef.current >= FOV_SAMPLE_FRAMES) return;
    fovSamplesRef.current += 1;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    // Measure INSIDE the operator's crop, never on the whole signal.
    //
    // On a screen share the signal is a desktop. Chrome and white UI are "lit"
    // at any luma threshold, so the detected span is the entire frame, the trim
    // reads as ~0, and the border that actually matters — the processor's,
    // inside the shared window — is never found at all. When the desktop IS
    // dark enough to detect something, fov.ts then refuses any rect under
    // MIN_AREA_FRACTION of what it was handed, so the correct answer gets
    // thrown out for being "small" relative to a screen; and unionRect, which
    // only ever widens, swallows any bright dialog that appears while sampling.
    // All three failures are the same mistake: measuring the wrong region.
    const crop = cropValidFor(cropRectRef.current, captureModeRef.current, vw, vh);
    const base: Rect = crop
      ? { x: Math.round(crop.x * vw), y: Math.round(crop.y * vh),
          w: Math.round(crop.w * vw), h: Math.round(crop.h * vh) }
      : { x: 0, y: 0, w: vw, h: vh };
    if (base.w <= 0 || base.h <= 0) return;
    let found: Rect | null;
    if (crop) {
      const probe = fovProbeRef.current ?? (fovProbeRef.current = document.createElement("canvas"));
      if (probe.width !== base.w) probe.width = base.w;
      if (probe.height !== base.h) probe.height = base.h;
      probe.getContext("2d")!.drawImage(video, base.x, base.y, base.w, base.h, 0, 0, base.w, base.h);
      const r = detectFovRect(probe, base.w, base.h);
      // Back into full-frame coordinates: everything downstream — fovNorm, the
      // overlay, the intersect in sourceRect — speaks native frame pixels.
      found = r ? { x: r.x + base.x, y: r.y + base.y, w: r.w, h: r.h } : null;
    } else {
      found = detectFovRect(video, vw, vh);
    }
    if (!found) return;
    const merged = unionRect(fovRectRef.current, found);
    fovRectRef.current = merged;
    fovBaseRef.current = base;
    setFovBase((prev) =>
      prev && prev.x === base.x && prev.y === base.y
        && prev.w === base.w && prev.h === base.h ? prev : base);
    setFovFrame((prev) => (prev && prev.w === vw && prev.h === vh ? prev : { w: vw, h: vh }));
    // Only push to React state when it actually moved — this runs inside the
    // capture loop and a setState per frame would re-render the whole player.
    setFovRectState((prev) =>
      prev && merged && prev.x === merged.x && prev.y === merged.y
        && prev.w === merged.w && prev.h === merged.h ? prev : merged);
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

  /** Draw a region of `video` into `dst`, progressive.
   *
   *  Deinterlacing is motion-adaptive (lib/interlace.ts): still areas keep all
   *  their real scanlines, only moving ones are rebuilt. An earlier version
   *  discarded a whole field ("bob") -- measurably clean, but it halves the
   *  vertical resolution of the entire picture, and once the panel started
   *  showing frames at native size the doubling that leaves behind was plainly
   *  visible as horizontal banding.
   *
   *  No-ops into a plain draw on a progressive source: the same capture loop
   *  also serves screen share, the demo clips, and files off the operator's
   *  disk, and deinterlacing any of those would only destroy detail. */
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
   *  hundred milliseconds, and the scope moves in that time.
   *
   *  This is where deinterlacing matters most. CAPTURE_EDGE is 960 and the
   *  source is 720 wide, so `scale` is 1 and nothing is downsized: unlike the
   *  inference canvas, there is no shrink here to incidentally average the
   *  comb away. These frames are what doctors review and what future training
   *  data is built from, so they are kept progressive. */
  function grabCapture(video: HTMLVideoElement, sx: number, sy: number, sw: number, sh: number) {
    const scale = Math.min(1, CAPTURE_EDGE / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
    const slot = hiSlotRef.current;
    hiSlotRef.current = (slot + 1) % HI_RING_SLOTS;
    const ring = hiRingRef.current;
    const c = ring[slot] ?? (ring[slot] = document.createElement("canvas"));
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
  }

  /** Keep the frame that was just scored, for the review panel's timeline.
   *
   *  The JPEG is the very one the loop already encoded and sent for inference,
   *  so this is an array push and nothing else: no encode, no re-encode, no
   *  copy, no decode, no disk I/O, nothing awaited. The clinic PC must not pay
   *  for a replay feature while it is inferring. Boxes are already in this
   *  JPEG's own pixel space -- it is the frame they were scored on. */
  function keepFrame(jpeg: Blob, cap: HTMLCanvasElement, boxes: Box[]) {
    if (!procedureStartedRef.current || !procStartRef.current) return;
    frameStoreRef.current.push({
      atMs: Date.now() - procStartRef.current,
      jpeg,
      boxes,
      w: cap.width,
      h: cap.height,
    });
  }

  // Auto-capture — one filed frame per appearance, chosen for being the
  // clearest frame of that appearance rather than the first one. The tier table
  // at the top of this file says why each bar is where it is.
  function maybeAutoCapture(boxes: Box[], cap: HTMLCanvasElement | null, hi: HTMLCanvasElement | null) {
    // Filing runs by default and only stops when someone stops it. Detection
    // itself keeps running and stays visible on screen either way — this only
    // decides whether a detection is worth keeping.
    //
    // Nothing filters for being inside the patient here, and nothing needs to:
    // an out-of-body frame is dropped by the gate in the capture loop before it
    // is ever inferred, so it cannot reach this function with boxes on it.
    if (!procedureStartedRef.current) return;
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
    }
    episodeHitsRef.current += 1;
    considerBest(cap, hi, boxes);

    // TWO captures per appearance, 2026-10-11 (ADR 0005):
    //
    //   "first" -- this frame, filed immediately, no bar to clear. Tier 3 beeps
    //     on the first drawn box, so anything stricter here means the room
    //     hears a sound with nothing behind it for a reviewer to look at. And a
    //     lesion the model glimpsed only once is precisely the one most likely
    //     to have been missed by eye, which is what this product is for.
    //   "best"  -- below, unchanged: the clearest frame of the appearance
    //     (frameScore: sharpness, confidence, apparent size), filed once
    //     FILE_MIN_MS has passed or the appearance ends, whichever comes first,
    //     then refreshed while the lesion stays on screen.
    //
    // FILE_MIN_HITS still guards "best" only, so a single-frame detection files
    // exactly one image rather than the same frame twice.
    if (episodeHitsRef.current === 1) flushBest(now, "first");

    const age = now - episodeStartRef.current;

    // Tier 2 — the capture. First filing waits for the window to close; after
    // that a lesion still on screen is refreshed occasionally, so a long look is
    // not represented by one frame.
    if (episodeHitsRef.current < FILE_MIN_HITS) return;
    const due = episodeFiledRef.current
      ? now - lastAutoCaptureRef.current >= AUTO_CAPTURE_REFRESH_MS
      : age >= FILE_MIN_MS;
    if (due) flushBest(now);
  }

  /** Tier 2. Hand the best frame of this appearance to the uploader. */
  function flushBest(now: number, kind: "first" | "best" = "best") {
    const best = bestRef.current;
    const canvas = bestCanvasRef.current;
    if (!best || !canvas) return;
    const boxes = best.boxes;
    // "first" deliberately leaves the episode bookkeeping alone: the "best"
    // capture still happens afterwards on its own schedule. Marking the episode
    // filed here would push the best frame out to the refresh interval instead
    // of FILE_MIN_MS, and clearing bestRef would stop it being scored at all.
    if (kind === "best") {
      episodeFiledRef.current = true;
      lastAutoCaptureRef.current = now;
      bestRef.current = null;  // a refresh picks a fresh best, not this one again
    }
    const w = canvas.width, h = canvas.height;
    canvas.toBlob((blob) => {
      if (!blob) return;
      sendCapture(blob, boxes, kind, pushShot(blob, boxes, kind, w, h));
    }, "image/jpeg", 0.82);
  }

  /** Keep a filed capture on screen, now, without waiting for its upload.
   *
   *  Called from the two toBlob callbacks rather than from sendCapture,
   *  because sendCapture runs TWICE for a deferred capture -- once to park it
   *  in deferredRef and once again from the finally re-dispatch -- and that
   *  would file the same frame into the strip twice. */
  function pushShot(blob: Blob, boxes: Box[], kind: Shot["kind"], w: number, h: number): string {
    const id = `s${++shotSeqRef.current}`;
    const url = URL.createObjectURL(blob);
    setShots((prev) => {
      const next = [{ id, url, at: Date.now(), kind, boxes, w, h, uploaded: false }, ...prev];
      // Revoking the evicted URL is what keeps this bounded in memory, but not
      // while someone is looking at that exact frame enlarged -- the img would
      // break under them. It is released on unmount either way.
      for (const gone of next.slice(SHOT_RING)) {
        if (gone.id !== openShotIdRef.current) URL.revokeObjectURL(gone.url);
      }
      return next.slice(0, SHOT_RING);
    });
    return id;
  }

  function markShotUploaded(id: string) {
    setShots((prev) => prev.map((s) => (s.id === id ? { ...s, uploaded: true } : s)));
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
  function sendCapture(blob: Blob, boxes: Box[], kind: "first" | "best", shotId?: string) {
    // A second deferral overwrites the first, so that blob never reaches the
    // server. Its strip tile keeps uploaded:false and renders dimmed -- the
    // strip must not imply a reviewer will find the frame in the queue.
    if (uploadingRef.current) { deferredRef.current = { blob, boxes, kind, shotId }; return; }
    uploadingRef.current = true;
    // Read before the upload, not after: a deferred capture can sit behind an
    // in-flight one for seconds, and the bar has to mark when the frame was
    // TAKEN, not when it finally got sent.
    const takenAtMs = procStartRef.current ? Date.now() - procStartRef.current : 0;
    const fd = new FormData();
    fd.append("file", blob, "frame.jpg");
    fd.append("ai_detections", JSON.stringify(boxes));
    // Which of an appearance's two captures this is -- see maybeAutoCapture.
    fd.append("capture_kind", kind);
    // No clip. The session recording already holds this moment, so all a
    // reviewer needs is where to seek to — a few bytes instead of the ~250 KB
    // of video that was starving the live frame stream.
    const at = recorderRef.current.mark();
    if (at) {
      fd.append("recording_id", at.recordingId);
      fd.append("video_offset_ms", String(at.offsetMs));
    }
    void (async () => {
      try {
        // caseIdRef, not caseId: this runs out of the capture loop's closure,
        // which predates any rotation. Same hazard as recorderRef above.
        // The response carries the name the server filed this under, which is
        // the capture's identity in the review panel. Pairing that name with
        // the moment it was taken is what lets the timeline put the tick in
        // the right place, and seek to it exactly.
        const res = await fetch(`${API}/api/feedback/${caseIdRef.current}/auto-capture`,
                               { method: "POST", body: fd });
        if (procStartRef.current) {
          try {
            const name = (await res.json())?.filename;
            if (typeof name === "string" && name) captureAtRef.current.set(name, takenAtMs);
          } catch { /* not JSON -- the timestamp fallback in atMsOf covers it */ }
        }
        if (shotId) markShotUploaded(shotId);
        setFeedbackRefreshKey((k) => k + 1);
      } catch {
        /* best-effort — never interrupt the live loop over this */
      } finally {
        uploadingRef.current = false;
        const next = deferredRef.current;
        deferredRef.current = null;
        if (next) sendCapture(next.blob, next.boxes, next.kind, next.shotId);
      }
    })();
  }



  // Instant, no-dialog manual capture of whatever is on screen right now — the
  // one case auto-capture can't cover, a doctor spotting something the model
  // missed. Box drawing/correction happens in the side panel, not in a popup.
  // A doctor-found capture used to encode the camera's full frame (1280x720+)
  // at quality 0.9: a synchronous draw + JPEG encode on the same main thread as
  // the inference loop, then ~200 KB of JPEG plus the clip pushed up in one
  // burst. Both the encode and the upload showed as a hitch in the live video.
  // A review still does not need more than this.
  const CAPTURE_MAX_EDGE = 960;

  // Deinterlaced for the same reason grabCapture is: at 960 against a 720-wide
  // source `scale` is 1, so nothing is downsized and there is no incidental
  // averaging to hide the comb. Callers pass a sourceRect(), so sy/sh are even.
  function captureCanvas(video: HTMLVideoElement, src: { x: number; y: number; w: number; h: number }) {
    const scale = Math.min(1, CAPTURE_MAX_EDGE / Math.max(src.w, src.h));
    const cap = document.createElement("canvas");
    cap.width = Math.round(src.w * scale);
    cap.height = Math.round(src.h * scale);
    drawDeinterlaced(video, src.x, src.y, src.w, src.h, cap, cap.width, cap.height);
    return cap;
  }

  function captureDrFound() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const src = sourceRect(video);
    const cap = captureCanvas(video, src);
    cap.toBlob(async (blob) => {
      if (!blob) return;
      const shotId = pushShot(blob, lastBoxesRef.current, "dr", cap.width, cap.height);
      const fd = new FormData();
      fd.append("file", blob, "frame.jpg");
      fd.append("ai_detections", JSON.stringify(lastBoxesRef.current));
      // No clip. The session recording already holds this moment, so all a
      // reviewer needs is where to seek to — a few bytes instead of the ~250 KB
      // of video that was starving the live frame stream.
      const at = recorderRef.current.mark();
      if (at) {
        fd.append("recording_id", at.recordingId);
        fd.append("video_offset_ms", String(at.offsetMs));
      }
      try {
        await fetch(`${API}/api/feedback/${caseId}/dr-found/capture`, { method: "POST", body: fd });
        markShotUploaded(shotId);
        setFeedbackRefreshKey((k) => k + 1);
      } catch { /* best-effort */ }
    }, "image/jpeg", 0.82);
  }

  // A demo clip or a saved recording is a file, so it has a timeline that staff
  // can scrub. A camera or screen share does not — nothing to seek in a stream.
  const seekable = captureMode === "demo" || captureMode === "recording" || captureMode === "local";

  // The bar only grows while a procedure is running, so the heartbeat only
  // runs then. 1 Hz is enough for a clock measured in minutes.
  useEffect(() => {
    if (!streaming || !procedureStarted) return;
    const id = setInterval(() => setTimelineTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [streaming, procedureStarted]);

  /** What the review panel needs to draw and play the timeline. Undefined
   *  before a procedure starts, which is also how the panel decides to keep
   *  its thumbnail strips instead. */
  const timelineSource: TimelineSource | undefined = useMemo(() => {
    if (!procStartRef.current) return undefined;
    const store = frameStoreRef.current;
    const started = procStartRef.current;
    return {
      totalMs: Math.max(1000, Date.now() - started),
      playableFromMs: store.fromMs,
      atMsOf: (e) => {
        const exact = captureAtRef.current.get(e.filename);
        if (exact !== undefined) return exact;
        // Filed by another device, or before this procedure started. Fall back
        // to the server's own timestamp, which is seconds-resolution and on
        // the server's clock -- good enough to place a tick, not good enough
        // to seek to, which is why the exact map exists at all.
        const ts = Number(e.timestamp) * 1000;
        if (!Number.isFinite(ts)) return null;
        const rel = ts - started;
        if (rel < -2000 || rel > Date.now() - started + 2000) return null;
        return Math.max(0, rel);
      },
      getFrames: () => store.frames,
    };
    // timelineTick is the dependency that matters: it is what makes totalMs
    // and playableFromMs refresh while the procedure runs.
  }, [timelineTick, procedureStarted]);

  /** Which case the timeline currently describes, so a rotation can be told
   *  from a re-render. */
  const timelineCaseRef = useRef<string | null>(null);

  // Owns the procedure clock -- the timeline's whole axis -- and nothing else
  // does.
  //
  // It cannot live in the Start/Stop handler alone, which is where it started:
  // `procedureStarted` DEFAULTS TO TRUE, so a session that is simply begun --
  // kiosk autostart, or picking a test video and never touching that button --
  // never fires that handler, never got a clock, and the store then silently
  // kept nothing at all. The replay looked implemented and did nothing.
  //
  // It also has to react to the case changing. Kiosk mode rotates the case per
  // patient without anyone pressing Stop, and without this the previous
  // patient's frames would still be in the store, on a clock that started
  // before they arrived.
  //
  // Note what this does NOT depend on: recording. The replay plays the frames
  // the model scored, not the session recording (see lib/frameRing.ts for why
  // that recording cannot be played from the middle at all), so it works with
  // saving switched off -- on a test video that is already on disk, for
  // instance -- and never puts a byte on the link.
  useEffect(() => {
    const active = streaming && procedureStarted;
    if (timelineCaseRef.current !== caseId) {
      timelineCaseRef.current = caseId;
      frameStoreRef.current.clear();
      captureAtRef.current.clear();
      procStartRef.current = 0;
    }
    if (!active) procStartRef.current = 0;
    else if (!procStartRef.current) procStartRef.current = Date.now();
    setTimelineTick((n) => n + 1);
  }, [caseId, streaming, procedureStarted]);

  /** The same frames, for the capture strip's enlarged view -- so clicking a
   *  tile in fullscreen plays forward from that moment instead of only showing
   *  it as a still. */
  const stripReplay: StripReplay | undefined = useMemo(() => {
    if (!procStartRef.current) return undefined;
    const started = procStartRef.current;
    return { getFrames: () => frameStoreRef.current.frames, procStartMs: started };
  }, [timelineTick, procedureStarted]);

  function handleTimeUpdate() {
    if (videoRef.current) setCurTime(videoRef.current.currentTime);
  }

  /** A demo clip is an mp4 and reports its length here. A live MediaStream and a
   *  cue-less WebM both report Infinity — neither may clobber a length the
   *  recordings API already gave us. */
  function handleLoadedMetadata() {
    const v = videoRef.current;
    if (!v) return;
    if (Number.isFinite(v.duration) && v.duration > 0) setDuration(v.duration);
    setCurTime(v.currentTime);
  }

  function seekTo(newTime: number) {
    const video = videoRef.current;
    if (!video) return;
    const hi = duration > 0 ? duration : Number.MAX_SAFE_INTEGER;
    const target = Math.max(0, Math.min(hi, newTime));
    // A streaming WebM carries no cue index, so the browser scans on every seek.
    // Issuing one per drag event queues them and the tab stops responding — keep
    // a single seek in flight and remember only the newest target.
    if (video.seeking) {
      pendingSeekRef.current = target;
      return;
    }
    pendingSeekRef.current = null;
    video.currentTime = target;
    setCurTime(target);
  }

  /** Read the test-window inputs and put the clip at the start of them.
   *  Returns false when no window is set, in which case the source plays end
   *  to end exactly as it always did.
   *
   *  Clears the persistence counters on the way in: a second pass over the
   *  same seconds has to start from the same state as the first, or
   *  confirmations carry over from the previous run and the two runs are not
   *  comparable. */
  async function armWindow(video: HTMLVideoElement): Promise<boolean> {
    const a = parseFloat(winStart), b = parseFloat(winStop);
    winRef.current = (isFinite(a) || isFinite(b))
      ? { a: isFinite(a) ? a : 0, b: isFinite(b) ? b : Infinity }
      : null;
    setWinDone(false);
    if (!winRef.current) return false;
    // A clip that wrapped round to the beginning would replay part of the
    // window twice, and count its captures twice with it.
    video.loop = false;
    video.currentTime = winRef.current.a;
    await new Promise<void>((res) => {
      const done = () => { video.removeEventListener("seeked", done); res(); };
      video.addEventListener("seeked", done);
    });
    temporal.reset();
    return true;
  }

  /** Replay the window from its start. Safe to call with the loop stopped at
   *  the end of a previous run — that is the usual case, since the loop breaks
   *  out of itself when it reaches the end. */
  async function rerunWindow() {
    const video = videoRef.current;
    if (!video) return;
    await armWindow(video);
    await video.play().catch(() => {});
    startLoop();
  }

  /** Stop and hold on the current frame. The inference loop keeps grabbing that
   *  frozen frame, so the detector — and both gates — keep scoring it, which is
   *  what makes a single moment inspectable. */
  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    // The window ran to its end and stopped the loop with it. Play here means
    // the next pass of the experiment, not a resume into frames outside it.
    if (winDone) { void rerunWindow(); return; }
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }

  function changeSpeed(s: number) {
    speedChosenRef.current = true;
    setSpeed(s);
    if (videoRef.current) videoRef.current.playbackRate = s;
  }

  /** Applies whatever target arrived while the previous seek was still running. */
  function handleSeeked() {
    const video = videoRef.current;
    if (!video) return;
    setCurTime(video.currentTime);
    const queued = pendingSeekRef.current;
    if (queued === null) return;
    pendingSeekRef.current = null;
    video.currentTime = queued;
  }

  // Live loop — send current frame → wait for result → send next. The loop never
  // seeks on its own; it just grabs whatever frame is current, so scrubbing from
  // the UI simply changes what the next grab picks up.
  async function startLoop() {
    if (scanRef.current) return;
    scanRef.current = true;
    // The bandwidth-arbitration hold (see uploadCoordinator.ts) is acquired
    // and released per in-body/out-of-body transition inside applyAutoRecord,
    // not for this whole loop's lifetime -- so a still-uploading recording
    // can use an out-of-body window instead of waiting for the loop to end
    // entirely. The try/finally here is only a safety net in case the loop
    // exits while still holding it (e.g. the operator leaves Live Camera
    // mid-procedure, still inside the body) -- leaking that hold would
    // permanently block all future uploads in this tab.

    // The frame handed to the socket but not yet drawn. Carries its own cap and
    // hi so the boxes are always applied to the picture they describe, even
    // though the loop has moved on to preparing the next one.
    type InFlight = {
      result: Promise<{ boxes: Box[]; timing: Timing } | null>;
      cap: HTMLCanvasElement;
      hi: HTMLCanvasElement;
      /** The JPEG already encoded for the wire. Carried so the review
       *  timeline can keep it without encoding a second copy. */
      jpeg: Blob;
    };
    let inFlight: InFlight | null = null;

    // Everything that reacts to a result lives here, so it happens in frame
    // order whichever path got us here. updateBoxes, the temporal gate and
    // maybeAutoCapture are all state machines keyed on sequence -- settling
    // out of order would corrupt all three.
    const settle = async (f: InFlight) => {
      const result = await f.result;
      if (result) {
        // One gate for both what is shown and what is kept.
        const shown = temporal.filter(
          result.boxes.filter((b) => b.conf >= confMinRef.current));
        updateBoxes(shown);
        drawAnalyzedFrame(f.cap, f.hi, shown);
        maybeAutoCapture(shown, f.cap, f.hi);
        keepFrame(f.jpeg, f.cap, shown);
      } else {
        // A timed-out frame is not evidence the lesion left, but it is not
        // evidence it is still there either. maybeAutoCapture is the only writer
        // of the gap timer, so a stretch of skipped frames used to freeze the
        // state machine mid-appearance and throttle the NEXT lesion against a
        // stale timestamp. Feeding the quiet frame through lets it close.
        maybeAutoCapture([], null, null);
      }
    };

    /** Nothing may overtake a frame already sent. Both skip paths below draw
     *  and advance the capture state machine immediately, so they have to let
     *  the older frame land first or the panel would jump backwards. */
    const drainInFlight = async () => {
      if (!inFlight) return;
      const f = inFlight;
      inFlight = null;
      await settle(f);
    };

    try {
    while (scanRef.current) {
      const ws = wsRef.current;
      const video = videoRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !video || !video.videoWidth) {
        await new Promise<void>((res) => requestAnimationFrame(() => res()));
        continue;
      }

      // End of the test window: stop, rather than loop round. Pausing alone is
      // not enough -- this loop keeps inferring a held frame on purpose, so it
      // would go on scoring and auto-capturing the last frame of the window
      // indefinitely, inflating the very count the experiment is measuring.
      if (winRef.current && video.currentTime >= winRef.current.b) {
        scanRef.current = false;
        video.pause();
        setWinDone(true);
        break;
      }

      // Before choosing the region, not after — the first frames of a session
      // are exactly the ones that decide it.
      sampleFov(video);
      // Both of the draws below ask whether this source is interlaced, so the
      // answer has to be as up to date as it can be before either runs.
      sampleInterlace(video);

      const { x: srcX, y: srcY, w: srcW, h: srcH } = sourceRect(video);
      // Size the panels to the region actually being analyzed, so the two live
      // panels and the captured feedback frames all share one aspect ratio.
      setAspect(`${srcW}/${srcH}`);

      const scale = inferWidth / srcW;
      const capW  = inferWidth;
      const capH  = Math.round(srcH * scale);
      const cap   = document.createElement("canvas");
      cap.width   = capW;
      cap.height  = capH;
      // NOT deinterlaced, on purpose. Squashing 480 lines into ~213 averages
      // neighbouring lines, and that averaging cancels the comb by itself --
      // this shrink IS a blend deinterlace. Measured on clinic footage at the
      // 320px size the model actually sees: comb ratio 0.60-0.65 drawn straight
      // (anything under 1.0 is clean) against 0.55-0.56 with a field discarded
      // first, for identical retained detail (3.34 vs 3.17, 6.24 vs 6.08).
      // Deinterlacing here was pure cost in the hot loop for no measurable
      // gain. The full-size paths are different -- nothing downsizes them, so
      // they get the real treatment; see grabCapture.
      const capCtx = cap.getContext("2d")!;
      capCtx.imageSmoothingEnabled = true;
      capCtx.imageSmoothingQuality = "high";
      if (capH * 2 >= srcH) {
        // ...but that incidental blend only happens when the shrink is
        // aggressive. A 640 capture keeps ~427 of 480 lines, the comb would
        // survive, so larger sizes get the real motion-adaptive treatment,
        // same as the full-size paths.
        drawDeinterlaced(video, srcX, srcY, srcW, srcH, cap, capW, capH);
      } else {
        capCtx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, capW, capH);
      }
      // Grabbed now, from this same video frame, so a filed capture and the boxes
      // drawn on it describe the same instant. See grabCapture.
      const hi = grabCapture(video, srcX, srcY, srcW, srcH);
      // The gates read a fixed-320 view so a larger model imgsz never moves
      // their operating points (thresholds were fitted on 320px captures).
      const gateCap = capW > INFER_WIDTH ? downscaleForGates(cap) : cap;

      // Out of body: no JPEG encode, no round trip, no inference. The panel keeps
      // showing the real frame with no boxes, so it stays obvious that the feed is
      // live and the detector is simply not being asked. Paced at roughly the
      // inference cadence rather than spinning a tight while loop.
      const insideNow = inBody.shouldInfer(gateCap);
      applyAutoRecord(insideNow);
      if (!insideNow) {
        await drainInFlight();
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
      if (!quality.shouldInfer(gateCap)) {
        await drainInFlight();
        updateBoxes([]);
        drawAnalyzedFrame(cap, hi, []);
        maybeAutoCapture([], null, null);
        await new Promise<void>((res) => setTimeout(res, 100));
        continue;
      }

      const blob: Blob = await new Promise((res) => cap.toBlob((b) => res(b!), "image/jpeg", 0.85));
      const buf = await blob.arrayBuffer();

      // Sent, not awaited. This is the whole point of the pipeline: the wire
      // time for THIS frame now overlaps the settle of the previous one and
      // the preparation of the next, instead of being dead time in which
      // nothing is inferred. See MAX_IN_FLIGHT.
      const sent = sendForInference(ws, buf);

      // Now -- and only now -- wait for the PREVIOUS frame and draw it. One
      // frame of extra latency between picture and boxes, in exchange for the
      // round trip no longer being serialised against inference.
      const prev = inFlight;
      inFlight = { result: sent, cap, hi, jpeg: blob };
      if (prev) await settle(prev);
    }

    // The loop has stopped, but the last frame sent is still owed a draw.
    await drainInFlight();
    } finally {
      if (liveInferenceReleaseRef.current) {
        liveInferenceReleaseRef.current();
        liveInferenceReleaseRef.current = null;
      }
      gateOutsideSinceRef.current = null;
    }
  }

  const DEVICE_KEY = "polyp_camera_device_id";
  const DEVICE_LABEL_KEY = "polyp_camera_device_label";

  /** Put last session's device back in the box, so the clinic's capture card
   *  is already selected and starting it is one click.
   *
   *  Preselect only: opening a camera stays the operator's own gesture, and a
   *  remembered choice that has since become the wrong one must not begin
   *  streaming before they get the chance to change it. This is the same
   *  reason requestDevices does not start anything either.
   *
   *  The one exception is the `autoStart` prop, which the clinic PC sets
   *  because there is no operator there to make the gesture. It is opt-in per
   *  machine and off everywhere else. */
  function preselectRemembered(cams: MediaDeviceInfo[]) {
    if (selectedDeviceId) return;
    try {
      const id = localStorage.getItem(DEVICE_KEY);
      const label = localStorage.getItem(DEVICE_LABEL_KEY);
      // deviceId first; the label is a fallback because deviceIds are only
      // stable per origin and profile, and a cleared profile would otherwise
      // forget a device that is still physically plugged in.
      const hit = cams.find((d) => d.deviceId === id)
        ?? (label ? cams.find((d) => d.label === label) : undefined)
        // Nothing remembered: a fresh browser profile, which on the clinic PC
        // is the one occasion nobody is going to open the dropdown.
        ?? pickCaptureCard(cams);
      if (hit) setSelectedId(hit.deviceId);
    } catch { /* ignore */ }
  }

  /** List cameras without asking the operator for anything.
   *
   *  Labels only exist once camera permission has been granted at least once
   *  for this origin -- but Chrome remembers that for an https site, so on
   *  every visit after the first this is all that is needed and the access
   *  step disappears entirely. Returns false when labels are still blank,
   *  which is the only case that needs the prompt below. */
  async function listDevicesQuietly(): Promise<boolean> {
    try {
      const cams = (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => d.kind === "videoinput");
      if (!cams.length || !cams.some((d) => d.label)) return false;
      setDevices(cams);
      setPermission("granted");
      preselectRemembered(cams);
      return true;
    } catch { return false; }
  }

  // Only needed when labels are still blank: one throwaway open purely to
  // unlock them. Deliberately a separate step from picking a source -- the
  // button that used to carry this said "Choose a camera" while actually
  // requesting access, which made two different things look like one.
  async function requestDevices() {
    setPermission("requesting");
    setLastError("");
    setCameraBusy(false);
    try {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ video: true });
        probe.getTracks().forEach((track) => track.stop());
      } catch (probeErr) {
        // {video:true} opens the DEFAULT device, normally the built-in webcam.
        // If that one is busy or disabled this throws even though the capture
        // card is perfectly available -- which is exactly how a laptop webcam
        // used to make the capture card unreachable. A real refusal still
        // counts; anything else, carry on and list whatever we can.
        if (!(probeErr instanceof DOMException) || probeErr.name === "NotAllowedError") throw probeErr;
      }

      const all = await navigator.mediaDevices.enumerateDevices();
      const cams = all.filter((d) => d.kind === "videoinput");
      setDevices(cams);
      setPermission("granted");
      preselectRemembered(cams);
      // Deliberately does NOT auto-start the first device: on a machine with
      // both a built-in webcam and a USB/HDMI capture card, "first in the
      // list" is whatever the OS happens to enumerate first, not necessarily
      // the one the operator wants. The dropdown right below this (deviceSelect)
      // is the actual picker -- starting a stream is its job, on an explicit
      // choice, not this function's.
    } catch (err: unknown) {
      setPermission("denied");
      setLastError(describeCameraError(err));
      setCameraBusy(err instanceof DOMException && (err.name === "NotReadableError" || err.name === "TrackStartError"));
    }
  }

  async function startStream(deviceId: string) {
    // An answer given to the replay prompt was about that clip. A live source
    // goes back to the documented on-by-default, so "don't save" for a demo
    // cannot leave an actual procedure unrecorded.
    if (replayAnswerRef.current) {
      replayAnswerRef.current = false;
      autoRecordEnabledRef.current = true;
      setAutoRecordEnabled(true);
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    // Let go of the element's reference too, and give the driver a moment.
    // A USB grabber does not finish releasing when stop() returns, and a
    // getUserMedia that lands while it is still active gets locked to the
    // OLD configuration -- every other exact size then comes back
    // OverconstrainedError, which reads exactly like "unsupported".
    if (videoRef.current) videoRef.current.srcObject = null;
    await new Promise((r) => setTimeout(r, 200));
    scanRef.current = false;
    try {
      // Not a plain getUserMedia. Left to choose, Chrome takes the mode whose
      // height is nearest the one asked for -- and asking for 720 from the
      // clinic's SD card selected its 576-line PAL container to carry a
      // 480-line NTSC picture, leaving 96 unwritten lines that render green.
      // That was the green band, and we were choosing it ourselves every
      // session. cameraMode.ts probes the device and judges on pixels.
      setNegotiating(t("Checking camera modes…"));
      const negotiated = await negotiateCameraMode(deviceId, {
        onProgress: (step, i, total) => setNegotiating(
          i > 0 && total > 1
            ? t("Checking camera modes… {step} ({i}/{total})", { step, i, total })
            : t("Opening camera…")),
      });
      setNegotiating("");
      const stream = negotiated.stream;
      if (!stream) throw new DOMException("No usable camera mode", "NotReadableError");
      const got = negotiated.settings;
      // The border belongs to the source, and a different mode is a different
      // source shape -- anything measured against the old one is now wrong.
      const prev = lastFrameSizeRef.current;
      if (!prev || prev.w !== (got?.width ?? 0) || prev.h !== (got?.height ?? 0)) {
        resetFovDetection();
        // A different mode can also be a different scan type -- the card's PAL
        // and NTSC modes are both interlaced, but 720p from another device is
        // not. Re-measure rather than carry the old answer over.
        resetInterlaceDetection();
        lastFrameSizeRef.current = { w: got?.width ?? 0, h: got?.height ?? 0 };
      }
      setSourceMode({ text: describeMode(got, negotiated.padFraction), padded: negotiated.padded });
      // Does this driver let the browser retune the card's front end? The
      // answer differs per device and per driver, so it is asked, not assumed.
      const track = stream.getVideoTracks()[0];
      const caps = readProcAmpCaps(track);
      setProcAmpCaps(caps);
      if (caps) {
        const initial = readProcAmpValues(track, caps);
        setProcAmp(initial);
        procAmpRef.current = initial;
        // Wait for the canvas to hold real frames -- auto-tune measures the
        // picture, and there is nothing to measure before the first paint.
        setTimeout(() => { void runAutoTune(caps); }, 1200);
      } else {
        setTuneNote("");
      }
      setModeScan(negotiated.tried);
      streamRef.current = stream;
      setActiveStream(stream);
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
      // Unplugged, or a driver reset. startScreenShare has always watched for
      // this; the camera path never did, so a dead card left a frozen picture
      // and nothing else. Handled identically here -- and on the clinic PC the
      // kiosk watchdog then re-opens it, because stopCamera clears streamRef
      // and that is exactly what the watchdog looks for.
      stream.getVideoTracks()[0].addEventListener("ended", stopCamera);
      switchCaptureMode("camera");
      setCameraBusy(false);
      setLastError("");
      setStreaming(true);
      startLoop();
    } catch (err: unknown) {
      setNegotiating("");
      setLastError(describeCameraError(err));
      setCameraBusy(err instanceof DOMException && (err.name === "NotReadableError" || err.name === "TrackStartError"));
    }
  }

  // Play one of the bundled demo clips as if it were a camera: the <video> is
  // fed from a file instead of a MediaStream and looped, and everything after
  // that — the capture loop, the socket, auto-capture, the two panels — is the
  // camera path untouched. Works with no capture hardware attached at all.
  /**
   * Play a file through the camera pipeline. Everything downstream of the
   * <video> element — capture loop, socket, FOV crop, auto-capture, session
   * recording — is the same code the capture card drives, so this is a genuine
   * rehearsal of a live procedure rather than a preview of one.
   *
   * Loops on purpose: a capture card never reaches an end, and a source that
   * stops would end the session in a way the real one never does.
   */
  async function startFileSource(src: string, mode: "demo" | "recording" | "local", optionValue: string,
                                 knownDurationSec = 0, label = "") {
    // Before anything is torn down: the operator is still looking at the
    // current source while they answer. See saveAsk above for why we ask.
    await askSaveVideo(label || optionValue);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    scanRef.current = false;
    setLastError("");
    setCameraBusy(false);
    const video = videoRef.current;
    if (!video) return;
    try {
      video.srcObject = null;
      video.src = src;
      video.loop = true;
      // Assigning src resets the rate to 1, so the rate has to be re-applied
      // rather than set once at mount. Which rate depends on the source: a
      // demo clip defaults to DEMO_SPEED, anything else to 1x -- unless the
      // operator has already picked a speed, which wins over both.
      const rate = speedChosenRef.current ? speed : mode === "demo" ? DEMO_SPEED : 1;
      setSpeed(rate);
      video.playbackRate = rate;
      // Both sources are same-origin (demos are static assets, recordings come
      // from this server's own API), so the canvas stays readable and the FOV
      // probe works. A cross-origin file would taint it and silently disable it.
      setSelectedId(optionValue);
      switchCaptureMode(mode);
      // A saved recording is a MediaRecorder WebM written in streaming mode: no
      // duration in the header, so the browser reports Infinity and the scrub bar
      // has no range. The API already knows the length — using it beats making
      // the browser scan the whole file to rediscover it, which is what made
      // starting a clip feel slow. Must come after switchCaptureMode, which
      // clears the previous source's timeline.
      if (knownDurationSec > 0) setDuration(knownDurationSec);
      // Unhide before waiting for pixels — a display:none <video> is not a
      // reliable captureStream() source, the same reason the screen-share path
      // flips this before it waits.
      setStreaming(true);
      await video.play();
      await waitForFrame(video);

      // The element's own captureStream() stands in for a device stream, so
      // session recording and the rolling clip work here unchanged.
      let stream: MediaStream | null = null;
      try {
        // @ts-expect-error captureStream isn't in the older lib.dom typings
        stream = typeof video.captureStream === "function" ? video.captureStream() : null;
      } catch { /* recording just won't be available for this clip */ }
      streamRef.current = stream;
      setActiveStream(stream);

      // Seek into the window before a single frame is inferred, so the run
      // covers the seconds asked for and nothing ahead of them.
      await armWindow(video);

      startLoop();
    } catch (err: unknown) {
      setStreaming(false);
      setDemoFile(null);
      setRecordingLabel(null);
      setLastError(err instanceof Error ? err.message : String(err));
    }
  }

  async function startDemo(file: string) {
    setDemoFile(file);
    setRecordingLabel(null);
    await startFileSource(`${BASE_PATH}/demos/${file}`, "demo", `${DEMO_PREFIX}${file}`, 0,
                          t(DEMO_VIDEOS.find((v) => v.file === file)?.label ?? file));
  }

  /** A clip off the operator's own machine, played through the pipeline the
   *  capture card drives. Only where the bytes came from differs from a demo. */
  async function startLocalFile(file: File) {
    if (localFile) URL.revokeObjectURL(localFile.url);
    const url = URL.createObjectURL(file);
    setLocalFile({ url, name: file.name });
    setDemoFile(null);
    setRecordingLabel(null);
    await startFileSource(url, "local", `${LOCAL_PREFIX}${file.name}`, 0, file.name);
  }

  async function startRecording(rec: ServerRecording) {
    setDemoFile(null);
    setRecordingLabel(describeRecording(rec));
    await startFileSource(
      `${API}/api/recordings/${rec.case_id}/${rec.id}/video`,
      "recording",
      `${REC_PREFIX}${rec.case_id}/${rec.id}`,
      (rec.duration_ms || 0) / 1000,
      describeRecording(rec),
    );
  }

  // Fallback when the physical device is locked by another app (e.g. ColnoSpy already has it
  // open) — capture the pixels of whatever window/screen is showing the feed instead of the
  // device itself. No coordination with the other app needed, just a one-time picker consent.
  async function startScreenShare(surface: "window" | "monitor" = "window") {
    // An answer given to the replay prompt was about that clip. A live source
    // goes back to the documented on-by-default, so "don't save" for a demo
    // cannot leave an actual procedure unrecorded.
    if (replayAnswerRef.current) {
      replayAnswerRef.current = false;
      autoRecordEnabledRef.current = true;
      setAutoRecordEnabled(true);
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    scanRef.current = false;
    setLastError("");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: surface } as MediaTrackConstraints,
        audio: false,
      });
      streamRef.current = stream;
      setActiveStream(stream);
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
      stream.getVideoTracks()[0].addEventListener("ended", stopCamera);
      switchCaptureMode("screen");
      setCameraBusy(false);
      setStreaming(true);
      startLoop();

      // Guide straight into region selection — a shared window/screen usually has toolbars/UI
      // chrome around the actual video, so cropping right away is part of the normal flow here.
      await waitForFrame(video);
      openRegionSelector();
    } catch (err: unknown) {
      setLastError(describeCameraError(err));
    }
  }

  function waitForFrame(video: HTMLVideoElement | null): Promise<void> {
    return new Promise((resolve) => {
      if (!video || video.videoWidth) return resolve();
      const check = () => { if (video.videoWidth) resolve(); else requestAnimationFrame(check); };
      requestAnimationFrame(check);
    });
  }

  // --- Screen-share crop selection: drag a box on a snapshot of the shared window/screen to
  // send only that region (e.g. just the video pane, not toolbars/UI chrome around it). ---
  function openRegionSelector() {
    const video = videoRef.current;
    const canvas = snapshotCanvasRef.current;
    if (!video || !video.videoWidth || !canvas) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    setDragBox(null);
    setSelectingRegion(true);
  }

  function handleSelectPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    dragStartRef.current = p;
    setDragBox({ x: p.x, y: p.y, w: 0, h: 0 });
  }

  function handleSelectPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const start = dragStartRef.current;
    if (!start) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    setDragBox({ x: Math.min(start.x, x), y: Math.min(start.y, y), w: Math.abs(x - start.x), h: Math.abs(y - start.y) });
  }

  function handleSelectPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const box = dragBox;
    dragStartRef.current = null;
    if (!box || box.w < 10 || box.h < 10) return; // ignore accidental clicks
    const canvas = e.currentTarget;
    const cssRect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / cssRect.width;
    const scaleY = canvas.height / cssRect.height;
    setCropRect({
      x: (box.x * scaleX) / canvas.width,
      y: (box.y * scaleY) / canvas.height,
      w: (box.w * scaleX) / canvas.width,
      h: (box.h * scaleY) / canvas.height,
      mode: captureModeRef.current,
      // Stamped with the frame it was drawn against -- see cropValidFor.
      fw: videoRef.current?.videoWidth ?? 0,
      fh: videoRef.current?.videoHeight ?? 0,
    });
    setSelectingRegion(false);
  }

  /** Walk every candidate mode and report what each one returns. Purely
   *  diagnostic -- it stops the live stream, so it is never run automatically.
   *  Exists so a mode problem can be diagnosed in the room, from the page,
   *  instead of over a remote shell afterwards. */
  async function scanModes() {
    const id = selectedDeviceId;
    if (!id || scanningModes) return;
    setScanningModes(true);
    const wasStreaming = streaming;
    try {
      const r = await negotiateCameraMode(id, {
        scanAll: true,
        onProgress: (step, i, total) => setNegotiating(
          t("Checking camera modes… {step} ({i}/{total})", { step, i: Math.max(i, 1), total })),
      });
      setNegotiating("");
      setModeScan(r.tried);
      r.stream?.getTracks().forEach((t) => t.stop());
    } catch { /* the per-candidate results are the point; a total failure shows as none */ }
    finally {
      setScanningModes(false);
      setNegotiating("");
      // The scan left the device on some arbitrary rung; put the session
      // back on a properly negotiated one.
      if (wasStreaming) await startStream(id);
    }
  }

  function handleDeviceChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const id = e.target.value;
    if (!id) return;
    setSelectedId(id);
    // Demo clips sit in the same list as the real devices — picking one is the
    // same gesture as picking a camera, so it runs through the same handler.
    if (id.startsWith(DEMO_PREFIX)) startDemo(id.slice(DEMO_PREFIX.length));
    else if (id.startsWith(REC_PREFIX)) {
      const [caseId, recId] = id.slice(REC_PREFIX.length).split("/");
      const rec = recordings.find((r) => r.case_id === caseId && r.id === recId);
      if (rec) startRecording(rec);
    }
    // Re-selecting the operator's own clip replays the object URL already
    // held; there is no file to re-read and no second dialog to sit through.
    else if (id.startsWith(LOCAL_PREFIX)) {
      if (localFile) startFileSource(localFile.url, "local", id);
    }
    else {
      // Remember only a real, explicit pick -- this is the branch the
      // operator reaches by choosing a camera, so it is the only one that
      // should teach preselectRemembered anything.
      try {
        localStorage.setItem(DEVICE_KEY, id);
        const d = devices.find((x) => x.deviceId === id);
        if (d?.label) localStorage.setItem(DEVICE_LABEL_KEY, d.label);
      } catch { /* ignore */ }
      startStream(id);
    }
  }

  function stopCamera() {
    scanRef.current = false;
    // Close the recording before killing the tracks: stop() flushes the final
    // slice, and a recorder whose source has already died has nothing to flush.
    recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setActiveStream(null);
    // A demo is a file on the element, not a device: stopping the captured
    // tracks does not stop it playing, so unload it explicitly.
    const video = videoRef.current;
    if (video && video.src) { video.pause(); video.removeAttribute("src"); video.load(); }
    setDemoFile(null);
    setStreaming(false);
    updateBoxes([]);
    // The picture area belongs to the source. Whatever comes next gets measured
    // on its own frames rather than inheriting this one's border.
    resetFovDetection();
    // So does the scan type: a progressive demo clip must not inherit
    // "interlaced" from the capture card that was selected a moment ago.
    resetInterlaceDetection();
  }

  const wsOk = wsStatus === "open";
  // Both panels show the same frame at the same size — one just carries the AI
  // mask and trails by the inference round-trip. Hidden panels are clipped,
  // never unmounted: the <video> holds the MediaStream and the <canvas> has to
  // keep being drawn into for inference to continue while it's out of sight.
  // One per panel: either can take the screen on its own, and coming back
  // must not disturb the other.
  /** First click. Decides HOW the doctor window will be placed; the window
   *  itself is opened by a second click below.
   *
   *  Split in two deliberately. getScreenDetails() prompts, and awaiting a
   *  prompt spends the click's user activation -- a window.open() afterwards
   *  is at the popup blocker's mercy. The picker gives the open its own fresh
   *  gesture. Where no prompt is involved the window opens on this click. */
  function onDoctorScreenClick() {
    setDoctorNote(null);
    setDoctorManual(false);
    if (!canPlaceWindows()) {
      // Firefox and Safari: no placement API, and no prompt to await, so this
      // is still the original gesture and the popup is allowed.
      doctor.open();
      setDoctorNote(t("This browser can't put a window on a display you choose. Drag the doctor window onto the other monitor, then press Full screen inside it."));
      return;
    }
    if (!hasSecondDisplay()) {
      doctor.open();
      setDoctorNote(t("Only one display is connected — the doctor view opened on this one."));
      return;
    }
    void (async () => {
      const list = await listDisplays();
      if (!list || list.length < 2) {
        // Denied or dismissed. Do NOT re-prompt in a loop -- once denied,
        // getScreenDetails rejects immediately and nothing the page does
        // changes that. Offer the manual route instead.
        setDoctorManual(true);
        setDoctorNote(t("Permission to use the other display wasn't given. You can still open the doctor window here and drag it across, or allow 'Window management' for this site in the browser's site settings."));
        return;
      }
      setDisplays(list);
      setChosenDisplay(suggestDisplay(list)?.index ?? 0);
    })();
  }

  // Only attached once a picker is up, so the permission is already granted
  // and this never prompts.
  useEffect(() => {
    if (!displays) return;
    let off = () => {};
    let dead = false;
    void watchDisplays(() => {
      setDoctorNote(t("The displays changed — if the doctor window moved, close it and open it again."));
      void listDisplays().then((l) => { if (l && !dead) setDisplays(l); });
    }).then((fn) => { if (dead) fn(); else off = fn; });
    return () => { dead = true; off(); };
  }, [displays, t]);

  function describeDisplay(d: DoctorDisplay): string {
    const parts = [`#${d.index + 1}`, `${d.width}×${d.height}`];
    if (d.label) parts.splice(1, 0, d.label);
    if (d.isCurrent) parts.push(t("this one"));
    else if (d.isInternal) parts.push(t("built-in"));
    if (d.isPrimary) parts.push(t("primary"));
    return parts.join(" · ");
  }

  // One object, built once per render, so the in-page grid and the overlay
  // cannot disagree about what the numbers are.
  const hudStats: LatencyStats = {
    sent: stats.sent,
    received: stats.received,
    rtt:    { shown: stats.rttMs, cur: cur.rtt,    baseline: rttBase.current.mean,    n: rttBase.current.n },
    server: { shown: stats.avgMs, cur: cur.server, baseline: serverBase.current.mean, n: serverBase.current.n },
    net:    { shown: stats.netMs, cur: cur.net,    baseline: netBase.current.mean,    n: netBase.current.n },
    fps:    { shown: stats.fps,   cur: cur.fps,    baseline: fpsBase.current.mean,    n: fpsBase.current.n },
    uplinkMbps,
  };

  const detectedFs = useFullscreen();
  const liveFs = useFullscreen();

  /**
   * Kiosk: give the detected picture the whole screen, unasked.
   *
   * On the clinic screen the only thing anyone wants to see is the picture
   * with the boxes on it; the controls around it are for setting up, not for
   * a procedure. There is nobody there to press the fullscreen button, so
   * this presses it.
   *
   * requestFullscreen normally needs a user gesture. Two things make that a
   * non-issue: Chrome's AutomaticFullscreenAllowedForUrls policy grants this
   * origin the right to ask without one (set by clinic-pc/setup-clinic-pc.cmd),
   * and useFullscreen already falls back to a CSS full-viewport cover when the
   * request is refused -- so this degrades to the same view rather than
   * failing silently.
   *
   * Once per mount only. An operator who leaves fullscreen has decided
   * something, and must not be dragged back in two seconds later.
   */
  const autoFsRef = useRef(false);
  useEffect(() => {
    if (!autoStart || autoFsRef.current) return;
    if (!streaming || !showDetected || detectedFs.active) return;
    autoFsRef.current = true;
    // A beat after the first frames, so the panel is sized to the real
    // aspect ratio before it takes the screen (fsBoxStyle reads it).
    const t = setTimeout(() => detectedFs.toggle(), 1500);
    return () => clearTimeout(t);
  }, [autoStart, streaming, showDetected]);   // eslint-disable-line react-hooks/exhaustive-deps
  const panelBox = "relative w-full rounded-xl overflow-hidden border border-gray-800 bg-black";
  // When a screen-share crop is active the Detected panel shows only that region,
  // so the Live panel has to be blown up and offset to the same region — otherwise
  // it sits next to a panel that looks zoomed in relative to it. The scaled <video>
  // keeps its native ratio exactly (the panel box is already the crop's ratio), so
  // this crops without distorting.
  // The detected picture area, normalized against the native frame so it can be
  // composed with the hand-drawn screen-share region and used for CSS.
  const fovNorm = fovRect && fovFrame
    ? { x: fovRect.x / fovFrame.w, y: fovRect.y / fovFrame.h,
        w: fovRect.w / fovFrame.w, h: fovRect.h / fovFrame.h }
    : null;
  // Against the region the FOV was measured inside, not the whole frame — with
  // a screen-share crop those differ by a lot and the full-frame number is
  // meaningless (see sampleFov).
  const fovTrim = fovRect && fovBase && fovBase.w > 0 && fovBase.h > 0
    ? Math.max(0, 1 - (fovRect.w * fovRect.h) / (fovBase.w * fovBase.h))
    : fovRect && fovFrame ? trimmedFraction(fovRect, fovFrame.w, fovFrame.h) : 0;
  // Worth acting on only if there is a real border. A frame that arrived already
  // cropped trims a percent or two, and applying that buys nothing.
  const fovWorthIt = !!fovNorm && fovTrim >= NEGLIGIBLE_TRIM;
  const fovApplied = fovEnabled && fovWorthIt;

  // Only the crop drawn for the mode actually running right now -- see the
  // cropRect declaration for why a stale rect from a different mode must
  // never leak in just because it's the last thing stored.
  const manualCrop = cropValidFor(cropRect, captureMode, fovFrame?.w ?? 0, fovFrame?.h ?? 0);
  // Same composition the capture loop does, in normalized space, so the Live
  // panel frames exactly the region the model is being given.
  const analyzedCrop =
    fovApplied && manualCrop ? intersectRect(manualCrop, fovNorm!)
    : fovApplied ? fovNorm
    : manualCrop;
  // While the overlay is up the whole frame is shown instead, because the point
  // of the overlay is to see the part that normally gets dropped.
  //
  // Deliberately just analyzedCrop, nothing extra: an earlier version also
  // force-trimmed a hardcoded bottom band here as a guaranteed fallback for
  // this deployment's capture card, before manual crop was available for
  // camera mode. That meant the Live panel, the operator's own drawn region,
  // and what the server actually analyzed could all show a different crop —
  // three sources of truth instead of one. Now that "Select capture region"
  // (manualCrop, above) covers this case directly and visibly, the Live
  // panel shows exactly analyzedCrop, the same composition sourceRect() uses
  // for what gets sent to the model. One crop, everywhere.
  const liveCrop = showFovOverlay ? null : analyzedCrop;
  // The panel has to carry the native ratio in overlay mode, otherwise
  // object-contain letterboxes the video inside it and the overlay percentages
  // no longer line up with the picture they are describing.
  // SD pixels are not square: 720x480 is a 4:3 picture stored in a 3:2 grid,
  // so an uncorrected panel shows everything slightly too wide. Geometry
  // only -- no resample, nothing re-encoded.
  const liveAspect = aspect43 ? "4/3"
    : showFovOverlay && fovFrame ? `${fovFrame.w}/${fovFrame.h}` : aspect;
  const liveStyle = liveCrop
    ? {
        width: `${100 / liveCrop.w}%`,
        height: `${100 / liveCrop.h}%`,
        left: `${(-liveCrop.x * 100) / liveCrop.w}%`,
        top: `${(-liveCrop.y * 100) / liveCrop.h}%`,
      }
    : undefined;
  const toggleBtn = "text-xs px-2 py-0.5 rounded-md border border-gray-800 text-gray-500 hover:text-gray-300 hover:border-gray-600 transition-colors flex-shrink-0";
  const transportBtn = "px-2.5 py-1 rounded-md bg-gray-800 hover:bg-gray-700 text-gray-300 font-mono transition-colors";

  // Pulled out to plain JSX values (not a component) so the exact same markup
  // -- refs, overlays, toggle buttons and all -- can sit inside a fixed-shape
  // wrapper whose only variable is column count (see the Detected+Live grid
  // below), without ever changing where the <video>/<canvas> live in the tree.
  // Reparenting a ref'd element between renders makes React remount it,
  // destroying its attached MediaStream/src -- that already happened once
  // this session with an earlier "side by side" toggle that nested livePanel
  // differently depending on its state, and hung the capture loop.
  //
  // The panel grid below is pinned dir="ltr" so Review/Detected/Live keep a
  // fixed physical left-to-right order regardless of the app's language --
  // otherwise Farsi's dir="rtl" (the default; see lib/i18n.tsx) flips which
  // physical side is "column 1" for both this pair and the outer Review vs.
  // video-area placement, scrambling the intended layout. Each panel's own
  // dir is reasserted here to the real page direction so its own label text
  // still reads correctly -- only the grids' column-assignment math is pinned.
  const pageDir = lang === "fa" ? "rtl" : "ltr";
  const detectedPanel = (
    <div dir={pageDir} className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-gray-500 uppercase tracking-wide truncate">
          {/* Total round trip, not just server time -- network time also
              delays when this panel's annotated frame actually appears, so
              avgMs (server-only) understated how far behind live this is. */}
          {t("Detected · ~{rtt}ms behind live", { rtt: stats.rttMs || stats.avgMs || 250 })}
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
          {/* Siblings AFTER the canvas, never a wrapper around it: the canvas
              must keep its position in this child list or React remounts it
              and the capture loop draws into a detached element. Overlays
              rather than layout, so the picture stays exactly the size
              fsBoxStyle computed -- see CaptureStrip's header comment. */}
          {detectedFs.active && (
            <CaptureStrip
              shots={shots}
              position={stripPos}
              openId={openShotId}
              onOpen={setOpenShotId}
              onClose={() => setOpenShotId(null)}
              size={stripSize}
              replay={stripReplay}
            />
          )}
          {detectedFs.active && (
            <StripChooser position={stripPos} onChange={setStripPos}
                          size={stripSize} onSize={setStripSize} />
          )}
          {detectedFs.active && hudOn && (
            <LatencyHud stats={hudStats} compact className="absolute top-3 start-3 z-40" />
          )}
          {detectedFs.active && (
            <button onClick={detectedFs.toggle} className={fsExitBtnClass}>
              {t("Exit full screen")}
            </button>
          )}
        </div>
      </div>
    </div>
  );

  const livePanel = (
    <div dir={pageDir} className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-gray-500 uppercase tracking-wide truncate">{t("Live · no lag")}</p>
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
            muted
            playsInline
            loop={captureMode === "demo" || captureMode === "recording"}
            onTimeUpdate={handleTimeUpdate}
            onSeeked={handleSeeked}
            onPlay={() => setPaused(false)}
            onPause={() => setPaused(true)}
            onLoadedMetadata={handleLoadedMetadata}
            onDurationChange={handleLoadedMetadata}
            className={liveStyle ? "absolute object-contain" : "absolute inset-0 w-full h-full object-contain"}
            // Hidden, not removed: opacity only. display:none or visibility
            // would stop the element producing frames, and the capture loop
            // reads from it. Revealed again if the canvas path ever fails.
            style={{ ...(liveStyle ?? {}), opacity: liveCanvasOk ? 0 : 1 }}
          />
          {/* The Live picture the operator actually sees: the same frames,
              deinterlaced. Same classes and same CSS crop as the <video> above,
              so the panel composition is unchanged. */}
          {liveCanvasOk && (
            <canvas
              ref={liveCanvasRef}
              className={liveStyle ? "absolute object-contain" : "absolute inset-0 w-full h-full object-contain"}
              style={{ ...(liveStyle ?? {}), opacity: enhanceOn ? 0 : 1 }}
            />
          )}
          {/* Always mounted so the WebGL context survives the sliders going
              to zero and back; only its visibility follows them. */}
          <canvas
            ref={enhanceCanvasRef}
            className={liveStyle ? "absolute object-contain" : "absolute inset-0 w-full h-full object-contain"}
            style={{ ...(liveStyle ?? {}), opacity: enhanceOn ? 1 : 0 }}
          />
          {/* What the crop discards. The panel is showing the whole
              frame right now (liveCrop is forced to null above), so the
              kept region is outlined and everything outside it is
              washed red by an outsized ring shadow the panel clips. */}
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
  );
  const wsStatusText =
    wsStatus === "open" ? t("connected") :
    wsStatus === "closed" ? t("closed ({code})", { code: closeCode ?? "" }) :
    wsStatus === "reconnecting" ? t("reconnecting… ({code})", { code: closeCode ?? "" }) :
    t(wsStatus);
  // A real capture device is selected, as opposed to a demo clip, a saved
  // recording or a local file -- the only case where "start the camera"
  // means anything.
  const selectedIsCamera = !!selectedDeviceId
    && !selectedDeviceId.startsWith(DEMO_PREFIX)
    && !selectedDeviceId.startsWith(REC_PREFIX)
    && !selectedDeviceId.startsWith(LOCAL_PREFIX);

  // One <optgroup> per clinic day, newest first. A flat list stops being
  // usable past the first day of recordings: the operator knows which day they
  // want, never which case id, and the old label led with a locale date string
  // on every single row.
  const recordingDays = useMemo(() => {
    const byDay = new Map<string, ServerRecording[]>();
    for (const r of recordings) {
      const key = clinicDayKey(r);
      const bucket = byDay.get(key);
      if (bucket) bucket.push(r);
      else byDay.set(key, [r]);
    }
    return Array.from(byDay.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([day, items]) => ({
        day,
        // Midday, so a timezone shift can't push the label onto the day before.
        label: new Date(`${day}T12:00:00`).toLocaleDateString(lang === "fa" ? "fa-IR" : "en-GB",
                                                             { day: "numeric", month: "long", year: "numeric" }),
        items: [...items].sort((a, b) => b.started_at - a.started_at),
      }));
  }, [recordings, lang]);

  const deviceSelect = (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <select
        value={selectedDeviceId}
        onChange={handleDeviceChange}
        className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
      >
        {!selectedDeviceId && <option value="">{t("Select a source…")}</option>}
        {devices.length > 0 && (
          <optgroup label={t("Cameras")}>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || t("Camera {id}", { id: d.deviceId.slice(0, 6) })}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label={t("Demo clips")}>
          {DEMO_VIDEOS.map((v) => (
            <option key={v.file} value={`${DEMO_PREFIX}${v.file}`}>{t(v.label)}</option>
          ))}
        </optgroup>
        {recordingDays.map(({ day, label, items }) => (
          <optgroup key={day} label={t("Clinic · {day} ({n})", { day: label, n: items.length })}>
            {items.map((r) => (
              <option key={`${r.case_id}/${r.id}`} value={`${REC_PREFIX}${r.case_id}/${r.id}`}>
                {describeRecordingInDay(r)}
              </option>
            ))}
          </optgroup>
        ))}
        {localFile && (
          <optgroup label={t("From this computer")}>
            <option value={`${LOCAL_PREFIX}${localFile.name}`}>{localFile.name}</option>
          </optgroup>
        )}
      </select>
      {/* What the device actually gave us. A card that has come up in the
          wrong mode looks identical to one that has not until you see the
          numbers, and at the clinic there is nobody to read a console. */}
      {/* Selecting from the dropdown starts the stream through onChange, but a
          device restored from last session was never "changed" -- no event
          fires and there would be nothing to click. Preselect without this
          button is a dead end, which is exactly how it shipped once. */}
      {selectedIsCamera && !streaming && (
        <button
          onClick={() => void startStream(selectedDeviceId)}
          disabled={!!negotiating}
          className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
        >
          {negotiating ? t("Opening camera…") : t("Start camera")}
        </button>
      )}
      {negotiating && (
        <span className="text-xs px-2 py-1 rounded-md border border-purple-800 bg-purple-950/40 text-purple-300 animate-pulse">
          {negotiating}
        </span>
      )}
      {!negotiating && sourceMode && (
        <span className={`text-xs px-2 py-1 rounded-md border ${sourceMode.padded
          ? "border-amber-800 bg-amber-950/40 text-amber-300"
          : "border-gray-800 bg-gray-900 text-gray-400"}`}>
          {sourceMode.text}
        </span>
      )}
      {/* Opens the camera once per candidate, so it is a button rather than
          something the capture path does on its own. */}
      {selectedIsCamera && (
        <button
          onClick={() => void scanModes()}
          disabled={scanningModes}
          className="text-xs px-2 py-1 rounded-md border border-gray-800 text-gray-500 hover:text-gray-300 hover:border-gray-600 transition-colors disabled:opacity-50"
        >
          {scanningModes ? t("Scanning\u2026") : t("Scan all modes")}
        </button>
      )}
      {modeScan && modeScan.length > 1 && (
        <span className="text-xs text-gray-600 font-mono">
          {modeScan.map((a) => `${a.label}: ${a.error ?? `${a.got} pad ${((a.pad ?? 0) * 100).toFixed(1)}%`}`).join("  \u00b7  ")}
        </span>
      )}
      {/* Beside the list rather than in it: picking a file is a dialog, not a
          selection, and a browser will not open one from a <select>.

          A label wrapping the input rather than a button holding a ref to it:
          this whole control is rendered twice at once — once on the idle screen
          and once in the running session's controls — and one ref cannot point
          at two inputs. The label pairs each copy with its own. */}
      <label className="px-3 py-2 rounded-lg border border-gray-700 bg-gray-900 text-sm text-gray-300 hover:border-gray-500 transition-colors cursor-pointer">
        {t("Use a clip from this computer")}
        <input
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) startLocalFile(f);
            // Clear it, or picking the same file twice fires no change event.
            e.target.value = "";
          }}
        />
      </label>
    </div>
  );

  return (
    <div className="space-y-3">
      {/* Status bar */}
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-3">
          <span className={`flex items-center gap-1.5 ${wsOk ? "text-green-400" : "text-yellow-400"}`}>
            <span className={`w-2 h-2 rounded-full inline-block ${wsOk ? "bg-green-400 animate-pulse" : "bg-yellow-400"}`} />
            {wsStatusText}
          </span>
          {captureMode === "recording" && recordingLabel && (
            <span className="text-xs px-2 py-0.5 rounded-md border border-sky-800 bg-sky-950/40 text-sky-300">
              {t("Replaying recording: {name}", { name: recordingLabel })}
            </span>
          )}
          {captureMode === "demo" && demoFile && (
            <span className="text-xs px-2 py-0.5 rounded-md border border-purple-800 bg-purple-950/40 text-purple-300">
              {t("Demo clip: {name}", { name: t(DEMO_VIDEOS.find((v) => v.file === demoFile)?.label ?? demoFile) })}
            </span>
          )}
          {captureMode === "local" && localFile && (
            <span className="text-xs px-2 py-0.5 rounded-md border border-purple-800 bg-purple-950/40 text-purple-300">
              {t("Your clip: {name}", { name: localFile.name })}
            </span>
          )}
          {/* Tier 3 — the same control the spectator view gets, over the same
              behaviour. */}
          <AlertSoundControls alert={alert} />
          {/* case_id doesn't exist yet before a session has actually started
              — "no-case" is the placeholder LiveCameraPlayer is mounted with
              before that, and there is nothing to spectate on it. */}
          {caseId !== "no-case" && (
            <button
              onClick={() => {
                const url = `${window.location.origin}${BASE_PATH}/spectator/${caseId}`;
                void navigator.clipboard.writeText(url).then(() => {
                  setSpectatorLinkCopied(true);
                  setTimeout(() => setSpectatorLinkCopied(false), 2000);
                });
              }}
              title={t("Copy a link for watching this session live from another, signed-in computer.")}
              className="text-xs px-2 py-0.5 rounded-md border border-gray-800 text-gray-500 hover:text-gray-300 hover:border-gray-600 transition-colors"
            >
              {spectatorLinkCopied ? t("Link copied") : t("Copy spectator link")}
            </button>
          )}
        </div>
        <button onClick={() => { stopCamera(); onStop(); }} className="text-sm text-red-400 hover:text-red-300 transition-colors">{t("Stop")}</button>
      </div>

      {insecure && (
        <div className="bg-yellow-950 border border-yellow-800 rounded-lg px-3 py-2 text-yellow-300 text-xs">
          {t("This page isn't served over HTTPS (or localhost) — browsers block camera access on insecure origins. Open it via https:// or localhost for the camera to work.")}
        </div>
      )}

      {/* Debug panel -- same grid as before, now shared with the compact
          overlay in the fullscreen view so there is one implementation. */}
      <LatencyHud stats={hudStats} error={lastError} />

      {!streaming && (
        <div className="space-y-4 text-center py-16 border-2 border-dashed border-gray-700 rounded-xl">
          {initialMode === "demo" ? (
            <>
              <p className="text-gray-200 text-lg">{t("Replay a saved clip")}</p>
              <p className="text-gray-500 text-sm max-w-md mx-auto px-4">
                {t("A bundled clip, a session already recorded here, or a file from this computer. All three go through the same pipeline a capture card drives — which is what makes a replay a rehearsal rather than a preview.")}
              </p>
              <div>{deviceSelect}</div>
              <div className="pt-2 flex items-center justify-center gap-3 text-xs">
                <button onClick={requestDevices} className="text-gray-500 hover:text-gray-300 underline transition-colors">
                  {permission === "requesting" ? t("Requesting access...") : t("Use a real camera instead")}
                </button>
                <button onClick={() => startScreenShare("window")} className="text-gray-500 hover:text-gray-300 underline transition-colors">
                  {t("Share a window instead")}
                </button>
              </div>
            </>
          ) : initialMode === "screen" ? (
            <>
              <p className="text-gray-200 text-lg">{t("Share a screen or window")}</p>
              <p className="text-gray-500 text-sm max-w-sm mx-auto px-4">
                {t("Pick the window or monitor showing your video feed (e.g. ColnoSpy). Works even when the capture device itself is locked by another app.")}
              </p>
              <div className="flex items-center justify-center gap-3">
                <button
                  onClick={() => startScreenShare("window")}
                  className="px-6 py-2.5 bg-purple-600 hover:bg-purple-500 rounded-lg text-white font-medium transition-colors"
                >
                  {t("Share a window")}
                </button>
                <button
                  onClick={() => startScreenShare("monitor")}
                  className="px-6 py-2.5 bg-purple-600 hover:bg-purple-500 rounded-lg text-white font-medium transition-colors"
                >
                  {t("Share entire screen")}
                </button>
              </div>
            </>
          ) : (
            <>
              {permission !== "granted" ? (
                <>
                  <p className="text-gray-200 text-lg">{t("Connect a camera")}</p>
                  <p className="text-gray-500 text-sm max-w-sm mx-auto px-4">
                    {t("Laptop webcam, phone camera (if this page is opened on the phone itself), or a USB/HDMI capture card — any of them show up below once you grant camera access.")}
                  </p>
                  <button
                    onClick={requestDevices}
                    className="px-6 py-2.5 bg-purple-600 hover:bg-purple-500 rounded-lg text-white font-medium transition-colors"
                  >
                    {permission === "requesting" ? t("Requesting access...") : t("Allow camera access")}
                  </button>
                </>
              ) : (
                <p className="text-gray-500 text-sm">{t("No active stream — pick a device below.")}</p>
              )}
              <div>{deviceSelect}</div>

              {cameraBusy && (
                <div className="max-w-sm mx-auto bg-red-950 border border-red-800 rounded-lg px-4 py-3 space-y-2">
                  <p className="text-red-300 text-sm">{t("Camera is in use by another app on this computer.")}</p>
                  <div className="flex items-center justify-center gap-2">
                    <button
                      onClick={() => startScreenShare("window")}
                      className="px-3 py-2 bg-purple-600 hover:bg-purple-500 rounded-lg text-white text-sm font-medium transition-colors"
                    >
                      {t("Share a window")}
                    </button>
                    <button
                      onClick={() => startScreenShare("monitor")}
                      className="px-3 py-2 bg-purple-600 hover:bg-purple-500 rounded-lg text-white text-sm font-medium transition-colors"
                    >
                      {t("Share entire screen")}
                    </button>
                  </div>
                </div>
              )}

              <div className="pt-2 flex items-center justify-center gap-3 text-xs">
                <button onClick={() => startScreenShare("window")} className="text-gray-500 hover:text-gray-300 underline transition-colors">
                  {t("Share a window instead")}
                </button>
                <button onClick={() => startScreenShare("monitor")} className="text-gray-500 hover:text-gray-300 underline transition-colors">
                  {t("Share entire screen instead")}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Always mounted (just hidden) so the <video> node exists before `streaming` flips true —
          otherwise startStream() has nowhere to attach the MediaStream. */}
      <div className={streaming ? "" : "hidden"}>
        {/* Three equal columns — capture on the left, the two feedback lanes
            taking the other two. Same structure (and same card chrome) as the
            real-time player, so the live panels and the captured feedback
            frames render at identical size. Stacks on narrow screens. */}
        {/* dir="ltr" pins Review/Detected/Live to a fixed physical left-to-right
            order (see the long comment above detectedPanel/livePanel) -- Farsi's
            dir="rtl" would otherwise flip which side "column 1" lands on. Only
            three columns while Live is shown; two equal ones once it's hidden,
            so Review and Detected end up the same width either way rather than
            Detected staying stuck at 2/3 width with a dead third of a track. */}
        <div dir="ltr" className={showLive ? "grid grid-cols-1 xl:grid-cols-3 gap-4 items-start" : "grid grid-cols-1 xl:grid-cols-2 gap-4 items-start"}>
          {/* Session controls. Pressed between moments rather than read during
              one, so they span the top of the grid instead of sitting on the
              video column -- which is what lets the Detected panel and the
              review lane start at the same height. */}
          <div dir={pageDir} className={`${showLive ? "xl:col-span-3" : "xl:col-span-2"} min-w-0 bg-gray-900/50 border border-gray-800 rounded-xl p-3
                          flex flex-col md:flex-row md:flex-wrap md:items-center gap-3 [&>*]:min-w-0`}>
            {/* Right at the top of the column — it's pressed mid-procedure, so it
                should never be somewhere you have to look for or scroll to. */}
            <button
              onClick={() => {
                const next = !procedureStarted;
                setProcedureStarted(next);
                procedureStartedRef.current = next;
                // A fresh start should not inherit the episode state of whatever
                // was on camera beforehand, or the first real detection is
                // treated as a continuation and skipped. Same for tier 3:
                // stopping a procedure must not leave a tone sounding.
                resetEpisode();
                alert.reset();
                lastAutoCaptureRef.current = 0;
                // A procedure boundary is a patient boundary. Everything the
                // timeline holds belongs to whoever just left: the frames are
                // tens of megabytes, and the ticks would point at moments that
                // are not on this timeline at all. The clock itself is set by
                // the effect that owns it, not here -- see timelineCaseRef.
                frameStoreRef.current.clear();
                captureAtRef.current.clear();
                setTimelineTick((n) => n + 1);
              }}
              className={`w-full md:w-auto py-2.5 px-4 rounded-xl text-white font-medium text-sm transition-colors ${
                procedureStarted
                  ? "bg-gray-700 hover:bg-gray-600"
                  : "bg-blue-600 hover:bg-blue-500"
              }`}
            >
              {procedureStarted ? t("⏹ Stop procedure") : t("▶ Start procedure")}
            </button>
            <p className="text-xs text-gray-500 text-center">
              {!procedureStarted
                ? t("Stopped — nothing is being filed. Press start to resume.")
                : inBody.enabled && !inBody.inside
                  ? t("Outside the patient — filing pauses, and resumes on its own.")
                  : t("Filing frames for review while the camera is in the colon.")}
            </p>

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

            {/* Off by default and remembered per browser. Deliberately a plain
                visible checkbox rather than a hidden key: whoever is running
                the session should be able to turn the numbers on without
                being told a shortcut, and they only ever draw over the
                fullscreen view, never the normal page. */}
            <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={hudOn}
                onChange={(e) => setHudOn(e.target.checked)}
                className="accent-blue-500 cursor-pointer"
              />
              {t("Show latency numbers on the full-screen view")}
            </label>

            {/* Two screens, PowerPoint style: the doctor gets a clean picture
                on one monitor, this page keeps every control on the other. */}
            <div className="w-full rounded-xl border border-gray-800 bg-gray-900/60 px-3 py-2 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-gray-400">{t("Doctor screen")}</span>
                {doctor.ready ? (
                  <button
                    onClick={() => { doctor.close(); setDisplays(null); setDoctorNote(null); }}
                    className="text-xs px-2.5 py-1 rounded-md border border-gray-700 text-gray-300 hover:border-gray-500"
                  >
                    {t("Close doctor screen")}
                  </button>
                ) : (
                  <button
                    onClick={onDoctorScreenClick}
                    className="text-xs px-2.5 py-1 rounded-md border border-blue-700 bg-blue-950/40 text-blue-200 hover:border-blue-500"
                  >
                    {t("Open doctor screen")}
                  </button>
                )}
              </div>

              {!doctor.ready && displays && displays.length > 1 && (
                <div dir="ltr" className="space-y-1">
                  <p className="text-[11px] text-gray-500" dir={pageDir}>
                    {t("Which display is the doctor's?")}
                  </p>
                  {displays.map((d) => (
                    <label key={d.index} className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                      <input
                        type="radio"
                        name="doctor-display"
                        checked={chosenDisplay === d.index}
                        onChange={() => setChosenDisplay(d.index)}
                        className="accent-blue-500 cursor-pointer"
                      />
                      <span className="font-mono">{describeDisplay(d)}</span>
                    </label>
                  ))}
                  <button
                    onClick={() => {
                      const d = displays.find((x) => x.index === chosenDisplay);
                      if (d) doctor.open({ left: d.left, top: d.top, width: d.width, height: d.height });
                    }}
                    className="mt-1 text-xs px-2.5 py-1 rounded-md bg-blue-600 hover:bg-blue-500 text-white"
                  >
                    {t("Open doctor view there")}
                  </button>
                </div>
              )}

              {!doctor.ready && doctorManual && (
                <button
                  onClick={() => doctor.open()}
                  className="text-xs px-2.5 py-1 rounded-md border border-gray-700 text-gray-300 hover:border-gray-500"
                >
                  {t("Open doctor window here")}
                </button>
              )}

              {doctor.ready && (
                <p className="text-[11px] text-gray-500">
                  {t("Press Full screen inside the doctor window — a browser won't do that for a window it just opened.")}
                </p>
              )}
              {doctor.error === "blocked" && (
                <p className="text-[11px] text-red-400">
                  {t("The browser blocked the second window. Allow pop-ups for this site and try again.")}
                </p>
              )}
              {doctorNote && <p className="text-[11px] text-gray-500">{doctorNote}</p>}
            </div>

            {/* Recording is opt-in: nothing is written to the server until this
                is pressed, so a session that nobody wants archived leaves nothing. */}
            <RecordingRecoveryBanner />
            <RecordingControls recorder={recorder} ready={streaming}
              autoRecordEnabled={autoRecordEnabled} onAutoRecordEnabledChange={setAutoRecordEnabled}
              recordOverride={recordOverride} onRecordOverrideChange={setRecordOverride} />
          </div>
          <div dir={pageDir} className={`space-y-2 min-w-0 bg-gray-900/50 border border-gray-800 rounded-xl p-3 xl:order-2 ${showLive ? "xl:col-span-2" : ""}`}>
            {/* Detected and Live, always rendered as this exact pair in this exact
                order -- only the column count changes (2 when Live is shown, 1 when
                hidden, and it drops into the second row rather than vanishing). The
                <video>/<canvas> refs inside detectedPanel/livePanel never move to a
                different parent, so neither ever remounts. */}
            <div dir="ltr" className={showLive ? "grid grid-cols-1 xl:grid-cols-2 gap-2" : "grid grid-cols-1 gap-2"}>
              {detectedPanel}
              {livePanel}
            </div>

            {/* Scrub — lets staff line up an exact moment in a clip instead of
                waiting for the loop to come back around to it. Hidden for camera
                and screen share, which have no timeline. Sits directly under the
                pair above since it's one shared timeline for both. */}
            {seekable && (
              <div className="space-y-1">
                {duration > 0 ? (
                  <input
                    type="range" min={0} max={duration} step={0.1}
                    value={scrubbing ? scrubValue : curTime}
                    onPointerDown={() => { setScrubbing(true); setScrubValue(curTime); }}
                    onPointerUp={() => setScrubbing(false)}
                    onPointerCancel={() => setScrubbing(false)}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setScrubValue(v);
                      seekTo(v);
                    }}
                    className="w-full accent-blue-500 cursor-pointer"
                  />
                ) : (
                  <p className="text-xs text-gray-600">{t("Measuring clip length…")}</p>
                )}
                {/* dir=ltr because a transport is read the same way everywhere: the
                    signs carry the direction, so nothing here depends on the page
                    being LTR or on arrow glyphs being flipped for RTL. */}
                <div dir="ltr" className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
                  <button onClick={togglePlay} className={transportBtn}>{paused ? "▶" : "⏸"}</button>
                  <button onClick={() => seekTo(curTime - 3)} className={transportBtn}>{"−3s"}</button>
                  <button onClick={() => seekTo(curTime - 1)} className={transportBtn}>{"−1s"}</button>
                  <button onClick={() => seekTo(curTime + 1)} className={transportBtn}>{"+1s"}</button>
                  <button onClick={() => seekTo(curTime + 3)} className={transportBtn}>{"+3s"}</button>
                  <button onClick={() => seekTo(0)} className={transportBtn}>{t("↺ Restart")}</button>
                  <span className="text-gray-500 font-mono">
                    {formatClock(curTime)}{duration > 0 ? ` / ${formatClock(duration)}` : ""}
                  </span>
                </div>

                {/* Speed sits on its own row: the label is translated, so unlike the
                    transport above it should follow the page direction. */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
                  <span
                    className="text-gray-500"
                    title={t("slower playback = less motion between frames = the two panels drift apart less")}
                  >
                    {t("Playback speed")}
                  </span>
                  {SPEEDS.map((s) => (
                    <button
                      key={s}
                      onClick={() => changeSpeed(s)}
                      className={`px-2.5 py-1 rounded-md font-mono transition-colors ${
                        speed === s ? "bg-green-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                      }`}
                    >
                      {s}x
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-500">
                  {t("Scrub the clip — detection keeps running from wherever you land.")}
                </p>
              </div>
            )}

            {/* The gate sits directly below the Detected+Live pair (and the scrub
                bar): when it fires, this is the explanation for why those panels
                have stopped updating. */}
            <InBodyGateNotice gate={inBody} />

            <QualityGateNotice gate={quality} />

            {/* Exact seconds to replay. The whole point of the persistence
                comparison is running identical frames twice, which eyeballing
                the scrub bar cannot deliver. Only shown for a source that has a
                timeline: there is nothing to seek in a camera. */}
            {seekable && (
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
                {(winStart || winStop) && (
                  <button onClick={() => void rerunWindow()}
                          className="text-xs px-2 py-1 rounded-md border border-green-800 bg-green-950/30 text-green-300 hover:border-green-600 transition-colors">
                    {winDone ? t("Run the window again") : t("Run the window from its start")}
                  </button>
                )}
                <p className="text-[11px] text-gray-600">
                  {winDone
                    ? t("Stopped at the end of the window. Change the persistence setting and run it again for the second pass.")
                    : winStart || winStop
                      ? t("Seeks to the start when the clip is loaded and stops at the end. Persistence counters reset each run.")
                      : t("Empty = play the whole clip. Set both to replay identical frames with persistence on and off.")}
                </p>
              </div>
            )}

            <TemporalGateNotice gate={temporal} />

            <FilterBankNotice gate={gate} temporal={temporal} show={showBank} onToggle={() => setShowBank(!showBank)} />

            {/* Field of view. The signal is wider than the picture: there is a
                black border around it, and averaging quality statistics over
                that border flattens the difference between a sharp frame and a
                soft one. lib/fov.ts has the measurements. */}
            {streaming && (
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

            {/* Picture controls. Collapsed by default: during a procedure
                nobody is adjusting sliders, and an always-open block would
                push the things that ARE pressed mid-procedure down the page. */}
            {streaming && (
              <div className="space-y-2">
                <button
                  onClick={() => setEnhOpen(!enhOpen)}
                  className={`w-full md:w-auto flex items-center gap-2 px-3 py-2 rounded-xl border text-sm transition-colors ${
                    enhanceOn ? "border-emerald-700 bg-emerald-950/30 text-emerald-300"
                              : "border-gray-700 bg-gray-900 text-gray-300 hover:border-gray-500"}`}
                >
                  <span>🎨</span>
                  <span>{t("Picture settings")}</span>
                  <span className="text-xs text-gray-500">
                    {enhanceOn ? t("on") : enhOpen ? "▾" : "▸"}
                  </span>
                </button>
                {enhOpen && (
                  <div className="rounded-xl border border-gray-800 bg-gray-900/60 px-3 py-2 space-y-2">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-gray-400">{t("Deinterlace")}</span>
                      <select
                        value={deintMode}
                        onChange={(e) => {
                          setDeintMode(e.target.value as DeintMode);
                          deintRef.current.reset();
                          glDeintRef.current?.reset();
                        }}
                        className="rounded-md border border-gray-700 bg-gray-800 px-1.5 py-0.5 text-gray-300 text-xs max-w-[12rem]"
                      >
                        {DEINT_MODES.map((m) => (
                          <option key={m.key} value={m.key} title={m.hint}>{t(m.label)}</option>
                        ))}
                      </select>
                    </div>

                    {([["Denoise", denoise, setDenoise], ["Sharpen", sharpen, setSharpen]] as const).map(
                      ([name, value, set]) => (
                        <div key={name}>
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-gray-400">{t(name)}</span>
                            <span className="font-mono text-gray-200">{Math.round(value * 100)}%</span>
                          </div>
                          <input type="range" min={0} max={1} step={0.05} value={value}
                                 onChange={(e) => set(Number(e.target.value))}
                                 className="w-full accent-blue-500 cursor-pointer" />
                        </div>
                      ))}

                    <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
                      <input type="checkbox" checked={aspect43} className="accent-blue-500"
                             onChange={(e) => setAspect43(e.target.checked)} />
                      {t("Correct to 4:3 (SD pixels are not square)")}
                    </label>

                    {procAmpCaps && (
                      <div className="pt-1 border-t border-gray-800 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[11px] text-gray-500">
                            {t("From the capture card itself — these change the signal every part of the app receives.")}
                          </p>
                          <button
                            onClick={() => procAmpCaps && void runAutoTune(procAmpCaps)}
                            className="text-xs px-2 py-1 rounded-md border border-emerald-800 text-emerald-300 hover:border-emerald-600 whitespace-nowrap"
                          >
                            {t("Auto-tune")}
                          </button>
                        </div>
                        <p className="text-[11px] text-gray-600">
                          {t("Tuned automatically when the card is connected. Adjust only if you want to.")}
                        </p>
                        {tuneNote && <p className="text-[11px] text-gray-500 font-mono">{tuneNote}</p>}
                        {Object.entries(procAmpCaps).map(([k, cap]) => (
                          <div key={k}>
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-gray-400">{t(k)}</span>
                              <span className="font-mono text-gray-200">{procAmp[k] ?? cap.min}</span>
                            </div>
                            <input
                              type="range" min={cap.min} max={cap.max} step={cap.step || 1}
                              value={procAmp[k] ?? cap.min}
                              onChange={(e) => { setTuneNote(""); void applyProcAmp(k, Number(e.target.value)); }}
                              className="w-full accent-emerald-500 cursor-pointer"
                            />
                          </div>
                        ))}
                      </div>
                    )}

                    {(denoise > 0 || sharpen > 0) && (
                      <button onClick={() => { setDenoise(0); setSharpen(0); setSlowNote(""); }}
                              className="text-xs px-2 py-1 rounded-md border border-gray-700 text-gray-300 hover:border-gray-500">
                        {t("Turn enhancement off")}
                      </button>
                    )}
                    {slowNote && <p className="text-[11px] text-amber-400">{slowNote}</p>}
                    <p className="text-[11px] text-gray-600">
                      {t("Picture settings change what you see, not what is analysed or recorded.")}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Shown whenever the source is switchable — with the demo clips in
                the list that is any time we are not screen-sharing. */}
            {captureMode !== "screen" && deviceSelect}

            {streaming && (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <button onClick={openRegionSelector} className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-white transition-colors">
                  {manualCrop ? t("Change capture region") : t("Select capture region")}
                </button>
                {manualCrop && (
                  <button onClick={() => setCropRect(null)} className="text-gray-500 hover:text-gray-300 transition-colors">
                    {t("Reset (use full frame)")}
                  </button>
                )}
              </div>
            )}

            <button onClick={stopCamera} className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
              {captureMode === "screen" ? t("← Disconnect screen share")
                : captureMode === "demo" ? t("← Stop demo clip")
                : captureMode === "recording" ? t("← Stop replay")
                : t("← Disconnect camera")}
            </button>
          </div>

          {/* Review, leftmost of the three columns. Placed via xl:order-1 rather
              than moved earlier in the JSX -- its own conditional (streaming)
              flips independently of the video column, and reordering the JSX
              itself would shift the video column's sibling index every time
              this toggles, which is the same remount hazard as the Detected+Live
              grid above. order is pure CSS and never touches sibling identity.
              Scrolls internally so it never lengthens the page. Mounted only
              while streaming so it isn't polling behind the setup screen. */}
          {streaming && (
            <div dir={pageDir} className="min-w-0 xl:order-1 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto">
              <FeedbackPanel
                caseId={caseId}
                refreshSignal={feedbackRefreshKey}
                timeline={timelineSource}
              />
            </div>
          )}
        </div>

        {/* Playback for what was recorded in THIS session, full width so the
            player isn't squeezed into the narrow capture column. Collapsed by
            default and unmounted while closed — during a procedure nobody is
            watching a replay, and an open panel would be polling for no one. */}
        <div className="mt-4 border-t border-gray-800 pt-3 space-y-3">
          <button
            onClick={() => setShowRecordings((v) => !v)}
            className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
          >
            {showRecordings ? t("▾ Recordings from this session") : t("▸ Recordings from this session")}
          </button>
          {showRecordings && (
            <RecordingsPanel
              caseId={caseId}
              refreshSignal={recorder.finishedCount}
              title={t("Recorded in this session")}
            />
          )}
        </div>
      </div>

      {saveAsk && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 p-5 space-y-3">
            <h3 className="text-base font-semibold text-white">{t("Save video for this clip?")}</h3>
            <p className="text-sm text-gray-300 break-words">{saveAsk.label}</p>
            <p className="text-xs text-gray-500">
              {t("A replay can be recorded to the server exactly like a live procedure. Frames you capture for feedback are saved either way.")}
            </p>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => answerSaveVideo(true)}
                className="flex-1 px-3 py-2 bg-purple-600 hover:bg-purple-500 rounded-lg text-white text-sm font-medium transition-colors"
              >
                {t("Save video")}
              </button>
              <button
                onClick={() => answerSaveVideo(false)}
                className="flex-1 px-3 py-2 rounded-lg border border-gray-700 bg-gray-900 text-sm text-gray-300 hover:border-gray-500 transition-colors"
              >
                {t("Don't save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Always mounted (just hidden) so snapshotCanvasRef exists before openRegionSelector()
          needs to draw into it — it draws first, then flips this visible. */}
      <div className={`fixed inset-0 z-50 bg-black/90 flex-col items-center justify-center gap-3 p-4 ${selectingRegion ? "flex" : "hidden"}`}>
        <p className="text-white text-sm">{t("Drag a rectangle around just the video area, then release.")}</p>
        <div className="relative">
          <canvas
            ref={snapshotCanvasRef}
            onPointerDown={handleSelectPointerDown}
            onPointerMove={handleSelectPointerMove}
            onPointerUp={handleSelectPointerUp}
            className="block max-w-full max-h-[70vh] border border-gray-600 cursor-crosshair"
            style={{ touchAction: "none" }}
          />
          {dragBox && (
            <div
              className="pointer-events-none absolute border-2 border-[#39ff14]"
              style={{ left: dragBox.x, top: dragBox.y, width: dragBox.w, height: dragBox.h }}
            />
          )}
        </div>
        <button onClick={() => setSelectingRegion(false)} className="text-sm text-gray-400 hover:text-gray-200">{t("Cancel")}</button>
      </div>

      <p className="text-xs text-gray-600">
        {sourceMode && (
          <span className={sourceMode.padded ? "text-amber-500" : "text-gray-500"}>
            {t("Source {mode}", { mode: sourceMode.text })}{" · "}
          </span>
        )}
        {t("Frames scaled to {width}px before sending · one frame in flight at a time · ~{rtt}ms round trip ({server}ms of it server-side)", { width: inferWidth, rtt: stats.rttMs || 0, server: stats.avgMs || 0 })}
      </p>

      {/* Last child, and always written as the same single expression, so its
          index in this list never shifts -- a sibling that appears and
          disappears above a ref'd element is how remounts happen here.
          `ready` is state and `doctorRoot` is only read once it is true, so
          this cannot render before the container document exists, and it
          cannot render during SSR because nothing sets `ready` except a
          click. */}
      {doctor.ready && doctor.win && doctorRoot(doctor.win) &&
        createPortal(
          <DoctorScreen
            win={doctor.win}
            mirrorSource={mirrorSource}
            generation={mirrorGeneration}
            aspect={aspect}
            shots={shots}
            stripPos={stripPos}
            onStripPos={setStripPos}
            stripSize={stripSize}
            onStripSize={setStripSize}
            openShotId={openShotId}
            onOpenShot={setOpenShotId}
            hudStats={hudStats}
            hudOn={hudOn}
            stopped={!streaming}
            replay={stripReplay}
          />,
          doctorRoot(doctor.win)!,
        )}
    </div>
  );
}
