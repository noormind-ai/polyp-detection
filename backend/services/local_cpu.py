"""CPU inference — same three-function surface as modal_client and local_gpu,
but the model runs in this process on the CPU, through ONNX Runtime.

Why not reuse local_gpu with device="cpu": that path needs torch + ultralytics,
~2 GB installed. call2fly runs a dozen unrelated production services with a few
GB of RAM free and deliberately has no torch (see services/inference.py). ONNX
Runtime + numpy is ~150 MB, so the whole pipeline here — letterbox, decode, NMS —
is hand-written against numpy rather than borrowed from ultralytics.

Serves several models, selected as "cpu:<name>", so the UI can offer a real
comparison from one box:

    cpu:yolo11n_polyp  the polyp fine-tune (2026-08-13). Real detections, fastest.
    cpu:yolov5m        the long-deployed polyp detector. Real detections.
    cpu:yolo11n        stock COCO weights. NOT polyp-trained — a speed probe only.
    cpu:yolo26n        stock COCO weights. NOT polyp-trained — a speed probe only.

The two stock models are what proved the CPU was fast enough to be worth
fine-tuning for. They find essentially nothing on colonoscopy frames, and that
is expected — they are kept only as a latency reference.

Every model carries its own frame confidence threshold, because confidence
scales are not comparable across architectures: scored on the 108 report-linked
studies, yolov5m peaks at 0.30 and yolo11n_polyp at 0.50.

Inference runs at 320 px because the frontend already downsizes frames to 320
(RealtimePlayer.tsx:21) — running at ultralytics' default 640 pays 4x the compute
to upscale pixels that were discarded at capture.
"""

import asyncio
import logging
import os
import threading
import time
from pathlib import Path

import numpy as np

log = logging.getLogger("local_cpu")

MODELS_DIR = Path(os.getenv("POLYP_CPU_MODELS", Path(__file__).resolve().parents[1] / "models"))
IMGSZ = 320
# Fallback only — each model carries its own threshold in MODELS below.
# Confidence scales are NOT comparable across architectures: on the 108
# report-linked studies yolov5m peaks at frame-conf 0.30 while the yolo11n
# fine-tune peaks at 0.50. Serving the nano at 0.30 floods the screen; serving
# it at 0.70 (the old study rule) found 6 of 31 studies instead of 24.
CONF = 0.3
IOU = 0.45

# Threads for the ONNX session. 4 is the measured sweet spot on the 8-vCPU
# call2fly box: it gives 3.3x over one thread (82% efficiency) while leaving half
# the machine to the dozen other services sharing it. Going to 8 buys only 4.9x
# total (62%) and would starve them.
THREADS = int(os.getenv("POLYP_CPU_THREADS", "4"))

# name -> (onnx file, UI label, detects polyps?, frame confidence threshold)
MODELS = {
    "yolo11n_polyp": ("yolo11n_polyp.onnx", "YOLO11n · polyp fine-tune · fastest", True, 0.50),
    "yolov5m": ("yolov5m.onnx", "YOLOv5m · polyp (deployed model)", True, 0.30),
    "yolo11n": ("yolo11n.onnx", "YOLO11n · NOT polyp-trained — speed test only", False, 0.30),
    "yolo26n": ("yolo26n.onnx", "YOLO26n · NOT polyp-trained — speed test only", False, 0.30),
}
DEFAULT_MODEL = "yolov5m"

_sessions: dict[str, object] = {}
_load_lock = threading.Lock()


# ---------------------------------------------------------------------------
# model loading
# ---------------------------------------------------------------------------
def model_path(name: str) -> Path:
    return MODELS_DIR / MODELS[name][0]


def _session(name: str):
    """Double-checked lazy load, one ONNX session per model per process."""
    sess = _sessions.get(name)
    if sess is not None:
        return sess

    with _load_lock:
        if name in _sessions:
            return _sessions[name]

        import onnxruntime as ort

        path = model_path(name)
        if not path.exists():
            raise FileNotFoundError(f"model not found: {path}")

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = THREADS
        opts.inter_op_num_threads = 1
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

        sess = ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"])
        _sessions[name] = sess
        log.info("CPU model ready | %s | %s | threads=%d", name, path.name, THREADS)
        return sess


