/** Experimental, optional transport: a browser-native WebRTC video stream
 *  instead of JPEG-encoding and sending each frame by hand.
 *
 *  See documents/webrtc-implementation-plan.txt (polyp-detection repo root)
 *  for the mental model and why this exists. Signaling: the server always
 *  sends exactly one setup message first (TURN credentials, or a plain
 *  "ready" if no TURN is configured on that deployment) -- the browser's
 *  RTCPeerConnection needs its full iceServers list at construction time,
 *  before it starts gathering candidates, so that message has to arrive
 *  before an offer is created, not after. Then one offer, one answer
 *  (non-trickle ICE for v1), over the same WebSocket that then carries
 *  {"boxes","timing"} results back, matching the JSON shape the existing
 *  JPEG path already uses.
 */

import { superviseWebrtc, type Attempt, type AttemptEvent, type RecoveryInfo, type RecoveryStatus } from "./webrtcRecovery";

/** Status of the whole WebRTC session (every reconnect attempt together) --
 *  see webrtcRecovery.ts. "fallback" = gave up on WebRTC; switch to JPEG. */
export type WebrtcStatus = RecoveryStatus;
export type { RecoveryInfo as WebrtcStatusInfo };

export type WebrtcResult = {
  boxes?: unknown; timing?: unknown; error?: string;
  /** This result's frame number on the server -- what "file frame #N" names. */
  frame?: number;
  /** Where that frame sits in the server's open recording, if any. */
  rec?: { id?: string; offset_ms?: number };
  /** Size of the frame as the server received it -- the space the boxes are in. */
  w?: number; h?: number;
};

/** Replies to commands sent with session.send(): server recording state
 *  ("recording") and filed captures ("captured"). See
 *  backend/routes/webrtc_infer.py's _handle_control. */
export type WebrtcControl = { type: "recording" | "captured"; [k: string]: unknown };

/** Numbers the browser itself measured -- not derived, not guessed.
 *  encodeMsPerFrame comes straight from getStats()'s outbound-rtp report
 *  (totalEncodeTime/framesEncoded, delta since the last poll): this is the
 *  actual answer to "does WebRTC's encoder cost less CPU than JPEG",
 *  whichever encoder Chrome actually picked, hardware or software.
 *  rttMs comes from the active ICE candidate pair's own currentRoundTripTime
 *  -- a real measurement, but a smoothed one updated once per poll, not an
 *  exact per-frame number the way JPEG mode's RTT is (see the comment at
 *  the call site in LiveCameraPlayer.tsx for why that's an accepted,
 *  disclosed difference rather than a hidden one). */
export type WebrtcStats = { encodeMsPerFrame: number; rttMs: number };

export type WebrtcSession = {
  close: () => void;
  /** Send a control message (record / capture). False if the socket isn't open. */
  send: (msg: object) => boolean;
};

const STATS_POLL_MS = 1000;

type SessionOpts = {
  wsUrl: string;
  stream: MediaStream;
  onResult: (data: WebrtcResult) => void;
  onStatus: (status: WebrtcStatus, info: RecoveryInfo) => void;
  onStats?: (stats: WebrtcStats) => void;
  onControl?: (data: WebrtcControl) => void;
  /** A fresh connection replaced a lost one: the server-side session
   *  (recording, frame numbers) of the old one is gone. */
  onReconnected?: () => void;
};

/** A self-healing WebRTC session: reconnects on its own after any drop
 *  (webrtcRecovery.ts decides when), until close() or "fallback". */
export function startWebrtcSession(opts: SessionOpts): WebrtcSession {
  return superviseWebrtc({
    connect: (emit) => openAttempt(opts, emit),
    onStatus: opts.onStatus,
    onReconnected: opts.onReconnected,
  });
}

/** ONE connection attempt: a WebSocket plus one RTCPeerConnection. Never
 *  retries by itself -- it reports what happens to it through `emit`, and
 *  the supervisor throws it away and opens a new one when needed. */
