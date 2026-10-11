"use client";

/**
 * /spectator/[caseId] — a read-only live view of a session running on
 * another computer (the actual procedure room), for watching from anywhere
 * without being the machine wired to the capture card.
 *
 * Deliberately NOT built on top of LiveCameraPlayer: this page has no
 * capture loop of its own, no recording, no gates on what gets sent (there
 * is nothing to send) — it only consumes what the room's session already
 * chose to broadcast (see backend/services/spectate_bus.py and the
 * case_id-keyed hook in backend/routes/infer.py's _stream_inference). Boxes
 * are drawn with the shared drawBoxes() helper so a detection looks
 * identical here and in the room. The review panel below the video is the
 * same FeedbackPanel component the room uses, unmodified — this page adds
 * no review logic of its own.
 *
 * Access is two gates: signed in (bounced to /login like /tutorials), AND
 * that account is in the server's POLYP_SPECTATOR_USERS allowlist — being
 * signed in to the main app is not enough on its own. A signed-in-but-
 * unlisted account still reaches this page (client-side auth is UX only)
 * but the websocket itself rejects with 1008, which is what actually
 * enforces this.
 *
 * Image decode is coalesced to "always the latest frame": ws.onmessage is
 * not serialized by the browser, so if createImageBitmap ever takes longer
 * than the interval between frames, decodes start overlapping and the view
 * falls permanently behind with no way to catch up. Every incoming message
 * still updates stats/boxes/alert immediately (cheap, synchronous); only the
 * image decode is deferred into pendingFrameRef + drawLoop, which always
 * works on the newest frame and silently drops any that arrived and were
 * superseded while a decode was in flight.
 *
 * The recording-status strip below is READ ONLY: it polls the existing
 * GET /api/recordings?case_id= endpoint (same one RecordingsPanel.tsx uses)
 * on a plain timer. It does not touch backend/routes/recordings.py's
 * chunked-upload path (start/chunk/stop, seq ordering) or
 * lib/useSessionRecorder.ts at all -- on purpose, since that upload path has
 * bitten this app before (see useSessionRecorder.ts's START_RETRY_COOLDOWN_MS
 * comment). This is deliberately smaller than RecordingsPanel: no playback,
 * no delete -- just whether something is recording right now, and each
 * recording's upload status, nothing that can act on the room's session.
 */

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useLanguage } from "@/lib/i18n";
import { drawBoxes, type Box } from "@/lib/drawBoxes";
import { useAlertSound, SPECTATOR_ALERT_KEY } from "@/lib/useAlertSound";
import AlertSoundControls from "@/components/AlertSoundControls";
import FeedbackPanel from "@/components/FeedbackPanel";
import { formatBytes, formatDuration } from "@/components/RecordingControls";

const API = process.env.NEXT_PUBLIC_API_URL || "";
const API_WS = (process.env.NEXT_PUBLIC_API_URL
  || (typeof window !== "undefined" ? window.location.origin : "")).replace(/^http/, "ws");
// Same 10-sample smoothing window LiveCameraPlayer.tsx uses for its own
// latency stats, so the two panels read comparably.
const HISTORY_LEN = 10;
// Plain fixed-interval poll of GET /recordings?case_id= -- same endpoint
// RecordingsPanel.tsx already uses, same cadence as the review panel below.
const RECORDING_POLL_MS = 5000;

interface Timing { recv_ms: number; modal_ms: number; total_ms: number; }
// The room's own client-side connection stats, as posted to
// /api/spectate/{case_id}/room-stats -- see LiveCameraPlayer.tsx's onmessage
// and spectate_bus.py's _room_stats. null until the room's first report
// arrives after this page connects.
interface RoomStats { sent: number; received: number; avg_ms: number; rtt_ms: number; net_ms: number; fps: number; }
interface SpectateMsg {
  boxes: Box[]; timing: Timing; jpeg_b64: string; sent_at_ms?: number; room_stats?: RoomStats | null;
}
interface Recording {
  id: string;
  source: "camera" | "screen" | "joined";
  started_at: number;
  duration_ms: number;
  chunks: number;
  bytes: number;
  status: "recording" | "complete" | "truncated" | "interrupted";
}

