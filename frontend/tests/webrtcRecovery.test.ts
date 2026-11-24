// Run: node --test frontend/tests/   (Node >= 22.18 runs .ts directly)
// Drives the WebRTC repair ladder with a fake clock and fake attempts.
// Design: documents/design/webrtc-connection-recovery.md
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  superviseWebrtc, backoffMs, RECOVERY,
  type AttemptEvent, type RecoveryStatus, type RecoveryInfo,
} from "../src/lib/webrtcRecovery.ts";

// ---------- harness ----------

function fakeClock() {
  let t = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number) => { const id = nextId++; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimeout: (id: unknown) => { timers.delete(id as number); },
    /** Move time forward, firing due timers in order (including ones they schedule). */
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | null = null;
        for (const e of timers) if (e[1].at <= end && (!due || e[1].at < due[1].at)) due = e;
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
  };
}

function setup(opts: { random?: () => number } = {}) {
  const clock = fakeClock();
  const attempts: { emit: (e: AttemptEvent) => void; closed: boolean; sent: object[] }[] = [];
  const statuses: [RecoveryStatus, RecoveryInfo][] = [];
  let reconnected = 0;
  const session = superviseWebrtc({
    connect: (emit) => {
      const a = { emit, closed: false, sent: [] as object[] };
      attempts.push(a);
      return { close: () => { a.closed = true; }, send: (m) => { a.sent.push(m); return true; } };
    },
    onStatus: (s, i) => statuses.push([s, i]),
    onReconnected: () => { reconnected += 1; },
    clock,
    random: opts.random ?? (() => 0.5), // jitter factor exactly 1.0
    log: () => {},
  });
  const last = () => attempts[attempts.length - 1];
  return {
    clock, attempts, statuses, session, last,
    get reconnected() { return reconnected; },
    status: () => statuses[statuses.length - 1][0],
    connect: () => { last().emit({ kind: "ws-open" }); last().emit({ kind: "pipe", state: "connected" }); },
    /** The server answered (WebSocket open) but video never connects; then it closes. */
    reachableButNoVideo: () => { last().emit({ kind: "ws-open" }); last().emit({ kind: "ws-closed", code: 4000 }); },
    /** Simulate a healthy stream for `ms`: frames advancing + a result each second. */
    healthy(ms: number) {
      for (let i = 0; i < ms / 1000; i++) {
        last().emit({ kind: "frames", encoded: (i + 1) * 30 + attempts.length * 10_000 });
        last().emit({ kind: "message" });
        clock.advance(1000);
      }
    },
  };
}

// ---------- tests ----------

