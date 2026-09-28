# Concurrent live sessions — capacity & bottlenecks

**Status:** Open — first measurement pass, 2026-09-28. No code changes made yet.

## Question

How many clinics can run a **live** session (real-time camera/screen-share inference)
against `noormind-iran` at once, before the experience noticeably stops feeling
"live"? And what actually limits that number?

## What we tested

A staged concurrency load test against the real inference path
(`/api/ws/infer`, `backend=cpu:rtdetr` — RT-DETR on the server's RTX A2000 GPU),
run directly on the box over loopback so the result isolates server-side
capacity from internet variables.

- Frames: extracted from a real demo clip, resized to 320px wide and
  JPEG-encoded at quality 0.85 — identical to what `RealtimePlayer.tsx`
  actually sends.
- Each simulated client sent one frame, waited for the response, then sent
  the next — the same one-frame-in-flight pattern the real frontend uses, not
  an artificial fire-hose.
- Ramped 1 → 2 → 4 → 6 → 8 concurrent sessions, checking free RAM and GPU
  memory between each stage, with a safety abort below 600MB available.
- Confirmed no real clinic traffic was active before/during the test.

## What we measured

| Concurrent sessions | server time / frame | + real network (~12ms, measured separately) | total, real-world feel |
|---|---|---|---|
| 1 | 46ms | ~58ms | instant |
| 2 | 47ms | ~59ms | no difference from 1 |
| 4 | 53ms | ~65ms | still basically the same, nobody would notice |
| 6 | 78ms | ~90ms | starting to feel a bit slower, still fine |
| 8 | 100ms | ~112ms | noticeably slower, but still works — nothing broke |

Zero dropped sessions and zero protocol errors at every stage, including 8x
concurrency. Total server throughput plateaus around **~75-80 frames/sec
combined**, regardless of how many sessions share it — that plateau is the
real ceiling.

Network figure: a ping-style test from the operator's own machine to the
server measured ~10-15ms round trip. That's the only real-world network data
point we have — it reflects one connection, not necessarily what any given
clinic's internet would show.

## What we understood

1. **The GPU is the real bottleneck, eventually — not RAM, not bandwidth.**
   There is one physical GPU; every session's frame ultimately queues for the
   same chip. Latency stays flat while the GPU has slack (1→4 concurrent) and
   climbs once total demand approaches the ~75-80 fps ceiling (6-8+).
2. **RAM is not a bottleneck for inference itself.** Available memory moved
   by ~63MB total across the entire 1→8 ramp. (Not yet tested: feedback-capture's
   rolling-clip buffers, which weren't exercised by this test.)
3. **Server-side bandwidth is a non-issue at this scale** — 2 concurrent
   sessions need ~6 Mbps combined, negligible for any real server uplink.
4. **Real per-clinic network delay is still the biggest unknown.** Everything
   above isolates server compute; an actual clinic's internet quality adds a
   number we can't measure without a client physically on their network.

**Practical takeaway:** 2-4 concurrent clinics is comfortably supported today,
with real-world total latency around 60-65ms — well inside "feels live"
territory. The curve only bends meaningfully past 4.

## Possible future improvements

Two independent levers, neither implemented yet — estimates below are typical
published speedups for this class of model/GPU, **not measured on this exact
RT-DETR export**. Treat the ranges as directional, not precise.

| Lever | What it does | Typical speedup | Rough new "same-feel" ceiling |
|---|---|---|---|
| **TensorRT** | Recompile the model specifically for this GPU chip. `TensorrtExecutionProvider` is already installed on the box but unused — the code only requests `CUDAExecutionProvider` today. | ~1.5-2.5x per frame | ~6-10 clinics |
| **FP16 (half precision)** | Use the A2000's Tensor Cores instead of full-precision math. Often bundled into a TensorRT conversion rather than a separate step. | ~1.3-1.8x, often overlaps with the TensorRT gain above | included above |
| **Micro-batching** | Instead of processing each incoming frame one at a time, hold arrivals for a short window (~10-20ms) and run the GPU once on the whole batch. Directly targets the "more clinics = more queueing" effect. | ~1.5-2.5x total throughput | ~6-10 clinics |
| **Both combined** | Faster per-frame compute *and* better GPU utilization per call — effects roughly compound, with some overlap. | — | ~12-20 clinics (upper end optimistic, needs real testing) |

**Why these are ranges, not numbers:** the only way to know the real figure
is to implement one change and re-run this exact same load test — small
model/export quirks can swing published speedups 30-50% either way.

**Recommendation:** no urgent need to build either at 2-4 clinics' current
scale. TensorRT is the smaller, more contained change (swap execution
provider, no architecture change) and the likely better first move if/when
scaling past 4 concurrent clinics becomes a real plan.