function openAttempt(opts: SessionOpts, emit: (e: AttemptEvent) => void): Attempt {
  const { wsUrl, stream, onResult, onStats, onControl } = opts;
  let closed = false;
  // True once the server's answer is applied. Control messages (record,
  // capture) are held back until then: the server reads the FIRST message
  // after setup as the offer, and auto-record can fire before the offer is
  // sent (the offer waits for ICE gathering). Sending "record start" first
  // made the server drop the connection -- the "WebRTC: closed/timeout" race.
  let negotiated = false;
  let pc: RTCPeerConnection | null = null;
  let statsTimer: ReturnType<typeof setInterval> | null = null;
  let lastEncodeTime = 0;
  let lastFramesEncoded = 0;

  const ws = new WebSocket(wsUrl);

  async function handleSetupMessage(data: { type: string; username?: string; password?: string }) {
    // Without any ICE server this box only ever offers its own
    // private-network address as a candidate (it sits behind its hosting
    // provider's own private network), which the browser has no way to
    // reach. STUN alone reports a public address but can't open a door the
    // provider's firewall keeps closed for everything except a few fixed
    // ports -- the TURN entry (when the server sends one) is what actually
    // gets through; see backend/routes/webrtc_infer.py for the matching
    // server-side config and why this was needed.
    const iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
    if (data.type === "turn" && data.username && data.password) {
      const host = new URL(wsUrl).hostname;
      iceServers.push({
        urls: [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`],
        username: data.username,
        credential: data.password,
      });
    }

    pc = new RTCPeerConnection({ iceServers });
    stream.getVideoTracks().forEach((track) => pc!.addTrack(track, stream));
    pc.onconnectionstatechange = () => {
      if (closed || !pc) return;
      const state = pc.connectionState;
      if (state === "connected") {
        // Always polled, not only when the caller wants stats: the
        // watchdog needs framesEncoded to tell "sending but no answer"
        // from "nothing to send" (a background tab).
        if (!statsTimer) statsTimer = setInterval(() => void pollStats(), STATS_POLL_MS);
        emit({ kind: "pipe", state: "connected" });
      } else if (state === "disconnected" || state === "failed") {
        emit({ kind: "pipe", state });
      }
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGatheringComplete(pc);
      if (closed) return;
      ws.send(JSON.stringify({ type: "offer", sdp: pc.localDescription!.sdp }));
    } catch {
      if (!closed) emit({ kind: "pipe", state: "failed" });
    }
  }

  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data as string);
      if (!data) return;
      emit({ kind: "message" });
      if (!pc) {
        // First message: the setup step above (turn/ready) -- anything
        // else here would mean the server's signaling order changed
        // without this file being updated to match.
        void handleSetupMessage(data);
      } else if (data.type === "answer") {
        pc.setRemoteDescription({ type: "answer", sdp: data.sdp })
          .then(() => { negotiated = true; })
          .catch(() => { if (!closed) emit({ kind: "pipe", state: "failed" }); });
      } else if (data.type === "recording" || data.type === "captured") {
        onControl?.(data);
      } else {
        onResult(data);
      }
    } catch {
      // Malformed message — nothing to recover, just drop this one.
    }
  };

  ws.onopen = () => { if (!closed) emit({ kind: "ws-open" }); };
  // onerror is always followed by onclose; one report is enough.
  ws.onclose = (ev) => { if (!closed) emit({ kind: "ws-closed", code: ev.code }); };

  async function pollStats() {
    if (closed || !pc) return;
    const report = await pc.getStats();
    let encodeMsPerFrame = 0;
    let rttMs = 0;
    report.forEach((stat) => {
      if (stat.type === "outbound-rtp" && stat.kind === "video") {
        const totalEncodeTime = stat.totalEncodeTime as number | undefined;
        const framesEncoded = stat.framesEncoded as number | undefined;
        if (typeof totalEncodeTime === "number" && typeof framesEncoded === "number") {
          const dTime = totalEncodeTime - lastEncodeTime;
          const dFrames = framesEncoded - lastFramesEncoded;
          if (dFrames > 0) encodeMsPerFrame = (dTime / dFrames) * 1000;
          lastEncodeTime = totalEncodeTime;
          lastFramesEncoded = framesEncoded;
          emit({ kind: "frames", encoded: framesEncoded });
        }
      } else if (stat.type === "candidate-pair" && (stat as { state?: string }).state === "succeeded"
        && (stat as { nominated?: boolean }).nominated) {
        const rtt = (stat as { currentRoundTripTime?: number }).currentRoundTripTime;
        if (typeof rtt === "number") rttMs = rtt * 1000;
      }
    });
    onStats?.({ encodeMsPerFrame, rttMs });
  }

  function close() {
    closed = true;
    if (statsTimer) clearInterval(statsTimer);
    try { ws.close(); } catch { /* already closed */ }
    try { pc?.close(); } catch { /* already closed */ }
  }

  function send(msg: object): boolean {
    if (closed || !negotiated || ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify(msg)); return true; } catch { return false; }
  }

  return { close, send };
}

function waitForIceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
  });
}
