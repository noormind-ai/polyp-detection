# One frame in flight: stop serialising the round trip against inference

## Status
Resolved 2026-10-11.

## Problem / Context

The live capture loop was strictly **send -> wait -> send**: it awaited each
frame's boxes before preparing the next one.

```js
const result = await new Promise((resolve) => {
  pendingRef.current = resolve;   // one resolver == one frame in flight
  ws.send(buf);
});
```

That makes the achieved frame rate `1 / (client work + network RTT + inference)`
— every millisecond the wire costs is a millisecond in which the model is idle.

Server-side inference is already fast and very stable. From
`backend/data/bench/sessions.csv`, `cpu:rtdetr` over sessions up to 13,612
frames: **median 38 ms, p90 45 ms**. And the 320px input is already the tuned
choice — `local_cpu.py` documents that the 640 export was *"2.2x slower (251 ms
vs 116 ms at 14 threads) for no gain"*. There is no easy win left in the model.

So the question was whether the wire was worth attacking, and that turned on
what the RTT actually is.

### A measurement we got wrong first

The initial reading came from a single `ss -tin` snapshot of the clinic
connection:

```
rtt:7.321/1.285   rto:208   retrans:0/34
bytes_retrans:40422 / bytes_sent:1680918   (2.4% of bytes)
```

Read as "7.3 ms", that says the network is ~13% of the frame budget and not
worth a refactor. That conclusion was wrong, and the same output contains the
reason: `rtt` is a *smoothed average*, while `rto:208` and 34 retransmissions
say this link drops packets. On TCP a lost segment head-of-line blocks
everything queued behind it — so the distribution matters and the mean hides it.

### What it actually is

387 samples over ~97 s against the live clinic client:

| | ms |
|---|---|
| min | 5.8 |
| median | 9.3 |
| **p90** | **27.1** |
| p99 | 44.2 |
| max | 57.4 |

mean 12.9, stdev 8.6 — **16.3% of samples over 20 ms**, 0.3% over 50 ms.

A 3x spread, not a flat 7 ms. And with a serialised loop every one of those
excursions costs frames directly, because frame N+1 cannot even be encoded
until N's reply lands. This matches the reported symptom: the frame rate does
not sit still, it sags whenever the link does.

Honest budget:

```
                 median      p90
inference         38          45
network            9          27
client work      ~10         ~10
                 ----        ----
                 ~57ms       ~82ms
                 17.5 fps    12 fps
```

At p90 the wire is **a third of the frame budget**, not a rounding error.

## Candidates

1. **Do nothing** — the loop is simple and provably correct as-is.
2. **WebRTC / a temporal codec** — attack bandwidth and transport jitter properly.
3. **`frame_id` in the protocol + N frames in flight** — the textbook answer.
4. **1-deep pipelining, correlating replies by order** — send frame N+1 before
   awaiting N, no protocol change.

## Attempts

### Steady-state model — 2026-10-11
With `prepare = 10 ms`, serialised period is `prepare + net + infer`. Pipelined,
the period settles at `max(infer, (net + infer + prepare)/2)` — floored by server
throughput, since the backend infers strictly one frame at a time.

| | serialised | pipelined |
|---|---|---|
| median net (9.3 ms) | 57.3 ms = 17.5 fps | **38.0 ms = 26.3 fps** (+51%) |
| p90 net (27.1 ms) | 75.1 ms = 13.3 fps | **38.0 ms = 26.3 fps** (+98%) |
| p99 net (44.2 ms) | 92.2 ms = 10.8 fps | **46.1 ms = 21.7 fps** (+100%) |

The headline is not the +51% at the median. It is that the pipelined column is
**flat at 26 fps across the whole distribution** — the frame rate becomes bounded
by inference instead of tracking the network. The jitter is what this removes.

## Decision

**Allow exactly one frame in flight (`MAX_IN_FLIGHT = 1`), and correlate replies
by order rather than by any identifier.**

The loop now sends frame N and *then* settles frame N-1:

```js
const sent = sendForInference(ws, buf);   // not awaited
const prev = inFlight;
inFlight = { result: sent, cap, hi };
if (prev) await settle(prev);
```

so this frame's wire time overlaps the previous frame's settle and the next
frame's preparation, instead of being dead time.

Three things make that safe:

- **Ordering.** `_stream_frames` receives, infers and replies strictly one
  frame at a time, and WebSocket preserves order, so the Nth reply always
  belongs to the Nth request. A FIFO (`pendingQueueRef`) is the entire
  correlation mechanism — no `frame_id` needed.
- **Timeouts leave tombstones.** A frame we gave up on stays in the queue with
  `done = true`, because the *server* has not given up and its reply still has
  to consume a slot. Dropping the entry would misalign every later reply.
- **`hi` became a ring.** It was a single shared scratch canvas; with a frame
  in flight it would be overwritten by frame N+1 before frame N's boxes came
  back, and those boxes would then be drawn over — and filed against — the
  wrong picture. `HI_RING_SLOTS = MAX_IN_FLIGHT + 1`.

All result handling stays in one place (`settle`), so `updateBoxes`, the
temporal gate and `maybeAutoCapture` still see frames in order; both skip paths
(out-of-body, quality gate) call `drainInFlight()` before drawing, so nothing
can overtake a frame already sent.

### How it works

**Before** — the loop could not start frame N+1 until frame N came back, so the
network sat in the critical path and the model was idle for the whole round trip:

    prepare N ---- send N ----[ wire ][ infer ][ wire ]---- draw N
                                                            prepare N+1 ---- send N+1 ----[ wire ][ infer ]...
    |<--------------------- one frame period ---------------------->|
    period = prepare + network + inference

