# How a live session actually works, end to end

One source feed, three independent consumers. Each reads the picture its own
way — that separation is *why* two of them can work perfectly while the third
silently fails, which is exactly what happened in the recording bug below.

```
Capture card (USB/HDMI)
        |
        v
  <video> element  <-- the browser's own decode of the raw feed
   /     |      \
  v      v       v
Live   AI        Recording
view   inference
```

- **Live view**: draws the `<video>` element onto a canvas, with image
  cleanup (deinterlace/sharpen) applied only for *display*.
- **AI inference**: draws the `<video>` element onto a separate canvas at a
  fixed small size, sends that as JPEGs over a WebSocket to the model, draws
  the returned boxes on yet another overlay canvas on top.
- **Recording**: saves the picture to a video file. Must NOT have the AI's
  boxes baked in (the saved file has to stay "clean" to be useful later), so
  it never looks at the overlay canvas — only the plain decoded picture.

## The recording path, specifically

```
MediaRecorder -> 3-second pieces -> saved on your computer first (chunkStore)
                                              |
                                              v
                                   uploaded to the server, later
```

Two important design choices here, both reasonable on their own:

1. **Save locally first, upload later.** A piece is written to your
   computer's own storage the moment it's recorded. Upload is a separate,
   slower step — this is why a local "save to my computer" download can have
   much more video than what reached the server: they're not the same step.

2. **Uploads deliberately wait while the AI is actively running.** Sending
   video competes for the same network link as sending frames to the model,
   so the app pauses uploads whenever it thinks the scope is inside the body,
   and only lets them through once it's been outside for a full continuous
   minute. (Tested and confirmed solid on its own — not a source of bugs.)

Combined effect: on a real procedure, almost nothing uploads *during* the
session. Nearly everything is sent in one big batch at the very end, once the
recording stops — whether that's you clicking Stop, or the automatic
60-second out-of-body timeout.

## The bug (confirmed, documents/adr/0009)

The moment a recording stops, the server is told "this one's finishing" —
status **"closing"**. That's deliberate: it lets the server keep accepting
the backlog of pieces that still need to upload, rather than rejecting them.

Every piece upload gets back the recording's current status in its reply. A
safety check was meant to catch exactly one real problem — the recording got
too big and the server refused it (status "truncated"). Instead it reacts to
*anything that isn't "recording"* — which also matches the completely normal
"closing" status. So: the big end-of-session batch starts sending, the first
piece succeeds but its reply says "closing," the check misreads that as the
size-limit error, and it stops sending everything else. One piece gets
through, every time, regardless of the capture card, the signal, or anything
hardware-related.

## What else the capture-card investigation found (not shipped)

None of this caused today's "almost nothing uploads" symptom — that was
always the status-check bug above. Found along the way, for the record:
- The new HDMI capture card (Macrosilicon MS2109) silently substitutes a
  fallback picture instead of erroring when it loses signal — confirmed by
  direct test.
- The clinic computer's HDMI output doesn't reliably turn on for this card
  (a handshake issue) — needs a physical fix (splitter) if it matters.
- A real fix existed for "recording stops if the cable is physically
  unplugged mid-procedure" (read from the same decoded picture live view
  uses, instead of the raw device feed). Not shipped — judged an unrealistic
  scenario for actual clinic use. See ADR 0009.
