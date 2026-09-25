import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { PCM_VOICE, encodeVoiceWav, inspectVoiceWav } from "../lib/memories/voice-wav";
import { parseVoiceSave } from "../lib/memories/voice-contract";

test("canonical WAV parser derives a strict 30 second duration from PCM bytes", () => {
  const bytes = encodeVoiceWav(new Int16Array(PCM_VOICE.samples));
  assert.deepEqual(inspectVoiceWav(bytes), { samples: 1440000, milliseconds: 30000, bytes: 2880044, mime: "audio/wav" });
  assert.throws(() => encodeVoiceWav(new Int16Array(PCM_VOICE.samples + 1)));
  assert.throws(() => encodeVoiceWav(new Int16Array()));
});
test("WAV parser rejects forged headers, overlong data, extra chunks and trailing bytes", () => {
  const original = encodeVoiceWav(new Int16Array([1, -32768, 32767]));
  for (const offset of [0, 4, 8, 12, 16, 20, 22, 24, 28, 32, 34, 36, 40]) {
    const bytes = original.slice(); bytes[offset] ^= 1; assert.throws(() => inspectVoiceWav(bytes), `header offset ${offset}`);
  }
  assert.throws(() => inspectVoiceWav(new Uint8Array([...original, 0])));
  assert.throws(() => inspectVoiceWav(new Uint8Array(PCM_VOICE.bytes + 2)));
});
test("worklet emits bounded ordered PCM blocks and stops exactly at the sample cap", () => {
  const output: { sequence?: number; samples: Int16Array | number; done?: boolean }[] = [];
  let Processor!: new () => { process(inputs: Float32Array[][]): boolean; port: { onmessage(event: { data: string }): void } };
  runInNewContext(readFileSync(new URL("../public/voice-pcm-worklet.js", import.meta.url), "utf8"), {
    AudioWorkletProcessor: class { port = { postMessage: (value: typeof output[number]) => output.push(value) }; },
    registerProcessor: (_: string, value: typeof Processor) => { Processor = value; }, Int16Array, Number, Math,
  });
  const processor = new Processor(), channel = new Float32Array(128).fill(0.5);
  for (let i = 0; i < 12000; i++) processor.process([[channel]]);
  const blocks = output.filter(row => !row.done);
  assert.equal(blocks.reduce((sum, row) => sum + (row.samples as Int16Array).length, 0), PCM_VOICE.samples);
  blocks.forEach((row, index) => { assert.equal(row.sequence, index); assert.ok((row.samples as Int16Array).length <= PCM_VOICE.block); });
  assert.equal(output.at(-1)?.done, true); assert.equal(output.at(-1)?.samples, PCM_VOICE.samples);
  assert.equal(output.filter(row => row.done).length, 1);
});
test("large base64 validation is bounded and rejects malformed padding", () => {
  const base = { requestId: "11111111-1111-4111-8111-111111111111", revision: 0, text: "", audio: { operation: "replace", wav: Buffer.from(encodeVoiceWav(new Int16Array(PCM_VOICE.samples))).toString("base64") } };
  assert.equal(parseVoiceSave(base).audio.operation, "replace");
  assert.throws(() => parseVoiceSave({ ...base, text: "x".repeat(2001) }));
  assert.throws(() => parseVoiceSave({ ...base, audio: { operation: "replace", wav: "A=AA" } }));
});