def available() -> bool:
    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        return False
    return any(model_path(n).exists() for n in MODELS)


def available_models() -> list[dict]:
    """What the UI can actually offer, with labels that say which are real."""
    return [
        {"name": n, "label": label, "polyp_trained": trained,
         "conf": conf, "backend": f"cpu:{n}"}
        for n, (_, label, trained, conf) in MODELS.items()
        if model_path(n).exists()
    ]


def device_name() -> str | None:
    try:
        with open("/proc/cpuinfo") as fh:
            for line in fh:
                if line.startswith("model name"):
                    return f"{line.split(':', 1)[1].strip()} ({THREADS} threads)"
    except OSError:
        pass
    import platform
    return f"{platform.processor() or 'CPU'} ({THREADS} threads)"


# ---------------------------------------------------------------------------
# pre / post processing
# ---------------------------------------------------------------------------
def _letterbox(frame: np.ndarray) -> tuple[np.ndarray, float, int, int]:
    """Resize preserving aspect ratio, pad to IMGSZ with grey. Returns the
    tensor plus the ratio and padding needed to map boxes back to frame pixels."""
    import cv2

    h, w = frame.shape[:2]
    r = min(IMGSZ / h, IMGSZ / w)
    nh, nw = round(h * r), round(w * r)
    resized = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_LINEAR)

    canvas = np.full((IMGSZ, IMGSZ, 3), 114, dtype=np.uint8)
    top, left = (IMGSZ - nh) // 2, (IMGSZ - nw) // 2
    canvas[top:top + nh, left:left + nw] = resized

    # BGR->RGB, HWC->CHW, 0-255 -> 0-1
    x = canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0
    return np.ascontiguousarray(x), r, left, top


def _nms(boxes: np.ndarray, scores: np.ndarray, iou_thr: float) -> list[int]:
    """Plain greedy NMS. boxes are xyxy."""
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1).clip(0) * (y2 - y1).clip(0)
    order = scores.argsort()[::-1]

    keep = []
    while order.size:
        i = order[0]
        keep.append(int(i))
        if order.size == 1:
            break
        rest = order[1:]
        xx1 = np.maximum(x1[i], x1[rest])
        yy1 = np.maximum(y1[i], y1[rest])
        xx2 = np.minimum(x2[i], x2[rest])
        yy2 = np.minimum(y2[i], y2[rest])
        inter = (xx2 - xx1).clip(0) * (yy2 - yy1).clip(0)
        iou = inter / (areas[i] + areas[rest] - inter + 1e-9)
        order = rest[iou <= iou_thr]
    return keep


def _decode(out: np.ndarray, conf_thr: float) -> tuple[np.ndarray, np.ndarray]:
    """Normalise the two output layouts these exports produce into (xyxy, conf).

    (1, 4+nc, N)  anchor-style raw output — YOLOv5m (nc=2) and YOLO11n (nc=80).
                  Boxes are xywh centre form and still need NMS.
    (1, N, 6)     YOLO26 is NMS-free end-to-end: rows are already
                  [x1, y1, x2, y2, conf, cls], sorted, no NMS wanted.
    """
    o = out[0]

    if o.ndim == 2 and o.shape[1] == 6 and o.shape[0] != 6:
        xyxy = o[:, :4].astype(np.float32)
        conf = o[:, 4].astype(np.float32)
        m = conf >= conf_thr
        return xyxy[m], conf[m]

    p = o.T                                   # (N, 4+nc)
    xywh, cls_scores = p[:, :4], p[:, 4:]
    conf = cls_scores.max(axis=1)
    cls_id = cls_scores.argmax(axis=1)
    m = conf >= conf_thr
    xywh, conf, cls_id = xywh[m], conf[m], cls_id[m]
    if not len(xywh):
        return np.empty((0, 4), np.float32), np.empty((0,), np.float32)

    cx, cy, w, h = xywh[:, 0], xywh[:, 1], xywh[:, 2], xywh[:, 3]
    xyxy = np.stack([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], axis=1)

    # Class-aware NMS, as ultralytics does it: shift each class into its own
    # coordinate band so boxes of different classes can never suppress each
    # other. Class-agnostic NMS silently drops real detections — it cost 3 of 15
    # boxes on the 80-class COCO model before this was added.
    keep = _nms(xyxy + (cls_id * 7680.0)[:, None], conf, IOU)
    return xyxy[keep], conf[keep]


