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
import collections
import json
import logging

from fastapi import APIRouter, WebSocket

from backend import auth
from backend.services import engine, turn_credentials

# The address THIS PROCESS uses to reach the TURN relay (coturn, same box).
# Deliberately the box's PRIVATE address, not its public one -- confirmed by
# direct testing 2026-11-18: a process can't reliably reach its own public
# IP from inside the same machine (a routing quirk called hairpin NAT; many
# providers' networks don't support it), even though that exact IP is fully
# reachable from the outside. A direct aioice.turn.create_turn_endpoint()
# call against the public IP timed out with zero log entries on coturn's
# side; the identical call against the private IP succeeded immediately.
# The BROWSER's TURN address is unaffected by this -- it's genuinely
# external, so it keeps using the public host (derived from the page's own
# URL in frontend/src/lib/webrtcTransport.ts, not this constant).
import os
TURN_HOST_INTERNAL = os.environ.get("TURN_HOST_INTERNAL", "192.168.158.12")

log = logging.getLogger("webrtc_infer")

router = APIRouter()

# How often the inference loop logs, so a real session doesn't spam one line
# per frame but still shows up quickly in the log.
FRAME_LOG_EVERY = 30

# Inferred frames kept, newest last, so the browser can ask "file frame #N"
# and get the exact picture its boxes were computed on -- the browser never
# has that frame itself in this mode. At the ~10 fps the CPU engine infers,
# 150 is ~15 s, comfortably more than auto-capture's 1 s best-frame window
# plus a slow round trip. ~230 KB each at 320px: ~35 MB per live session.
RING_FRAMES = 150
# ...but bounded by memory too, because the operator can stream larger
# frames (up to 960px wide: ~2 MB each raw). Past this budget fewer frames
# are kept: ~3 s at 960px, still well over the 1 s best-frame window.
RING_BYTES = 64 * 1024 * 1024
# Model input side when the engine doesn't say (the Modal engine).
DEFAULT_MODEL_SIDE = 640


def _model_side(eng) -> int:
    """The square side the model resizes every frame to (320 or 640 for the
    local RT-DETR variants -- local_cpu.MODELS[name][4])."""
    try:
        from backend.services import local_cpu
        return int(local_cpu.MODELS[eng.name][4])
    except Exception:
        return DEFAULT_MODEL_SIDE


def _fit_for_model(img, side: int):
    """Shrink a frame larger than the model's input BEFORE inference, with
    area averaging. The model's own resize (local_cpu._letterbox/_stretch)
    uses bilinear, which is right for small changes but skips detail and
    aliases on a 3x shrink (960 -> 320). The browser's own canvas shrink --
    what JPEG mode and 320px WebRTC send -- is a smooth one, and the model's
    thresholds were set on frames like that. Returns (image, factor to scale
    boxes back to the original frame)."""
    h, w = img.shape[:2]
    if max(h, w) <= side:
        return img, 1.0
    import cv2
    r = side / max(h, w)
    small = cv2.resize(img, (max(1, round(w * r)), max(1, round(h * r))),
                       interpolation=cv2.INTER_AREA)
    return small, w / small.shape[1]


def _scale_boxes(detections: list, k: float) -> list:
    out = []
    for d in detections:
        b = d.get("bbox")
        if isinstance(b, (list, tuple)) and len(b) == 4:
            d = {**d, "bbox": [round(float(v) * k, 1) for v in b]}
        out.append(d)
    return out


