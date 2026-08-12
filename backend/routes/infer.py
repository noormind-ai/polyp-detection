import logging
import secrets
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, WebSocket
from fastapi.responses import JSONResponse

from backend import auth
from backend.routes.auth import require_user
from backend.services import modal_client

log = logging.getLogger("infer")

router = APIRouter()

UPLOAD_DIR = Path("/tmp/polyp-uploads")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

MAX_UPLOAD_MB = 500


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


@router.post("/session/start")
async def session_start():
    """Boot the GPU container. Called when someone opens live camera or screen
    share — NOT on page load, and never for the demos."""
    try:
        await modal_client.warmup()
        return {"status": "ready", "case_id": _new_case_id()}
    except Exception as e:
        return JSONResponse(
            status_code=503,
            content={"error": f"Modal unreachable: {str(e)[:200]}. Is the app deployed? Run: modal deploy inference/app.py"},
        )


@router.post("/session/stop")
async def session_stop():
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
    frame_n = 0
    log.info("WS session opened (%s)", label)
    while True:
        try:
            t_recv = time.perf_counter()
            frame_bytes = await websocket.receive_bytes()
            recv_ms = int((time.perf_counter() - t_recv) * 1000)
        except Exception:
            log.info("WS session closed (%s) after %d frames", label, frame_n)
            break

        frame_n += 1
        t_total = time.perf_counter()
        try:
            detections, timing = await modal_client.infer_frame(frame_bytes)
            timing["recv_ms"] = recv_ms
            timing["total_ms"] = int((time.perf_counter() - t_total) * 1000)
            log.info(
                "frame %d | %d bytes | modal=%dms total=%dms | %d boxes",
                frame_n, len(frame_bytes), timing["modal_ms"], timing["total_ms"], len(detections),
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