def _to_frame_coords(xyxy: np.ndarray, r: float, pad_x: int, pad_y: int,
                     shape: tuple[int, int]) -> np.ndarray:
    """Undo the letterbox so boxes are in original-frame pixels."""
    if not len(xyxy):
        return xyxy
    out = xyxy.copy()
    out[:, [0, 2]] = (out[:, [0, 2]] - pad_x) / r
    out[:, [1, 3]] = (out[:, [1, 3]] - pad_y) / r
    h, w = shape
    out[:, [0, 2]] = out[:, [0, 2]].clip(0, w)
    out[:, [1, 3]] = out[:, [1, 3]].clip(0, h)
    return out


# ---------------------------------------------------------------------------
# inference
# ---------------------------------------------------------------------------
def _predict(name: str, frame: np.ndarray) -> tuple[list[dict], float]:
    sess = _session(name)
    conf_thr = MODELS[name][3]
    x, r, pad_x, pad_y = _letterbox(frame)

    t = time.perf_counter()
    out = sess.run(None, {sess.get_inputs()[0].name: x})[0]
    infer_ms = (time.perf_counter() - t) * 1000

    xyxy, conf = _decode(out, conf_thr)
    xyxy = _to_frame_coords(xyxy, r, pad_x, pad_y, frame.shape[:2])
    boxes = [
        {"bbox": [round(float(v)) for v in box], "conf": round(float(c), 3)}
        for box, c in zip(xyxy, conf)
    ]
    return boxes, infer_ms


def _infer_sync(name: str, frame_bytes: bytes) -> tuple[list[dict], float, float]:
    import cv2

    t0 = time.perf_counter()
    frame = cv2.imdecode(np.frombuffer(frame_bytes, np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("payload was not a decodable image")
    decode_ms = (time.perf_counter() - t0) * 1000

    boxes, infer_ms = _predict(name, frame)
    return boxes, decode_ms, infer_ms


def _infer_video_sync(name: str, video_bytes: bytes) -> dict:
    import os as _os
    import tempfile

    import cv2

    fd, path = tempfile.mkstemp(suffix=".mp4", prefix="polyp-cpu-")
    try:
        with _os.fdopen(fd, "wb") as f:
            f.write(video_bytes)

        cap = cv2.VideoCapture(path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        frames = []
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            boxes, _ = _predict(name, frame)
            frames.append(boxes)
        cap.release()
        return {"fps": fps, "width": width, "height": height, "frames": frames}
    finally:
        _os.unlink(path)


class _Bound:
    """Adapter exposing the standard backend surface for one chosen model, so
    services/inference.py can keep calling mod.infer_frame(frame_bytes)."""

    def __init__(self, name: str):
        self.name = name

    async def warmup(self) -> str:
        def _warm():
            blank = np.zeros((480, 640, 3), dtype=np.uint8)
            _predict(self.name, blank)
        await asyncio.to_thread(_warm)
        return "ready"

    async def infer_frame(self, frame_bytes: bytes) -> tuple[list[dict], dict]:
        t0 = time.perf_counter()
        boxes, decode_ms, infer_ms = await asyncio.to_thread(_infer_sync, self.name, frame_bytes)
        total_ms = int((time.perf_counter() - t0) * 1000)
        # "modal_ms" is a misnomer kept on purpose — it is the key the frontend
        # already reads for its latency readout, so the UI needs no change.
        return boxes, {
            "modal_ms": total_ms,
            "decode_ms": round(decode_ms, 2),
            "cpu_ms": round(infer_ms, 2),
            "model": self.name,
        }

    async def infer_video(self, video_bytes: bytes) -> dict:
        return await asyncio.to_thread(_infer_video_sync, self.name, video_bytes)


def bind(name: str | None) -> _Bound:
    chosen = (name or DEFAULT_MODEL).strip().lower()
    if chosen not in MODELS:
        raise ValueError(f"unknown CPU model {chosen!r} (expected one of {', '.join(MODELS)})")
    return _Bound(chosen)
