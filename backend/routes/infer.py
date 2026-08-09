import logging
import secrets
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile, WebSocket
from fastapi.responses import JSONResponse

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


@router.post("/session/start")
async def session_start():
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
async def infer_video(file: UploadFile = File(...)):
    if not file.content_type or not file.content_type.startswith("video/"):
        raise HTTPException(status_code=400, detail="File must be a video")

    content = await file.read()
    if len(content) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"File exceeds {MAX_UPLOAD_MB} MB limit")

    try:
        return await modal_client.infer_video(content)
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
    frame_n = 0
    log.info("WS session opened")
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
