"use client";

/**
 * /sim — capture-card simulator and enhancement testbed.
 *
 * A local video file is played as if it were the capture card, through the
 * same stages the live page uses, with every stage visible side by side:
 *
 *   Raw              what the file actually contains
 *   After encoder    the same picture through MediaRecorder at a chosen
 *                    bitrate — i.e. what a SAVED recording would look like
 *   Enhanced         deinterlace choice + denoise + sharpen (the display
 *                    chain being prototyped before it reaches the clinic)
 *   AI               what the model is sent, with its boxes and timings
 *
 * Everything is measured rather than asserted: per-stage client ms, encoder
 * output kbps vs requested, and the usual round-trip split.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createDeinterlacer, combRatio, looksInterlaced } from "@/lib/interlace";
import { negotiateCameraMode, describeMode } from "@/lib/cameraMode";
import { measureNetwork } from "@/lib/clinicDiagnostic";
import { readProcAmpCaps, readProcAmpValues, measureLevels, autoTuneProcAmp } from "@/lib/procAmp";
import { createEnhancer, type EnhanceCost } from "@/lib/enhance";
import { createGLEnhancer, type GLEnhancer } from "@/lib/enhanceGL";
import { createGLDeinterlacer, DEINT_MODES, type GLDeinterlacer, type DeintMode } from "@/lib/deinterlaceGL";
import { EncoderPreview, type EncoderPreviewState, type EncoderStats } from "@/lib/encoderPreview";
import { drawBoxes, type Box } from "@/lib/drawBoxes";

const API = process.env.NEXT_PUBLIC_API_URL || "";
const API_WS = (API || (typeof window !== "undefined" ? window.location.origin : "")).replace(/^http/, "ws");
const INFER_WIDTH = 320;
const INFER_TIMEOUT_MS = 6000;

/** The subset of the recordings API this page needs. Same endpoint and same
 *  filtering rules as the live page's saved-video picker. */
interface ServerRecording {
  id: string;
  case_id: string;
  source: "camera" | "screen" | "joined" | "replay";
  width: number;
  height: number;
  started_at: number;
  duration_ms: number;
  status: string;
  bytes?: number;
  joined_from?: string[];
}

const MIN_CLIP_BYTES = 200_000;

function clipLabel(r: ServerRecording): string {
  const mins = Math.round(r.duration_ms / 60000);
  const when = new Date(r.started_at * 1000).toLocaleString();
  return `${when} · ${mins || "<1"} min · ${r.width}×${r.height}${r.source === "joined" ? " · joined" : ""}`;
}

type InferSource = "raw" | "enhanced";

const panelBox = "relative w-full bg-black rounded-lg overflow-hidden border border-gray-800";
const toggleBtn = "text-xs px-2 py-0.5 rounded-md border border-gray-800 text-gray-500 hover:text-gray-300 hover:border-gray-600 transition-colors";

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[s.length >> 1] * 100) / 100;
}