type ConnState = "connecting" | "open" | "closed" | "rejected";

function decodeJpegB64(b64: string): Blob {
  // Direct decode instead of fetch(`data:...`) -> .blob(): the fetch path
  // goes through the whole Response/Blob machinery for what is, in this
  // process, just a base64 string -- measurably slower per frame for no
  // benefit, and per-frame cost is exactly what compounds into visible lag.
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: "image/jpeg" });
}

export default function SpectatorPage({ params }: { params: { caseId: string } }) {
  const { caseId } = params;
  const { t, lang, toggleLang } = useLanguage();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) window.location.replace(`/login?next=/spectator/${caseId}`);
  }, [loading, user, caseId]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Tier 3, on its own mute key: a beep on an unattended remote machine is that
  // viewer's call, not the room's. The timing is the room's, though -- same hook,
  // same rule, same shared duration setting.
  const alert = useAlertSound(SPECTATOR_ALERT_KEY);
  const lastFrameB64Ref = useRef<string | null>(null);
  const lastBoxesRef = useRef<Box[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  // Coalescing state for the image decode -- see file header.
  const pendingFrameRef = useRef<{ jpeg_b64: string; boxes: Box[] } | null>(null);
  const decodingRef = useRef(false);

  // Rolling windows for the stats panel.
  const lagHistory = useRef<number[]>([]);
  const serverHistory = useRef<number[]>([]);
  const intervalHistory = useRef<number[]>([]);
  const lastMsgAtRef = useRef<number | null>(null);

  const [connState, setConnState] = useState<ConnState>("connecting");
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [boxCount, setBoxCount] = useState(0);
  const [stats, setStats] = useState({ received: 0, lagMs: 0, serverMs: 0, networkMs: 0, fps: 0 });
  const [roomStats, setRoomStats] = useState<RoomStats | null>(null);
  const [flagState, setFlagState] = useState<"idle" | "sending" | "sent">("idle");
  const [feedbackRefreshKey, setFeedbackRefreshKey] = useState(0);
  const [recordings, setRecordings] = useState<Recording[] | null>(null);
  const [, forceTick] = useState(0); // re-renders the "N s ago" line once a second

  // Reconnaissance tick for the "N s ago" status line — purely cosmetic, no
  // network activity of its own.
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Read-only poll of the same endpoint RecordingsPanel.tsx uses -- whether
  // the room is recording right now, and each recording's upload status.
  // Never writes anything; the chunked-upload path itself is untouched.
  useEffect(() => {
    if (!user || !caseId) return;
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(`${API}/api/recordings?case_id=${encodeURIComponent(caseId)}`, { credentials: "include" });
        if (!res.ok || cancelled) return;
        setRecordings(await res.json());
      } catch { /* transient — keep showing the last known list */ }
    }
    poll();
    const id = setInterval(poll, RECORDING_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [user, caseId]);

  useEffect(() => {
    if (!user || !caseId) return;
    let cancelled = false;
    const ws = new WebSocket(`${API_WS}/api/ws/spectate/${encodeURIComponent(caseId)}`);
    wsRef.current = ws;
    setConnState("connecting");

    // Always works on the newest pending frame; anything superseded while a
    // decode was in flight is dropped, never queued.
    async function drawLoop() {
      if (decodingRef.current) return;
      decodingRef.current = true;
      try {
        while (pendingFrameRef.current) {
          const frame = pendingFrameRef.current;
          pendingFrameRef.current = null;
          const canvas = canvasRef.current;
          if (!canvas) break;
          try {
            const bitmap = await createImageBitmap(decodeJpegB64(frame.jpeg_b64));
            drawBoxes(canvas, bitmap, frame.boxes, (det) => t("polyp  {conf}%", { conf: Math.round(det.conf * 100) }));
            bitmap.close();
          } catch { /* a dropped frame is not worth surfacing as an error */ }
        }
      } finally {
        decodingRef.current = false;
      }
    }

    ws.onopen = () => { if (!cancelled) setConnState("open"); };
    ws.onclose = (e) => {
      if (cancelled) return;
      // 1008 is the server's explicit "you may not watch this" — distinct
      // from a network blip so the page can say so plainly rather than
      // implying a retry might help.
      setConnState(e.code === 1008 ? "rejected" : "closed");
    };
    ws.onerror = () => { if (!cancelled) setConnState("closed"); };

    ws.onmessage = (ev) => {
      let data: unknown;
      try { data = JSON.parse(ev.data); } catch { return; }
      if (!data || typeof data !== "object" || "error" in data) return;
      const { boxes, timing: tm, jpeg_b64, sent_at_ms, room_stats } = data as SpectateMsg;
      const now = Date.now();

      if (room_stats) setRoomStats(room_stats);

      // Cheap, synchronous bookkeeping — happens for every message, whether
      // or not this particular frame ends up drawn.
      lastFrameB64Ref.current = jpeg_b64;
      lastBoxesRef.current = boxes;
      setBoxCount(boxes.length);
      setLastUpdate(now);

      if (sent_at_ms) {
        lagHistory.current.push(Math.max(0, now - sent_at_ms));
        if (lagHistory.current.length > HISTORY_LEN) lagHistory.current.shift();
      }
      serverHistory.current.push(tm.total_ms);
      if (serverHistory.current.length > HISTORY_LEN) serverHistory.current.shift();
      if (lastMsgAtRef.current) {
        const interval = now - lastMsgAtRef.current;
        if (interval > 0) {
          intervalHistory.current.push(interval);
          if (intervalHistory.current.length > HISTORY_LEN) intervalHistory.current.shift();
        }
      }
      lastMsgAtRef.current = now;

      const avg = (h: number[]) => h.length ? Math.round(h.reduce((a, b) => a + b, 0) / h.length) : 0;
      const avgLag = avg(lagHistory.current);
      const avgServer = avg(serverHistory.current);
      const avgInterval = avg(intervalHistory.current);
      setStats((s) => ({
        received: s.received + 1,
        lagMs: avgLag,
        serverMs: avgServer,
        networkMs: Math.max(0, avgLag - avgServer),
        fps: avgInterval ? Math.round((1000 / avgInterval) * 10) / 10 : 0,
      }));

      // Fed from the message, not from drawLoop: the draw is deliberately
      // coalesced and can skip frames, and an alert must not be skipped with it.
      // These are the room's own post-temporal-gate boxes, so this view alerts
      // off the same box state the room does.
      alert.onBoxState(boxes.length > 0);

      // The potentially-slow part: deferred and coalesced, see drawLoop.
      pendingFrameRef.current = { jpeg_b64, boxes };
      void drawLoop();
    };

    return () => { cancelled = true; ws.close(); wsRef.current = null; };
  }, [user, caseId, t]);

  async function flagThisMoment() {
    if (!lastFrameB64Ref.current || flagState === "sending") return;
    setFlagState("sending");
    try {
      const blob = decodeJpegB64(lastFrameB64Ref.current);
      const fd = new FormData();
      fd.append("file", blob, "frame.jpg");
      fd.append("ai_detections", JSON.stringify(lastBoxesRef.current));
      // No recording_id/video_offset_ms: those come from the room's own
      // local session recording, which this machine has no access to. The
      // reviewer still gets the image and the model's boxes for this
      // exact moment, just not a seek-to offset in the full recording.
      await fetch(`${API}/api/feedback/${caseId}/dr-found/capture`, { method: "POST", body: fd });
      setFlagState("sent");
      setFeedbackRefreshKey((k) => k + 1);
      setTimeout(() => setFlagState("idle"), 2000);
    } catch {
      setFlagState("idle");
    }
  }

  const statusText =
    connState === "open" ? t("Connected") :
    connState === "connecting" ? t("Connecting…") :
    connState === "rejected" ? t("Not authorised to watch this session") :
    t("Disconnected");
  const statusOk = connState === "open";
  const secsAgo = lastUpdate ? Math.max(0, Math.round((Date.now() - lastUpdate) / 1000)) : null;

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-3xl mx-auto p-4 sm:p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between mb-6">
          <div>
            <h1 className="text-xl sm:text-2xl font-semibold mb-1">{t("Spectator")}</h1>
            <p className="text-gray-500 text-sm font-mono">{caseId}</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <a href="/" className="text-sm px-3 py-2 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors">
              {t("Home")}
            </a>
            <button onClick={toggleLang} className="text-sm px-3 py-2 rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors">
              {lang === "fa" ? "English" : "فارسی"}
            </button>
          </div>
        </div>

        {!user ? (
          <p className="text-center text-gray-600 py-10">{t("Please wait…")}</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <div className="flex items-center gap-3">
                <span className={`flex items-center gap-1.5 ${statusOk ? "text-green-400" : "text-yellow-400"}`}>
                  <span className={`w-2 h-2 rounded-full inline-block ${statusOk ? "bg-green-400 animate-pulse" : "bg-yellow-400"}`} />
                  {statusText}
                </span>
                {secsAgo !== null && statusOk && (
                  <span className="text-gray-500 text-xs">{t("last frame {s}s ago", { s: secsAgo })}</span>
                )}
                {boxCount > 0 && statusOk && (
                  <span className="text-[#39ff14] font-medium animate-pulse">{t("Polyp detected")}</span>
                )}
              </div>
              {/* Same control as the room's, on this device's own mute key. */}
              <AlertSoundControls alert={alert} />
            </div>

            {connState === "rejected" && (
              <div className="bg-red-950 border border-red-800 rounded-lg px-3 py-2 text-red-300 text-sm">
                {t("This account is not on the spectator allowlist for this server. Ask an administrator to add it.")}
              </div>
            )}

            <div className="relative w-full bg-black rounded-lg overflow-hidden border border-gray-800" style={{ aspectRatio: "4 / 3" }}>
              <canvas ref={canvasRef} className="w-full h-full object-contain" />
              {!statusOk && (
                <div className="absolute inset-0 flex items-center justify-center text-gray-600 text-sm">
                  {connState === "connecting" ? t("Connecting…") : t("No live frame")}
                </div>
              )}
            </div>

            {/* Same debug-grid shape as LiveCameraPlayer.tsx's own stats panel,
                relabelled for what this page actually measures: it never sends
                a frame of its own, so there is no round trip to split -- only
                delivery lag (network) and the room's own inference time
                (server), both taken from what the broadcast already reports. */}
            <div className="space-y-1">
              <p className="text-[10px] text-gray-600 uppercase tracking-wide px-1">{t("This connection")}</p>
              <div className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 font-mono text-xs grid grid-cols-2 gap-x-6 gap-y-0.5">
                <span className="text-gray-500">{t("Frames received")}</span>
                <span className="text-white">{stats.received}</span>
                <span>
                  <span className="text-gray-500">{t("Lag (avg)")} </span>
                  <span className={stats.lagMs > 800 ? "text-red-400" : "text-green-400"}>
                    {stats.received > 0 ? t("{ms} ms", { ms: stats.lagMs }) : "—"}
                  </span>
                </span>
                <span>
                  <span className="text-gray-500">{t("server")} </span>
                  <span className="text-white">{stats.received > 0 ? t("{ms} ms", { ms: stats.serverMs }) : "—"}</span>
                  <span className="text-gray-600"> + </span>
                  <span className="text-gray-500">{t("network")} </span>
                  <span className="text-white">{stats.received > 0 ? t("{ms} ms", { ms: stats.networkMs }) : "—"}</span>
                </span>
                <span className="text-gray-500">{t("Analysed")}</span>
                <span className="text-white">{stats.fps > 0 ? t("{fps} fps", { fps: stats.fps.toFixed(1) }) : "—"}</span>
              </div>
            </div>

            {/* The exact same numbers the room itself shows in its own debug
                panel (LiveCameraPlayer.tsx) -- posted by the room on its own
                throttle (see backend/routes/spectate.py's room-stats POST),
                not derived here. Same t() keys as the room's panel on
                purpose, so the wording matches word-for-word. */}
            {roomStats && (
              <div className="space-y-1">
                <p className="text-[10px] text-gray-600 uppercase tracking-wide px-1">{t("Room")}</p>
                <div className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 font-mono text-xs grid grid-cols-2 gap-x-6 gap-y-0.5">
                  <span className="text-gray-500">{t("Frames sent")}</span>
                  <span className="text-white">{roomStats.sent}</span>
                  <span>
                    <span className="text-gray-500">{t("Responses back")} </span>
                    <span className="text-white">{roomStats.received}</span>
                  </span>
                  <span>
                    <span className="text-gray-500">{t("Round trip (avg)")} </span>
                    <span className={roomStats.rtt_ms > 800 ? "text-red-400" : "text-green-400"}>
                      {roomStats.rtt_ms > 0 ? t("{ms} ms", { ms: roomStats.rtt_ms }) : "—"}
                    </span>
                  </span>
                  <span>
                    <span className="text-gray-500">{t("server")} </span>
                    <span className="text-white">{roomStats.avg_ms > 0 ? t("{ms} ms", { ms: roomStats.avg_ms }) : "—"}</span>
                    <span className="text-gray-600"> + </span>
                    <span className="text-gray-500">{t("network")} </span>
                    <span className="text-white">{roomStats.rtt_ms > 0 ? t("{ms} ms", { ms: roomStats.net_ms }) : "—"}</span>
                  </span>
                  <span className="text-gray-500">{t("Analysed")}</span>
                  <span className="text-white">{roomStats.fps > 0 ? t("{fps} fps", { fps: roomStats.fps.toFixed(1) }) : "—"}</span>
                </div>
              </div>
            )}

            {/* Read-only: status of what's being recorded for this case, not
                a control surface. See the file header for why this stays a
                plain poll of the existing endpoint rather than anything that
                touches the chunked-upload path. */}
            {recordings !== null && recordings.length > 0 && (
              <div className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 space-y-1.5">
                {recordings.map((r) => {
                  const badge =
                    r.status === "recording" ? { text: t("recording…"), cls: "text-red-400 border-red-900 bg-red-950/40" } :
                    r.status === "truncated" ? { text: t("size limit"), cls: "text-amber-400 border-amber-900 bg-amber-950/40" } :
                    r.status === "interrupted" ? { text: t("interrupted"), cls: "text-amber-400 border-amber-900 bg-amber-950/40" } :
                    { text: t("saved"), cls: "text-green-400 border-green-900 bg-green-950/40" };
                  return (
                    <div key={r.id} className="flex items-center gap-2 text-xs">
                      <span className={`px-1.5 py-0.5 rounded border flex-shrink-0 ${badge.cls}`}>{badge.text}</span>
                      <span className="text-gray-500 font-mono truncate">
                        {t("{duration} · {size}", {
                          duration: r.duration_ms ? formatDuration(r.duration_ms) : "—",
                          size: formatBytes(r.bytes),
                        })}
                        {r.status === "recording" && r.chunks > 0 &&
                          ` · ${t("{n} pieces uploaded so far", { n: r.chunks })}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex items-center justify-end gap-3">
              <button
                onClick={flagThisMoment}
                disabled={!lastFrameB64Ref.current || flagState === "sending"}
                className="text-sm px-4 py-2 rounded-lg border border-amber-700 bg-amber-950/40 text-amber-300 hover:border-amber-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {flagState === "sent" ? t("Flagged for review") :
                 flagState === "sending" ? t("Flagging…") :
                 t("Flag this moment for review")}
              </button>
            </div>

            <FeedbackPanel caseId={caseId} refreshSignal={feedbackRefreshKey} />
          </div>
        )}
      </div>
    </main>
  );
}
