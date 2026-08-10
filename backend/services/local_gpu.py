"""Local GPU inference — same three-function surface as modal_client, but the
model runs inside this process on the machine's own NVIDIA GPU.

Used where the backend and the GPU are the same box (the IranServer deployment).
There is deliberately no separate inference service and no network hop:
experiments/RESULTS.md part 2 measured ~95% of the Modal round trip as invocation
overhead rather than compute (~11ms of actual GPU work inside a ~250ms call), so
deleting the hop is the entire point of this backend.

Model load is lazy and happens once per process. Ultralytics' predict path shares
mutable state on the model object and isn't documented as thread-safe, so forward
passes are serialised by a lock — free here, since the WebSocket route already
keeps exactly one frame in flight.
"""

import asyncio
import logging
import os
import threading
import time
from pathlib import Path

log = logging.getLogger("local_gpu")

# Same weights and threshold as inference/app.py. If these two drift apart, any
# comparison between the local and Modal backends stops meaning anything.
HF_REPO = "goktug14/yolov5_kvasir_polyp"
HF_FILE = "weights/best.pt"
CONF = 0.3

_model = None
_device = None
_load_lock = threading.Lock()
_infer_lock = threading.Lock()


def _weights_path() -> str:
    """Local file if POLYP_WEIGHTS is set, otherwise pull from HuggingFace once
    and let huggingface_hub cache it under ~/.cache/huggingface."""
    override = os.getenv("POLYP_WEIGHTS")
    if override:
        if not Path(override).exists():
            raise FileNotFoundError(f"POLYP_WEIGHTS is set to {override!r}, which does not exist")
        return override

    from huggingface_hub import hf_hub_download
    return hf_hub_download(repo_id=HF_REPO, filename=HF_FILE)


def _load():
    """Double-checked lazy load — the first request in and any concurrent ones
    must not each build their own copy of the model in VRAM."""
    global _model, _device
    if _model is not None:
        return _model

    with _load_lock:
        if _model is not None:
            return _model

        import torch
        from ultralytics import YOLO

        path = _weights_path()
        device = "cuda" if torch.cuda.is_available() else "cpu"
        if device == "cpu":
            # RESULTS.md part 3 measured ~800ms/frame on CPU, 3x worse than the
            # Modal round trip. Silently serving from CPU would read as a hang,
            # so make the reason obvious in the log.
            log.warning("No CUDA device visible — falling back to CPU (~800ms/frame, effectively unusable live)")

        model = YOLO(path)
        model.to(device)
        _device, _model = device, model
        log.info("Local model ready on %s | weights=%s", device, path)
        return _model


def available() -> bool:
    """Whether this backend can actually serve a request, used to decide what to
    offer in the UI rather than letting the user pick something that will fail."""
    try:
        import torch
        import ultralytics  # noqa: F401
    except ImportError:
        return False
    try:
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def device_name() -> str | None:
    try:
        import torch
        if torch.cuda.is_available():
            return torch.cuda.get_device_name(0)
    except Exception:
        pass
    return None


def _boxes(results) -> list[dict]:
    return [
        {
            "bbox": [round(x) for x in box.xyxy[0].tolist()],
            "conf": round(float(box.conf[0]), 3),
        }
        for box in results.boxes
    ]


def _infer_sync(frame_bytes: bytes) -> tuple[list[dict], float, float]:
    import cv2
    import numpy as np

    model = _load()

    t0 = time.perf_counter()
    frame = cv2.imdecode(np.frombuffer(frame_bytes, np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("payload was not a decodable image")
    decode_ms = (time.perf_counter() - t0) * 1000

    t1 = time.perf_counter()
    with _infer_lock:
        results = model(frame, conf=CONF, verbose=False)[0]
    gpu_ms = (time.perf_counter() - t1) * 1000

    return _boxes(results), decode_ms, gpu_ms


def _warm_sync() -> None:
    import numpy as np

    model = _load()
    # One real forward pass on a blank frame so the first clinical frame doesn't
    # pay for CUDA context setup and kernel autotuning.
    blank = np.zeros((480, 640, 3), dtype=np.uint8)
    with _infer_lock:
        model(blank, conf=CONF, verbose=False)


def _infer_video_sync(video_bytes: bytes) -> dict:
    import os as _os
    import tempfile

    import cv2

    model = _load()

    # A unique temp file per call — the Modal version writes a fixed
    # /tmp/input.mp4, which would corrupt results if two uploads ever overlapped.
    fd, path = tempfile.mkstemp(suffix=".mp4", prefix="polyp-infer-")
    try:
        with _os.fdopen(fd, "wb") as f:
            f.write(video_bytes)

        cap = cv2.VideoCapture(path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        frames_detections = []
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            with _infer_lock:
                results = model(frame, conf=CONF, verbose=False)[0]
            frames_detections.append(_boxes(results))

        cap.release()
        return {"fps": fps, "width": width, "height": height, "frames": frames_detections}
    finally:
        _os.unlink(path)


async def warmup() -> str:
    await asyncio.to_thread(_warm_sync)
    return "ready"


async def infer_frame(frame_bytes: bytes) -> tuple[list[dict], dict]:
    t0 = time.perf_counter()
    boxes, decode_ms, gpu_ms = await asyncio.to_thread(_infer_sync, frame_bytes)
    total_ms = int((time.perf_counter() - t0) * 1000)

    # "modal_ms" is a misnomer for this backend and is kept on purpose: it is the
    # key the frontend already reads for its latency readout, so keeping it means
    # the UI works against either backend with no change. decode_ms/gpu_ms are
    # extra and let a benchmark separate compute from everything around it.
    return boxes, {
        "modal_ms": total_ms,
        "decode_ms": round(decode_ms, 2),
        "gpu_ms": round(gpu_ms, 2),
    }


async def infer_video(video_bytes: bytes) -> dict:
    return await asyncio.to_thread(_infer_video_sync, video_bytes)
