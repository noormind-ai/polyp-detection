"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import UploadPanel from "@/components/UploadPanel";
import WarmupPanel from "@/components/WarmupPanel";
import VideoPlayer from "@/components/VideoPlayer";
import LiveCameraPlayer from "@/components/LiveCameraPlayer";
import SignInPrompt, { goToLogin } from "@/components/SignInPrompt";
import RecordingsPanel from "@/components/RecordingsPanel";
import ReviewCallout from "@/components/ReviewCallout";
import ModelPerformance from "@/components/ModelPerformance";
import { useAuth } from "@/lib/auth";
import { useLanguage } from "@/lib/i18n";
import { measureNetwork } from "@/lib/clinicDiagnostic";

/** Where the whole-file upload flow is in its own little lifecycle. */
type UploadStage = "idle" | "processing" | "done";
/** Modal GPU container state. Only the live capture modes ever move this. */
type GpuState = "off" | "starting" | "ready";
type Mode = "upload" | "simulation" | "camera" | "screen" | "recordings";

interface Detection {
  bbox: [number, number, number, number];
  conf: number;
}

interface InferResult {
  fps: number;
  width: number;
  height: number;
  frames: Detection[][];
}

interface GtData {
  width: number;
  height: number;
  frames: { bbox: [number, number, number, number] }[][];
}

/** A live-camera room some other tab/device/clinic PC already has open --
 *  see GET /api/sessions/active. `user` is unset only for sessions opened
 *  before this field existed; the UI just shows those as unattributed. */
interface ActiveRoom {
  case_id: string;
  started_at: number;
  engine: string;
  user: string | null;
}

/** A CPU model the server has actually deployed. `polyp_trained` is false for
 *  the stock COCO nano models, which are carried only to measure CPU speed. */
interface CpuModel {
  name: string;
  label: string;
  polyp_trained: boolean;
  conf?: number;
  // Capture width this model consumes (320 or 640), from the server registry.
  // The players size their inference canvas from it so the model never sees
  // upscaled pixels. Absent on an older server -> players default to 320.
  imgsz?: number;
  backend: string;
  // True when this model's onnx session is bound to CUDAExecutionProvider on
  // this box, not just present. A GPU joined noormind-iran 2026-09-27 -- only
  // RT-DETR runs on it so far, so this is per-model, not a deployment-wide flag.
  gpu?: boolean;
}

interface BackendInfo {
  default: string;
  available: Record<string, boolean>;
  cpu: string | null;
  cpu_models?: CpuModel[];
  // Set by a deployment with no GPU and no Modal account. Demos run live on the
  // CPU there instead of replaying results baked by a different model.
  cpu_only?: boolean;
}

interface EngineOption {
  id: string;
  icon: string;
  title: string;
  detail: string;
  note: string;
  usable: boolean;
}

const isCpuEngine = (b: string) => b.startsWith("cpu");

/** Whether `backend` is a local engine actually bound to this box's GPU
 *  right now, per the server's per-model `gpu` flag -- not every `cpu:`
 *  engine qualifies (only rtdetr does, at time of writing). */
const usesLocalGpu = (d: BackendInfo | null, b: string) =>
  !!d?.cpu_models?.find((m) => m.backend === b)?.gpu;

/** Modal is always offered; the CPU entries come from whatever the server has
 *  deployed, so a box with no onnx models simply shows the one option. */
function engineOptions(d: BackendInfo | null, t: (s: string) => string): EngineOption[] {
  if (!d) return [];
  // No cloud GPU option: this deployment is CPU-only (POLYP_CPU_ONLY), so
  // offering Modal meant rendering a button the server would then refuse.
  const opts: EngineOption[] = [];
  for (const m of d.cpu_models ?? []) {
    opts.push({
      id: m.backend,
      icon: m.polyp_trained ? "🖥️" : "⏱️",
      title: m.label,
      detail: d.cpu ?? t("This server's CPU"),
      note: !m.polyp_trained
        ? t("Speed test only · will NOT detect polyps")
        : m.gpu
          ? t("Runs on this server's GPU · no cloud")
          : t("Runs on this server's CPU · no GPU, no cloud"),
      usable: !!d.available?.cpu,
    });
  }
  // Real detectors first, speed probes last — otherwise a stock COCO model can
  // sit above the polyp models and read as a recommended option.
  opts.sort((a, b) => Number(b.note !== t("Speed test only · will NOT detect polyps"))
                    - Number(a.note !== t("Speed test only · will NOT detect polyps")));
  return opts;
}

