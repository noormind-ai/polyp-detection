/** The "repair ladder" for WebRTC mode: keeps detection alive across network
 *  drops of any length, with nobody at the clinic PC to reload the page.
 *
 *  Concepts and the reasoning for every number below:
 *  documents/design/webrtc-connection-recovery.md.
 *
 *  Pure logic, no browser APIs: one connection ATTEMPT (WebSocket + video
 *  pipe, see webrtcTransport.ts) is created by the injected `connect` and
 *  reports what happens to it as AttemptEvents; this file decides what to do.
 *  The clock and randomness are injected too, so tests drive it with a fake
 *  clock (frontend/tests/webrtcRecovery.test.ts).
 *
 *  Rungs, cheapest first:
 *    1. WAIT      video pipe "disconnected" -> give it DISCONNECT_GRACE_MS.
 *    2. REBUILD   "failed", WebSocket closed, grace ran out, or an attempt
 *                 not connected within CONNECT_TIMEOUT_MS -> throw the
 *                 attempt away and open a fresh one after a backoff wait.
 *                 (No ICE restart: the server's aiortc doesn't support it.)
 *    3. WATCHDOG  frames are being sent but the server has said nothing for
 *                 SILENCE_MS (FIRST_RESULT_MS before an attempt's first
 *                 result) -> REBUILD.
 *    4. FALL BACK FALLBACK_AFTER attempts in a row reached the server (its
 *                 WebSocket opened) but the video pipe still never
 *                 connected, or the server can't do WebRTC at all -> give
 *                 up on WebRTC; the caller switches to JPEG mode.
 *                 Attempts that can't even reach the server don't count: a
 *                 backend restart or a dead network would stop JPEG mode
 *                 just the same, so WebRTC keeps retrying through those.
 */

export type PipeState = "connecting" | "connected" | "disconnected" | "failed";

/** What one attempt reports. "message" = ANY message from the server (a
 *  result, an error reply, a control reply) -- proof the server side is
 *  alive. "frames" = the browser encoder's cumulative framesEncoded, from
 *  getStats(): proof the browser is actually sending video. */
export type AttemptEvent =
  | { kind: "ws-open" }
  | { kind: "pipe"; state: PipeState }
  | { kind: "ws-closed"; code: number }
  | { kind: "message" }
  | { kind: "frames"; encoded: number };

export type Attempt = { close: () => void; send: (msg: object) => boolean };

/** Status of the whole WebRTC SESSION (all attempts together), not of one
 *  attempt or one pipe. */
export type RecoveryStatus = "connecting" | "open" | "reconnecting" | "fallback" | "closed";

export type RecoveryInfo = {
  /** Why we are reconnecting / fell back, e.g. "failed", "ws-closed:1006", "watchdog". */
  reason?: string;
  /** 1-based number of the attempt being made or waited for. */
  attempt: number;
  /** Wait before the next attempt, when status is "reconnecting" after a failure. */
  retryInMs?: number;
};

export type Clock = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
};

export const RECOVERY = {
  DISCONNECT_GRACE_MS: 4_000,
  CONNECT_TIMEOUT_MS: 10_000,
  SILENCE_MS: 6_000,
  FIRST_RESULT_MS: 30_000,
  WATCHDOG_TICK_MS: 1_000,
  BACKOFF_BASE_MS: 1_000,
  BACKOFF_MAX_MS: 15_000,
  JITTER: 0.2,
  FALLBACK_AFTER: 4,
  /** Server closes with this when WebRTC can't work there at all (aiortc
   *  missing) -- retrying is pointless, fall back at once. */
  UNAVAILABLE_CLOSE_CODE: 1011,
};

/** Wait before retry number `n` (0-based): 1, 2, 4, 8, 15, 15 ... s, each
 *  scaled by a random factor in [1-JITTER, 1+JITTER] so many clients that
 *  lost the server together don't all hit it again in the same instant. */
