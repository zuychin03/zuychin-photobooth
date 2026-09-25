import { test } from "node:test";
import assert from "node:assert/strict";
import { createPcmVoiceRecorder } from "../lib/memories/voice-pcm-recorder";
test("PCM capture cancelled during permission cannot keep a late microphone stream", async () => {
  let resolve!: (stream: MediaStream) => void, stopped = 0, ready = 0;
  const recorder = createPcmVoiceRecorder({ state() {}, ready: () => ready++, error: error => { throw error; } }, () => new Promise(done => { resolve = done; }));
  const pending = recorder.start(); recorder.cancel();
  resolve({ getTracks: () => [{ stop: () => stopped++ }, { stop: () => stopped++ }] } as unknown as MediaStream);
  await pending; assert.equal(stopped, 2); assert.equal(ready, 0);
});
test("PCM permission denial produces text fallback and releases active state", async () => {
  const errors: string[] = [], states: string[] = [];
  const recorder = createPcmVoiceRecorder({ state: state => states.push(state), ready() {}, error: error => errors.push(error.message) }, async () => { throw new DOMException("Denied", "NotAllowedError"); });
  await recorder.start(); await recorder.start();
  assert.equal(errors.length, 2); assert.match(errors[0], /declined/); assert.equal(states.at(-1), "idle");
});
