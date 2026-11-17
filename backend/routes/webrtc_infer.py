"""Experimental, optional WebRTC transport for live inference.

Signaling (one offer, one answer) plus receiving a continuous video track,
re-encoding each frame to JPEG and handing it to the exact same
infer_frame() the JPEG-over-WebSocket path already calls — see
backend/routes/infer.py's _stream_frames. Nothing about the model or its
engines changes; only how a frame arrives at this process.

This is a brand-new route, never touched by /ws/infer or /ws/infer-file.
aiortc is imported lazily, only inside the handler below — a deployment
that never installs it (see requirements-webrtc.txt) is completely
unaffected by this file existing, the same pattern
backend/services/engine.py already uses for making the `modal` package
optional.
"""
import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket

from backend import auth
from backend.services import engine, turn_credentials

# Public address of the TURN relay (coturn) -- same box, same IP this
# backend already runs on. Overridable so this file doesn't hardcode an IP
# that could change; see documents/webrtc-implementation-plan.txt for why a
# relay is needed at all (the hosting provider blocks arbitrary inbound
# ports; 3478 had to be explicitly opened).
import os
TURN_HOST = os.environ.get("TURN_HOST", "31.214.168.29")

log = logging.getLogger("webrtc_infer")

router = APIRouter()

# How often the inference loop logs, so a real session doesn't spam one line
# per frame but still shows up quickly in the log.
FRAME_LOG_EVERY = 30


def aiortc_available() -> bool:
    """Honest, lazy answer — same shape as engine.modal_available(). A box
    that never installed aiortc must not be affected by this route existing;
    this is the only place that finds out either way."""
    try:
        import aiortc  # noqa: F401
        return True
    except ImportError:
        return False


async def _consume_track(track, websocket: WebSocket, eng, user: str) -> None:
    """Infer, one frame at a time, always the LATEST one.

    When the engine supports it (local_cpu's _Bound.infer_array — see
    backend/services/local_cpu.py), the decoded pixel array goes straight to
    the model: no JPEG re-encode, no second decode, no lossy round trip for
    data that was never leaving this process anyway. The Modal engine has no
    such method — its infer_frame() genuinely needs bytes to cross an RPC
    boundary to a remote GPU container, so for that engine only, frames are
    re-encoded to JPEG first (the seam this function originally used for
    every engine).

    track.recv() is push-based: frames keep arriving over RTP regardless of
    whether the previous infer_frame() call has returned. A naive
    `while True: frame = await track.recv(); infer(frame)` would let frames
    queue up behind a slow inference call, reintroducing the staleness the
    JPEG path's MAX_IN_FLIGHT=1 (documents/adr/0007) exists to prevent — just
    unboundedly instead of capped at one. This reproduces that same "one
    frame of staleness, never more" behavior on the backend instead: a
    receiver coroutine drains track.recv() as fast as frames arrive and
    always overwrites a single slot; the loop below only ever infers
    whatever is in that slot right now, dropping anything that arrived and
    was overwritten while inference was running.
    """
    slot: dict = {"frame": None}
    frame_ready = asyncio.Event()

    async def receiver() -> None:
        while True:
            try:
                frame = await track.recv()
            except Exception:
                break
            slot["frame"] = frame
            frame_ready.set()

    recv_task = asyncio.create_task(receiver())
    n = 0
    try:
        while True:
            await frame_ready.wait()
            frame_ready.clear()
            frame = slot["frame"]
            if frame is None:
                continue

            img = frame.to_ndarray(format="bgr24")

            try:
                if hasattr(eng, "infer_array"):
                    detections, timing = await eng.infer_array(img)
                else:
                    import cv2
                    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
                    if not ok:
                        continue
                    detections, timing = await eng.infer_frame(buf.tobytes())
            except Exception as e:
                log.error("webrtc frame inference error (user=%s): %s", user, e)
                await websocket.send_text(json.dumps({"error": str(e)[:200]}))
                continue

            n += 1
            await websocket.send_text(json.dumps({"boxes": detections, "timing": timing}))
            if n % FRAME_LOG_EVERY == 0:
                log.info("webrtc frame %d inferred (user=%s)", n, user)
    except Exception:
        pass
    finally:
        recv_task.cancel()
        log.info("webrtc inference loop ended after %d frames (user=%s)", n, user)


