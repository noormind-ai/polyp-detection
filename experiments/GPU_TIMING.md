# Per-image inference cost — RTX 2080 Ti (IranServer)

How long one frame takes on the local GPU deployment, measured 2026-08-10.
Reproduce with `experiments/gpu_bench.py`.

This is the narrow "what does one image cost" reference. For why inference was
moved off Modal at all, and the end-to-end pipeline numbers, see
[`RESULTS.md`](RESULTS.md) part 4.

## Hardware / software

| | |
|---|---|
| GPU | NVIDIA GeForce RTX 2080 Ti, 11 GB, compute 7.5 (Turing) |
| Driver | 580.65.06 |
| torch | 2.5.1+cu124 |
| ultralytics | 8.4.117 |
| Model | `goktug14/yolov5_kvasir_polyp`, revision `a1fe72b5`, loaded via Ultralytics `YOLO()` |
| Threshold | `conf=0.3` |
| Host | Ubuntu 24.04, 16 vCPU, 44 GB RAM |

## One image

200 frames of `test_polyp_seq2.mp4` at 320px wide / JPEG q0.85 — the size the
browser actually sends. 10 warm-up frames discarded; `torch.cuda.synchronize()`
after every forward pass, otherwise the timing measures kernel launch rather than
completion.

| Stage | Mean | p50 | p95 |
|---|---|---|---|
| JPEG decode (`cv2.imdecode`) | 0.52 ms | — | — |
| **GPU forward pass** | **17.67 ms** | 17.33 | 18.91 |
| **Decode + forward (what one image costs)** | **18.18 ms** | 17.86 | 19.51 |

- Throughput, single stream, serial: **55.0 fps**
- Peak VRAM: 134 MiB allocated / 156 MiB reserved, of 11264 MiB
- GPU utilisation under continuous load: ~21%

The card is nowhere near saturated. Headroom is for concurrent sessions, not for
making a single stream faster.

## Measured at other layers

The same frame costs more the further out you measure. Useful when reading logs:

| Layer | Per frame | What it adds |
|---|---|---|
| GPU forward only | 17.7 ms | — |
| Decode + forward | 18.2 ms | JPEG decode |
| Server-reported (`infer=` in `logs/backend.log`) | **21.8–23.5 ms** | `asyncio.to_thread` hop, lock, response build |
| End-to-end over WebSocket from the same host | 25.3 ms | framing, loopback |

Production agrees: a 466-frame browser session logged **21.8 ms mean**, with
individual lines steady at `infer=20ms` … `infer=22ms`.

## Input size barely matters

From `latency_bench.py`, 60 frames per config:

| Input width | Payload | Server-side infer |
|---|---|---|
| 160 | 3.1 KB | 21.8 ms |
| 224 | 8.7 KB | 22.4 ms |
| 320 | 15.1 KB | 23.5 ms |
| 480 | 28.3 KB | 23.0 ms |
| 640 | 43.2 KB | 22.9 ms |

**A 14× larger payload costs about 1 ms.** Ultralytics letterboxes to
`imgsz=640` internally regardless of what it is handed, so the model does the
same work either way — downscaling only shrinks the JPEG decode and the bytes on
the wire, both already negligible.

Practical consequence: **choose the capture width for detection quality, not for
speed.** The client currently sends 320px (`INFER_WIDTH` in `RealtimePlayer.tsx`);
raising it is nearly free in latency terms.

## Against the A100 it replaced

| | Modal A100 | RTX 2080 Ti |
|---|---|---|
| Forward pass | ~11 ms | 17.7 ms |
| End-to-end per frame | 250–265 ms | 23–26 ms |

The 2080 Ti is ~1.6× slower per image and the pipeline is ~10× faster, because
~95% of the old latency was transatlantic invocation overhead rather than
compute. See `RESULTS.md` part 2 for that diagnosis.

## Caveats

- Measured from the server against `127.0.0.1`; the browser↔server leg is
  excluded and is now the dominant variable. At ~22 ms of compute, a client's
  network path matters more than the GPU does — a VPN routing out of the country
  and back turned 38 fps into 0.4 fps in testing.
- Single stream only. Forward passes are serialised by a lock in
  `backend/services/local_gpu.py`, so N concurrent sessions share these numbers
  rather than each getting them.
- FP32. `half=True` was not tried; Turing has FP16 tensor cores, so there is
  likely room below 17.7 ms if it is ever needed.

## Reproducing

```bash
/opt/polyp-venv/bin/python experiments/gpu_bench.py
/opt/polyp-venv/bin/python experiments/gpu_bench.py --width 640 --frames 500
```