const API = process.env.NEXT_PUBLIC_API_URL || "";
// MUST match scaledown_window in inference/app.py (120s). Modal releases the GPU
// container that long after its last request; we drop out of the live modes at the
// same moment so the UI never claims a GPU that is already gone. Waiting longer
// than the container lives would leave the next frame eating a cold start with a
// green "GPU ready" indicator above it.
//
// This cannot fire mid-procedure: the capture loop calls onActivity on every
// response, so the timer only counts down once streaming has actually stopped.
const MODAL_IDLE_MS = 2 * 60 * 1000;

/**
 * Kiosk mode — the clinic PC.
 *
 * That machine is switched on in the morning, shows this app on a screen in
 * the procedure room, and has nobody whose job it is to click through it. With
 * this flag set the page goes straight into Live Camera and the player opens
 * the capture card itself (LiveCameraPlayer's `autoStart`): power on, picture,
 * nothing else to do.
 *
 * Set once per machine by visiting /?kiosk=1 and cleared with /?kiosk=0. Kept
 * in localStorage rather than being a server or account setting because it is
 * a property of THAT computer: the same login opened on a laptop should still
 * land on the mode picker like everyone else's.
 */
const KIOSK_KEY = "polyp_kiosk";

/** The modes that need an account: the one that spends GPU on a video the user
 *  supplied, and the one that plays back patient video held on this server. */
const NEEDS_ACCOUNT: Mode[] = ["upload", "recordings"];
/** The modes that need a warm GPU container before they can do anything. */
const NEEDS_GPU: Mode[] = ["simulation", "camera", "screen"];
// A quick upload-speed reading at session start, so a slow start has a
// number attached to it instead of just a feeling. Far smaller than the
// clinic-test diagnostic's own probe (measureNetwork's default) -- this
// runs on every session, before the operator can begin scanning, so it
// has to stay a one-to-two-second cost on even a very slow uplink.
const UPLINK_PROBE_BYTES = 256 * 1024;

