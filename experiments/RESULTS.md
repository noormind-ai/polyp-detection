# Live-inference latency benchmark

Run: `experiments/latency_bench.py` — see that file's docstring for the full protocol.

**Setup:** ran from the server itself (`arman@call2fly.ai`) against the live backend at
`127.0.0.1:19000`, replaying `frontend/public/demos/test_polyp_seq2.mp4` (206 frames) frame by
frame — one frame in flight at a time, exactly like `RealtimePlayer.tsx` does today (send →
wait for boxes → send next). Swept resize width × JPEG quality, 60 timed frames per config
(+5 discarded warm-up frames), Modal container pre-warmed via `/api/session/start` first.

Raw data: `results/latency_20260711_092306.csv` (per-frame) and
`results/latency_20260711_092306_summary.csv` (per-config).

## Results

| width | quality | payload (KB) | e2e mean (ms) | e2e p50 | e2e p90 | e2e p95 | modal (ms) | network (ms) | fps @ 1-in-flight |
|---|---|---|---|---|---|---|---|---|---|
| 160 | 0.60 | 3.1  | 255.3 | 249.9 | 279.4 | 285.8 | 253.2 | 2.0 | 3.92 |
| 160 | 0.85 | 5.4  | 250.4 | 246.8 | 260.6 | 276.1 | 248.3 | 2.1 | 3.99 |
| 224 | 0.60 | 4.8  | 254.0 | 248.9 | 264.8 | 277.1 | 252.1 | 1.9 | 3.94 |
| 224 | 0.85 | 8.7  | 260.0 | 251.4 | 280.6 | 330.3 | 257.5 | 2.5 | 3.85 |
| 320 | 0.60 | 8.2  | 256.9 | 250.6 | 274.1 | 293.2 | 254.2 | 2.7 | 3.89 |
| 320 | 0.85 | 15.1 | 259.6 | 253.3 | 267.6 | 282.3 | 255.9 | 3.7 | 3.85 |
| 480 | 0.60 | 15.4 | 270.9 | 254.8 | 290.4 | 363.6 | 267.8 | 3.1 | 3.69 |
| 480 | 0.85 | 28.3 | 260.3 | 255.2 | 278.4 | 290.4 | 255.7 | 4.5 | 3.84 |
| 640 | 0.60 | 24.0 | 261.1 | 252.6 | 276.1 | 300.1 | 257.2 | 3.9 | 3.83 |
| 640 | 0.85 | 43.2 | 264.6 | 258.6 | 293.9 | 319.4 | 259.0 | 5.6 | 3.78 |

*(0 failed frames in every config.)*

## Key finding

**Resizing barely moves end-to-end latency.** Going from 160px/q0.6 (3 KB payload) all the way
up to 640px/q0.85 (43 KB — a 14x larger payload) only adds ~10ms to the mean round trip
(250ms → 265ms). `network_ms` (client↔backend transport) stays under 6ms at every size, and
this run didn't even cross a real network — it hit `127.0.0.1` on the same box.

The ~250-260ms is almost entirely `modal_ms`: the round trip to the Modal GPU function itself
(RPC/invocation overhead + the actual forward pass), which is roughly **fixed regardless of
image size**. So the lag isn't a bandwidth problem — it's the per-call cost of hitting Modal.
Shrinking the frame won't fix it.

## What this means for a target latency

None of the tested configs get anywhere close to a "feels responsive while panning" range
(commonly cited as ~100-150ms motion-to-photon, ~200ms as the outer edge of tolerable). Every
config here lands at ~250-270ms mean, ~270-360ms at p95.

Since resizing isn't the lever, options worth benchmarking next (not yet built/tested):
- Measure how much of `modal_ms` is fixed RPC overhead vs. actual GPU inference (e.g. call the
  Modal function directly and time just `model()` inside `infer_frame`, without changing the
  request pattern), to see if there's a fixed floor we can't resize our way under.
