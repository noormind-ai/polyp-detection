// Run: node --test frontend/tests/   (Node >= 22.18 runs .ts directly)
import { test } from "node:test";
import assert from "node:assert/strict";
import { WEBRTC_NATIVE, webrtcSendWidth, webrtcSendHeight } from "../src/lib/webrtcSize.ts";

test("native sends the source's own width", () => {
  assert.equal(webrtcSendWidth(WEBRTC_NATIVE, 720), 720);
  assert.equal(webrtcSendWidth(WEBRTC_NATIVE, 1920), 1920);
});

test("a fixed width shrinks a larger source", () => {
  assert.equal(webrtcSendWidth(320, 720), 320);
  assert.equal(webrtcSendWidth(960, 1920), 960);
});

test("a fixed width never upscales a smaller source", () => {
  assert.equal(webrtcSendWidth(960, 720), 720);
});

test("sizes are even, as H.264 needs", () => {
  assert.equal(webrtcSendWidth(WEBRTC_NATIVE, 701), 702);
  assert.equal(webrtcSendHeight(320, 720, 576), 256);
  assert.equal(webrtcSendHeight(702, 701, 575) % 2, 0);
});
