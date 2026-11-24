# WebRTC mode: connection recovery — design

Goal: in WebRTC mode, detection must come back on its own after any network
drop, of any length, with nobody touching the clinic PC. Before this design,
a drop left the live video playing with no boxes (fps 0) until someone
reloaded the page.

Code: `frontend/src/lib/webrtcRecovery.ts` (the ladder, pure logic),
`frontend/src/lib/webrtcTransport.ts` (one connection attempt),
`frontend/src/components/LiveCameraPlayer.tsx` (wiring),
`backend/routes/webrtc_infer.py` (server side).
Background on the transport itself: `documents/webrtc-implementation-plan.txt`.

---

## 1. Concepts

### Two pipes

A WebRTC session is two separate connections. Detection needs both.

```
Pipe 1  VIDEO      browser ──UDP──► server     one way: video in (via the TURN relay)
Pipe 2  WEBSOCKET  browser ◄─TCP──► server     setup messages, then boxes back
```

- **UDP vs TCP.** TCP re-sends every lost packet and waits for it, which
  freezes live video. UDP drops lost packets and moves on — right for video,
  where the next frame replaces the lost one anyway. The video is carried as
  RTP (UDP packets with sequence numbers and timestamps).
- **Signaling** is the setup chat over the WebSocket: the server sends TURN
  credentials, then browser and server swap SDP "business cards" (offer and
  answer: which codecs, which addresses to reach each side at).

### Ports, STUN, TURN

- A connection has two ports: the sender's "from" port and the receiver's
  "to" port. A firewall checks the "to" port of incoming traffic.
- **Fixed vs random ports.** A fixed port is for being *found* by strangers
  (websites on 443, coturn on 3478). WebRTC picks a random free port per
  connection, because the other side is *told* the port in the SDP card —
  and random ports let many calls share one machine without clashing.
- **The problem.** The Iran server sits behind its hosting provider's
  firewall, which blocks every port except a few fixed ones. The backend's
  random video port is blocked from outside.
- **STUN** = a mirror: "what public address do you see me coming from?"
  It carries no video and opens no doors. (We use Google's.)
- **TURN** = a relay. **coturn** runs on the same server, on port 3478,
  which the provider opened. The browser sends video *to* 3478 (allowed);
  coturn passes it to the backend *inside* the box, where no firewall sits,
  so the backend's random port no longer matters. coturn keeps a table
  (sender address → session) so concurrent sessions never mix.
- **Hairpin NAT.** The server cannot reach its own public IP from inside.
  So the browser uses coturn's public address and the backend uses the
  private one (`TURN_HOST_INTERNAL`).
- **TURN credentials** are made per connection from a secret shared with
  coturn and expire after 1 hour. Every rebuild (below) fetches fresh ones.

### How each pipe breaks

The video pipe's status is owned by the browser's `RTCPeerConnection`:

| State | Meaning |
|---|---|
| `connected` | working |
| `disconnected` | short glitch — often heals by itself within seconds |
| `failed` | the browser gave up; Chrome never recovers from this alone |

- **Break A — video pipe fails**, WebSocket still open: no video reaches the
  server, so no boxes come back.
- **Break B — WebSocket closes** (backend restart, nginx reload, network
  blip): the server deliberately tears down *both* pipes on its side, since
  without the WebSocket it can't return boxes.

To the doctor both look identical: live video, no boxes.

### Network slowness is a different problem

WebRTC's built-in congestion control (always on, nothing to enable) lowers
bitrate/resolution when the link gets slow. That keeps video flowing on a
*slow* link; it does nothing for a *broken* one. Recovery is for broken.

---

## 2. The repair ladder

Cheapest fix first; climb only if it fails.

| Rung | Trigger | Action |
|---|---|---|
| 1. Wait | video pipe `disconnected` | give it 4 s to heal |
| 2. Rebuild | `failed`; WebSocket closed; rung 1 timed out; an attempt not connected within 10 s | close everything, open a fresh WebSocket + fresh TURN credentials + fresh video pipe (= an automatic page reload of the connection). Waits between tries: 1, 2, 4, 8, 15, 15 … s, ±20 % random jitter |
| 3. Watchdog | frames are being sent but no server message for 6 s (30 s before the first result, so a cold GPU start isn't a failure) | force a rebuild — catches silent failures no status reports |
| 4. Fall back | 4 attempts in a row reached the server (WebSocket opened) but the video pipe never connected, or server says WebRTC isn't installed | switch this session to JPEG mode, show that it switched; JPEG mode reconnects forever on its own |

Server side: when the server's own video pipe reaches `failed`, it closes the
WebSocket, so the browser learns at once and the server finalizes the
recording instead of holding it open.

Attempts that can't reach the server at all do **not** count toward the
fallback. A backend restart refuses connections for 10–20 s; counting those
would drop every session to JPEG on a routine restart, although JPEG mode is
just as cut off. Only "server answered, video still couldn't get through"
(e.g. a network that blocks UDP and TURN) is evidence against WebRTC itself.

The backoff resets only after an attempt delivers a real result, not merely
on "connected" — otherwise a link that connects and immediately dies would
retry every second forever.

The watchdog only counts while the browser's encoder is actually producing
frames (from `getStats()`). A background tab stops drawing the canvas, so no
frames are sent and no results are expected — that must not trigger rebuilds.

### Why no ICE restart

ICE is the "find a working route" step. The textbook rung between Wait and
Rebuild is an **ICE restart**: find a new route without tearing down the
connection (~1–2 s, video kept). The server's library, aiortc 1.16.0, has no
ICE-restart support (checked in its installed source), so we rebuild instead
(~1–3 s more blackout). Revisit if aiortc adds it or the server side moves to
a different WebRTC stack.

### Why retry forever

Several sources say "cap the retries" — they are written for phones, where
retries waste battery. This is an unattended clinic PC; giving up is never
right. After 4 failed tries we hand over to JPEG mode, which itself retries
forever.

---

## 3. Effect on recording and captures

Server-side recording (WebRTC mode) belongs to one connection. On a rebuild:

- the server finalizes the open recording with reason `disconnect`;
- the browser resets its recorder state, so the auto-record rules start a
  **new** recording on the next in-body frame;
- frame numbers restart per connection, so pending "file frame #N" captures
  from the old connection are dropped.

Accepted cost: a gap of a few seconds, and two recording files instead of one.

---

## 4. Sources

- BlogGeek, ICE restart — https://bloggeek.me/webrtcglossary/ice-restart/
- RTMA, connection recovery & ICE restart —
  https://www.real-time-media-architecture.com/webrtc-protocol-stack-signaling-servers/connection-recovery-ice-restart/
- RTMA, disconnected vs failed —
  https://www.real-time-media-architecture.com/webrtc-protocol-stack-signaling-servers/connection-recovery-ice-restart/disconnected-vs-failed-ice-connection-states/
- Fora Soft, telemedicine reconnection —
  https://www.forasoft.com/learn/telemedicine/articles-telemedicine/connection-reliability-reconnection-degradation