export default function Home() {
  const { t, lang, toggleLang } = useLanguage();
  const { user, loading: authLoading, logout, reviewer, spectator } = useAuth();

  const [mode, setMode] = useState<Mode | null>(null);

  const [kiosk, setKiosk] = useState(false);
  // Auto-opens once per page load and no more: backing out of Live Camera has
  // to leave the operator on the mode picker, not bounce them straight back in.
  const kioskOpenedRef = useRef(false);

  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get("kiosk");
      if (q === "1") localStorage.setItem(KIOSK_KEY, "1");
      else if (q === "0") localStorage.removeItem(KIOSK_KEY);
      setKiosk(localStorage.getItem(KIOSK_KEY) === "1");
    } catch { /* private mode: kiosk simply stays off */ }
  }, []);

  // RecordingControls sits several levels down inside the players; an event is
  // less invasive than threading a callback through every one of them.
  useEffect(() => {
    const open = () => goToLogin();
    window.addEventListener("polyp:signin", open);
    return () => window.removeEventListener("polyp:signin", open);
  }, []);

  // Whole app behind the login, matching the server (every inference, feedback
  // and recording endpoint now requires a session). The one-shot guard is the
  // same precaution /login already takes: if the session is refused on arrival
  // for any reason, a plain redirect here would bounce the two pages forever.
  useEffect(() => {
    if (authLoading || user) return;
    try {
      if (sessionStorage.getItem("polyp_home_bounce")) return;
      sessionStorage.setItem("polyp_home_bounce", "1");
    } catch { /* private mode: accept the small risk of one extra hop */ }
    window.location.replace("/login?next=/");
  }, [authLoading, user]);
  useEffect(() => {
    if (user) { try { sessionStorage.removeItem("polyp_home_bounce"); } catch { /* ignore */ } }
  }, [user]);
  const [gpu, setGpu] = useState<GpuState>("off");
  const [uploadStage, setUploadStage] = useState<UploadStage>("idle");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [result, setResult] = useState<InferResult | null>(null);
  const [groundTruth, setGroundTruth] = useState<GtData | null>(null);
  const [showGt, setShowGt] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [caseId, setCaseId] = useState<string | null>(null);
  // Measured once per session/start (see openMode) -- shown next to the
  // live latency readout, and carried in LiveCameraPlayer's own room-stats
  // report so it lands in the server's netstat log too.
  const [uplinkMbps, setUplinkMbps] = useState<number | null>(null);
  // Other rooms found open at session start (see openMode) -- non-null
  // shows the conflict dialog. stoppingCaseId/confirmStopOther track one
  // row's own in-progress stop and, when it belongs to a different
  // operator, the extra confirm before ending someone else's procedure.
  const [sessionConflicts, setSessionConflicts] = useState<ActiveRoom[] | null>(null);
  const [stoppingCaseId, setStoppingCaseId] = useState<string | null>(null);
  const [confirmStopOther, setConfirmStopOther] = useState<ActiveRoom | null>(null);
  const [backends, setBackends] = useState<BackendInfo | null>(null);
  // Empty until /api/backends answers, and empty means "whatever this
  // deployment serves" — the server reads INFERENCE_BACKEND. It used to start
  // on "modal", so a click landing before that fetch resolved asked a CPU-only
  // box for a GPU it does not have and came back 400, which read as a hang.
  const [backend, setBackend] = useState<string>("");
  const gtInputRef = useRef<HTMLInputElement>(null);
  const lastActiveRef = useRef<number>(Date.now());

  const markActive = useCallback(() => { lastActiveRef.current = Date.now(); }, []);

  // The model the engine picker currently points at -- carries the per-model
  // capture width (imgsz) and serving threshold (conf) from /api/backends.
  const selectedModel = backends?.cpu_models?.find((m) => m.backend === backend);

  // A case ID for filing feedback captures under. Deliberately its own endpoint
  // rather than session/start: every mode files feedback, including the
  // precomputed demos, and those must never wake a GPU.
  const newCase = useCallback(() => {
    fetch(`${API}/api/case/new`, { method: "POST", credentials: "include" })
      .then((r) => r.json())
      .then((d) => setCaseId(d.case_id ?? null))
      .catch(() => { /* feedback capture degrades on its own if this fails */ });
  }, []);

  useEffect(() => { newCase(); }, [newCase]);

  // Ask the server which engines it can actually serve, so the UI never offers
  // a choice that will fail. Read-only and starts nothing.
  useEffect(() => {
    fetch(`${API}/api/backends`)
      .then((r) => r.json())
      .then((d: BackendInfo) => {
        setBackends(d);
        if (d.default) setBackend(d.default);
      })
      .catch(() => { /* picker just stays on the Modal default */ });
  }, []);

  // Kiosk: open Live Camera without being asked to. Waits for /api/backends so
  // the session starts on the engine this deployment actually serves, and so
  // the player is handed that model's capture width and threshold, rather than
  // on whatever an empty `backend` resolves to.
  useEffect(() => {
    if (!kiosk || authLoading || !user || !backends || mode !== null) return;
    if (kioskOpenedRef.current) return;
    kioskOpenedRef.current = true;
    void openMode("camera");
  }, [kiosk, authLoading, user, backends, mode]);   // eslint-disable-line react-hooks/exhaustive-deps

  const stopGpu = useCallback(async () => {
    setGpu("off");
    try {
      await fetch(`${API}/api/session/stop`, { method: "POST", credentials: "include" });
    } catch { /* the container scales itself down anyway */ }
  }, []);

  // Only runs while a live capture mode holds a GPU. Modal has already released
  // the container by this point, so staying on the live screen would just mean
  // the next frame eats a cold start.
  useEffect(() => {
    if (gpu !== "ready") return;
    // CPU-only boxes (the Iran deployment) have no container to release: the
    // ONNX session lives in the backend process for as long as it runs. Timing
    // a clinician out mid-procedure there would cost a session and save
    // nothing, so the timer only exists when a Modal GPU is actually in play.
    if (backends?.cpu_only || backend.startsWith("cpu:")) return;
    const interval = setInterval(() => {
      if (Date.now() - lastActiveRef.current > MODAL_IDLE_MS) {
        stopGpu();
        setMode(null);
        setError(t("Session timed out after 2 minutes idle — the GPU was released to save cost. Open live camera or screen share again to reconnect."));
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [gpu, stopGpu, t, backends, backend]);

  /** Live capture modes boot the container first and show the warm-up log while it comes up. */
  async function openMode(next: Mode) {
    setError(null);
    setMode(next);
    if (!NEEDS_GPU.includes(next)) return;

    setGpu("starting");
    try {
      // encode: CPU engines carry a colon, as in "cpu:yolo11n"
      const res = await fetch(
        backend
          ? `${API}/api/session/start?backend=${encodeURIComponent(backend)}`
          : `${API}/api/session/start`,
        { method: "POST", credentials: "include" }
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(t("Backend error {status}: {text}", { status: res.status, text }));
      }
      const data = await res.json();
      if (data.case_id) setCaseId(data.case_id);
      setUplinkMbps(null);
      try {
        const net = await measureNetwork(UPLINK_PROBE_BYTES);
        const upload = net.upload as { mbps?: number } | undefined;
        if (typeof upload?.mbps === "number") setUplinkMbps(upload.mbps);
      } catch {
        // Best-effort -- a failed probe must never block starting the session.
      }

      // Someone else (another tab, device, or the clinic PC left running)
      // may already have this case -- or any case -- open. Surfaced as a
      // blocking dialog rather than just a warning, since starting a
      // second live socket means two detectors competing for the same
      // uplink, which is the exact problem this session start just paid
      // to measure. Best-effort: a failed check must not block a normal
      // start, so it fails open.
      try {
        const activeRes = await fetch(`${API}/api/sessions/active`, { credentials: "include" });
        if (activeRes.ok) {
          const activeData = await activeRes.json();
          const others: ActiveRoom[] = (activeData.rooms ?? []).filter(
            (r: ActiveRoom) => r.case_id !== data.case_id,
          );
          if (others.length > 0) {
            setSessionConflicts(others);
            markActive();
            return; // The dialog decides when (or whether) gpu becomes "ready".
          }
        }
      } catch {
        // Best-effort -- see above.
      }
      markActive();
      setGpu("ready");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(
        msg.includes("fetch") || msg.includes("Failed to fetch")
          ? t("Cannot reach backend at {API}. Is uvicorn running?", { API })
          : msg
      );
      setGpu("off");
      setMode(null);
    }
  }

  /** Back out of a mode, releasing the GPU if that mode was holding one. */
  function closeMode() {
    if (gpu !== "off") stopGpu();
    setMode(null);
    setUploadStage("idle");
    setResult(null);
    setVideoUrl(null);
    setGroundTruth(null);
    setShowGt(false);
  }

  function roomAge(startedAt: number): string {
    const secs = Math.max(0, Math.round(Date.now() / 1000 - startedAt));
    return secs < 60
      ? t("{n}s ago", { n: secs })
      : t("{n}m ago", { n: Math.round(secs / 60) });
  }

  /** The conflict dialog is clear (either nothing was found, or every row
   *  the operator stopped has actually gone) -- let the session everyone
   *  was already waiting on become ready. */
  function proceedPastConflicts() {
    setSessionConflicts(null);
    markActive();
    setGpu("ready");
  }

  /** Operator chose not to touch the other session(s) at all -- back out of
   *  the session this openMode() call just started, same as any other
   *  openMode failure. */
  async function cancelPastConflicts() {
    setSessionConflicts(null);
    await stopGpu();
    setMode(null);
  }

  /** Ends a room running in some OTHER tab/device -- see
   *  POST /api/sessions/{case_id}/stop. Ending a different operator's
   *  session needs a second confirm first (see confirmStopOther); ending
   *  one's own leftover tab does not. */
  async function stopOtherSession(room: ActiveRoom) {
    if (room.user && room.user !== user && confirmStopOther?.case_id !== room.case_id) {
      setConfirmStopOther(room);
      return;
    }
    setConfirmStopOther(null);
    setStoppingCaseId(room.case_id);
    try {
      await fetch(`${API}/api/sessions/${encodeURIComponent(room.case_id)}/stop`, {
        method: "POST", credentials: "include",
      });
    } catch {
      // Best-effort -- the poll below just keeps showing the row if this failed.
    }
    // The websocket loop only notices a stop request between frames (or
    // every STOP_POLL_INTERVAL_S while idle out-of-body), so this is not
    // instant -- poll briefly rather than assuming the single POST above
    // was enough.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await fetch(`${API}/api/sessions/active`, { credentials: "include" });
        if (res.ok) {
          const resData = await res.json();
          const stillThere = (resData.rooms ?? []).some((r: ActiveRoom) => r.case_id === room.case_id);
          if (!stillThere) break;
        }
      } catch { /* keep polling */ }
    }
    setStoppingCaseId(null);
    const next = (sessionConflicts ?? []).filter((r) => r.case_id !== room.case_id);
    if (next.length === 0) proceedPastConflicts();
    else setSessionConflicts(next);
  }

  async function handleUpload(file: File, gtUrl?: string) {
    setError(null);
    setGroundTruth(null);
    setShowGt(false);
    const localUrl = URL.createObjectURL(file);
    setVideoUrl(localUrl);
    setUploadStage("processing");

    const [inferRes, gtData] = await Promise.all([
      fetch(`${API}/api/infer-video`, {
        method: "POST",
        credentials: "include",
        body: (() => { const f = new FormData(); f.append("file", file); return f; })(),
      }),
      gtUrl ? fetch(gtUrl).then((r) => r.json()).catch(() => null) : Promise.resolve(null),
    ]);

    if (!inferRes.ok) {
      // 401 means the session expired mid-session; say so rather than blaming the backend.
      setError(inferRes.status === 401
        ? t("Your session expired. Sign in again to upload.")
        : t("Inference failed. Check backend logs."));
      setUploadStage("idle");
      return;
    }

    markActive();
    const data: InferResult = await inferRes.json();
    setResult(data);
    if (gtData) {
      setGroundTruth(gtData as GtData);
      setShowGt(true);
    }
    setUploadStage("done");
  }

  async function handleGtFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setGroundTruth(JSON.parse(text) as GtData);
    setShowGt(true);
    e.target.value = "";
  }

  function resetUpload() {
    setUploadStage("idle");
    setResult(null);
    setVideoUrl(null);
    setGroundTruth(null);
    setShowGt(false);
  }

  const backButton = (
    <button onClick={closeMode} className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
      {t("← Back")}
    </button>
  );

  // An upload mode opened by someone signed out shows the login form in place of
  // the mode itself. Nothing else on the page is gated.
  const blockedOnLogin = mode !== null && NEEDS_ACCOUNT.includes(mode) && !user && !authLoading;
  const warmingUp = mode !== null && NEEDS_GPU.includes(mode) && gpu !== "ready";

  const MODE_CARDS: { key: Mode; icon: string; title: string; blurb: string; hover: string }[] = [
    {
      key: "simulation", icon: "📼",
      title: "Saved Video",
      blurb: "Replay a clip through the live pipeline",
      hover: "hover:border-green-500 hover:bg-green-950/10",
    },
    {
      key: "camera", icon: "📹",
      title: "Live Camera",
      blurb: "Webcam, phone, or capture card",
      hover: "hover:border-purple-500 hover:bg-purple-950/10",
    },
    {
      key: "screen", icon: "🖥️",
      title: "Screen Share",
      blurb: "Share a window/screen instead of a device",
      hover: "hover:border-purple-500 hover:bg-purple-950/10",
    },
  ];

  return (
    // The player modes lay video and feedback out side by side, so they get the
    // full desktop width; the pickers/upload screens stay narrow and readable.
    <main className={`min-h-screen bg-gray-950 text-white mx-auto p-4 sm:p-8 ${
      mode && mode !== "upload" && mode !== "recordings" && !blockedOnLogin ? "max-w-[1700px]" : "max-w-4xl"
    }`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between mb-6 sm:mb-10">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold mb-1">{t("Polyp Detection AI")}</h1>
          <p className="text-gray-500 text-sm">
            {t("Real-time colonoscopy polyp detection · RT-DETR (TRUE-Colon) · fewest false alarms on our own archive")}
          </p>
        </div>
        <div className="flex gap-2 flex-shrink-0 flex-wrap justify-start sm:justify-end items-center">
          {user && (
            <span className="text-sm text-gray-500">
              {t("Signed in as {user}", { user })}
            </span>
          )}
          {reviewer && (
            <a
              href="/review"
              className="text-sm px-3 py-2 rounded-lg border border-emerald-500/60 bg-emerald-600/20 text-emerald-200 hover:bg-emerald-600/30 transition-colors"
            >
              {t("Clinical review")}
            </a>
          )}
          {!user && !authLoading && (
            <button
              onClick={() => goToLogin()}
              className="text-sm px-3 py-2 rounded-lg border border-blue-500/60 bg-blue-600/20 text-blue-200 hover:bg-blue-600/30 transition-colors"
            >
              {t("Sign in")}
            </button>
          )}
          {user && (
            <button
              onClick={logout}
              className="text-sm px-3 py-2 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors"
            >
              {t("Sign out")}
            </button>
          )}
          {/* Deliberately outside the account wall and in the header rather than
              down with the mode cards: the guides are part of what convinces
              someone to sign up, and they are wanted mid-task too. */}
          <a
            href="/tutorials"
            className="text-sm px-3 py-2 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors"
          >
            {t("📺 Tutorials")}
          </a>
          <a href="/" className="text-sm px-3 py-2 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors">
            {t("Home")}
          </a>
          <button
            onClick={toggleLang}
            className="text-sm px-3 py-2 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors"
          >
            {lang === "fa" ? "EN" : "فا"}
          </button>
        </div>
      </div>

      {/* Mode picker — the landing screen. No GPU is running at this point, and
          nothing here starts one; only the two live capture modes do. */}
      {mode === null && (
        <div className="space-y-4">
          {/* A reviewer came here for the panel, not for inference. Give it the
              top of the page, above the choices that are not their work. */}
          <ReviewCallout />

          {/* What the detector actually scores here, model by model. Sits on
              the landing screen because it is context for choosing a mode, not
              a detour from one. */}
          <ModelPerformance />

          {/* Engine picker. Only rendered when the server offers more than one,
              so a deployment with no CPU models looks exactly as it did. */}
          {engineOptions(backends, t).length > 1 && (
            <div className="space-y-2">
              <p className="text-sm text-gray-400">{t("Where should inference run?")}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {engineOptions(backends, t).map((o) => {
                  const selected = backend === o.id;
                  const warn = isCpuEngine(o.id) && o.note.includes("NOT");
                  return (
                    <button
                      key={o.id}
                      disabled={!o.usable}
                      onClick={() => setBackend(o.id)}
                      className={`text-left p-4 rounded-xl border-2 transition-colors ${
                        selected ? "border-blue-500 bg-blue-950/20" : "border-gray-700 hover:border-gray-500"
                      } ${o.usable ? "" : "opacity-40 cursor-not-allowed"}`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-lg">{o.icon}</span>
                        <span className="text-white font-medium text-sm">{o.title}</span>
                      </div>
                      <span className="text-gray-500 text-xs block">{o.detail}</span>
                      <span className={`text-xs block mt-0.5 ${warn ? "text-amber-500" : "text-gray-600"}`}>
                        {o.note}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <p className="text-sm text-gray-500">
            {t("Saved video, live camera and screen share all run the same pipeline — each starts a session when you open it.")}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
            {MODE_CARDS.map((card) => {
              const locked = NEEDS_ACCOUNT.includes(card.key) && !user;
              const startsGpu = NEEDS_GPU.includes(card.key);
              return (
                <button
                  key={card.key}
                  onClick={() => openMode(card.key)}
                  className={`flex flex-row sm:flex-col items-center gap-4 sm:gap-3 p-4 sm:p-8 rounded-xl border-2 border-gray-700 transition-colors text-start sm:text-center ${card.hover}`}
                >
                  <span className="text-3xl flex-shrink-0">{card.icon}</span>
                  {/* sm:contents dissolves this wrapper above the breakpoint, so
                      the desktop card is the column of four it always was. */}
                  <span className="flex flex-col gap-1 min-w-0 sm:contents">
                    <span className="text-white font-medium">{t(card.title)}</span>
                    <span className="text-gray-500 text-sm">{t(card.blurb)}</span>
                    {locked && (
                      <span className="text-xs text-gray-600">{t("🔒 Sign-in required")}</span>
                    )}
                    {startsGpu && (
                      <span className="text-xs text-gray-600">
                        {isCpuEngine(backend)
                          ? (usesLocalGpu(backends, backend)
                              ? t("⚡ Runs on this server's GPU")
                              : t("🖥️ Runs on this server's CPU"))
                          : t("⚡ Starts a GPU session")}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
            {/* Not a Mode -- this navigates to a real route (/spectator)
                instead of opening an inline mode, so it renders as a link
                rather than going through openMode(). Sits in the grid slot
                "Upload Video" used to occupy; that feature (mode === "upload",
                UploadPanel, /infer-video) is untouched, just no longer has a
                homepage entry point -- this replaced it, not deleted it. */}
            <a
              href="/spectator"
              className="flex flex-row sm:flex-col items-center gap-4 sm:gap-3 p-4 sm:p-8 rounded-xl border-2 border-gray-700 transition-colors text-start sm:text-center hover:border-amber-500 hover:bg-amber-950/10"
            >
              <span className="text-3xl flex-shrink-0">🔭</span>
              <span className="flex flex-col gap-1 min-w-0 sm:contents">
                <span className="text-white font-medium">{t("Spectator view")}</span>
                <span className="text-gray-500 text-sm">{t("Watch a live session from another computer")}</span>
                {!spectator && (
                  <span className="text-xs text-gray-600">{t("🔒 Sign-in required")}</span>
                )}
              </span>
            </a>
            {/* Write report -- the report-generation side app (/report, its
                own service on 19070), not a Mode. Open (no sign-in) during
                the ASR test phase. */}
            <a
              href="/report"
              className="flex flex-row sm:flex-col items-center gap-4 sm:gap-3 p-4 sm:p-8 rounded-xl border-2 border-gray-700 transition-colors text-start sm:text-center hover:border-amber-500 hover:bg-amber-950/10"
            >
              <span className="text-3xl flex-shrink-0">📝</span>
              <span className="flex flex-col gap-1 min-w-0 sm:contents">
                <span className="text-white font-medium">{t("Write report")}</span>
                <span className="text-gray-500 text-sm">{t("Dictate a colonoscopy or endoscopy report, section by section")}</span>
              </span>
            </a>
          </div>

          {/* Engineering tools. Signed-in only -- both routes bounce to
              /login, and a card that can only disappoint is worse than no
              card. A quiet row rather than cards: these are for us, not for
              the clinic's workflow. */}
          {user && (
            <div className="space-y-2">
              <span className="text-xs text-gray-600">{t("Tools")}</span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <a href="/clinic-test"
                   className="flex items-start gap-3 px-3 py-2.5 rounded-lg border border-gray-800
                              hover:border-gray-600 transition-colors group">
                  <span className="text-xl flex-shrink-0">🩺</span>
                  <span className="min-w-0">
                    <span className="block text-sm text-gray-300 group-hover:text-white">
                      {t("Measure this computer & capture card")}
                    </span>
                    <span className="block text-xs text-gray-600">
                      {t("Runs a 2-minute test and files the result. Needs the card plugged in.")}
                    </span>
                  </span>
                </a>
                <a href="/sim"
                   className="flex items-start gap-3 px-3 py-2.5 rounded-lg border border-gray-800
                              hover:border-gray-600 transition-colors group">
                  <span className="text-xl flex-shrink-0">🎛</span>
                  <span className="min-w-0">
                    <span className="block text-sm text-gray-300 group-hover:text-white">
                      {t("Tune picture & recording quality")}
                    </span>
                    <span className="block text-xs text-gray-600">
                      {t("Replays a saved video or the live card to compare settings side by side.")}
                    </span>
                  </span>
                </a>
              </div>
            </div>
          )}

          {/* Playback of sessions already recorded to this server. Deliberately
              its own row rather than a fifth card: it starts nothing and
              analyses nothing, it just opens the archive. */}
          <button
            onClick={() => openMode("recordings")}
            className="w-full flex items-center gap-4 p-5 rounded-xl border-2 border-gray-700 hover:border-gray-500 hover:bg-gray-900/40 transition-colors text-left"
          >
            <span className="text-2xl">🎞️</span>
            <span className="min-w-0">
              <span className="block text-white font-medium">{t("Saved recordings")}</span>
              <span className="block text-gray-500 text-sm">
                {t("Play back sessions recorded on this server")}
              </span>
            </span>
            {!user && <span className="ms-auto text-xs text-gray-600 flex-shrink-0">{t("🔒 Sign-in required")}</span>}
          </button>
        </div>
      )}

      {mode !== null && (
        <div className="space-y-3">
          {backButton}

          {blockedOnLogin && <SignInPrompt onOpenDemos={() => openMode("simulation")} />}

          {!blockedOnLogin && warmingUp && <WarmupPanel backend={backend} />}

          {!blockedOnLogin && !warmingUp && (
            <>
              {gpu === "ready" && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-green-400 text-sm">
                    <span className="w-2 h-2 rounded-full bg-green-400 inline-block animate-pulse" />
                    {isCpuEngine(backend)
                      ? (usesLocalGpu(backends, backend)
                          ? t("GPU ready · Model loaded · {cpu}", { cpu: backends?.cpu ?? t("this server's GPU") })
                          : t("CPU ready · Model loaded · {cpu}", { cpu: backends?.cpu ?? t("this server's CPU") }))
                      : t("GPU ready · Model loaded · T4 active")}
                  </div>
                  <button
                    onClick={closeMode}
                    className="text-sm text-red-400 hover:text-red-300 transition-colors"
                  >
                    {t("End Session")}
                  </button>
                </div>
              )}

              {/* The same player the capture card drives, fed from a file
                  instead. Deliberately not a second playback implementation:
                  an experiment run on a separate code path measures that path,
                  not the one that runs in clinic. */}
              {mode === "simulation" && (
                <LiveCameraPlayer caseId={caseId ?? "no-case"} onStop={closeMode} onActivity={markActive} initialMode="demo" backend={backend} inferWidth={selectedModel?.imgsz} initialConf={selectedModel?.conf} />
              )}

              {/* onCaseEnd is kiosk-only on purpose. The page there is never
                  reloaded, so without it a whole clinic day of patients would
                  be filed under the single case id minted on boot. An operator
                  working the page by hand already gets a fresh case each time
                  they open a mode, and rotating under them would silently
                  change the spectator link they had just shared. */}
              {mode === "camera" && (
                <LiveCameraPlayer caseId={caseId ?? "no-case"} onStop={closeMode} onActivity={markActive} backend={backend} inferWidth={selectedModel?.imgsz} initialConf={selectedModel?.conf} autoStart={kiosk} onCaseEnd={kiosk ? newCase : undefined} uplinkMbps={uplinkMbps} />
              )}

              {mode === "screen" && (
                <LiveCameraPlayer caseId={caseId ?? "no-case"} onStop={closeMode} onActivity={markActive} initialMode="screen" backend={backend} inferWidth={selectedModel?.imgsz} initialConf={selectedModel?.conf} uplinkMbps={uplinkMbps} />
              )}

              {mode === "recordings" && <RecordingsPanel title={t("All recordings on this server")} />}

              {mode === "upload" && uploadStage === "idle" && <UploadPanel onUpload={handleUpload} />}

              {mode === "upload" && uploadStage === "processing" && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-yellow-400 text-sm animate-pulse">
                    <span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" />
                    {t("Running inference on Modal...")}
                  </div>
                  {videoUrl && (
                    <video src={videoUrl} autoPlay loop muted
                      className="w-full rounded-xl border border-gray-800 bg-black opacity-40" />
                  )}
                </div>
              )}

              {mode === "upload" && uploadStage === "done" && videoUrl && result && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-green-400 text-sm">
                      <span className="w-2 h-2 rounded-full bg-green-400 inline-block" />
                      {t("Inference complete · {frames} frames · {fps} fps", { frames: result.frames.length, fps: result.fps.toFixed(0) })}
                    </div>
                    <button
                      onClick={resetUpload}
                      className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
                    >
                      {t("Try another video")}
                    </button>
                  </div>

                  <VideoPlayer
                    src={videoUrl}
                    detections={result.frames}
                    fps={result.fps}
                    width={result.width}
                    height={result.height}
                    groundTruth={showGt ? groundTruth?.frames : undefined}
                  />

                  {/* Ground truth panel */}
                  <div className={`rounded-xl border px-4 py-3 flex items-center justify-between transition-colors ${
                    groundTruth && showGt ? "border-cyan-800 bg-cyan-950/20" : "border-gray-700 bg-gray-900/50"
                  }`}>
                    {groundTruth ? (
                      <>
                        <div className="flex items-center gap-3">
                          <span className="inline-block w-3 h-3 rounded-sm flex-shrink-0" style={{ background: "#22d3ee" }} />
                          <span className="text-sm text-gray-300">{t("Ground Truth Labels")}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => setShowGt((v) => !v)}
                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                              showGt ? "bg-cyan-600" : "bg-gray-600"
                            }`}
                            role="switch"
                            aria-checked={showGt}
                          >
                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                              showGt ? "translate-x-6" : "translate-x-1"
                            }`} />
                          </button>
                          <button
                            onClick={() => { setGroundTruth(null); setShowGt(false); }}
                            className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
                          >
                            {t("Remove")}
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <span className="text-sm text-gray-400">{t("Want to compare with ground truth?")}</span>
                        <button
                          onClick={() => gtInputRef.current?.click()}
                          className="text-sm px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-white transition-colors"
                        >
                          {t("Load GT JSON")}
                        </button>
                      </>
                    )}
                  </div>
                  <input ref={gtInputRef} type="file" accept=".json" className="hidden" onChange={handleGtFile} />

                  <button
                    onClick={resetUpload}
                    className="w-full py-3 bg-gray-800 hover:bg-gray-700 rounded-xl text-white font-medium transition-colors"
                  >
                    {t("Upload another video")}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {error && (
        <div className="mt-4 bg-red-950 border border-red-800 rounded-lg px-4 py-3 text-red-300 text-sm font-mono">
          {error}
        </div>
      )}

      {sessionConflicts && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 p-5 space-y-3">
            <h3 className="text-base font-semibold text-white">
              {t("Already open somewhere else")}
            </h3>
            <p className="text-sm text-gray-300">
              {t("This case is already being scanned from another tab, device, or the clinic PC. Starting a second one means two detectors sharing the same uplink.")}
            </p>
            <div className="space-y-2">
              {sessionConflicts.map((room) => (
                <div key={room.case_id} className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 space-y-1">
                  <p className="text-sm text-white">
                    {room.user ? t("Opened by {user}", { user: room.user }) : t("Opened by an unknown operator")}
                  </p>
                  <p className="text-xs text-gray-400">
                    {t("{age} \u00b7 {engine}", { age: roomAge(room.started_at), engine: room.engine })}
                  </p>
                  {confirmStopOther?.case_id === room.case_id ? (
                    <div className="pt-1 space-y-2">
                      <p className="text-xs text-amber-400">
                        {t("This will end {user}'s live procedure right now. Are you sure?", { user: room.user ?? "" })}
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => void stopOtherSession(room)}
                          className="flex-1 px-3 py-1.5 bg-red-700 hover:bg-red-600 rounded-lg text-white text-xs font-medium transition-colors"
                        >
                          {t("Yes, stop it")}
                        </button>
                        <button
                          onClick={() => setConfirmStopOther(null)}
                          className="flex-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-white text-xs font-medium transition-colors"
                        >
                          {t("Cancel")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => void stopOtherSession(room)}
                      disabled={stoppingCaseId === room.case_id}
                      className="mt-1 w-full px-3 py-1.5 bg-red-700 hover:bg-red-600 disabled:opacity-60 rounded-lg text-white text-xs font-medium transition-colors"
                    >
                      {stoppingCaseId === room.case_id ? t("Stopping\u2026") : t("Stop this session")}
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={proceedPastConflicts}
                className="flex-1 px-3 py-2 bg-sky-600 hover:bg-sky-500 rounded-lg text-white text-sm font-medium transition-colors"
              >
                {t("Continue anyway")}
              </button>
              <button
                onClick={() => void cancelPastConflicts()}
                className="flex-1 px-3 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-white text-sm font-medium transition-colors"
              >
                {t("Cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