@router.websocket("/ws/webrtc-infer")
async def webrtc_infer_stream(websocket: WebSocket):
    """Signaling (one offer, one answer — non-trickle ICE for v1) followed
    by receiving a video track and inferring it. Same sign-in gate as
    /ws/infer, same 1008 handshake so the client can tell "sign in" from
    "unreachable". Engine choice comes from ?backend=, read once at connect
    time — same contract as _stream_inference in infer.py."""
    user = auth.read_session(websocket.cookies.get(auth.COOKIE_NAME, ""))
    if not user:
        await websocket.accept()
        await websocket.close(code=1008, reason="sign-in required")
        log.info("WS rejected (webrtc): not signed in")
        return

    await websocket.accept()

    if not aiortc_available():
        await websocket.send_text(json.dumps({
            "error": "WebRTC mode not available on this server (aiortc not installed)",
        }))
        await websocket.close(code=1011)
        return

    try:
        engine_name, eng = engine.resolve(websocket.query_params.get("backend"))
    except ValueError as e:
        await websocket.send_text(json.dumps({"error": str(e)}))
        await websocket.close()
        return

    from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription

    # Short-lived credentials for the self-hosted TURN relay (coturn on this
    # same box, port 3478 -- opened by the hosting provider 2026-11-17,
    # confirmed reachable with a real STUN/TURN packet, not just a raw
    # connect). Generated fresh per connection; sent to the browser as the
    # FIRST message, before any offer/answer, because the browser's
    # RTCPeerConnection needs its full iceServers list (including this) at
    # construction time -- before it starts gathering candidates, not after.
    # Always exactly one setup message before anything else, so the client
    # never has to guess whether one is coming -- a deployment with no TURN
    # configured still sends a plain "ready" so the client isn't left
    # waiting forever for a message that was never going to arrive.
    turn = turn_credentials.generate()
    if turn:
        await websocket.send_text(json.dumps({"type": "turn", **turn}))
    else:
        await websocket.send_text(json.dumps({"type": "ready"}))

    ice_servers = [RTCIceServer(urls="stun:stun.l.google.com:19302")]
    if turn:
        ice_servers.append(RTCIceServer(
            urls=[f"turn:{TURN_HOST}:3478?transport=udp", f"turn:{TURN_HOST}:3478?transport=tcp"],
            username=turn["username"], credential=turn["password"],
        ))
    # Without any ICE server this box only ever offers its own private
    # address as a candidate (it sits behind its hosting provider's private
    # network -- confirmed 2026-11-07), which the browser has no way to
    # reach. STUN alone reports a public address but can't open a door the
    # provider's firewall has closed for everything except a few fixed
    # ports -- that's what the TURN entry above is actually for.
    pc = RTCPeerConnection(RTCConfiguration(iceServers=ice_servers))
    track_task: asyncio.Task | None = None

    @pc.on("track")
    def on_track(track):
        nonlocal track_task
        if track.kind == "video":
            log.info("webrtc video track received (user=%s, engine=%s)", user, engine_name)
            track_task = asyncio.create_task(_consume_track(track, websocket, eng, user))

    @pc.on("connectionstatechange")
    async def on_state_change():
        log.info("webrtc connection state: %s (user=%s)", pc.connectionState, user)

    try:
        raw = await websocket.receive_text()
        msg = json.loads(raw)
        if msg.get("type") != "offer":
            await websocket.send_text(json.dumps({"error": "expected an offer"}))
            await websocket.close(code=1002)
            return

        await pc.setRemoteDescription(RTCSessionDescription(sdp=msg["sdp"], type="offer"))
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        await websocket.send_text(json.dumps({
            "type": "answer",
            "sdp": pc.localDescription.sdp,
        }))
        log.info("webrtc signaling complete (user=%s, engine=%s)", user, engine_name)

        # Nothing further to read from the client — the socket's own
        # close/disconnect is what ends the session; results are pushed from
        # _consume_track above, not in response to anything read here.
        while True:
            await websocket.receive_text()
    except Exception as e:
        log.info("webrtc session ended (user=%s): %s", user, e)
    finally:
        if track_task:
            track_task.cancel()
        await pc.close()