export function backoffMs(n: number, random: () => number = Math.random): number {
  const base = Math.min(RECOVERY.BACKOFF_MAX_MS, RECOVERY.BACKOFF_BASE_MS * 2 ** n);
  const factor = 1 - RECOVERY.JITTER + 2 * RECOVERY.JITTER * random();
  return Math.round(base * factor);
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export function superviseWebrtc(opts: {
  connect: (emit: (e: AttemptEvent) => void) => Attempt;
  onStatus: (status: RecoveryStatus, info: RecoveryInfo) => void;
  /** A NEW attempt connected after an earlier one had been open: anything
   *  tied to the old server-side session (recording, frame numbers) is gone. */
  onReconnected?: () => void;
  clock?: Clock;
  random?: () => number;
  log?: (msg: string) => void;
}): { close: () => void; send: (msg: object) => boolean } {
  const clock = opts.clock ?? realClock;
  const random = opts.random ?? Math.random;
  const log = opts.log ?? ((m: string) => console.info(`[webrtc] ${m}`));

  let closed = false;
  let attemptNo = 0;
  let failsInRow = 0;   // attempts in a row that reached the server but whose video pipe never connected
  let backoffIdx = 0;   // reset only when an attempt delivers a real result
  let everOpened = false;

  // Per-attempt state. `cur` is null between attempts (during a backoff wait).
  let cur: Attempt | null = null;
  let curId = 0;
  let connected = false;
  let wsOpened = false;
  let gotMessage = false;
  let silentMs = 0;
  let framesAtLastTick = -1;
  let framesNow = -1;
  let messageSinceTick = false;
  let connectTimer: unknown = null;
  let graceTimer: unknown = null;
  let watchdogTimer: unknown = null;
  let retryTimer: unknown = null;

  const clear = (id: unknown) => { if (id !== null) clock.clearTimeout(id); };

  function teardown() {
    clear(connectTimer); connectTimer = null;
    clear(graceTimer); graceTimer = null;
    clear(watchdogTimer); watchdogTimer = null;
    const a = cur;
    cur = null;
    curId += 1; // late events from the old attempt are now ignored
    try { a?.close(); } catch { /* already closed */ }
  }

  function start() {
    retryTimer = null;
    if (closed) return;
    attemptNo += 1;
    const id = ++curId;
    connected = false;
    wsOpened = false;
    gotMessage = false;
    silentMs = 0;
    framesAtLastTick = -1;
    framesNow = -1;
    messageSinceTick = false;
    opts.onStatus(everOpened ? "reconnecting" : "connecting", { attempt: attemptNo });
    log(`attempt ${attemptNo} starting`);
    connectTimer = clock.setTimeout(() => {
      if (id === curId && !connected) fail("connect-timeout");
    }, RECOVERY.CONNECT_TIMEOUT_MS);
    cur = opts.connect((e) => { if (id === curId && !closed) handle(e); });
  }

  function handle(e: AttemptEvent) {
    switch (e.kind) {
      case "ws-open":
        wsOpened = true;
        break;
      case "pipe":
        if (e.state === "connected") onConnected();
        else if (e.state === "disconnected") onDisconnected();
        else if (e.state === "failed") fail("failed");
        break;
      case "ws-closed":
        if (e.code === RECOVERY.UNAVAILABLE_CLOSE_CODE) fallback(`ws-closed:${e.code}`);
        else fail(`ws-closed:${e.code}`);
        break;
      case "message":
        messageSinceTick = true;
        silentMs = 0;
        if (!gotMessage) {
          gotMessage = true;
          backoffIdx = 0; // a real result -- this link genuinely works
        }
        break;
      case "frames":
        framesNow = e.encoded;
        break;
    }
  }

  function onConnected() {
    clear(connectTimer); connectTimer = null;
    if (graceTimer !== null) {
      clear(graceTimer); graceTimer = null;
      log("video pipe healed by itself");
      opts.onStatus("open", { attempt: attemptNo });
      return;
    }
    if (connected) return;
    connected = true;
    failsInRow = 0;
    const isReconnect = everOpened;
    everOpened = true;
    log(`attempt ${attemptNo} connected`);
    opts.onStatus("open", { attempt: attemptNo });
    if (isReconnect) opts.onReconnected?.();
    watchdogTimer = clock.setTimeout(tick, RECOVERY.WATCHDOG_TICK_MS);
  }

  function onDisconnected() {
    if (!connected || graceTimer !== null) return;
    log(`video pipe disconnected, waiting ${RECOVERY.DISCONNECT_GRACE_MS} ms for it to heal`);
    opts.onStatus("reconnecting", { attempt: attemptNo, reason: "disconnected" });
    graceTimer = clock.setTimeout(() => {
      graceTimer = null;
      fail("disconnected-too-long");
    }, RECOVERY.DISCONNECT_GRACE_MS);
  }

  /** Silence only counts while the browser is really sending frames: a
   *  background tab stops drawing the canvas, nothing is sent, and no result
   *  is owed -- that must not look like a dead server. */
  function tick() {
    watchdogTimer = null;
    if (closed || !cur) return;
    const sending = framesNow > framesAtLastTick && framesAtLastTick >= 0;
    framesAtLastTick = framesNow;
    if (messageSinceTick) silentMs = 0;
    else if (sending && graceTimer === null) silentMs += RECOVERY.WATCHDOG_TICK_MS;
    messageSinceTick = false;
    const limit = gotMessage ? RECOVERY.SILENCE_MS : RECOVERY.FIRST_RESULT_MS;
    if (silentMs >= limit) {
      fail("watchdog");
      return;
    }
    watchdogTimer = clock.setTimeout(tick, RECOVERY.WATCHDOG_TICK_MS);
  }

  function fail(reason: string) {
    if (closed) return;
    // Only "server answered, video still couldn't get through" is evidence
    // against WebRTC itself; an unreachable server says nothing about it.
    const webrtcFailed = !connected && wsOpened;
    teardown();
    if (webrtcFailed) failsInRow += 1;
    if (failsInRow >= RECOVERY.FALLBACK_AFTER) {
      fallback(`${reason} (${failsInRow} attempts reached the server but video never connected)`);
      return;
    }
    const wait = backoffMs(backoffIdx, random);
    backoffIdx += 1;
    log(`attempt ${attemptNo} lost (${reason}); retrying in ${wait} ms`);
    opts.onStatus("reconnecting", { attempt: attemptNo + 1, reason, retryInMs: wait });
    retryTimer = clock.setTimeout(start, wait);
  }

  function fallback(reason: string) {
    teardown();
    closed = true;
    log(`giving up on WebRTC: ${reason}`);
    opts.onStatus("fallback", { attempt: attemptNo, reason });
  }

  start();

  return {
    close() {
      if (closed) return;
      closed = true;
      clear(retryTimer); retryTimer = null;
      teardown();
      opts.onStatus("closed", { attempt: attemptNo });
    },
    send(msg) {
      return cur ? cur.send(msg) : false;
    },
  };
}
