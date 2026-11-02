import asyncio
import logging
import secrets
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, WebSocket
from fastapi.responses import JSONResponse

from backend import auth
from backend.routes.auth import require_user
from backend.routes.feedback import _check_id
from backend.services import engine, spectate_bus
from backend.services.tracker import PersistenceTracker

log = logging.getLogger("infer")

router = APIRouter()

# Keeps references to in-flight spectator broadcasts so asyncio can't garbage
# collect a task mid-send (an unreferenced task is fair game for collection —
# see the asyncio docs' own warning about this). Self-cleaning via the
# done callback; never inspected otherwise.
_spectate_tasks: set[asyncio.Task] = set()

UPLOAD_DIR = Path("/tmp/polyp-uploads")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

MAX_UPLOAD_MB = 500

# How often _stream_frames wakes up with no frame in hand, purely to check
# whether another tab/device asked this session to stop (see
# POST /api/sessions/{case_id}/stop). Short enough that a stop request lands
# quickly; long enough not to spin the loop while idle out-of-body.
STOP_POLL_INTERVAL_S = 2.0

# One row per streaming session, so engine comparisons are a spreadsheet rather
# than a grep over the log. Deliberately session-level: per-frame rows would be
# tens of thousands of lines a day for numbers nobody reads individually.
BENCH_CSV = Path(__file__).resolve().parents[1] / "data" / "bench" / "sessions.csv"
BENCH_HEADER = "ts,engine,label,frames,median_ms,p90_ms,min_ms,max_ms,fps\n"


def _record_session(engine_name: str, label: str, latencies: list[int]) -> None:
    """Append a session summary. Never let a logging failure kill a session."""
    try:
        import datetime
        s = sorted(latencies)
        med = s[len(s) // 2]
        BENCH_CSV.parent.mkdir(parents=True, exist_ok=True)
        new = not BENCH_CSV.exists()
        with BENCH_CSV.open("a", encoding="utf-8") as fh:
            if new:
                fh.write(BENCH_HEADER)
            fh.write(
                f"{datetime.datetime.now().isoformat(timespec='seconds')},{engine_name},"
                f"{label},{len(s)},{med},{s[int(0.9 * (len(s) - 1))]},{s[0]},{s[-1]},"
                f"{1000 / med if med else 0:.1f}\n"
            )
    except Exception as e:
        log.warning("could not record session benchmark: %s", e)


def _new_case_id() -> str:
    """Random per-session study ID — never a patient name or MRN. Feedback
    captures during this session are filed under this ID, not identifying info."""
    return secrets.token_hex(4)  # e.g. "a1b2c3d4"


@router.post("/case/new")
async def case_new(user: str = Depends(require_user)):
    """A case ID without starting a GPU.

    Feedback capture is filed per-case and is available in every mode,
    including the precomputed demos — which must not wake Modal. Session start
    below still returns one so the live modes keep working in a single call.
    """
    return {"case_id": _new_case_id()}


@router.get("/backends")
async def backends(user: str = Depends(require_user)):
    """Which inference engines this deployment can serve, and which is default.

    The UI reads this so it only offers choices that will actually work, and so
    it can label the CPU models that are NOT polyp-trained.
    """
    return engine.availability()


@router.post("/session/start")
async def session_start(backend: str | None = None, user: str = Depends(require_user)):
    """Boot the engine. Called when someone opens live camera or screen share —
    NOT on page load, and never for the demos.

    For a CPU engine there is no container to provision; warmup just builds the
    ONNX session so the first clinical frame doesn't pay for it.
    """
    try:
        name, eng = engine.resolve(backend)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})

    try:
        await eng.warmup()
        return {"status": "ready", "case_id": _new_case_id(), "backend": name}
    except Exception as e:
        hint = (
            "Is the app deployed? Run: modal deploy inference/app.py"
            if name == "modal"
            else "Are the .onnx files present in backend/models/ and onnxruntime installed?"
        )
        return JSONResponse(
            status_code=503,
            content={"error": f"{name} unreachable: {str(e)[:200]}. {hint}"},
        )


@router.post("/session/stop")
async def session_stop(user: str = Depends(require_user)):
    """Marks the end of a session from the UI's point of view.

    It does NOT force the GPU container down, and deliberately does not
    pretend to: Modal exposes no API to kill a deployed app's running
    containers without undeploying the app itself, which would break the next
    user. Release happens through scaledown_window in inference/app.py (120s)
    instead — so the real saving comes from keeping that window short and from
    never starting a container we do not need, not from this call.
    """
    return {"status": "stopped"}


@router.get("/sessions/active")
async def sessions_active(user: str = Depends(require_user)):
    """Live-camera rooms open right now, for any signed-in operator -- not
    gated on the spectator allowlist like /api/spectate/rooms, because this
    is about avoiding a collision with your own clinic PC, not watching
    someone else's procedure.

    In-memory, same as the rest of spectate_bus: a backend restart forgets
    active rooms, and only label=="live" sessions are tracked here -- a
    file replay never calls mark_room_active."""
    return {"rooms": spectate_bus.list_active_rooms()}


