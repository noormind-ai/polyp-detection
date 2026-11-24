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

export type WebrtcStatus = "connecting" | "open" | "closed" | "error" | "timeout";

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

export function startWebrtcSession(opts: {
  wsUrl: string;
  stream: MediaStream;
  onResult: (data: WebrtcResult) => void;
  onStatus: (status: WebrtcStatus) => void;
  onStats?: (stats: WebrtcStats) => void;
  onControl?: (data: WebrtcControl) => void;
  connectTimeoutMs?: number;
}): WebrtcSession {
  const { wsUrl, stream, onResult, onStatus, onStats, onControl, connectTimeoutMs = 5000 } = opts;
  let closed = false;
  let pc: RTCPeerConnection | null = null;
  let statsTimer: ReturnType<typeof setInterval> | null = null;
  let lastEncodeTime = 0;
  let lastFramesEncoded = 0;
  onStatus("connecting");

  const ws = new WebSocket(wsUrl);

  // No connection within this window -> tell the caller so it can fall back
  // to JPEG rather than leaving the session looking like it's still trying.
  const timeoutId = setTimeout(() => {
    if (!closed && pc?.connectionState !== "connected") {
      onStatus("timeout");
      close();
    }
  }, connectTimeoutMs);

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
      if (pc.connectionState === "connected") {
        clearTimeout(timeoutId);
        onStatus("open");
        if (onStats && !statsTimer) statsTimer = setInterval(() => void pollStats(), STATS_POLL_MS);
      } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        onStatus("error");
      }
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGatheringComplete(pc);
      ws.send(JSON.stringify({ type: "offer", sdp: pc.localDescription!.sdp }));
    } catch {
      onStatus("error");
    }
  }

  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data as string);
      if (!data) return;
      if (!pc) {
        // First message: the setup step above (turn/ready) -- anything
        // else here would mean the server's signaling order changed
        // without this file being updated to match.
        void handleSetupMessage(data);
      } else if (data.type === "answer") {
        void pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
      } else if (data.type === "recording" || data.type === "captured") {
        onControl?.(data);
      } else {
        onResult(data);
      }
    } catch {
      // Malformed message — nothing to recover, just drop this one.
    }
  };

  ws.onerror = () => { if (!closed) onStatus("error"); };
  ws.onclose = () => { if (!closed) onStatus("closed"); };

  async function pollStats() {
    if (closed || !pc || !onStats) return;
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
        }
      } else if (stat.type === "candidate-pair" && (stat as { state?: string }).state === "succeeded"
        && (stat as { nominated?: boolean }).nominated) {
        const rtt = (stat as { currentRoundTripTime?: number }).currentRoundTripTime;
        if (typeof rtt === "number") rttMs = rtt * 1000;
      }
    });
    onStats({ encodeMsPerFrame, rttMs });
  }

  function close() {
    closed = true;
    clearTimeout(timeoutId);
    if (statsTimer) clearInterval(statsTimer);
    try { ws.close(); } catch { /* already closed */ }
    try { pc?.close(); } catch { /* already closed */ }
  }

  function send(msg: object): boolean {
    if (closed || ws.readyState !== WebSocket.OPEN) return false;
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