- Decouple capture from the wait: instead of strict request→wait→next-frame, allow 2 frames
  in flight (send frame N+1 before frame N's result comes back) so the *displayed* frame rate
  isn't gated by round-trip latency, even though any single frame's latency stays ~250ms.
- Check whether the Modal container is scaling to zero between calls despite the warm-up
  (`scaledown_window=60`) — a cold GPU container would show up as occasional multi-second
  spikes in the p95/p99, which we didn't see here since frames were sent continuously.

## Real-world caveat

This run measured backend↔Modal latency in isolation (script ran on the same server as the
backend). The actual browser↔backend leg (clinic device → internet → server) is a separate,
additive cost not captured here — worth a second pass once the live-camera UI exists, run from
a machine on the clinic's actual network path.

## Part 2: is it GPU compute or invocation overhead?

Added `PolypDetector.infer_frame_bench` (`inference/app.py`, benchmark-only, doesn't touch the
production `infer_frame`/`infer_video` paths) — same work as `infer_frame` but times JPEG decode
and the GPU forward pass *inside the container* and returns those alongside the boxes. Then
`experiments/modal_rpc_bench.py` calls it directly through the Modal SDK (`.remote.aio()`, same
pattern as `backend/services/modal_client.py`), bypassing FastAPI/WebSocket entirely, so it
isolates the backend-server↔Modal leg. 30 timed calls per width, run from the server.

| width | rpc mean (ms) | gpu mean (ms) | decode mean (ms) | overhead mean (ms) | overhead % |
|---|---|---|---|---|---|
| 160 | 255.8 | 11.7 | 0.2 | 243.9 | 95.3% |
| 320 | 272.1 | 11.7 | 0.4 | 260.0 | 95.6% |
| 640 | 255.7 | 10.7 | 1.1 | 243.9 | 95.4% |

Raw data: `results/modal_rpc_bench_20260711_095610.csv` / `..._summary.csv`.

**GPU inference is ~11ms. Decode is ~1ms. 95%+ of the latency (~245-260ms) is invocation
overhead** — confirmed not payload size (flat across 160→640px, matching part 1).

Checked whether that overhead is physical network distance: the backend server is on Hetzner in
Helsinki, Finland; `api.modal.com` resolves to an AWS `us-east`-range IP (`54.163.156.253`).
Raw TCP connect time from the server to `api.modal.com:443` is **~107ms** — a transatlantic hop.
ICMP is blocked so no clean ping RTT, but the TCP-connect time alone accounts for roughly 40% of
the total round trip; the rest is TLS + however many round trips Modal's RPC protocol needs per
invocation (control-plane dispatch to the container, then the result).

**Conclusion: the ~250ms floor is mostly the Helsinki↔US network distance, not GPU work or
payload size.** Resizing frames (part 1) was never going to fix this — there was nothing to
trim; the frame data isn't the bottleneck.

### Options, not yet tried

- **Move the backend closer to Modal's region** (or find out if Modal can run this GPU function
  in an EU region) — this is the lever with the biggest expected payoff, since it directly
  attacks the transatlantic RTT. Needs checking Modal's docs/support for region selection, and
  is an infra/hosting decision, not a code change.
- **Reduce round trips per call** if Modal's protocol allows it (e.g. a persistent
  stream/connection instead of one invocation per frame) — would cut the multiplier on the
  network RTT even without moving anything.
- **Accept ~250ms as a floor** and design the UI around it (e.g. don't chase sub-200ms
  motion-to-photon; smooth/interpolate box positions between updates instead) if moving compute
  isn't practical.
