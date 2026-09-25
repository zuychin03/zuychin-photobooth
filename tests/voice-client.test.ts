import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceClient } from "../lib/memories/voice-client";
import { cloudSha256, type CloudIdentity } from "../lib/projects/cloud-client";
import { encodeVoiceWav } from "../lib/memories/voice-wav";
const ownerId = "11111111-1111-4111-8111-111111111111", activityId = "22222222-2222-4222-8222-222222222222", generation = "33333333-3333-4333-8333-333333333333";
test("voice download verifies canonical bytes and digest", async () => {
  const bytes = encodeVoiceWav(new Int16Array([100, -100])), hash = await cloudSha256(bytes.buffer);
  let bad = false;
  const client = createVoiceClient({ appOrigin: "https://example.test", identity: () => ({ ownerId, epoch: 1 }), accessToken: async () => "fixture", fetch: async () => new Response(bytes, { headers: { "Content-Type": "audio/wav", "X-Voice-Sha256": bad ? "0".repeat(64) : hash, "X-Voice-Generation": generation } }) });
  assert.equal((await client.download(activityId)).size, bytes.length);
  bad = true; await assert.rejects(client.download(activityId), /integrity_failed/); client.close();
});
test("account epoch changes before token resolution prevent requests", async () => {
  let identity: CloudIdentity | null = { ownerId, epoch: 1 }, resolve!: (value: string) => void, requests = 0;
  const client = createVoiceClient({ appOrigin: "https://example.test", identity: () => identity, accessToken: () => new Promise(done => { resolve = done; }), fetch: async () => { requests++; return new Response(); } });
  const pending = client.read(activityId); identity = { ownerId, epoch: 2 }; resolve("fixture");
  await assert.rejects(pending); assert.equal(requests, 0); assert.equal(client.signal.aborted, true);
});
test("late responses after account loss cannot reveal private caption text", async () => {
  let identity: CloudIdentity | null = { ownerId, epoch: 1 }, resolve!: (value: Response) => void;
  const client = createVoiceClient({ appOrigin: "https://example.test", identity: () => identity, accessToken: async () => "fixture", fetch: () => new Promise(done => { resolve = done; }) });
  const pending = client.read(activityId); await Promise.resolve(); identity = null;
  resolve(Response.json({ version: 1, activityId, revision: 1, text: "private", audio: null }));
  await assert.rejects(pending); assert.equal(client.signal.aborted, true);
});
