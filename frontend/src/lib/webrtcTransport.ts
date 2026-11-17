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

export type WebrtcResult = { boxes?: unknown; timing?: unknown; error?: string };

export type WebrtcSession = { close: () => void };

export function startWebrtcSession(opts: {
  wsUrl: string;
  stream: MediaStream;
  onResult: (data: WebrtcResult) => void;
  onStatus: (status: WebrtcStatus) => void;
  connectTimeoutMs?: number;
}): WebrtcSession {
  const { wsUrl, stream, onResult, onStatus, connectTimeoutMs = 5000 } = opts;
  let closed = false;
  let pc: RTCPeerConnection | null = null;
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
      } else {
        onResult(data);
      }
    } catch {
      // Malformed message — nothing to recover, just drop this one.
    }
  };

  ws.onerror = () => { if (!closed) onStatus("error"); };
  ws.onclose = () => { if (!closed) onStatus("closed"); };

  function close() {
    closed = true;
    clearTimeout(timeoutId);
    try { ws.close(); } catch { /* already closed */ }
    try { pc?.close(); } catch { /* already closed */ }
  }

  return { close };
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