- Pipelining (frame N+1 sent before frame N's result returns) raises achievable fps but does
  **not** reduce the lag of any single frame — doesn't address the "boxes lag when the camera
  moves" complaint by itself, only throughput.

## Part 3: would CPU inference on our own server be faster?

Tested directly (not theoretical): installed CPU-only PyTorch + ultralytics in an isolated venv
on the same Helsinki server, downloaded the real weights, ran the actual model with zero network
hop involved (`experiments/cpu_inference_bench.py`, 20 timed calls per width, 3 warmup).

| width | mean (ms) | p50 | p90 | max |
|---|---|---|---|---|
| 160 | 808.7 | 812.5 | 820.9 | 830.7 |
| 320 | 804.9 | 804.0 | 839.1 | 851.7 |
| 640 | 788.4 | 786.8 | 807.4 | 808.5 |

**No — CPU on our own server is ~3x slower than what we have now** (~800ms vs. the current
~250-260ms Modal round trip), even with the network hop completely eliminated. This model needs
GPU acceleration: ~11ms on the A100 vs. ~800ms on 8 CPU cores is a ~70x speedup, which more than
absorbs the transatlantic network penalty. Latency is flat across resize widths here too — same
reason as the GPU case: the model resizes its input internally regardless of what we hand it.
(Venv and downloaded weights removed after the test — this server is at ~95% disk.)

## Where this leaves us

GPU compute is fast (~11ms) and not the bottleneck. Network distance to Modal's US infrastructure
is ~95% of the latency. CPU locally is ruled out (3x worse). So the lever that matters is **GPU
compute located close to Helsinki** — not GPU vs. CPU, not payload size:

- Check whether Modal supports deploying this function in an EU region (their docs/support —
  not confirmed either way here).
- If not, other pay-per-use GPU platforms with EU regions are worth a same test (RunPod
  serverless, Google Cloud Run with GPU, AWS SageMaker/Lambda in `eu-north-1` Stockholm — ~400km
  from Helsinki, or `eu-central-1` Frankfurt) — any US-only GPU provider will hit the same RTT
  tax regardless of brand, so "which provider" matters only insofar as where its GPUs actually
  run.
- A small always-on GPU box rented in an EU region (rather than serverless per-call) is also an
  option if usage volume is low enough that idle time isn't wasteful — trades pay-per-use billing
  for predictable low latency and no cold-start risk.
- None of this has been benchmarked yet — the network-distance hypothesis is well-supported
  (raw TCP connect ~107ms to `api.modal.com`) but the actual fix needs testing against a real
  EU-region deployment before committing to it.

## Part 4: a local GPU, in-process — the predicted fix, measured

The "small always-on GPU box" option above was taken: a rented IranServer VM with a dedicated
**RTX 2080 Ti** (11 GB, compute 7.5, driver 580.65.06), Ubuntu 24.04, torch 2.5.1+cu124. The model
runs **inside the FastAPI process** (`backend/services/local_gpu.py`, `INFERENCE_BACKEND=local`) —
no Modal, no separate inference service, no network hop at all between backend and GPU. Same
weights (`goktug14/yolov5_kvasir_polyp`, revision `a1fe72b5`), same `conf=0.3`, so the numbers are
comparable to parts 1–3 rather than measuring a different model.

### 4a. Compute alone (same method as part 2)

200 frames of `test_polyp_seq2.mp4` at 320px/q0.85, timed inside the process, `cuda.synchronize()`
after each forward pass:

| | mean | p50 | p95 |
|---|---|---|---|
| JPEG decode | 0.52 ms | — | — |
| GPU forward | **17.67 ms** | 17.33 | 18.91 |
| decode + forward | 18.18 ms | 17.86 | 19.51 |

55.0 fps serial. Peak VRAM 134 MiB allocated / 156 MiB reserved — the 11 GB card is barely touched.

The 2080 Ti is ~1.6x slower than Modal's A100 at the forward pass (17.7ms vs ~11ms), exactly as
expected for the class of card. That difference is irrelevant next to the ~245ms of invocation
overhead it removes.

### 4b. End-to-end through the real pipeline (same harness as part 1)

`experiments/latency_bench.py` against the live backend, one frame in flight, full width x quality
matrix. Raw data: `results/latency_20260810_135543.csv` / `..._summary.csv`.

| width | quality | payload (KB) | e2e mean (ms) | e2e p50 | e2e p90 | e2e p95 | infer (ms) | network (ms) | fps | part 1 e2e | speedup |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 160 | 0.60 | 3.1  | **23.2** | 22.6 | 24.8 | 25.8 | 21.8 | 1.4 | 43.19 | 255.3 | 11.0x |
| 160 | 0.85 | 5.4  | **23.6** | 23.2 | 25.2 | 25.7 | 22.1 | 1.4 | 42.45 | 250.4 | 10.6x |
| 224 | 0.60 | 4.8  | **23.5** | 23.2 | 25.1 | 25.4 | 22.0 | 1.4 | 42.63 | 254.0 | 10.8x |
| 224 | 0.85 | 8.7  | **24.0** | 24.0 | 25.2 | 26.6 | 22.4 | 1.5 | 41.69 | 260.0 | 10.8x |
| 320 | 0.60 | 8.2  | **24.4** | 23.9 | 26.3 | 28.0 | 22.9 | 1.5 | 41.02 | 256.9 | 10.5x |
| 320 | 0.85 | 15.1 | **25.3** | 24.7 | 28.4 | 29.3 | 23.5 | 1.8 | 39.47 | 259.6 | 10.3x |
| 480 | 0.60 | 15.4 | **24.9** | 24.8 | 25.8 | 27.0 | 22.9 | 2.0 | 40.11 | 270.9 | 10.9x |
| 480 | 0.85 | 28.3 | **25.6** | 25.4 | 27.1 | 27.7 | 23.0 | 2.6 | 39.04 | 260.3 | 10.2x |
| 640 | 0.60 | 24.0 | **25.1** | 25.0 | 26.6 | 27.0 | 22.9 | 2.2 | 39.77 | 261.1 | 10.4x |
| 640 | 0.85 | 43.2 | **26.0** | 25.6 | 27.4 | 28.0 | 22.9 | 3.1 | 38.51 | 264.6 | 10.2x |

*(0 failed frames in every config, as before.)*

**Every config now passes the 200ms target. In part 1, none did.**

### What this confirms

The part 2 diagnosis was correct and the fix behaves exactly as it predicted. Removing the
transatlantic hop cut ~250ms to ~24ms — a **~10x end-to-end improvement** — while the GPU itself
got *slower* (A100 → 2080 Ti). Latency is now dominated by actual compute (~22ms of the ~24ms),
which is the regime you want: it means further gains have to come from the model or from FP16,
not from plumbing.

Two things that stayed true from part 1 and are worth noting because they're now clearly visible:
payload size still barely matters (23.2ms at 3 KB vs 26.0ms at 43 KB — a 14x payload increase
costs 2.8ms, all of it transport), and the model still resizes internally regardless of what it is
handed. The practical consequence is that **there is no longer any reason to downscale aggressively
for latency** — 640px costs ~3ms over 160px, so the width choice can be made on detection quality
instead.

### Caveat, same shape as part 1's

This was measured from the server itself against `127.0.0.1`, so it excludes the browser↔backend
leg. That leg is now the dominant unknown: at ~24ms of server-side latency, a clinic's network path
to the box will contribute more than inference does. Worth a second pass from a machine on the
actual clinical network before quoting a motion-to-photon figure.

Note also that both deployments still exist and are selectable at runtime
(`/api/backends`, backend chooser in the UI) — Modal was not removed, so this comparison can be
re-run on the same box whenever the Modal credentials are present.