**After** — frame N+1 is prepared and sent while frame N is still being inferred,
so the wire overlaps the model instead of adding to it:

    prepare N ---- send N ----[ wire ][ infer ][ wire ]---- draw N
                   prepare N+1 ---- send N+1 ----[ wire ][ infer ][ wire ]---- draw N+1
                                  prepare N+2 ---- send N+2 ...
    period = max(inference, (prepare + network + inference) / 2)

The second term is the pipeline filling; the first is the floor imposed by the
backend, which infers strictly one frame at a time. On this deployment inference
is the floor, so the frame rate becomes **flat at the inference limit regardless
of what the network does** — which is the actual win, more than the raw speedup.

The loop body is three lines:

```js
const sent = sendForInference(ws, buf);   // NOT awaited
const prev = inFlight;
inFlight = { result: sent, cap, hi };
if (prev) await settle(prev);             // last frame's boxes, drawn now
```

Three things make that safe:

**Correlation is by order, not by identifier.** `_stream_frames` receives, infers
and replies strictly one frame at a time, and WebSocket preserves order, so the
Nth reply always belongs to the Nth request. A FIFO (`pendingQueueRef`) is the
entire mechanism — no `frame_id` on the wire, no protocol change.

**Timeouts leave tombstones.** A frame we gave up on stays in the queue marked
`done`, because the *server* has not given up and its reply still has to consume
a slot. Removing the entry would misalign every later reply by one.

**Each in-flight frame carries its own canvases.** `hi` was a single shared
scratch; with a frame in flight it would be overwritten by frame N+1 before frame
N's boxes returned, and those boxes would then be drawn over — and filed against —
the wrong picture. It is now a ring, sized `MAX_IN_FLIGHT + 1`.

All result handling stays in one place (`settle`), and both skip paths
(out-of-body, quality gate) call `drainInFlight()` before drawing, so
`updateBoxes`, the temporal gate and `maybeAutoCapture` still observe frames in
strict order. Those are sequence-keyed state machines; settling out of order
would corrupt all three.

### Alternatives considered

**Do nothing** — pros: zero risk to a working clinical loop. / cons: leaves the
frame rate hostage to a link measured at 3x spread, for a bottleneck that is
pure idle time.

**WebRTC / H.264 (candidate 2)** — pros: real congestion control, drops stale
frames instead of head-of-line blocking them. / cons: needs STUN/TURN, which on
a single Iran box behind restrictive networking is an operational risk; and a
temporal codec destroys the per-frame independence that lets `_stream_frames`
run completely stateless. Rejected on both counts, not on bandwidth.

**`frame_id` in the protocol (candidate 3)** — pros: explicit, survives any
future server that answers out of order or in parallel. / cons: a wire-format
change on both sides to re-derive something the transport already guarantees.
Rejected as unnecessary *today* — but see the risk below, because it is the
upgrade path if the server ever stops replying in order.

**More than one frame in flight** — pros: would absorb even the p99. / cons:
every extra in-flight frame is another frame of staleness between the picture
and its boxes. For a CADe overlay that is a clinical cost, not just a latency
number, and one frame already flattens the curve to the inference floor.

### The readout could not show it -- 2026-10-11
After shipping, the operator reported no change in the on-screen frame rate.
It was not a regression and not a failure; the number was incapable of moving.

    const fps = avgRtt ? Math.round((1000 / avgRtt) * 10) / 10 : 0;

That is **latency** expressed as a rate, not throughput. Pipelining works by
overlapping frames -- it does not shorten any individual round trip -- so
1000/rtt reports the same value whether one frame is in flight or three. The
one metric anybody would use to judge this change was structurally blind to it.

Fixed by measuring the thing being claimed: the gaps between arriving results
(`arrivalHistory`), averaged over the last 20. `fps` is now observed throughput
and will move when the pipeline depth does.

Worth generalising: a derived statistic that *looks* like the quantity of
interest is worse than no statistic, because it is trusted. The RTT measurement
in Problem/Context above failed the same way -- a smoothed mean that hid a 3x
tail.

### Consequences / risks

- **Boxes are now one frame staler than before.** This buys throughput and
  smoothness, not freshness. -> held at `MAX_IN_FLIGHT = 1` deliberately; the
  constant's comment says why raising it is not free.
- **Correctness depends on the server replying in request order.** That is true
  of `_stream_frames` today and is now load-bearing rather than incidental.
  -> documented at `Pending`; if the backend ever infers frames concurrently or
  reorders, this breaks silently and `frame_id` becomes mandatory.
- **`hi` ring must grow with `MAX_IN_FLIGHT`.** -> expressed as
  `MAX_IN_FLIGHT + 1` rather than a literal, so the two cannot drift apart.
- **Per-frame RTT is now measured per queue entry**, not from one shared
  `sentAtRef` — with several frames in flight a single ref would be overwritten
  before the reply arrived and every round trip would read far shorter than it
  was.
- **A socket close must fail everything outstanding** or a caller waits forever
  on a socket that will never answer. -> `flushPending()` on `onclose`.
- **Confirmed working by the operator 2026-10-11**, once the `fps` readout was fixed
  to report throughput -- until then the change was invisible by construction.
- **Still modelled rather than instrumented.** The predicted effect is the
  on-screen fps holding ~26 and no longer sagging with the link. That readout
  only became capable of showing it after the fix above, so the verification
  has not actually happened yet.
- **A file source caps the gain.** Replaying a 25fps clip, the loop cannot find
  more than 25 distinct frames a second no matter how fast it runs, so the
  improvement there is ~17 -> 25, not ~17 -> 26. A live 29.97fps camera has
  more headroom.