@router.post("/sessions/{case_id}/stop")
async def sessions_stop(case_id: str, user: str = Depends(require_user)):
    """Ask a session running in a DIFFERENT tab/device to end itself --
    the caller's own session already has session/stop for that. The
    websocket loop in _stream_frames polls for this between frames, since
    nothing else can reach into a socket this process does not own."""
    _check_id(case_id, "case_id")
    log.info("operator %s requested stop of case %s", user, case_id)
    spectate_bus.request_stop(case_id)
    return {"ok": True, "requested": True}


@router.post("/infer-video")
async def infer_video(file: UploadFile = File(...), user: str = Depends(require_user),
                      backend: str | None = None):
    if not file.content_type or not file.content_type.startswith("video/"):
        raise HTTPException(status_code=400, detail="File must be a video")

    content = await file.read()
    if len(content) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"File exceeds {MAX_UPLOAD_MB} MB limit")

    log.info("infer_video: %s (%d bytes) for user %s", file.filename, len(content), user)
    try:
        _, eng = engine.resolve(backend)
        return await eng.infer_video(content)
    except Exception as e:
        return JSONResponse(
            status_code=503,
            content={"error": f"Inference failed: {str(e)[:200]}"},
        )


async def _stream_inference(websocket: WebSocket, label: str, user: str | None = None):
    """Frame-in / boxes-out loop, shared by both websocket routes. Owns the
    room-lobby bookkeeping (mark active/inactive) around the actual frame
    loop in _stream_frames, so that bookkeeping runs exactly once per
    connection regardless of how the loop below exits.

    `user` is whoever this socket authenticated as -- carried through to
    mark_room_active purely so /api/sessions/active can tell a second
    operator who already has this case open."""
    import json

    # Engine is fixed for the life of the socket: switching mid-stream would make
    # the latency average a blend of two very different numbers.
    try:
        engine_name, eng = engine.resolve(websocket.query_params.get("backend"))
    except ValueError as e:
        await websocket.send_text(json.dumps({"error": str(e)}))
        await websocket.close()
        return

    # Optional: lets spectator mode key its broadcasts to this session without
    # the room client needing to do anything else. Absent entirely for older
    # clients or the file-replay socket — both fall back to no broadcasting.
    case_id = websocket.query_params.get("case_id")
    # Only a real live-camera session is a "room" the spectator lobby lists —
    # label is "live" only for /ws/infer; a file-replay session (label
    # "file/{user}") is one person's own test, not something for anyone else
    # to watch, so it never appears there even if it happens to carry a case_id.
    is_room = label == "live" and bool(case_id)
    if is_room:
        spectate_bus.mark_room_active(case_id, engine_name, user)

    # ByteTrack is NOT run on the live stream as of 2026-10-11 -- see
    # documents/adr/0005-detection-gates-off-by-default.md.
    #
    # It used to run unconditionally here, and the comment at the send site
    # claimed it only tagged boxes and dropped nothing. That was wrong, in two
    # ways that both cost exactly the detection this product exists to surface:
    #
    #   1. BYTETracker sets det_thresh = track_thresh + 0.1 = 0.40
    #      (bytetrack/byte_tracker.py:143) and skips any unmatched detection
    #      below it when initialising new tracks (step 4, ~line 258). So a
    #      NEWLY appearing lesion needed conf >= 0.40 even though the model is
    #      served at 0.30 -- a 0.1 confidence gate nobody chose.
    #   2. STrack.activate() only sets is_activated when frame_id == 1 (~line
    #      49), and update() returns only activated tracks (~line 277). So a
    #      lesion first seen on any later frame was withheld until it was
    #      matched a second time -- a hidden, always-on, non-switchable 2-frame
    #      persistence rule, duplicating the client gate it was meant to be an
    #      alternative to.
    #
    # Boxes were also taken from the Kalman state (t.tlbr), not the model's
    # output. tracker.py and bytetrack/ stay in the tree for offline replay
    # work; this is the only live call site.
    tracker = None

    log.info("WS session opened (%s) | engine=%s", label, engine_name)
    try:
        await _stream_frames(websocket, label, engine_name, eng, tracker, case_id)
    finally:
        if is_room:
            spectate_bus.mark_room_inactive(case_id)


