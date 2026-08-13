"""
Per-image inference cost on a local GPU — no server, no network, no WebSocket.

Isolates what one frame actually costs the model, which the end-to-end benchmark
(latency_bench.py) cannot separate from transport. Run it on the GPU box itself:

    /opt/polyp-venv/bin/python experiments/gpu_bench.py
    /opt/polyp-venv/bin/python experiments/gpu_bench.py --width 640 --frames 500

Results are written up in GPU_TIMING.md.

Timing note: every forward pass is followed by torch.cuda.synchronize(). Without
it the CPU races ahead of the GPU and you end up timing kernel *launches*, which
reports absurdly fast numbers.
"""

import argparse
import statistics
import time
from pathlib import Path

import cv2
import numpy as np
import torch
from huggingface_hub import hf_hub_download
from ultralytics import YOLO

# Same weights and threshold as inference/app.py and backend/services/local_gpu.py.
# If these drift apart, the benchmark stops describing what production runs.
HF_REPO = "goktug14/yolov5_kvasir_polyp"
HF_FILE = "weights/best.pt"
CONF = 0.3

DEFAULT_VIDEO = Path(__file__).parent.parent / "frontend/public/demos/test_polyp_seq2.mp4"


def load_frames(video: Path, width: int, quality: int, count: int) -> list[bytes]:
    """Frames encoded exactly as the browser sends them: downscaled, JPEG."""
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise SystemExit(f"could not open {video}")

    frames: list[bytes] = []
    while len(frames) < count:
        ok, frame = cap.read()
        if not ok:
            if not frames:
                raise SystemExit(f"no frames decoded from {video}")
            break  # clip shorter than requested — use what we have
        h, w = frame.shape[:2]
        small = cv2.resize(frame, (width, round(h * width / w)))
        ok2, buf = cv2.imencode(".jpg", small, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
        if ok2:
            frames.append(buf.tobytes())
    cap.release()
    return frames


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--video", type=Path, default=DEFAULT_VIDEO)
    p.add_argument("--width", type=int, default=320, help="capture width, matching INFER_WIDTH in the client")
    p.add_argument("--quality", type=int, default=85)
    p.add_argument("--frames", type=int, default=200, help="timed frames")
    p.add_argument("--warmup", type=int, default=10, help="untimed frames first")
    p.add_argument("--half", action="store_true", help="FP16 — Turing and newer have the tensor cores for it")
    args = p.parse_args()

    weights = hf_hub_download(repo_id=HF_REPO, filename=HF_FILE)
    if not torch.cuda.is_available():
        raise SystemExit("no CUDA device — this benchmark is meaningless on CPU (~800ms/frame, see RESULTS.md part 3)")

    model = YOLO(weights)
    model.to("cuda")
    if args.half:
        model.model.half()

    print(f"device      {torch.cuda.get_device_name(0)}  capability {torch.cuda.get_device_capability(0)}")
    print(f"torch       {torch.__version__}")
    print(f"weights     {weights}")
    print(f"precision   {'FP16' if args.half else 'FP32'}")

    frames = load_frames(args.video, args.width, args.quality, args.frames + args.warmup)
    kb = sum(len(f) for f in frames) / len(frames) / 1024
    print(f"frames      {len(frames)} at {args.width}px q{args.quality}, avg {kb:.1f} KB\n")

    for b in frames[: args.warmup]:
        img = cv2.imdecode(np.frombuffer(b, np.uint8), cv2.IMREAD_COLOR)
        model(img, conf=CONF, verbose=False, half=args.half)
    torch.cuda.synchronize()
    torch.cuda.reset_peak_memory_stats()

    decode_ms: list[float] = []
    gpu_ms: list[float] = []
    total_ms: list[float] = []
    detections = 0

    for b in frames[args.warmup :]:
        t0 = time.perf_counter()
        img = cv2.imdecode(np.frombuffer(b, np.uint8), cv2.IMREAD_COLOR)
        t1 = time.perf_counter()
        result = model(img, conf=CONF, verbose=False, half=args.half)[0]
        torch.cuda.synchronize()  # see module docstring
        t2 = time.perf_counter()

        decode_ms.append((t1 - t0) * 1000)
        gpu_ms.append((t2 - t1) * 1000)
        total_ms.append((t2 - t0) * 1000)
        detections += len(result.boxes)

    def p95(v: list[float]) -> float:
        return statistics.quantiles(v, n=100)[94]

    n = len(total_ms)
    print(f"timed frames  {n}")
    print(f"detections    {detections} total ({detections / n:.2f}/frame)")
    print(f"decode        mean {statistics.mean(decode_ms):6.2f} ms")
    print(f"gpu forward   mean {statistics.mean(gpu_ms):6.2f} ms   p50 {statistics.median(gpu_ms):6.2f}   p95 {p95(gpu_ms):6.2f}")
    print(f"per image     mean {statistics.mean(total_ms):6.2f} ms   p50 {statistics.median(total_ms):6.2f}   p95 {p95(total_ms):6.2f}")
    print(f"throughput    {1000 / statistics.mean(total_ms):.1f} fps (single stream, serial)")
    print(f"VRAM          {torch.cuda.max_memory_allocated() / 1024**2:.0f} MiB allocated, "
          f"{torch.cuda.max_memory_reserved() / 1024**2:.0f} MiB reserved")


if __name__ == "__main__":
    main()
