// Run: node --test "frontend/tests/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { aiHealth, AI_HEALTH } from "../src/lib/inferenceHealth.ts";

const T = 100_000; // "now" in every case; timestamps are relative to it
const base = { now: T, streaming: true, connected: true, startedAt: T - 60_000, lastSentAt: T - 100, sendingSince: T - 60_000, lastOkAt: T - 200 };

test("healthy: sending and results arriving -> no banner", () => {
  assert.equal(aiHealth(base), null);
});

test("session not running -> no banner (the 'stopped' label covers it)", () => {
  assert.equal(aiHealth({ ...base, streaming: false, connected: false }), null);
});

test("connection down -> reconnecting, even if nothing is being sent", () => {
  assert.equal(aiHealth({ ...base, connected: false }), "reconnecting");
  assert.equal(aiHealth({ ...base, connected: false, lastSentAt: 0 }), "reconnecting");
});

test("sending but no result for 3 s -> no-results", () => {
  assert.equal(aiHealth({ ...base, lastOkAt: T - AI_HEALTH.NO_RESULT_MS + 1 }), null);
  assert.equal(aiHealth({ ...base, lastOkAt: T - AI_HEALTH.NO_RESULT_MS }), "no-results");
});

test("out of body (nothing sent) is NOT a fault, however long", () => {
  assert.equal(aiHealth({ ...base, lastSentAt: T - 60_000, lastOkAt: T - 60_000 }), null);
});

test("back in the body after a long pause: no flash before the first answer can arrive", () => {
  const s = { ...base, lastOkAt: T - 60_000, sendingSince: T - 50, lastSentAt: T - 50 };
  assert.equal(aiHealth(s), null, "just resumed sending");
  assert.equal(aiHealth({ ...s, sendingSince: T - AI_HEALTH.NO_RESULT_MS }), "no-results",
    "but 3 s of sending with no answer is a real fault");
});

test("start: grace, then 'starting' until the first result", () => {
  const fresh = { ...base, startedAt: T - 500, lastOkAt: 0 };
  assert.equal(aiHealth(fresh), null, "first 1.5 s: no flash");
  assert.equal(aiHealth({ ...fresh, startedAt: T - AI_HEALTH.START_GRACE_MS }), "starting");
  assert.equal(aiHealth({ ...fresh, startedAt: T - 30_000 }), "starting", "cold GPU: stays 'starting', not 'no-results'");
  assert.equal(aiHealth({ ...fresh, startedAt: T - 30_000, lastOkAt: T - 10 }), null);
});

test("not connected yet at session start is 'starting', not 'reconnecting'", () => {
  const fresh = { ...base, connected: false, lastOkAt: 0, lastSentAt: 0 };
  assert.equal(aiHealth({ ...fresh, startedAt: T - 500 }), null);
  assert.equal(aiHealth({ ...fresh, startedAt: T - 5_000 }), "starting");
});
