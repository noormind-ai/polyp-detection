"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import UploadPanel from "@/components/UploadPanel";
import WarmupPanel from "@/components/WarmupPanel";
import VideoPlayer from "@/components/VideoPlayer";
import RealtimePlayer from "@/components/RealtimePlayer";
import LiveCameraPlayer from "@/components/LiveCameraPlayer";
import LoginPanel from "@/components/LoginPanel";
import { useAuth } from "@/lib/auth";
import { useLanguage } from "@/lib/i18n";

/** Where the whole-file upload flow is in its own little lifecycle. */
type UploadStage = "idle" | "processing" | "done";
/** Modal GPU container state. Only the live capture modes ever move this. */
type GpuState = "off" | "starting" | "ready";
type Mode = "upload" | "realtime" | "camera" | "screen";

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

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8001";
// MUST match scaledown_window in inference/app.py (120s). Modal releases the GPU
// container that long after its last request; we drop out of the live modes at the
// same moment so the UI never claims a GPU that is already gone. Waiting longer
// than the container lives would leave the next frame eating a cold start with a
// green "GPU ready" indicator above it.
//
// This cannot fire mid-procedure: the capture loop calls onActivity on every
// response, so the timer only counts down once streaming has actually stopped.
const MODAL_IDLE_MS = 2 * 60 * 1000;

/** The modes that spend GPU on a video the user supplied, and so need an account. */
const NEEDS_ACCOUNT: Mode[] = ["upload"];
/** The modes that need a warm GPU container before they can do anything. */
const NEEDS_GPU: Mode[] = ["camera", "screen"];

export default function Home() {
  const { t, lang, toggleLang } = useLanguage();
  const { user, loading: authLoading, logout } = useAuth();

  const [mode, setMode] = useState<Mode | null>(null);
  const [gpu, setGpu] = useState<GpuState>("off");
  const [uploadStage, setUploadStage] = useState<UploadStage>("idle");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [result, setResult] = useState<InferResult | null>(null);
  const [groundTruth, setGroundTruth] = useState<GtData | null>(null);
  const [showGt, setShowGt] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [caseId, setCaseId] = useState<string | null>(null);
  const gtInputRef = useRef<HTMLInputElement>(null);
  const lastActiveRef = useRef<number>(Date.now());

  const markActive = useCallback(() => { lastActiveRef.current = Date.now(); }, []);

  // A case ID for filing feedback captures under. Deliberately its own endpoint
  // rather than session/start: every mode files feedback, including the
  // precomputed demos, and those must never wake a GPU.
  useEffect(() => {
    fetch(`${API}/api/case/new`, { method: "POST", credentials: "include" })
      .then((r) => r.json())
      .then((d) => setCaseId(d.case_id ?? null))
      .catch(() => { /* feedback capture degrades on its own if this fails */ });
  }, []);

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
    const interval = setInterval(() => {
      if (Date.now() - lastActiveRef.current > MODAL_IDLE_MS) {
        stopGpu();
        setMode(null);
        setError(t("Session timed out after 2 minutes idle — the GPU was released to save cost. Open live camera or screen share again to reconnect."));
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [gpu, stopGpu, t]);

  /** Live capture modes boot the container first and show the warm-up log while it comes up. */
  async function openMode(next: Mode) {
    setError(null);
    setMode(next);
    if (!NEEDS_GPU.includes(next)) return;

    setGpu("starting");
    try {
      const res = await fetch(`${API}/api/session/start`, { method: "POST", credentials: "include" });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(t("Backend error {status}: {text}", { status: res.status, text }));
      }
      const data = await res.json();
      if (data.case_id) setCaseId(data.case_id);
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
      key: "realtime", icon: "📷",
      title: "Real-time",
      blurb: "Frame-by-frame on a demo or your own clip",
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
    {
      key: "upload", icon: "🎬",
      title: "Upload Video",
      blurb: "Analyse a recorded colonoscopy clip",
      hover: "hover:border-blue-500 hover:bg-blue-950/10",
    },
  ];

  return (
    // The player modes lay video and feedback out side by side, so they get the
    // full desktop width; the pickers/upload screens stay narrow and readable.
    <main className={`min-h-screen bg-gray-950 text-white mx-auto p-8 ${
      mode && mode !== "upload" && !blockedOnLogin ? "max-w-[1700px]" : "max-w-4xl"
    }`}>
      <div className="flex items-start justify-between mb-10">
        <div>
          <h1 className="text-2xl font-semibold mb-1">{t("Polyp Detection AI")}</h1>
          <p className="text-gray-500 text-sm">
            {t("Real-time colonoscopy polyp detection · YOLOv5 · Kvasir-SEG · mAP50 0.93")}
          </p>
        </div>
        <div className="flex gap-2 flex-shrink-0 flex-wrap justify-end items-center">
          {user && (
            <span className="text-sm text-gray-500">
              {t("Signed in as {user}", { user })}
            </span>
          )}
          {user && (
            <button
              onClick={logout}
              className="text-sm px-3 py-2 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors"
            >
              {t("Sign out")}
            </button>
          )}
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
          <p className="text-sm text-gray-500">
            {t("Demo clips replay saved results instantly. Live camera and screen share start a GPU when you open them.")}
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {MODE_CARDS.map((card) => {
              const locked = NEEDS_ACCOUNT.includes(card.key) && !user;
              const startsGpu = NEEDS_GPU.includes(card.key);
              return (
                <button
                  key={card.key}
                  onClick={() => openMode(card.key)}
                  className={`flex flex-col items-center gap-3 p-8 rounded-xl border-2 border-gray-700 transition-colors text-center ${card.hover}`}
                >
                  <span className="text-3xl">{card.icon}</span>
                  <span className="text-white font-medium">{t(card.title)}</span>
                  <span className="text-gray-500 text-sm">{t(card.blurb)}</span>
                  {locked && (
                    <span className="text-xs text-gray-600">{t("🔒 Sign-in required")}</span>
                  )}
                  {startsGpu && (
                    <span className="text-xs text-gray-600">{t("⚡ Starts a GPU session")}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {mode !== null && (
        <div className="space-y-3">
          {backButton}

          {blockedOnLogin && <LoginPanel onOpenDemos={() => openMode("realtime")} />}

          {!blockedOnLogin && warmingUp && <WarmupPanel />}

          {!blockedOnLogin && !warmingUp && (
            <>
              {gpu === "ready" && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-green-400 text-sm">
                    <span className="w-2 h-2 rounded-full bg-green-400 inline-block animate-pulse" />
                    {t("GPU ready · Model loaded · A100 active")}
                  </div>
                  <button
                    onClick={closeMode}
                    className="text-sm text-red-400 hover:text-red-300 transition-colors"
                  >
                    {t("End Session")}
                  </button>
                </div>
              )}

              {mode === "realtime" && (
                <RealtimePlayer caseId={caseId ?? "no-case"} onStop={closeMode} onActivity={markActive} />
              )}

              {mode === "camera" && (
                <LiveCameraPlayer caseId={caseId ?? "no-case"} onStop={closeMode} onActivity={markActive} />
              )}

              {mode === "screen" && (
                <LiveCameraPlayer caseId={caseId ?? "no-case"} onStop={closeMode} onActivity={markActive} initialMode="screen" />
              )}

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
    </main>
  );
}
