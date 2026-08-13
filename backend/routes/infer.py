import logging
import secrets
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, WebSocket
from fastapi.responses import JSONResponse

from backend import auth
from backend.routes.auth import require_user
from backend.services import engine, modal_client

log = logging.getLogger("infer")

router = APIRouter()

UPLOAD_DIR = Path("/tmp/polyp-uploads")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

MAX_UPLOAD_MB = 500

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
async def case_new():
    """A case ID without starting a GPU.

    Feedback capture is filed per-case and is available in every mode,
    including the precomputed demos — which must not wake Modal. Session start
    below still returns one so the live modes keep working in a single call.
    """
    return {"case_id": _new_case_id()}


@router.get("/backends")
async def backends():
    """Which inference engines this deployment can serve, and which is default.

    The UI reads this so it only offers choices that will actually work, and so
    it can label the CPU models that are NOT polyp-trained.
    """
    return engine.availability()


@router.post("/session/start")
async def session_start(backend: str | None = None):
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
async def session_stop():
    """Marks the end of a session from the UI's point of view.

    It does NOT force the GPU container down, and deliberately does not
    pretend to: Modal exposes no API to kill a deployed app's running
    containers without undeploying the app itself, which would break the next
    user. Release happens through scaledown_window in inference/app.py (120s)
    instead — so the real saving comes from keeping that window short and from
    never starting a container we do not need, not from this call.
    """
    return {"status": "stopped"}


@router.post("/infer-video")
async def infer_video(file: UploadFile = File(...), user: str = Depends(require_user)):
    if not file.content_type or not file.content_type.startswith("video/"):
        raise HTTPException(status_code=400, detail="File must be a video")

    content = await file.read()
    if len(content) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"File exceeds {MAX_UPLOAD_MB} MB limit")

    log.info("infer_video: %s (%d bytes) for user %s", file.filename, len(content), user)
    try:
        return await modal_client.infer_video(content)
    except Exception as e:
        return JSONResponse(
            status_code=503,
            content={"error": f"Inference failed: {str(e)[:200]}"},
        )


async def _stream_inference(websocket: WebSocket, label: str):
    """Frame-in / boxes-out loop, shared by both websocket routes."""
    import json
    import time

    # Engine is fixed for the life of the socket: switching mid-stream would make
    # the latency average a blend of two very different numbers.
    try:
        engine_name, eng = engine.resolve(websocket.query_params.get("backend"))
    except ValueError as e:
        await websocket.send_text(json.dumps({"error": str(e)}))
        await websocket.close()
        return

    frame_n = 0
    latencies: list[int] = []
    log.info("WS session opened (%s) | engine=%s", label, engine_name)
    while True:
        try:
            t_recv = time.perf_counter()
            frame_bytes = await websocket.receive_bytes()
            recv_ms = int((time.perf_counter() - t_recv) * 1000)
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
            timing["recv_ms"] = recv_ms
            timing["total_ms"] = int((time.perf_counter() - t_total) * 1000)
            latencies.append(timing["modal_ms"])
            log.info(
                "frame %d | %s | %d bytes | infer=%dms total=%dms | %d boxes",
                frame_n, engine_name, len(frame_bytes), timing["modal_ms"],
                timing["total_ms"], len(detections),
            )
            await websocket.send_text(json.dumps({"boxes": detections, "timing": timing}))
        except Exception as e:
            log.error("frame %d inference error: %s", frame_n, e)
            await websocket.send_text(json.dumps({"error": str(e)[:200]}))


@router.websocket("/ws/infer")
async def infer_stream(websocket: WebSocket):
    """Live camera and screen share — open, no login. This is the real clinical
    path, and the footage never leaves the operator's own capture device."""
    await websocket.accept()
    await _stream_inference(websocket, "live")


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
    await _stream_inference(websocket, f"file/{user}")