class _Session:
    """State shared between the frame loop and the control-message loop of
    one WebRTC connection. Single event loop, so no locking beyond `send`."""

    def __init__(self, websocket: WebSocket, user: str):
        self.websocket = websocket
        self.user = user
        self.recording = None  # webrtc_recorder.ServerRecording while one is open
        self.frame_no = 0
        # frame number -> (bgr image, recording id or None, offset in it)
        self.ring: "collections.OrderedDict[int, tuple]" = collections.OrderedDict()
        self._send_lock = asyncio.Lock()

    async def send(self, payload: dict) -> None:
        # Two tasks write to this socket now (results, control replies);
        # one writer at a time keeps their frames from interleaving.
        async with self._send_lock:
            await self.websocket.send_text(json.dumps(payload))

    def rec_mark(self):
        r = self.recording
        if r is None or r.paused or r.stopped:
            return None, None
        return r.id, r.offset_ms

    def remember(self, img) -> int:
        self.frame_no += 1
        rec_id, offset = self.rec_mark()
        self.ring[self.frame_no] = (img, rec_id, offset)
        keep = max(10, min(RING_FRAMES, RING_BYTES // max(1, img.nbytes)))
        while len(self.ring) > keep:
            self.ring.popitem(last=False)
        return self.frame_no


def aiortc_available() -> bool:
    """Honest, lazy answer — same shape as engine.modal_available(). A box
    that never installed aiortc must not be affected by this route existing;
    this is the only place that finds out either way."""
    try:
        import aiortc  # noqa: F401
        return True
    except ImportError:
        return False


async def _consume_track(track, sess: "_Session", eng) -> None:
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
    user = sess.user
    slot: dict = {"frame": None}
    frame_ready = asyncio.Event()
    model_side = _model_side(eng)

    async def receiver() -> None:
        while True:
            try:
                frame = await track.recv()
            except Exception:
                break
            slot["frame"] = frame
            frame_ready.set()
            # EVERY frame goes to the recording, not just the ones that get
            # inferred -- the recording should be the video, not a slideshow.
            if sess.recording is not None:
                sess.recording.push(frame)

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
            # The ring keeps the FULL received frame: captures get whatever
            # size the operator chose to stream, not the model's.
            frame_id = sess.remember(img)
            small, back = _fit_for_model(img, model_side)

            try:
                if hasattr(eng, "infer_array"):
                    detections, timing = await eng.infer_array(small)
                else:
                    import cv2
                    ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 85])
                    if not ok:
                        continue
                    detections, timing = await eng.infer_frame(buf.tobytes())
            except Exception as e:
                log.error("webrtc frame inference error (user=%s): %s", user, e)
                await sess.send({"error": str(e)[:200]})
                continue
            if back != 1.0:
                detections = _scale_boxes(detections, back)

            n += 1
            # `frame` is this result's number, for "file frame #N" below;
            # `rec` is where this frame sits in the open recording, so a
            # browser-side capture (dr-found) can link to that moment.
            # `w`/`h` is the size the boxes are in -- the frame as RECEIVED,
            # which WebRTC may have shrunk below what the browser sent on a
            # congested link; the browser rescales to its own canvas.
            out = {"boxes": detections, "timing": timing, "frame": frame_id,
                   "w": int(img.shape[1]), "h": int(img.shape[0])}
            rec_id, offset = sess.ring[frame_id][1:]
            if rec_id:
                out["rec"] = {"id": rec_id, "offset_ms": offset}
            await sess.send(out)
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
        # aiortc only ever uses the first turn: URL it finds for a given
        # RTCIceServer (confirmed by reading aiortc's own source,
        # rtcicetransport.py's connection_kwargs) -- one plain UDP URL is
        # enough here. TURN_HOST_INTERNAL, not a public address: this
        # connection is this same box talking to its own TURN relay.
        ice_servers.append(RTCIceServer(
            urls=f"turn:{TURN_HOST_INTERNAL}:3478",
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
    sess = _Session(websocket, user)

    @pc.on("track")
    def on_track(track):
        nonlocal track_task
        if track.kind == "video":
            log.info("webrtc video track received (user=%s, engine=%s)", user, engine_name)
            track_task = asyncio.create_task(_consume_track(track, sess, eng))

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
        await sess.send({"type": "answer", "sdp": pc.localDescription.sdp})
        log.info("webrtc signaling complete (user=%s, engine=%s)", user, engine_name)

        # From here on the client only sends control messages (record /
        # capture); results are pushed from _consume_track above. The
        # socket's own close/disconnect is what ends the session.
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            await _handle_control(sess, msg)
    except Exception as e:
        log.info("webrtc session ended (user=%s): %s", user, e)
    finally:
        if track_task:
            track_task.cancel()
        # A dropped connection must not leave a recording open forever: close
        # it now. Its metadata says why, so the next incident is readable.
        if sess.recording is not None and not sess.recording.stopped:
            rec, sess.recording = sess.recording, None
            await asyncio.to_thread(rec.stop, "disconnect")
        await pc.close()


async def _handle_control(sess: _Session, msg: dict) -> None:
    """Record and capture commands from the browser.

    The browser keeps all the DECIDING (auto-record's in-body rules,
    auto-capture's first/best tiers -- the same code JPEG mode runs); the
    server only does what it alone can: write the stream it is receiving, and
    file the exact frame a result was computed on."""
    kind = msg.get("type")
    if kind == "record":
        await _handle_record(sess, msg)
    elif kind == "capture":
        await _handle_capture(sess, msg)


async def _handle_record(sess: _Session, msg: dict) -> None:
    from fastapi import HTTPException
    from backend.services.webrtc_recorder import ServerRecording

    action = msg.get("action")
    rec = sess.recording
    if action == "start":
        if rec is not None and not rec.stopped:
            rec.resume()
        else:
            source = msg.get("source") if msg.get("source") in ("camera", "screen") else "camera"
            rec = ServerRecording(str(msg.get("case_id", "")), sess.user, source)
            try:
                await asyncio.to_thread(rec.start)
            except HTTPException as e:
                await sess.send({"type": "recording", "state": "error", "error": str(e.detail)})
                return
            except Exception as e:
                log.exception("server recording failed to start (user=%s)", sess.user)
                await sess.send({"type": "recording", "state": "error", "error": str(e)[:200]})
                return
            sess.recording = rec
            log.info("server recording %s started (user=%s, case=%s)", rec.id, sess.user, rec.case_id)
    elif rec is None or rec.stopped:
        await sess.send({"type": "recording", "state": "idle"})
        return
    elif action == "pause":
        rec.pause()
    elif action == "resume":
        rec.resume()
    elif action == "stop":
        sess.recording = None
        reason = str(msg.get("reason") or "manual")[:32]
        await asyncio.to_thread(rec.stop, reason)
        await sess.send({"type": "recording", "state": "complete", "recording_id": rec.id,
                         "case_id": rec.case_id, "duration_ms": rec.offset_ms})
        return
    else:
        return
    await sess.send({"type": "recording", "state": "paused" if rec.paused else "recording",
                     "recording_id": rec.id, "case_id": rec.case_id})


async def _handle_capture(sess: _Session, msg: dict) -> None:
    """File one inferred frame as an auto-capture, exactly as POST
    /feedback/{case}/auto-capture would -- same table, same fields -- but
    with the picture taken from the ring instead of uploaded."""
    from backend.routes import feedback

    ref = msg.get("ref")
    frame_id = msg.get("frame")
    entry = sess.ring.get(frame_id) if isinstance(frame_id, int) else None
    if entry is None:
        await sess.send({"type": "captured", "ref": ref, "error": "frame no longer held"})
        return
    img, rec_id, offset = entry
    case_id = str(msg.get("case_id", ""))
    capture_kind = msg.get("kind") if msg.get("kind") in ("first", "best") else ""
    try:
        import cv2
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 90])
        if not ok:
            raise ValueError("jpeg encode failed")
        filename = await asyncio.to_thread(
            feedback._save_and_record, case_id, buf.tobytes(), None,
            {"source": "auto", "status": "pending",
             "ai_detections": json.dumps(msg.get("boxes") or []),
             "recording_id": rec_id or "",
             "video_offset_ms": "" if offset is None else str(offset),
             "capture_kind": capture_kind})
    except Exception as e:
        log.warning("webrtc capture failed (user=%s): %s", sess.user, e)
        await sess.send({"type": "captured", "ref": ref, "error": str(e)[:200]})
        return
    await sess.send({"type": "captured", "ref": ref, "filename": filename, "case_id": case_id,
                     "width": int(img.shape[1]), "height": int(img.shape[0])})