async def _stream_frames(websocket: WebSocket, label: str, engine_name: str, eng, tracker, case_id: str | None):
    import json
    import time

    frame_n = 0
    latencies: list[int] = []
    while True:
        try:
            t_recv = time.perf_counter()
            frame_bytes = await asyncio.wait_for(
                websocket.receive_bytes(), timeout=STOP_POLL_INTERVAL_S,
            )
            recv_ms = int((time.perf_counter() - t_recv) * 1000)
        except asyncio.TimeoutError:
            # Nothing arrived in STOP_POLL_INTERVAL_S -- completely normal
            # out-of-body (the client sends no frames at all while paused), so
            # this is NOT treated as a disconnect. The only thing worth waking
            # up for is a stop requested from a different tab/device, since
            # nothing else can reach into a websocket this process does not own.
            if case_id and spectate_bus.stop_requested(case_id):
                log.info(
                    "WS session stopped by operator request (%s) | case=%s | %d frames",
                    label, case_id, frame_n,
                )
                try:
                    await websocket.close(code=1000, reason="stopped by operator")
                except Exception:
                    pass
                break
            continue
        except Exception:
            # Summarise on close. Comparing engines means comparing
            # distributions, and grepping several hundred per-frame lines to get
            # there is the kind of chore that stops anyone from doing it.
            if latencies:
                s = sorted(latencies)
                med = s[len(s) // 2]
                log.info(
                    "WS session closed (%s) | engine=%s | %d frames | "
                    "infer median=%dms p90=%dms min=%dms max=%dms | %.1f fps",
                    label, engine_name, frame_n, med, s[int(0.9 * (len(s) - 1))],
                    s[0], s[-1], 1000 / med if med else 0.0,
                )
                _record_session(engine_name, label, latencies)
            else:
                log.info("WS session closed (%s) after %d frames", label, frame_n)
            break

        frame_n += 1
        t_total = time.perf_counter()
        try:
            detections, timing = await eng.infer_frame(frame_bytes)
            # Raw model output, straight to the browser. `tracker` is None on
            # the live path (see above); the guard keeps the offline/experiment
            # path working if one is wired back in.
            if tracker is not None:
                detections = tracker.update(detections)
            timing["recv_ms"] = recv_ms
            timing["total_ms"] = int((time.perf_counter() - t_total) * 1000)
            latencies.append(timing["modal_ms"])
            log.info(
                "frame %d | %s | %d bytes | infer=%dms total=%dms recv=%dms | %d boxes",
                frame_n, engine_name, len(frame_bytes), timing["modal_ms"],
                timing["total_ms"], timing["recv_ms"], len(detections),
            )
            await websocket.send_text(json.dumps({"boxes": detections, "timing": timing}))

            # Fire-and-forget: a spectator problem (slow consumer, dead
            # socket) must never slow or break the response the room client
            # just got above. Cheapest possible no-op when nobody is
            # watching — has_subscribers is one dict lookup.
            if case_id and spectate_bus.has_subscribers(case_id):
                # The JPEG travels as raw bytes framed alongside the JSON in one
                # binary message (see spectate_bus.pack), not base64 inside it:
                # encoding it cost a flat 33% on much the largest part of every
                # message, for every spectator, every frame.
                task = asyncio.create_task(spectate_bus.broadcast(case_id, {
                    "boxes": detections,
                    "timing": timing,
                    # Lets a spectator measure its own true delivery lag
                    # (Date.now() - sent_at_ms on arrival) instead of guessing
                    # — it never sends a frame of its own to time a round trip
                    # against, unlike the room client.
                    "sent_at_ms": int(time.time() * 1000),
                    # Whatever the room last reported about its own
                    # connection (see /spectate/{case_id}/room-stats) --
                    # None until its first report lands. Just a cached-value
                    # lookup, no extra cost when no report has arrived yet.
                    "room_stats": spectate_bus.get_room_stats(case_id),
                }, frame_bytes))
                _spectate_tasks.add(task)
                task.add_done_callback(_spectate_tasks.discard)
        except Exception as e:
            log.error("frame %d inference error: %s", frame_n, e)
            await websocket.send_text(json.dumps({"error": str(e)[:200]}))


@router.websocket("/ws/infer")
async def infer_stream(websocket: WebSocket):
    """Live camera and screen share.

    This used to be open on the grounds that the footage never leaves the
    operator's capture device. It is gated now because the rest of the app is:
    an anonymous caller could still spend GPU here, and leaving one unlocked
    door makes "is this server closed?" unanswerable. Same 1008 handshake as
    the file path, so the client can tell "sign in" from "unreachable".
    """
    user = auth.read_session(websocket.cookies.get(auth.COOKIE_NAME, ""))
    if not user:
        await websocket.accept()
        await websocket.close(code=1008, reason="sign-in required")
        log.info("WS rejected (live): not signed in")
        return
    await websocket.accept()
    await _stream_inference(websocket, "live", user)


@router.websocket("/ws/infer-file")
async def infer_stream_file(websocket: WebSocket):
    """Frame-by-frame inference on a video the user supplied — same GPU cost as
    the whole-file upload, so it is gated the same way.

    The handshake carries cookies (same origin as the page), so the session is
    read straight off the request. Policy violations close with 1008 rather
    than rejecting, so the client can tell "not signed in" apart from "server
    unreachable" and show a login prompt instead of a connection error.
    """
    user = auth.read_session(websocket.cookies.get(auth.COOKIE_NAME, ""))
    if not user:
        await websocket.accept()
        await websocket.close(code=1008, reason="sign-in required")
        log.info("WS rejected (file): not signed in")
        return
    await websocket.accept()
    await _stream_inference(websocket, f"file/{user}", user)
