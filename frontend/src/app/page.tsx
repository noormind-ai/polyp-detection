"use client";

import { useEffect, useRef, useState } from "react";
import UploadPanel from "@/components/UploadPanel";
import WarmupPanel from "@/components/WarmupPanel";
import VideoPlayer from "@/components/VideoPlayer";
import RealtimePlayer from "@/components/RealtimePlayer";
import LiveCameraPlayer from "@/components/LiveCameraPlayer";
import { useLanguage } from "@/lib/i18n";

type Stage = "idle" | "warming" | "ready" | "processing" | "done";

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
// Must match scaledown_window in inference/app.py — Modal releases the GPU container
// this long after its last request, so we bounce back to "Start Session" at the same
// point instead of letting the user hit a surprise cold-start delay. Applies to the
// Modal backend only; a local GPU is always on and never released.
const MODAL_IDLE_MS = 5 * 60 * 1000;

type BackendName = "local" | "modal";

interface BackendInfo {
  default: BackendName;
  available: Record<BackendName, boolean>;
  gpu: string | null;
}

const BACKEND_ORDER: BackendName[] = ["local", "modal"];

export default function Home() {
  const { t, lang, toggleLang } = useLanguage();
  const [stage, setStage] = useState<Stage>("idle");
  const [mode, setMode] = useState<"upload" | "realtime" | "camera" | "screen" | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [result, setResult] = useState<InferResult | null>(null);
  const [groundTruth, setGroundTruth] = useState<GtData | null>(null);
  const [showGt, setShowGt] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [caseId, setCaseId] = useState<string | null>(null);
  const [backends, setBackends] = useState<BackendInfo | null>(null);
  const [backend, setBackend] = useState<BackendName>("modal");
  const gtInputRef = useRef<HTMLInputElement>(null);
  const lastActiveRef = useRef<number>(Date.now());

  function markActive() { lastActiveRef.current = Date.now(); }

  // Ask the backend what it can actually serve. A box with no GPU shouldn't offer
  // "local", and one with no Modal credentials shouldn't offer "modal" — the
  // choice is only shown when there is a real choice to make.
  useEffect(() => {
    fetch(`${API}/api/backends`)
      .then((r) => r.json())
      .then((d: BackendInfo) => {
        setBackends(d);
        const usable = BACKEND_ORDER.filter((b) => d.available?.[b]);
        setBackend(usable.includes(d.default) ? d.default : usable[0] ?? d.default);
      })
      .catch(() => {});
  }, []);

  // While a session is active, watch for the GPU having gone idle long enough that
  // Modal already released the container — return to the start screen so the UI
  // reflects reality instead of letting the next request eat a cold-start delay.
  useEffect(() => {
    if (stage !== "ready" && stage !== "processing") return;
    // Only Modal releases its GPU. The local card stays loaded, so timing the user
    // out would be an invented limitation.
    if (backend !== "modal") return;
    const interval = setInterval(() => {
      if (Date.now() - lastActiveRef.current > MODAL_IDLE_MS) {
        fetch(`${API}/api/session/stop`, { method: "POST" }).catch(() => {});
        setStage("idle");
        setMode(null);
        setResult(null);
        setVideoUrl(null);
        setGroundTruth(null);
        setShowGt(false);
        setError(t("Session timed out after 5 minutes idle — the GPU was released to save cost. Click Start Session to reconnect."));
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [stage, t, backend]);

  async function handleStop() {
    setStopping(true);
    try {
      await fetch(`${API}/api/session/stop`, { method: "POST" });
    } finally {
      setStopping(false);
      setStage("idle");
      setResult(null);
      setVideoUrl(null);
      setError(null);
      setGroundTruth(null);
      setShowGt(false);
    }
  }

  async function handleStart() {
    setStage("warming");
    setError(null);
    try {
      const res = await fetch(`${API}/api/session/start?backend=${backend}`, { method: "POST" });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(t("Backend error {status}: {text}", { status: res.status, text }));
      }
      const data = await res.json();
      setCaseId(data.case_id ?? null);
      markActive();
      setStage("ready");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("fetch") || msg.includes("Failed to fetch")) {
        setError(t("Cannot reach backend at {API}. Is uvicorn running?", { API }));
      } else {
        setError(msg);
      }
      setStage("idle");
    }
  }

  async function handleUpload(file: File, gtUrl?: string) {
    setError(null);
    setGroundTruth(null);
    setShowGt(false);
    const localUrl = URL.createObjectURL(file);
    setVideoUrl(localUrl);
    setStage("processing");

    const [inferRes, gtData] = await Promise.all([
      fetch(`${API}/api/infer-video`, { method: "POST", body: (() => { const f = new FormData(); f.append("file", file); return f; })() }),
      gtUrl ? fetch(gtUrl).then((r) => r.json()).catch(() => null) : Promise.resolve(null),
    ]);

    if (!inferRes.ok) {
      setError(t("Inference failed. Check backend logs."));
      setStage("ready");
      return;
    }

    markActive();
    const data: InferResult = await inferRes.json();
    setResult(data);
    if (gtData) {
      setGroundTruth(gtData as GtData);
      setShowGt(true);
    }
    setStage("done");
  }

  async function handleGtFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setGroundTruth(JSON.parse(text) as GtData);
    setShowGt(true);
    e.target.value = "";
  }

  function resetToUpload() {
    setStage("ready");
    setMode(null);
    setResult(null);
    setVideoUrl(null);
    setGroundTruth(null);
    setShowGt(false);
  }

  return (
    // The player modes lay video and feedback out side by side, so they get the
    // full desktop width; the pickers/upload screens stay narrow and readable.
    <main className={`min-h-screen bg-gray-950 text-white mx-auto p-8 ${
      mode && mode !== "upload" ? "max-w-[1700px]" : "max-w-4xl"
    }`}>
      <div className="flex items-start justify-between mb-10">
        <div>
          <h1 className="text-2xl font-semibold mb-1">{t("Polyp Detection AI")}</h1>
          <p className="text-gray-500 text-sm">
            {t("Real-time colonoscopy polyp detection · YOLOv5 · Kvasir-SEG · mAP50 0.93")}
          </p>
        </div>
        <div className="flex gap-2 flex-shrink-0 flex-wrap justify-end">
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

      {stage === "idle" && (
        <div className="flex flex-col items-center justify-center py-20 gap-6">
          {/* Both options are always shown so the choice is visible; one that this
              deployment can't serve is disabled with the reason, rather than hidden. */}
          {backends && (
            <div className="w-full max-w-xl space-y-2">
              <p className="text-sm text-gray-400 text-center">{t("Where should inference run?")}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {BACKEND_ORDER.map((b) => {
                  const usable = backends.available?.[b];
                  const selected = backend === b;
                  return (
                    <button
                      key={b}
                      disabled={!usable}
                      onClick={() => setBackend(b)}
                      className={`text-left p-4 rounded-xl border-2 transition-colors ${
                        selected
                          ? "border-blue-500 bg-blue-950/20"
                          : "border-gray-700 hover:border-gray-500"
                      } ${usable ? "" : "opacity-40 cursor-not-allowed"}`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-lg">{b === "local" ? "⚡" : "☁️"}</span>
                        <span className="text-white font-medium text-sm">
                          {b === "local" ? t("This server's GPU") : t("Modal A100 (cloud)")}
                        </span>
                      </div>
                      <span className="text-gray-500 text-xs block">
                        {b === "local"
                          ? backends.gpu ?? t("Local NVIDIA GPU")
                          : t("Serverless · released after 5 min idle")}
                      </span>
                      <span className="text-gray-600 text-xs block mt-0.5">
                        {!usable
                          ? t("Not configured on this server")
                          : b === "local"
                          ? t("Always on · no network hop")
                          : t("~250ms per frame from here")}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <p className="text-gray-400 text-center max-w-sm">
            {backend === "local"
              ? t("Runs on this server's own GPU. The model loads once, on first start.")
              : t("Starts a GPU session on Modal. First start takes ~60 seconds to load the model.")}
          </p>
          <button
            onClick={handleStart}
            className="px-8 py-3 bg-blue-600 hover:bg-blue-500 rounded-xl text-white font-medium text-lg transition-colors"
          >
            {t("Start Session")}
          </button>
        </div>
      )}

      {stage === "warming" && <WarmupPanel />}

      {stage === "ready" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-green-400 text-sm">
              <span className="w-2 h-2 rounded-full bg-green-400 inline-block animate-pulse" />
              {backend === "local"
                ? t("GPU ready · Model loaded · {gpu}", { gpu: backends?.gpu ?? t("local GPU") })
                : t("GPU ready · Model loaded · A100 active")}
            </div>
            <button
              onClick={handleStop}
              disabled={stopping}
              className="text-sm text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
            >
              {stopping ? t("Ending...") : t("End Session")}
            </button>
          </div>

          {mode === null && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4">
              <button
                onClick={() => setMode("upload")}
                className="flex flex-col items-center gap-3 p-8 rounded-xl border-2 border-gray-700 hover:border-blue-500 hover:bg-blue-950/10 transition-colors text-center"
              >
                <span className="text-3xl">🎬</span>
                <span className="text-white font-medium">{t("Upload Video")}</span>
                <span className="text-gray-500 text-sm">{t("Analyse a recorded colonoscopy clip")}</span>
              </button>
              <button
                onClick={() => setMode("realtime")}
                className="flex flex-col items-center gap-3 p-8 rounded-xl border-2 border-gray-700 hover:border-green-500 hover:bg-green-950/10 transition-colors text-center"
              >
                <span className="text-3xl">📷</span>
                <span className="text-white font-medium">{t("Real-time")}</span>
                <span className="text-gray-500 text-sm">{t("Frame-by-frame · ~600ms/frame")}</span>
              </button>
              <button
                onClick={() => setMode("camera")}
                className="flex flex-col items-center gap-3 p-8 rounded-xl border-2 border-gray-700 hover:border-purple-500 hover:bg-purple-950/10 transition-colors text-center"
              >
                <span className="text-3xl">📹</span>
                <span className="text-white font-medium">{t("Live Camera")}</span>
                <span className="text-gray-500 text-sm">{t("Webcam, phone, or capture card")}</span>
              </button>
              <button
                onClick={() => setMode("screen")}
                className="flex flex-col items-center gap-3 p-8 rounded-xl border-2 border-gray-700 hover:border-purple-500 hover:bg-purple-950/10 transition-colors text-center"
              >
                <span className="text-3xl">🖥️</span>
                <span className="text-white font-medium">{t("Screen Share")}</span>
                <span className="text-gray-500 text-sm">{t("Share a window/screen instead of a device")}</span>
              </button>
            </div>
          )}

          {mode === "upload" && (
            <div className="space-y-3">
              <button onClick={() => setMode(null)} className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
                {t("← Back")}
              </button>
              <UploadPanel onUpload={handleUpload} />
            </div>
          )}

          {mode === "realtime" && (
            <div className="space-y-3">
              <button onClick={() => setMode(null)} className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
                {t("← Back")}
              </button>
              <RealtimePlayer caseId={caseId ?? "no-case"} onStop={() => setMode(null)} onActivity={markActive} backend={backend} />
            </div>
          )}

          {mode === "camera" && (
            <div className="space-y-3">
              <button onClick={() => setMode(null)} className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
                {t("← Back")}
              </button>
              <LiveCameraPlayer onStop={() => setMode(null)} onActivity={markActive} backend={backend} />
            </div>
          )}

          {mode === "screen" && (
            <div className="space-y-3">
              <button onClick={() => setMode(null)} className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
                {t("← Back")}
              </button>
              <LiveCameraPlayer onStop={() => setMode(null)} onActivity={markActive} initialMode="screen" backend={backend} />
            </div>
          )}
        </div>
      )}

      {stage === "processing" && (
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

      {stage === "done" && videoUrl && result && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-green-400 text-sm">
              <span className="w-2 h-2 rounded-full bg-green-400 inline-block" />
              {t("Inference complete · {frames} frames · {fps} fps", { frames: result.frames.length, fps: result.fps.toFixed(0) })}
            </div>
            <div className="flex gap-4">
              <button
                onClick={resetToUpload}
                className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
              >
                {t("Try another video")}
              </button>
              <button
                onClick={handleStop}
                disabled={stopping}
                className="text-sm text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
              >
                {stopping ? t("Ending...") : t("End Session")}
              </button>
            </div>
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
            onClick={resetToUpload}
            className="w-full py-3 bg-gray-800 hover:bg-gray-700 rounded-xl text-white font-medium transition-colors"
          >
            {t("Upload another video")}
          </button>
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