test("backoff: 1,2,4,8,15,15 s and jitter stays within ±20%", () => {
  const mid = () => 0.5;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((n) => backoffMs(n, mid)), [1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  assert.equal(backoffMs(0, () => 0), 800);
  assert.equal(backoffMs(0, () => 1), 1200);
  assert.equal(backoffMs(4, () => 1), 18000);
});

test("happy path: connecting -> open, one attempt, no reconnect", () => {
  const h = setup();
  assert.equal(h.status(), "connecting");
  h.connect();
  assert.equal(h.status(), "open");
  h.healthy(60_000);
  assert.equal(h.attempts.length, 1);
  assert.equal(h.reconnected, 0);
});

test("rung 1: a disconnected pipe that heals within the grace is left alone", () => {
  const h = setup();
  h.connect();
  h.healthy(3000);
  h.last().emit({ kind: "pipe", state: "disconnected" });
  assert.equal(h.status(), "reconnecting");
  h.clock.advance(RECOVERY.DISCONNECT_GRACE_MS - 500);
  h.connect(); // healed by itself
  assert.equal(h.status(), "open");
  h.clock.advance(10_000);
  assert.equal(h.attempts.length, 1, "no rebuild");
  assert.equal(h.attempts[0].closed, false);
});

test("rung 1 -> 2: disconnected longer than the grace triggers a rebuild", () => {
  const h = setup();
  h.connect();
  h.healthy(3000);
  h.last().emit({ kind: "pipe", state: "disconnected" });
  h.clock.advance(RECOVERY.DISCONNECT_GRACE_MS);
  assert.equal(h.attempts[0].closed, true);
  assert.equal(h.statuses.at(-1)![1].reason, "disconnected-too-long");
  h.clock.advance(1000); // backoff 1 s
  assert.equal(h.attempts.length, 2);
});

test("rung 2: failed pipe -> rebuild after 1 s; reconnected callback fires on the new open", () => {
  const h = setup();
  h.connect();
  h.healthy(5000);
  h.last().emit({ kind: "pipe", state: "failed" });
  assert.equal(h.attempts[0].closed, true);
  assert.equal(h.status(), "reconnecting");
  h.clock.advance(999);
  assert.equal(h.attempts.length, 1, "waits the backoff");
  h.clock.advance(1);
  assert.equal(h.attempts.length, 2);
  h.connect();
  assert.equal(h.status(), "open");
  assert.equal(h.reconnected, 1);
});

test("rung 2: WebSocket close (e.g. backend restart, 1006) -> rebuild", () => {
  const h = setup();
  h.connect();
  h.healthy(2000);
  h.last().emit({ kind: "ws-closed", code: 1006 });
  assert.equal(h.statuses.at(-1)![1].reason, "ws-closed:1006");
  h.clock.advance(1000);
  assert.equal(h.attempts.length, 2);
});

test("rung 2: an attempt that never connects times out and is retried", () => {
  const h = setup();
  h.clock.advance(RECOVERY.CONNECT_TIMEOUT_MS);
  assert.equal(h.attempts[0].closed, true);
  assert.equal(h.statuses.at(-1)![1].reason, "connect-timeout");
});

test("long outage: keeps retrying with growing waits, recovers when the network returns", () => {
  const h = setup();
  h.connect();
  h.healthy(5000);
  // Outage: every new attempt connects (TURN reachable) but the socket drops at once.
  h.last().emit({ kind: "ws-closed", code: 1006 });
  const waits: number[] = [];
  for (let i = 0; i < 8; i++) {
    waits.push(h.statuses.at(-1)![1].retryInMs!);
    h.clock.advance(waits.at(-1)!);
    h.connect();                                   // connected, so not a "never connected" failure
    h.last().emit({ kind: "ws-closed", code: 1006 });
  }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000]);
  assert.notEqual(h.status(), "fallback");
  // Network back.
  h.clock.advance(h.statuses.at(-1)![1].retryInMs!);
  h.connect();
  h.healthy(3000);
  assert.equal(h.status(), "open");
});

test("backoff resets only after a real result, not on mere 'connected'", () => {
  const h = setup();
  h.connect();
  h.healthy(2000);
  h.last().emit({ kind: "pipe", state: "failed" });   // wait 1 s
  h.clock.advance(1000); h.connect();
  h.last().emit({ kind: "pipe", state: "failed" });   // connected, no result -> wait 2 s
  assert.equal(h.statuses.at(-1)![1].retryInMs, 2000);
  h.clock.advance(2000); h.connect();
  h.healthy(2000);                                     // real results
  h.last().emit({ kind: "pipe", state: "failed" });
  assert.equal(h.statuses.at(-1)![1].retryInMs, 1000, "reset after results");
});

test("rung 3 watchdog: frames sent, server silent for 6 s -> rebuild", () => {
  const h = setup();
  h.connect();
  h.healthy(3000);
  let f = 1_000_000;
  for (let i = 0; i < RECOVERY.SILENCE_MS / 1000 + 1 && h.attempts.length === 1; i++) {
    h.last().emit({ kind: "frames", encoded: (f += 30) });
    h.clock.advance(1000);
  }
  assert.equal(h.attempts[0].closed, true);
  assert.ok(h.statuses.some(([, i]) => i.reason === "watchdog"));
  assert.ok(h.clock.now() - 3000 <= RECOVERY.SILENCE_MS + 1000, "fired within ~6 s of silence");
});

test("rung 3 watchdog: no frames being sent (background tab) is NOT a failure", () => {
  const h = setup();
  h.connect();
  h.healthy(3000);
  h.clock.advance(120_000); // no frames, no messages
  assert.equal(h.attempts.length, 1);
  assert.equal(h.attempts[0].closed, false);
});

