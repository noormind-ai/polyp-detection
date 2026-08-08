"""
Modal inference endpoint — runs on A100 GPU.
Weights: goktug14/yolov5_kvasir_polyp (HuggingFace)
Downloaded once to Modal Volume on first container start, reused forever after.

Deploy:  modal deploy inference/app.py
Test:    modal run inference/app.py::PolypDetector.smoke_test
"""

import modal

app = modal.App("polyp-detection")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(["libgl1", "libglib2.0-0", "ffmpeg"])
    .pip_install([
        "torch>=2.4.0",
        "torchvision>=0.19.0",
        "ultralytics>=8.3.0",
        "huggingface_hub>=0.24.0",
        "opencv-python-headless>=4.10.0",
        "numpy>=1.26.0",
    ])
)

volume = modal.Volume.from_name("polyp-models", create_if_missing=True)
MODELS_DIR = "/models"
WEIGHTS_PATH = f"{MODELS_DIR}/yolo_polyp.pt"

HF_REPO = "goktug14/yolov5_kvasir_polyp"
HF_FILE = "weights/best.pt"


@app.cls(
    gpu="A100",
    image=image,
    volumes={MODELS_DIR: volume},
    scaledown_window=300,  # container stops 5min after last request — short enough to control cost, long enough to survive normal UI setup time between warmup and first frame
)
class PolypDetector:

    @modal.enter()
    def load_model(self):
        """
        Runs once per container start.
        First ever start: downloads weights from HuggingFace → saves to Volume.
        All later starts: weights already in Volume → just load into GPU.
        """
        import os
        import shutil
        import torch
        from huggingface_hub import hf_hub_download
        from ultralytics import YOLO

        # Download weights to Volume if not already there
        if not os.path.exists(WEIGHTS_PATH):
            print(f"First run — downloading weights from HuggingFace ({HF_REPO})...")
            os.makedirs(MODELS_DIR, exist_ok=True)
            tmp = hf_hub_download(repo_id=HF_REPO, filename=HF_FILE)
            shutil.copy(tmp, WEIGHTS_PATH)
            volume.commit()
            print("Weights saved to Modal Volume.")

        # Load into GPU memory
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = YOLO(WEIGHTS_PATH)
        self.model.to(self.device)
        print(f"Model ready on {self.device}")

    @modal.method()
    def warmup(self) -> str:
        """Called by /api/session/start — just forces container start + load_model to run."""
        return "ready"

    @modal.method()
    def infer_frame(self, frame_bytes: bytes) -> list[dict]:
        """
        Single frame inference.
        Returns: [{"bbox": [x1, y1, x2, y2], "conf": 0.87}, ...]
        Coordinates are in original frame pixels.
        """
        import cv2
        import numpy as np

        frame = cv2.imdecode(np.frombuffer(frame_bytes, np.uint8), cv2.IMREAD_COLOR)
        results = self.model(frame, conf=0.3, verbose=False)[0]

        return [
            {
                "bbox": [round(x) for x in box.xyxy[0].tolist()],
                "conf": round(float(box.conf[0]), 3),
            }
            for box in results.boxes
        ]

    @modal.method()
    def infer_frame_bench(self, frame_bytes: bytes) -> dict:
        """
        Benchmark-only variant of infer_frame — times JPEG decode and the GPU
        forward pass separately so RPC/network overhead can be isolated from
        actual compute time. Not called by the production app.
        """
        import time
        import cv2
        import numpy as np

        t0 = time.perf_counter()
        frame = cv2.imdecode(np.frombuffer(frame_bytes, np.uint8), cv2.IMREAD_COLOR)
        decode_ms = (time.perf_counter() - t0) * 1000

        t1 = time.perf_counter()
        results = self.model(frame, conf=0.3, verbose=False)[0]
        gpu_ms = (time.perf_counter() - t1) * 1000

        boxes = [
            {
                "bbox": [round(x) for x in box.xyxy[0].tolist()],
                "conf": round(float(box.conf[0]), 3),
            }
            for box in results.boxes
        ]
        return {"boxes": boxes, "decode_ms": round(decode_ms, 2), "gpu_ms": round(gpu_ms, 2)}

    @modal.method()
    def infer_video(self, video_bytes: bytes) -> dict:
        """
        Full video inference.
        Returns per-frame detections as JSON — frontend draws boxes on canvas.
        Response: { fps, width, height, frames: [[{bbox, conf}, ...], ...] }
        """
        import cv2

        with open("/tmp/input.mp4", "wb") as f:
            f.write(video_bytes)

        cap = cv2.VideoCapture("/tmp/input.mp4")
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        frames_detections = []
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            results = self.model(frame, conf=0.3, verbose=False)[0]
            frames_detections.append([
                {
                    "bbox": [round(x) for x in box.xyxy[0].tolist()],
                    "conf": round(float(box.conf[0]), 3),
                }
                for box in results.boxes
            ])

        cap.release()
        return {"fps": fps, "width": width, "height": height, "frames": frames_detections}

    @modal.method()
    def smoke_test(self):
        """Quick sanity check: modal run inference/app.py::PolypDetector.smoke_test"""
        import cv2
        import numpy as np

        dummy = np.zeros((480, 640, 3), dtype=np.uint8)
        _, buf = cv2.imencode(".jpg", dummy)
        result = self.infer_frame(buf.tobytes())
        print(f"Smoke test passed. Detections on blank frame: {result}")
