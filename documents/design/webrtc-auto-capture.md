# Auto-capture in WebRTC mode — how it works and why

Status: built in commit `5f5ad10` (2026-11-24). Tested on the server, not yet
in a real browser.

## What the doctor gets

When the AI sees a polyp during a live procedure, that moment is saved as a
picture with its boxes. The picture goes into the **Review Queue** (with
status "pending", meaning not reviewed yet) for the doctor to confirm or
reject later. Video mode makes no difference: JPEG mode and WebRTC mode feed
the same queue, the same capture strip, and the same review flow.

## The two video modes (quick reminder)

- **JPEG mode**: the browser sends single pictures, one at a time. Each reply
  answers exactly one picture, so the browser always knows which picture a
  box belongs to.
- **WebRTC mode**: the browser sends a continuous video stream, which the
  PC's hardware video chip encodes cheaply. Results come back for frames of
  that stream, but the browser no longer holds "the picture this box is for".

## The problem

To save a capture, the picture and its boxes have to match exactly. In
WebRTC mode the browser's screen has already moved on by about 100–200 ms
when a result arrives. If the browser saved its current picture, the box
could sit beside the polyp instead of on it.

## The solution: the browser decides, the server saves

```
browser                                   server
  |  ---- video stream ------------------->  |  keeps the last ~150 frames
  |                                          |  (max 64 MB), numbered
  |  <--- boxes + "this was frame #812" ---  |
  |                                          |
  |  same rules as JPEG mode decide:         |
  |  "worth capturing"                       |
  |  ---- "save frame #812, these boxes" --> |  saves that exact frame
  |                                          |  into the Review Queue
  |  <--- "saved, filename X" -------------  |
  |  shows it in the capture strip           |
```

1. Every result from the server says which frame number it describes.
2. The browser runs the **same capture rules as JPEG mode**: a "first"
   capture as soon as a polyp appears, then a "best" (sharpest) one a moment
   later, and a refresh every 8 s while it stays on screen.
3. The browser asks the server to save frame #N.
4. The server still holds that exact frame, so the saved picture and its
   boxes always match.
5. The server sends the saved picture back so it appears in the on-screen
   capture strip.

## Why not let the browser save the frame itself?

- WebRTC gives frames no ID the browser can match later. Chrome may also
  skip or merge frames on a slow network, so "frame #812" can't be reliably
  found on the browser's side.
- Saving and uploading pictures from the browser costs CPU and upload
  bandwidth on the weak clinic PC. Avoiding that cost is the reason WebRTC
  mode exists.
- The server already has the picture, so re-sending it would be wasted work.

(It is possible to tag each video frame with hidden data, using a browser
feature called "insertable streams". That's a lot of work for the same
result, so it wasn't done.)

## Costs we accept

- **Capture quality = stream quality.** Captures are the size of the WebRTC
  stream: 320px wide by default, and compressed video. If reviewers find
  them too blurry, raise the WebRTC width setting (480 / 640 / 960) on the
  clinic PC. It's a browser setting, not a code change.
- **Network drop = no captures.** If the connection drops, the server
  receives nothing and captures nothing until it reconnects.
- **Too-late requests are refused.** If a request arrives after its frame
  has left the server's memory, the server replies "frame no longer held".
  That memory lasts about 5 s at 320px, but only about 1.5 s at 960px,
  because bigger frames fill the 64 MB limit sooner. That capture is skipped rather than replaced with the wrong
  picture.

## Where the code is

- Browser, capture rules and request: `frontend/src/components/LiveCameraPlayer.tsx`
  (`maybeAutoCapture`, `flushBest`, `sendWebrtcCapture`, `onWebrtcCaptured`)
- Server, frame memory and saving: `backend/routes/webrtc_infer.py`
  (`_Session.ring`, `_handle_capture`)
- Review queue storage (shared with JPEG mode): `backend/routes/feedback.py`
  (`_save_and_record`)
