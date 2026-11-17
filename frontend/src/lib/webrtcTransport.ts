/** Experimental, optional transport: a browser-native WebRTC video stream
 *  instead of JPEG-encoding and sending each frame by hand.
 *
 *  See documents/webrtc-implementation-plan.txt (polyp-detection repo root)
 *  for the mental model and why this exists. Signaling is one offer, one
 *  answer (non-trickle ICE for v1 — simpler protocol), over the same
 *  WebSocket that then carries {"boxes","timing"} results back, matching
 *  the JSON shape the existing JPEG path already uses.
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
  onStatus("connecting");

  const pc = new RTCPeerConnection();
  stream.getVideoTracks().forEach((track) => pc.addTrack(track, stream));

  const ws = new WebSocket(wsUrl);

  // No connection within this window -> tell the caller so it can fall back
  // to JPEG rather than leaving the session looking like it's still trying.
  const timeoutId = setTimeout(() => {
    if (!closed && pc.connectionState !== "connected") {
      onStatus("timeout");
      close();
    }
  }, connectTimeoutMs);

  pc.onconnectionstatechange = () => {
    if (closed) return;
    if (pc.connectionState === "connected") {
      clearTimeout(timeoutId);
      onStatus("open");
    } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      onStatus("error");
    }
  };

  ws.onopen = () => {
    void (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGatheringComplete(pc);
        ws.send(JSON.stringify({ type: "offer", sdp: pc.localDescription!.sdp }));
      } catch {
        onStatus("error");
      }
    })();
  };

  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data as string);
      if (data && data.type === "answer") {
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
    try { pc.close(); } catch { /* already closed */ }
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