export default function CaptureSimulator() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rawRef = useRef<HTMLCanvasElement | null>(null);
  const enhRef = useRef<HTMLCanvasElement | null>(null);
  const aiRef = useRef<HTMLCanvasElement | null>(null);
  const encVideoRef = useRef<HTMLVideoElement | null>(null);

  // A file is reproducible; the card is the truth. Both feed the same
  // <video>, so every panel and measurement below is source-agnostic.
  const [sourceKind, setSourceKind] = useState<"file" | "saved" | "camera">("file");
  const [recordings, setRecordings] = useState<ServerRecording[]>([]);
  const [recordingId, setRecordingId] = useState("");
  const [recordingsNote, setRecordingsNote] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [cameraNote, setCameraNote] = useState("");
  const streamRef = useRef<MediaStream | null>(null);
  const [procAmpCaps, setProcAmpCaps] = useState<Record<string, { min: number; max: number; step?: number }> | null>(null);
  const [procAmp, setProcAmp] = useState<Record<string, number>>({});
  const [tuning, setTuning] = useState("");
  const [levels, setLevels] = useState<{ black: number; clip: number; mean: number } | null>(null);
  const [net, setNet] = useState<{ rtt: number; mbps: number } | null>(null);
  const [netBusy, setNetBusy] = useState(false);
  const [fileName, setFileName] = useState("");
  const [srcInfo, setSrcInfo] = useState({ w: 0, h: 0, fps: 0, interlaced: null as boolean | null, comb: 0 });

  const [mbps, setMbps] = useState(8);
  const [encState, setEncState] = useState<EncoderPreviewState>({ kind: "starting" });
  const [encStats, setEncStats] = useState<EncoderStats>({ bytes: 0, kbps: 0 });
  const [segmentMode, setSegmentMode] = useState(true);

  const [deintMode, setDeintMode] = useState<DeintMode>("adaptive");
  const [slowNote, setSlowNote] = useState("");
  const [denoise, setDenoise] = useState(0);
  const [sharpen, setSharpen] = useState(0);
  const [aspect43, setAspect43] = useState(false);
  const [cost, setCost] = useState<EnhanceCost & { deintMs: number }>({ denoiseMs: 0, sharpenMs: 0, deintMs: 0 });

  const [inferOn, setInferOn] = useState(false);
  const [inferSource, setInferSource] = useState<InferSource>("raw");
  const [stats, setStats] = useState({ sent: 0, received: 0, avgMs: 0, rttMs: 0, netMs: 0, fps: 0 });
  const [clientMs, setClientMs] = useState({ downscale: 0, jpeg: 0 });
  const [wsError, setWsError] = useState("");

  // Refs mirror the controls: the paint loop's closure is captured once.
  const deintModeRef = useRef(deintMode);
  const denoiseRef = useRef(denoise);
  const sharpenRef = useRef(sharpen);
  const inferOnRef = useRef(inferOn);
  const inferSourceRef = useRef(inferSource);
  useEffect(() => { deintModeRef.current = deintMode; }, [deintMode]);
  useEffect(() => { denoiseRef.current = denoise; }, [denoise]);
  useEffect(() => { sharpenRef.current = sharpen; }, [sharpen]);
  useEffect(() => { inferOnRef.current = inferOn; }, [inferOn]);
  useEffect(() => { inferSourceRef.current = inferSource; }, [inferSource]);

  const deintRef = useRef(createDeinterlacer());
  const enhancerRef = useRef(createEnhancer());          // CPU fallback
  const glRef = useRef<GLEnhancer | null>(null);
  const glTriedRef = useRef(false);
  const glDeintRef = useRef<GLDeinterlacer | null>(null);
  const glDeintTriedRef = useRef(false);
  // Rolling cost of the whole display chain. A machine that cannot afford it
  // should not be left discovering that as stutter during a procedure.
  const costSamplesRef = useRef<number[]>([]);
  const [gpu, setGpu] = useState<boolean | null>(null);
  const previewRef = useRef<EncoderPreview | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const inflightRef = useRef<{ sentAt: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const rttsRef = useRef<number[]>([]);
  const avgsRef = useRef<number[]>([]);
  const arrivalsRef = useRef<number[]>([]);
  const lastArrivalRef = useRef(0);
  const downMsRef = useRef<number[]>([]);
  const jpegMsRef = useRef<number[]>([]);
  const sentRef = useRef(0);
  const recvRef = useRef(0);
  const objUrlRef = useRef<string | null>(null);

  async function loadRecordings() {
    setRecordingsNote("Loading…");
    try {
      const res = await fetch(`${API}/api/recordings`, { credentials: "include" });
      if (!res.ok) throw new Error(`list failed (${res.status})`);
      const all: ServerRecording[] = await res.json();
      // Same rules as the live page's picker: a stitched recording stands in
      // for its fragments, and a replay is a copy of something already here.
      const stitched = new Set(all.flatMap((r) => r.joined_from ?? []));
      // Same usability gate as the live picker -- real footage regardless of
      // how the recording ended. See the comment in LiveCameraPlayer.tsx.
      const usable = all.filter((r) => r.status !== "recording" && r.duration_ms > 0
                                       && (r.bytes ?? 0) >= MIN_CLIP_BYTES
                                       && r.source !== "replay" && !stitched.has(r.id));
      setRecordings(usable);
      setRecordingsNote(usable.length ? "" : "No saved recordings on this server yet.");
      if (usable.length && !recordingId) setRecordingId(`${usable[0].case_id}/${usable[0].id}`);
    } catch (e) {
      setRecordingsNote(`Could not load recordings: ${e instanceof Error ? e.message : e}`);
    }
  }

  function playRecording(key: string) {
    const [caseId, id] = key.split("/");
    const rec = recordings.find((r) => r.case_id === caseId && r.id === id);
    if (!rec) return;
    releaseStream();
    const v = videoRef.current!;
    v.srcObject = null;
    if (objUrlRef.current) { URL.revokeObjectURL(objUrlRef.current); objUrlRef.current = null; }
    // Same-origin and cookie-authenticated, so the canvas stays readable --
    // a tainted canvas would silently break every measurement on this page.
    v.src = `${API}/api/recordings/${caseId}/${id}/video`;
    v.loop = true;
    v.muted = true;
    deintRef.current.reset();
    enhancerRef.current.reset();
    glRef.current?.reset();
    setFileName(clipLabel(rec));
    void v.play().catch(() => { /* the operator can press play */ });
  }

  function releaseStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  async function listDevices() {
    setCameraNote("");
    try {
      const warm = await navigator.mediaDevices.getUserMedia({ video: true });
      warm.getTracks().forEach((t) => t.stop());
      const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      setDevices(all);
      if (all.length && !deviceId) setDeviceId(all[0].deviceId);
    } catch (e) {
      setCameraNote(`Camera access failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function startCamera(id: string) {
    releaseStream();
    setCameraNote("Choosing the card's native mode…");
    const v = videoRef.current!;
    try {
      // Same negotiation the live page uses -- asking plainly for a capture
      // card gets the padded PAL mode and its green band (see cameraMode.ts).
      const negotiated = await negotiateCameraMode(id, {
        onProgress: (step, i, total) => setCameraNote(`${step} (${i}/${total})`),
      });
      const stream = negotiated.stream ?? await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: id } },
      });
      streamRef.current = stream;
      v.srcObject = stream;
      v.loop = false;
      v.muted = true;
      deintRef.current.reset();
      enhancerRef.current.reset();
      glRef.current?.reset();
      await v.play().catch(() => { /* muted autoplay should pass */ });
      setCameraNote(describeMode(negotiated.settings, negotiated.padFraction));
      // Does this driver let us reach the card's front end? Asked, not assumed
      // -- it differs per device, per driver, and per browser.
      const track = stream.getVideoTracks()[0];
      const caps = readProcAmpCaps(track);
      setProcAmpCaps(caps);
      if (caps) setProcAmp(readProcAmpValues(track, caps));
      setFileName(devices.find((d) => d.deviceId === id)?.label || "capture device");
      // Tune the card's levels straight away rather than leaving a new user
      // to discover that the defaults are wrong. Announced, and every slider
      // stays free afterwards.
      setTimeout(() => { void autoTuneLevels(); }, 800);
    } catch (e) {
      setCameraNote(`Could not open the device: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function applyProcAmp(k: string, v: number) {
    setProcAmp((p) => ({ ...p, [k]: v }));
    const track = streamRef.current?.getVideoTracks()[0];
    try {
      await track?.applyConstraints({ advanced: [{ [k]: v }] } as MediaTrackConstraints);
    } catch (e) {
      setTuning(`${k} rejected by the driver: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function autoTuneLevels() {
    if (!procAmpCaps) return;
    await autoTuneProcAmp({
      caps: procAmpCaps,
      values: { ...procAmp },
      measure: () => measureLevels(rawRef.current),
      apply: applyProcAmp,
      onProgress: (msg, lv) => { setTuning(msg); if (lv) setLevels(lv); },
    });
  }

  async function runNetworkTest() {
    setNetBusy(true);
    try {
      const r = await measureNetwork();
      const up = r.upload as { mbps: number };
      setNet({ rtt: Number(r.rtt_median_ms ?? 0), mbps: up?.mbps ?? 0 });
    } catch {
      setNet(null);
    } finally {
      setNetBusy(false);
    }
  }

  function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    releaseStream();
    videoRef.current!.srcObject = null;
    if (objUrlRef.current) URL.revokeObjectURL(objUrlRef.current);
    objUrlRef.current = URL.createObjectURL(f);
    setFileName(f.name);
    const v = videoRef.current!;
    v.src = objUrlRef.current;
    v.loop = true;
    v.muted = true;
    deintRef.current.reset();
    enhancerRef.current.reset();
    glRef.current?.reset();
    void v.play().catch(() => { /* user can press play on the element */ });
  }

  // ---- the paint loop: raw → enhanced, plus the AI send ----
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !fileName) return;
    type V = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, md: { mediaTime: number }) => void) => number;
      cancelVideoFrameCallback?: (h: number) => void;
    };
    const vv = v as V;
    if (typeof vv.requestVideoFrameCallback !== "function") return;

    let handle = 0, cancelled = false;
    let lastMedia = -1;
    const fpsGaps: number[] = [];
    let combSamples = 0;
    let frameNo = 0;

    const paint = (_now: number, md: { mediaTime: number }) => {
      if (cancelled) return;
      const w = v.videoWidth & ~1, h = v.videoHeight & ~1;
      if (w && h) {
        if (lastMedia >= 0 && md.mediaTime > lastMedia) {
          fpsGaps.push(md.mediaTime - lastMedia);
          if (fpsGaps.length > 30) fpsGaps.shift();
        }
        lastMedia = md.mediaTime;

        // Source identity: interlace is measured, exactly as the live page does.
        if (combSamples < 20) {
          const r = combRatio(v, w, h);
          if (r !== null) {
            combSamples++;
            setSrcInfo((s) => ({ w, h, comb: Math.max(s.comb, Math.round(r * 100) / 100),
                                 fps: fpsGaps.length ? Math.round(10 / median(fpsGaps)) / 10 : s.fps,
                                 interlaced: looksInterlaced(r) ? true : s.interlaced }));
          }
        } else if (frameNo % 30 === 0) {
          setSrcInfo((s) => ({ ...s, w, h, fps: fpsGaps.length ? Math.round(10 / median(fpsGaps)) / 10 : s.fps,
                               interlaced: s.interlaced ?? false }));
        }

        // Raw panel — deinterlaced per the chosen algorithm.
        const raw = rawRef.current;
        if (raw) {
          if (raw.width !== w) raw.width = w;
          if (raw.height !== h) raw.height = h;
          const t0 = performance.now();
          const ctx = raw.getContext("2d")!;
          const mode = deintModeRef.current;
          if (!glDeintTriedRef.current) {
            glDeintTriedRef.current = true;
            glDeintRef.current = createGLDeinterlacer();
          }
          const out = glDeintRef.current?.process(v, w, h, mode);
          if (out) {
            // One readback per frame to keep the raw canvas 2D: everything
            // downstream (inference, the encoder's captureStream, level
            // measurement) expects to read pixels from it.
            ctx.drawImage(out.canvas, 0, 0);
          } else if (mode === "adaptive" || mode === "legacy") {
            deintRef.current.draw(v, 0, 0, w, h, raw, w, h, v.currentTime);
          } else if (mode === "bob") {
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(v, 0, 0, w, h, 0, 0, w, h / 2);
            ctx.drawImage(raw, 0, 0, w, h / 2, 0, 0, w, h);
          } else {
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(v, 0, 0, w, h);
          }
          const deintMs = performance.now() - t0;

          const enh = enhRef.current;
          if (enh) {
            // One attempt at WebGL2 per canvas: a context that failed to
            // initialise cannot be retried, and asking again every frame
            // would be the slowest possible way to find that out.
            if (!glTriedRef.current) {
              glTriedRef.current = true;
              glRef.current = createGLEnhancer(enh);
              setGpu(!!glRef.current);
            }
            const params = { denoise: denoiseRef.current, sharpen: sharpenRef.current };
            if (glRef.current) {
              const ms = glRef.current.process(raw, w, h, params);
              if (frameNo % 15 === 0) {
                setCost({ denoiseMs: ms, sharpenMs: 0, deintMs: Math.round(deintMs * 100) / 100 });
              }
              // 15 ms of a 33 ms frame is the point where the chain starts
              // costing frames rather than improving them.
              if (params.denoise > 0 || params.sharpen > 0) {
                const s = costSamplesRef.current;
                s.push(ms + deintMs);
                if (s.length > 60) s.shift();
                if (s.length === 60 && median(s) > 15) {
                  s.length = 0;
                  setDenoise(0); setSharpen(0);
                  setSlowNote(`Enhancement switched off: it was costing ${Math.round(median(s) || 16)} ms a frame on this computer. Lower settings or a different deinterlacer may still fit.`);
                }
              }
            } else {
              const c = enhancerRef.current.process(raw, enh, params);
              if (frameNo % 15 === 0) setCost({ ...c, deintMs: Math.round(deintMs * 100) / 100 });
            }
          }
        }

        if (inferOnRef.current) sendForInference(w, h);
      }
      frameNo++;
      handle = vv.requestVideoFrameCallback!(paint);
    };
    handle = vv.requestVideoFrameCallback(paint);
    return () => { cancelled = true; try { vv.cancelVideoFrameCallback?.(handle); } catch { /* gone */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileName]);

  // Start inference as soon as there is something to infer on, once per
  // source. A ref, not state: this must not re-fire when the socket closes
  // on its own, or a dropped connection becomes a reconnect loop.
  const autoInferRef = useRef("");
  useEffect(() => {
    if (!fileName || autoInferRef.current === fileName) return;
    autoInferRef.current = fileName;
    if (!inferOn) toggleInference();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileName]);

  // ---- encoder preview lifecycle (rebuilt on bitrate/mode change) ----
  useEffect(() => {
    if (!fileName) return;
    const canvas = rawRef.current, video = encVideoRef.current;
    if (!canvas || !video) return;
    const t = setTimeout(() => {
      previewRef.current?.stop();
      const p = new EncoderPreview({
        canvas, videoEl: video,
        bitsPerSecond: Math.round(mbps * 1e6),
        onStats: setEncStats,
        onStateChange: setEncState,
      });
      previewRef.current = p;
      p.start(segmentMode);
    }, 300);   // debounce: slider drags must not rebuild per pixel
    return () => clearTimeout(t);
  }, [fileName, mbps, segmentMode]);

  useEffect(() => () => {
    previewRef.current?.stop();
    wsRef.current?.close();
    releaseStream();
    if (objUrlRef.current) URL.revokeObjectURL(objUrlRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- inference ----
  const sendForInference = useCallback((w: number, h: number) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || inflightRef.current) return;
    const source = inferSourceRef.current === "enhanced" ? enhRef.current : rawRef.current;
    if (!source) return;

    const t0 = performance.now();
    const scale = INFER_WIDTH / w;
    const dw = INFER_WIDTH, dh = Math.max(2, Math.round(h * scale));
    const tmp = document.createElement("canvas");
    tmp.width = dw; tmp.height = dh;
    tmp.getContext("2d")!.drawImage(source, 0, 0, dw, dh);
    downMsRef.current.push(performance.now() - t0);
    if (downMsRef.current.length > 30) downMsRef.current.shift();

    const tj = performance.now();
    tmp.toBlob((blob) => {
      if (!blob || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      jpegMsRef.current.push(performance.now() - tj);
      if (jpegMsRef.current.length > 30) jpegMsRef.current.shift();
      void blob.arrayBuffer().then((buf) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
        const timer = setTimeout(() => { inflightRef.current = null; }, INFER_TIMEOUT_MS);
        inflightRef.current = { sentAt: performance.now(), timer };
        wsRef.current.send(buf);
        sentRef.current++;
      });
    }, "image/jpeg", 0.7);
  }, []);

  function toggleInference() {
    if (inferOn) {
      wsRef.current?.close();
      wsRef.current = null;
      setInferOn(false);
      return;
    }
    setWsError("");
    const ws = new WebSocket(`${API_WS}/api/ws/infer-file?case_id=sim`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => { setInferOn(true); };
    ws.onclose = (e) => {
      setInferOn(false);
      if (e.code === 1008) setWsError("Sign-in required for inference (session expired?).");
    };
    ws.onerror = () => setWsError("WebSocket error — is the backend reachable?");
    ws.onmessage = (e) => {
      const entry = inflightRef.current;
      if (entry) { clearTimeout(entry.timer); inflightRef.current = null; }
      let data: { boxes?: Box[]; timing?: { modal_ms: number }; error?: string };
      try { data = JSON.parse(e.data as string); } catch { return; }
      if (data.error) { setWsError(data.error); return; }
      recvRef.current++;

      const now = performance.now();
      if (lastArrivalRef.current) {
        arrivalsRef.current.push(now - lastArrivalRef.current);
        if (arrivalsRef.current.length > 20) arrivalsRef.current.shift();
      }
      lastArrivalRef.current = now;
      if (entry) {
        rttsRef.current.push(now - entry.sentAt);
        if (rttsRef.current.length > 10) rttsRef.current.shift();
      }
      if (data.timing) {
        avgsRef.current.push(data.timing.modal_ms);
        if (avgsRef.current.length > 10) avgsRef.current.shift();
      }
      const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
      const avg = Math.round(mean(avgsRef.current));
      const rtt = Math.round(mean(rttsRef.current));
      const gap = mean(arrivalsRef.current);
      setStats({
        sent: sentRef.current, received: recvRef.current,
        avgMs: avg, rttMs: rtt, netMs: Math.max(0, rtt - avg),
        fps: gap > 0 ? Math.round((1000 / gap) * 10) / 10 : 0,
      });
      setClientMs({ downscale: median(downMsRef.current), jpeg: median(jpegMsRef.current) });

      const src = inferSourceRef.current === "enhanced" ? enhRef.current : rawRef.current;
      const ai = aiRef.current;
      if (ai && src && src.width) {
        // Boxes arrive in the 320-wide space the model saw; drawBoxes paints
        // into the source's own space, so scale them up to match.
        const k = src.width / INFER_WIDTH;
        const scaled = (data.boxes ?? []).map((b) => ({
          ...b, bbox: b.bbox.map((n) => n * k) as [number, number, number, number],
        }));
        drawBoxes(ai, src, scaled, (b) => `${Math.round(b.conf * 100)}%`);
      }
    };
    wsRef.current = ws;
  }

  const aspectStyle = aspect43 ? { aspectRatio: "4 / 3" } : (srcInfo.w ? { aspectRatio: `${srcInfo.w} / ${srcInfo.h}` } : undefined);
  const canvasCls = "absolute inset-0 w-full h-full object-contain";

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------- source picker */}
      <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 text-xs">
          {(["file", "saved", "camera"] as const).map((k) => (
            <button key={k}
                    onClick={() => {
                      setSourceKind(k);
                      if (k === "camera" && !devices.length) void listDevices();
                      if (k === "saved" && !recordings.length) void loadRecordings();
                    }}
                    className={`px-2.5 py-1 rounded-md transition-colors ${sourceKind === k ? "bg-gray-700 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}>
              {k === "file" ? "Video file" : k === "saved" ? "Saved recording" : "Capture card / camera"}
            </button>
          ))}
        </div>
        {sourceKind === "camera" && (
          <>
            {devices.length === 0 ? (
              <button onClick={listDevices}
                      className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-sm">
                Allow camera access
              </button>
            ) : (
              <>
                <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}
                        className="px-2 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-gray-200 text-sm max-w-xs">
                  {devices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 12)}</option>
                  ))}
                </select>
                <button onClick={() => void startCamera(deviceId)} disabled={!deviceId}
                        className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm disabled:opacity-40">
                  Connect
                </button>
              </>
            )}
            {cameraNote && <span className="text-xs text-gray-500 font-mono truncate max-w-md">{cameraNote}</span>}
          </>
        )}
        {sourceKind === "saved" && (
          <>
            {recordings.length === 0 ? (
              <button onClick={loadRecordings}
                      className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-sm">
                Load saved recordings
              </button>
            ) : (
              <>
                <select value={recordingId} onChange={(e) => setRecordingId(e.target.value)}
                        className="px-2 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-gray-200 text-sm max-w-md">
                  {recordings.map((r) => (
                    <option key={`${r.case_id}/${r.id}`} value={`${r.case_id}/${r.id}`}>{clipLabel(r)}</option>
                  ))}
                </select>
                <button onClick={() => playRecording(recordingId)} disabled={!recordingId}
                        className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm disabled:opacity-40">
                  Play
                </button>
              </>
            )}
            {recordingsNote && <span className="text-xs text-gray-500">{recordingsNote}</span>}
          </>
        )}
        {sourceKind === "file" && (
        <input type="file" accept="video/*" onChange={pickFile}
               className="text-sm text-gray-400 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg
                          file:border-0 file:bg-purple-600 file:text-white file:text-sm hover:file:bg-purple-500" />
        )}
        {fileName && (
          <span className="text-xs text-gray-500 font-mono">
            {fileName} · {srcInfo.w}×{srcInfo.h} · {srcInfo.fps || "?"} fps ·{" "}
            {srcInfo.interlaced === null ? "measuring…" : srcInfo.interlaced
              ? `interlaced (comb ${srcInfo.comb})` : `progressive (comb ${srcInfo.comb})`}
          </span>
        )}
      </div>

      {!fileName ? (
        <p className="text-sm text-gray-600 py-10 text-center border-2 border-dashed border-gray-800 rounded-xl">
          {sourceKind === "camera"
            ? "Connect the capture card to tune these settings against the live signal."
            : sourceKind === "saved"
              ? "Pick a recording from this server — real clinic footage, with the card's own interlacing and noise."
              : "Pick a video file from this computer."}
        </p>
      ) : (
        <>
          {/* ------------------------------------------------- the panels */}
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
            <Panel title="Raw — the source as decoded"
                   sub={`deinterlace: ${deintMode} · ${cost.deintMs} ms/frame`}>
              <div className={panelBox} style={aspectStyle}>
                <canvas ref={rawRef} className={canvasCls} />
              </div>
            </Panel>

            <Panel title="After encoder — what a saved recording looks like"
                   sub={encState.kind === "live" ? `live · ${encState.mime}`
                      : encState.kind === "segment" ? `segment mode (${encState.reason})${encState.recording ? " — recording…" : ""}`
                      : encState.kind === "error" ? `error: ${encState.message}` : "starting…"}>
              <div className={panelBox} style={aspectStyle}>
                <video ref={encVideoRef} muted playsInline className={canvasCls} />
              </div>
            </Panel>

            <Panel title="Enhanced — display chain (denoise + sharpen)"
                   sub={gpu === null ? "starting…"
                      : gpu ? `GPU · ${cost.denoiseMs} ms/frame`
                      : `CPU fallback · ${cost.denoiseMs + cost.sharpenMs} ms/frame`}>
              <div className={panelBox} style={aspectStyle}>
                <canvas ref={enhRef} className={canvasCls} />
              </div>
            </Panel>

            <Panel title="AI — what the model sees, with its boxes"
                   sub={inferOn ? `from ${inferSource} · ${stats.fps} fps` : "off"}>
              <div className={panelBox} style={aspectStyle}>
                <canvas ref={aiRef} className={canvasCls} />
              </div>
            </Panel>
          </div>

          {/* ------------------------------------------------- controls */}
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(320px,1fr))]">
            <div className="rounded-xl border border-gray-800 bg-gray-900/60 px-3 py-2 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-400">Recording bitrate</span>
                <span className="font-mono text-gray-200">{mbps.toFixed(1)} Mbps</span>
              </div>
              <input type="range" min={0.5} max={15} step={0.1} value={mbps}
                     onChange={(e) => setMbps(Number(e.target.value))}
                     className="w-full accent-blue-500 cursor-pointer" />
              <p className="text-[11px] text-gray-600">
                1.2 = the old setting (~5 KB/frame) · 8 = the clinic&apos;s own still-image budget
                (current default) · above ~12 mostly encodes analog noise.
              </p>
              <div className="flex items-center gap-3 text-[11px] text-gray-500">
                <span className="font-mono">measured {encStats.kbps} kbps</span>
                <label className="flex items-center gap-1.5 cursor-pointer"
                       title="Records a 6-second sample at this bitrate and loops it, re-recording every 20s. Unticking streams the encoder live instead — lower latency in theory, but it can stall.">
                  <input type="checkbox" checked={segmentMode} className="accent-gray-500"
                         onChange={(e) => setSegmentMode(e.target.checked)} />
                  sample mode (recommended)
                </label>
              </div>
            </div>

            <div className="rounded-xl border border-gray-800 bg-gray-900/60 px-3 py-2 space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-gray-400">Deinterlace</span>
                <select value={deintMode}
                        onChange={(e) => {
                          setDeintMode(e.target.value as DeintMode);
                          deintRef.current.reset();
                          glDeintRef.current?.reset();
                        }}
                        className="rounded-md border border-gray-700 bg-gray-800 px-1.5 py-0.5 text-gray-300 text-xs max-w-[13rem]">
                  {DEINT_MODES.map((m) => (
                    <option key={m.key} value={m.key} title={m.hint}>{m.label}</option>
                  ))}
                </select>
              </div>
              <p className="text-[11px] text-gray-600 -mt-1">
                {DEINT_MODES.find((m) => m.key === deintMode)?.hint}
                {" QTGMC (the offline gold standard) is not available live — it needs seconds per frame."}
              </p>
              <Slider label="Denoise" value={denoise} onChange={setDenoise} />
              <Slider label="Sharpen" value={sharpen} onChange={setSharpen} />
              <label className="flex items-center gap-1.5 text-[11px] text-gray-500 cursor-pointer">
                <input type="checkbox" checked={aspect43} className="accent-gray-500"
                       onChange={(e) => setAspect43(e.target.checked)} />
                correct to 4:3 (SD pixels are not square)
              </label>
              {(denoise > 0 || sharpen > 0) && (
                <button onClick={() => { setDenoise(0); setSharpen(0); setSlowNote(""); }}
                        className={toggleBtn}>Turn enhancement off</button>
              )}
              {slowNote && <p className="text-[11px] text-amber-400">{slowNote}</p>}
            </div>

            {/* Proc-amp. Present only with a live device whose driver exposes
                the controls -- a saved file has no front end to tune. */}
            {sourceKind === "camera" && (
              <div className="rounded-xl border border-emerald-900/60 bg-emerald-950/10 px-3 py-2 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-emerald-300">
                    Capture card controls (proc-amp) · tuned automatically on connect
                  </span>
                  {procAmpCaps && (
                    <button onClick={autoTuneLevels} className={toggleBtn}>Auto-tune levels</button>
                  )}
                </div>
                {!procAmpCaps ? (
                  <p className="text-[11px] text-gray-500">
                    This driver exposes no picture controls to the browser. Tune them in the card&apos;s own
                    driver panel instead (AMCap or Device Manager), or use the display chain above —
                    which cannot recover anything the card already clipped.
                  </p>
                ) : (
                  <>
                    {Object.entries(procAmpCaps).map(([k, cap]) => (
                      <div key={k}>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-gray-400">{k}</span>
                          <span className="font-mono text-gray-200">{procAmp[k] ?? cap.min}</span>
                        </div>
                        <input type="range" min={cap.min} max={cap.max} step={cap.step || 1}
                               value={procAmp[k] ?? cap.min}
                               onChange={(e) => void applyProcAmp(k, Number(e.target.value))}
                               className="w-full accent-emerald-500 cursor-pointer" />
                      </div>
                    ))}
                    <div className="flex items-center gap-3 text-[11px]">
                      <button onClick={() => setLevels(measureLevels(rawRef.current))} className={toggleBtn}>Measure levels</button>
                      {levels && (
                        <span className="font-mono text-gray-500">
                          black {levels.black} · clipped {levels.clip}% · mean {levels.mean}
                        </span>
                      )}
                    </div>
                    {tuning && <p className="text-[11px] text-gray-500 font-mono">{tuning}</p>}
                    <p className="text-[11px] text-gray-600">
                      These change the card itself — the live view, the model&apos;s input and the
                      recording all receive the result.
                    </p>
                  </>
                )}
              </div>
            )}
          </div>

          {/* ------------------------------------------------- inference */}
          <div className="rounded-xl border border-gray-800 bg-gray-900/60 px-3 py-2 space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <button onClick={toggleInference}
                      className={`px-3 py-1.5 rounded-lg text-sm text-white ${inferOn ? "bg-red-700 hover:bg-red-600" : "bg-blue-600 hover:bg-blue-500"}`}>
                {inferOn ? "■ Stop inference" : "▶ Run inference"}
              </button>
              <span className="text-[11px] text-gray-600">starts on its own with the source</span>
              <label className="text-xs text-gray-400 flex items-center gap-1.5">
                Infer from:
                <select value={inferSource} onChange={(e) => setInferSource(e.target.value as InferSource)}
                        className="rounded-md border border-gray-700 bg-gray-800 px-1.5 py-0.5 text-gray-300">
                  <option value="raw">raw (production behaviour)</option>
                  <option value="enhanced">enhanced (experiment)</option>
                </select>
              </label>
              {wsError && <span className="text-xs text-red-400">{wsError}</span>}
              <button onClick={runNetworkTest} disabled={netBusy} className={toggleBtn}>
                {netBusy ? "measuring link…" : "Measure link speed"}
              </button>
              {net && (
                <span className="text-xs text-gray-500 font-mono">
                  RTT {net.rtt} ms · upload {net.mbps} Mbps
                  {net.mbps > 0 && ` · a ${mbpsLabel(net.mbps)}`}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-0.5 font-mono text-xs">
              <Stat k="sent / back" v={`${stats.sent} / ${stats.received}`} />
              <Stat k="round trip" v={stats.rttMs ? `${stats.rttMs} ms` : "—"} />
              <Stat k="— server" v={stats.avgMs ? `${stats.avgMs} ms` : "—"} />
              <Stat k="— network" v={stats.rttMs ? `${stats.netMs} ms` : "—"} />
              <Stat k="analysed" v={stats.fps ? `${stats.fps} fps` : "—"} />
              <Stat k="downscale" v={`${clientMs.downscale} ms`} />
              <Stat k="jpeg encode" v={`${clientMs.jpeg} ms`} />
              <Stat k="deinterlace" v={`${cost.deintMs} ms`} />
            </div>
          </div>
        </>
      )}

      {/* The source element itself is never shown — the panels are its views. */}
      <video ref={videoRef} muted playsInline className="hidden" />
    </div>
  );
}

/** What the measured uplink means for recording: the upload has to keep up
 *  with the encoder or every procedure ends with a queue still draining. */
function mbpsLabel(mbps: number): string {
  if (mbps >= 12) return "15 Mbps recording uploads in real time";
  if (mbps >= 8) return "8 Mbps recording uploads in real time";
  if (mbps >= 4) return "4 Mbps keeps up; 8 finishes after the procedure";
  return "recordings will upload well after the procedure";
}

function Panel({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs text-gray-400 uppercase tracking-wide truncate">{title}</p>
        <span className="text-[11px] text-gray-600 font-mono truncate">{sub}</span>
      </div>
      {children}
    </div>
  );
}

function Slider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-400">{label}</span>
        <span className="font-mono text-gray-200">{Math.round(value * 100)}%</span>
      </div>
      <input type="range" min={0} max={1} step={0.05} value={value}
             onChange={(e) => onChange(Number(e.target.value))}
             className="w-full accent-blue-500 cursor-pointer" />
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (<><span className="text-gray-500">{k}</span><span className="text-gray-200">{v}</span></>);
}