test("rung 3 watchdog: before the first result it allows 30 s (cold GPU start)", () => {
  const h = setup();
  h.connect();
  let f = 0;
  for (let i = 0; i < 20; i++) { h.last().emit({ kind: "frames", encoded: (f += 30) }); h.clock.advance(1000); }
  assert.equal(h.attempts[0].closed, false, "20 s without a first result is still fine");
  for (let i = 0; i < 15; i++) { h.last().emit({ kind: "frames", encoded: (f += 30) }); h.clock.advance(1000); }
  assert.equal(h.attempts[0].closed, true, "but not forever");
});

test("rung 4: falls back after 4 attempts in a row that reached the server but never got video", () => {
  const h = setup();
  for (let i = 0; i < 3; i++) {
    h.reachableButNoVideo();
    assert.equal(h.status(), "reconnecting");
    h.clock.advance(h.statuses.at(-1)![1].retryInMs!);
  }
  h.reachableButNoVideo();
  assert.equal(h.status(), "fallback");
  h.clock.advance(120_000);
  assert.equal(h.attempts.length, 4, "no more attempts after fallback");
});

test("rung 4: a connection in between resets the never-connected count", () => {
  const h = setup();
  const failNow = () => {
    h.reachableButNoVideo();
    h.clock.advance(h.statuses.at(-1)![1].retryInMs!);
  };
  failNow(); failNow(); failNow();          // 3 never-connected in a row
  h.connect();                              // 4th connects -> count resets
  h.last().emit({ kind: "pipe", state: "failed" });
  h.clock.advance(h.statuses.at(-1)![1].retryInMs!);
  failNow(); failNow(); failNow();          // 3 more: still below 4
  assert.notEqual(h.status(), "fallback");
  failNow();                                // 4th in a row -> now fall back
  assert.equal(h.status(), "fallback");
});

test("rung 4: server unreachable (backend restart) never counts toward fallback", () => {
  const h = setup();
  h.connect();
  h.healthy(3000);
  h.last().emit({ kind: "ws-closed", code: 1012 });       // server going down
  for (let i = 0; i < 12; i++) {                           // ~2.5 min of refused connections
    h.clock.advance(h.statuses.at(-1)![1].retryInMs!);
    h.last().emit({ kind: "ws-closed", code: 1006 });      // refused: never opened
  }
  assert.notEqual(h.status(), "fallback");
  h.clock.advance(h.statuses.at(-1)![1].retryInMs!);
  h.connect();                                             // server back
  h.healthy(2000);
  assert.equal(h.status(), "open");
});

test("rung 2: an attempt whose WebSocket hangs (server frozen) times out and doesn't count toward fallback", () => {
  const h = setup();
  for (let i = 0; i < 6; i++) {
    h.clock.advance(RECOVERY.CONNECT_TIMEOUT_MS);
    assert.equal(h.statuses.at(-1)![1].reason, "connect-timeout");
    h.clock.advance(h.statuses.at(-1)![1].retryInMs!);
  }
  assert.notEqual(h.status(), "fallback");
});

test("rung 4: server says WebRTC unavailable (1011) -> fall back at once", () => {
  const h = setup();
  h.last().emit({ kind: "ws-closed", code: RECOVERY.UNAVAILABLE_CLOSE_CODE });
  assert.equal(h.status(), "fallback");
  assert.equal(h.attempts.length, 1);
});

test("close(): stops everything, including a pending retry", () => {
  const h = setup();
  h.connect();
  h.last().emit({ kind: "pipe", state: "failed" });
  h.session.close();
  assert.equal(h.status(), "closed");
  h.clock.advance(60_000);
  assert.equal(h.attempts.length, 1);
});

test("events from an old, replaced attempt are ignored", () => {
  const h = setup();
  h.connect();
  const old = h.attempts[0];
  old.emit({ kind: "pipe", state: "failed" });
  h.clock.advance(1000);
  h.connect();
  old.emit({ kind: "ws-closed", code: 1006 }); // late close of the old socket
  assert.equal(h.status(), "open");
  assert.equal(h.attempts.length, 2);
});

test("send() goes to the current attempt; false while between attempts", () => {
  const h = setup();
  h.connect();
  assert.equal(h.session.send({ a: 1 }), true);
  h.last().emit({ kind: "pipe", state: "failed" });
  assert.equal(h.session.send({ a: 2 }), false);
  h.clock.advance(1000);
  assert.equal(h.session.send({ a: 3 }), true);
  assert.deepEqual(h.attempts[1].sent, [{ a: 3 }]);
});
