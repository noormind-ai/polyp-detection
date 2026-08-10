import logging
import secrets
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile, WebSocket
from fastapi.responses import JSONResponse

from backend.services import inference

log = logging.getLogger("infer")

router = APIRouter()

UPLOAD_DIR = Path("/tmp/polyp-uploads")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

MAX_UPLOAD_MB = 500


def _new_case_id() -> str:
    """Random per-session study ID — never a patient name or MRN. Feedback
    captures during this session are filed under this ID, not identifying info."""
    return secrets.token_hex(4)  # e.g. "a1b2c3d4"


@router.get("/backends")
async def backends():
    """Which inference backends this deployment can serve, and which is default.
    The UI calls this before offering the choice so it never lists one that fails."""
    return inference.availability()


@router.post("/session/start")
async def session_start(backend: str | None = None):
    try:
        name, _ = await inference.warmup(backend)
        return {"status": "ready", "case_id": _new_case_id(), "backend": name}
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except Exception as e:
        wanted = backend or inference.default_backend()
        hint = (
            "Is the GPU model loadable? Check torch.cuda.is_available() and the weights path."
            if wanted == "local"
            else "Is the app deployed? Run: modal deploy inference/app.py"
        )
        return JSONResponse(
            status_code=503,
            content={"error": f"{wanted} backend unreachable: {str(e)[:200]}. {hint}"},
        )


@router.post("/session/stop")
async def session_stop():
    return {"status": "stopped"}


@router.post("/infer-video")
async def infer_video(file: UploadFile = File(...), backend: str | None = None):
    if not file.content_type or not file.content_type.startswith("video/"):
        raise HTTPException(status_code=400, detail="File must be a video")

    content = await file.read()
    if len(content) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"File exceeds {MAX_UPLOAD_MB} MB limit")

    try:
        return await inference.infer_video(content, backend)
    except Exception as e:
        return JSONResponse(
            status_code=503,
            content={"error": f"Inference failed: {str(e)[:200]}"},
        )


@router.websocket("/ws/infer")
async def infer_stream(websocket: WebSocket):
    import json
    import time
    await websocket.accept()
    # Backend is fixed for the life of the socket: switching mid-stream would make
    # the latency average a blend of two very different numbers.
    requested = websocket.query_params.get("backend")
    try:
        backend_name, _ = inference.resolve(requested)
    except ValueError as e:
        await websocket.send_text(json.dumps({"error": str(e)}))
        await websocket.close()
        return

    frame_n = 0
    log.info("WS session opened | backend=%s", backend_name)
    while True:
        try:
            t_recv = time.perf_counter()
            frame_bytes = await websocket.receive_bytes()
            recv_ms = int((time.perf_counter() - t_recv) * 1000)
        except Exception:
            log.info("WS session closed after %d frames", frame_n)
            break

        frame_n += 1
        t_total = time.perf_counter()
        try:
            detections, timing = await inference.infer_frame(frame_bytes, backend_name)
            timing["recv_ms"] = recv_ms
            timing["total_ms"] = int((time.perf_counter() - t_total) * 1000)
            log.info(
                "frame %d | %s | %d bytes | infer=%dms total=%dms | %d boxes",
                frame_n, backend_name, len(frame_bytes), timing["modal_ms"], timing["total_ms"], len(detections),
            )
            await websocket.send_text(json.dumps({"boxes": detections, "timing": timing}))
        except Exception as e:
            log.error("frame %d inference error: %s", frame_n, e)
            await websocket.send_text(json.dumps({"error": str(e)[:200]}))
