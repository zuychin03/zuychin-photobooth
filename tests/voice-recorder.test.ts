import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceRecorder, voiceExtension, VOICE_LIMITS, type VoiceRecording, type VoiceState } from "../lib/memories/voice-recorder";

function fixture() {
  let stopped = 0, now = 0;
  const states: VoiceState[] = [], errors: string[] = [], results: VoiceRecording[] = [];
  const stream = { getTracks: () => [{ stop: () => stopped++ }] } as unknown as MediaStream;
  const recorder = { state: "inactive", mimeType: "audio/ogg;codecs=opus", ondataavailable: null as null | ((event: { data: Blob }) => void), onstop: null as null | (() => void), onerror: null as null | (() => void), start() { this.state = "recording"; }, stop() { this.state = "inactive"; } };
  const callbacks = { state: (s: VoiceState) => states.push(s), ready: (r: VoiceRecording) => results.push(r), error: (e: string) => errors.push(e) };
  const deps = { getStream: async () => stream, supports: () => true, create: () => recorder as unknown as MediaRecorder, now: () => now };
  return { recorder, deps, callbacks, results, states, errors, stream, stopped: () => stopped, time: (value: number) => { now = value; } };
}
test("stop releases microphone immediately and keeps final encoded chunks and actual format", async () => {
  const f = fixture(), handle = createVoiceRecorder(f.callbacks, f.deps); await handle.start(); f.time(1500); handle.stop();
  assert.equal(f.stopped(), 1); f.recorder.ondataavailable?.({ data: new Blob(["voice"]) }); f.time(10000); f.recorder.onstop?.();
  assert.equal(f.results[0].extension, "ogg"); assert.equal(f.results[0].milliseconds, 1500); assert.equal(await f.results[0].blob.text(), "voice"); handle.cancel();
});
test("late microphone permission after cancellation releases every track without recording", async () => {
  const f = fixture(); let resolve!: (stream: MediaStream) => void;
  f.deps.getStream = () => new Promise(done => { resolve = done; });
  const handle = createVoiceRecorder(f.callbacks, f.deps), pending = handle.start(); handle.cancel(); resolve(f.stream); await pending;
  assert.equal(f.stopped(), 1); assert.equal(f.recorder.state, "inactive"); assert.equal(f.results.length, 0);
});
test("permission denial is actionable and can retry", async () => {
  const f = fixture(); f.deps.getStream = async () => { throw new DOMException("Denied", "NotAllowedError"); };
  const handle = createVoiceRecorder(f.callbacks, f.deps); await handle.start(); assert.match(f.errors[0], /declined/);
  f.deps.getStream = async () => f.stream; await handle.start(); assert.equal(f.recorder.state, "recording"); handle.cancel();
});
test("oversized and overlong recordings are rejected, cancellation suppresses stale chunks", async () => {
  const f = fixture(), handle = createVoiceRecorder(f.callbacks, f.deps); await handle.start();
  const stale = f.recorder.ondataavailable; stale?.({ data: new Blob([new Uint8Array(VOICE_LIMITS.bytes + 1)]) });
  assert.equal(f.stopped(), 1); assert.match(f.errors[0], /10 MB/); stale?.({ data: new Blob(["late"]) }); assert.equal(f.results.length, 0);
  await handle.start(); f.time(31000); handle.stop(); f.recorder.ondataavailable?.({ data: new Blob(["voice"]) }); f.recorder.onstop?.();
  assert.match(f.errors[1], /30 seconds/); assert.equal(f.results.length, 0);
});
test("unknown audio formats and empty recordings fail closed", async () => {
  assert.throws(() => voiceExtension("video/webm")); assert.equal(voiceExtension("audio/mp4;codecs=mp4a.40.2"), "m4a");
  const f = fixture(), handle = createVoiceRecorder(f.callbacks, f.deps); await handle.start(); handle.stop(); f.recorder.onstop?.(); assert.match(f.errors[0], /No audio/);
});
test("the 30 second deadline stops recording without user interaction", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), handle = createVoiceRecorder(f.callbacks, f.deps); await handle.start();
  f.time(30000); context.mock.timers.tick(30000);
  assert.equal(f.recorder.state, "inactive"); assert.equal(f.stopped(), 1);
  f.recorder.ondataavailable?.({ data: new Blob(["voice"]) }); f.recorder.onstop?.();
  assert.equal(f.results[0].milliseconds, 30000);
});
