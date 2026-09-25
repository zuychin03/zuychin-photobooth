import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { VoiceError, type VoiceCaptionSnapshot } from "../lib/memories/voice-contract";
import { encodeVoiceWav } from "../lib/memories/voice-wav";
import { createVoiceHandler, type VoiceRequestPorts } from "../lib/server/voice-requests";
import { createVoiceStore, type VoiceStage } from "../lib/server/voice-store";
import { createVoiceObjects } from "../lib/server/voice-objects";
import { processVoiceMaintenance } from "../lib/server/voice-maintenance";
import type { ProjectStorePorts } from "../lib/server/project-store";

const actor = randomUUID(), activityId = randomUUID(), generation = randomUUID();
const env = { PB_MEMORIES_ENABLED: "true", PB_VOICE_CAPTIONS_ENABLED: "true", PB_PUBLIC_ORIGIN: "https://app.example.invalid", NEXT_PUBLIC_SUPABASE_URL: "https://db.example.invalid", SUPABASE_SERVICE_ROLE_KEY: "nonsecret-service-fixture" };
const wav = encodeVoiceWav(new Int16Array([0, -800, 1200])), sha256 = createHash("sha256").update(wav).digest("hex");
const audio = { generation, bytes: wav.length, samples: 3, sha256, mime: "audio/wav" as const };
const snapshot: VoiceCaptionSnapshot = { version: 1, activityId, revision: 1, text: "Private caption", audio };
const stage: VoiceStage = { ...audio, actor, activityId, path: `${actor}/${activityId}/${generation}.wav`, expiresAt: new Date(Date.now() + 600000).toISOString() };
const request = (body: unknown, headers: Record<string, string> = {}) => new Request(`${env.PB_PUBLIC_ORIGIN}/api/memories/${activityId}/voice`, { method: "POST", headers: { origin: env.PB_PUBLIC_ORIGIN, authorization: "Bearer nonsecret-user-fixture", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const save = { operation: "save", requestId: generation, revision: 0, text: "Private caption", audio: { operation: "replace", wav: Buffer.from(wav).toString("base64") } };
function fixture() {
  const calls: string[] = []; let reads = 0, revoked = false, wrongBytes = false, rateDenied = false;
  const ports: VoiceRequestPorts = {
    store: async () => { calls.push("store"); return { actor,
      async rate() { calls.push("rate"); if (rateDenied) throw new VoiceError("rate_limited", 429); },
      async read() { calls.push("read"); if (++reads === 2 && revoked) throw new VoiceError("access_denied", 403); return snapshot; },
      async save(_id, input) { calls.push("save"); assert.equal(input.audio?.sha256, sha256); assert.equal(input.audio.samples, 3); return { status: "staged", stage }; },
      async finish() { calls.push("finish"); return snapshot; },
    }; },
    objects: () => ({ async upload(_stage, bytes) { calls.push("upload"); assert.deepEqual(new Uint8Array(bytes), wav); }, async read() { calls.push("provider-read"); return wrongBytes ? encodeVoiceWav(new Int16Array([9, 8, 7])) : wav.slice(); }, async remove() { throw new Error("not expected"); } }),
  };
  return { calls, ports, handler: () => createVoiceHandler(ports, () => env), revoke: () => { revoked = true; }, corrupt: () => { wrongBytes = true; }, rateDeny: () => { rateDenied = true; } };
}
test("disabled, unauthenticated, forged-origin and malformed requests perform no provider/store work", async () => {
  const f = fixture(); assert.equal((await createVoiceHandler(f.ports, () => ({ ...env, PB_VOICE_CAPTIONS_ENABLED: "false" }))(request({ operation: "read" }), activityId)).status, 503);
  for (const [body, headers, status] of [[{ operation: "read" }, { authorization: "" }, 401], [{ operation: "read" }, { origin: "https://foreign.example.invalid" }, 403], [{ operation: "read", actor }, {}, 400], [{ operation: "delete", revision: 0 }, {}, 400]] as const) assert.equal((await f.handler()(request(body, headers), activityId)).status, status);
  assert.deepEqual(f.calls, []);
});
test("save verifies actual canonical PCM and provider bytes before committing", async () => {
  const f = fixture(), response = await f.handler()(request(save), activityId);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), snapshot);
  assert.deepEqual(f.calls, ["store", "rate", "save", "upload", "provider-read", "finish"]); assert.equal(response.headers.get("cache-control"), "private, no-store");
});
test("noncanonical base64 padding and invalid WAV never reserve or upload", async () => {
  for (const encoded of ["AB==", Buffer.from("not a WAV").toString("base64")]) {
    const f = fixture(), response = await f.handler()(request({ ...save, audio: { operation: "replace", wav: encoded } }), activityId);
    assert.equal(response.status, 400); assert(!f.calls.includes("save")); assert(!f.calls.includes("upload"));
  }
});
test("provider mismatch cannot replace the old generation and download is gated after fetch", async () => {
  const f = fixture(); f.corrupt(); assert.equal((await f.handler()(request(save), activityId)).status, 409); assert(!f.calls.includes("finish"));
  const revoked = fixture(); revoked.revoke(); const response = await revoked.handler()(request({ operation: "download" }), activityId); assert.equal(response.status, 403); assert.equal(response.headers.get("x-voice-sha256"), null);
});
test("verified download has exact identity headers and private WAV bytes", async () => {
  const f = fixture(), response = await f.handler()(request({ operation: "download" }), activityId);
  assert.equal(response.status, 200); assert.equal(response.headers.get("x-voice-sha256"), sha256); assert.equal(response.headers.get("x-voice-generation"), generation); assert.equal(response.headers.get("content-type"), "audio/wav"); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), wav);
  assert.deepEqual(f.calls, ["store", "rate", "read", "provider-read", "read"]);
});
test("durable rate denial stops read/save/provider work", async () => {
  const f = fixture(); f.rateDeny(); const response = await f.handler()(request(save), activityId); assert.equal(response.status, 429); assert.equal(response.headers.get("retry-after"), "60"); assert.deepEqual(f.calls, ["store", "rate"]);
});
test("store derives the actor, reauthenticates and rejects changed privileged upload envelopes", async () => {
  let identity: string | null = actor, changed = false; const calls: Record<string, unknown>[] = [];
  const ports: ProjectStorePorts = { authenticate: async () => identity, rpc: async (name, args) => { calls.push(args); return { error: null, data: name === "pb_voice_capabilities" ? { version: 1, ready: true, actorBytes: 57600880, generations: 20, heads: 500, receipts: 100 } : name === "pb_voice_save" ? { ...stage, status: "staged", ...(changed ? { path: `${randomUUID()}/${activityId}/${generation}.wav` } : {}) } : snapshot }; } };
  const store = await createVoiceStore("nonsecret", env, undefined, ports);
  await store.read(activityId); assert(calls.some(call => call.p_actor === actor));
  changed = true; await assert.rejects(store.save(activityId, { requestId: generation, revision: 0, text: "Private caption", operation: "replace", audio: { bytes: wav.length, samples: 3, sha256 } }));
  identity = randomUUID(); await assert.rejects(store.read(activityId), /access_denied/);
});
function responseAt(url: string, body: BodyInit | null, init: ResponseInit = {}) { const response = new Response(body, init); Object.defineProperty(response, "url", { value: url }); return response; }
test("private Storage writes are exact no-overwrite paths with reserved metadata; deletes require a 404 confirmation", async () => {
  const methods: string[] = [];
  const objects = createVoiceObjects(env, async (input, init) => {
    const url = String(input); methods.push(init!.method!); assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store");
    if (init?.method === "POST") { assert(url.endsWith(stage.path)); assert.equal((init.headers as Record<string, string>)["x-upsert"], "false"); assert.equal(JSON.parse(Buffer.from((init.headers as Record<string, string>)["x-metadata"], "base64").toString()).voice_sha256, sha256); return responseAt(url, "{}", { status: 200 }); }
    if (init?.method === "GET") return responseAt(url, wav, { status: 200 });
    return responseAt(url, null, { status: init?.method === "HEAD" ? 404 : 200 });
  });
  await objects.upload(stage, wav); assert.deepEqual(await objects.read(stage), wav); assert.equal(await objects.remove(stage), true); assert.deepEqual(methods, ["POST", "GET", "DELETE", "HEAD"]);
  const bad = createVoiceObjects(env, async input => responseAt(String(input), null, { status: 500 })); await assert.rejects(bad.remove(stage));
});
test("provider redirects and oversized streamed bodies never return audio", async () => {
  const redirect = createVoiceObjects(env, async () => responseAt("https://foreign.example.invalid", wav)); await assert.rejects(redirect.read(stage));
  const large = createVoiceObjects(env, async input => responseAt(String(input), new Uint8Array(wav.length + 1))); await assert.rejects(large.read(stage));
});
test("maintenance retains charges on failed deletion and skips external work under stale leases", async () => {
  let deletes = 0; const results: boolean[] = [], claim = { ...stage, lease: randomUUID(), leaseUntil: new Date(Date.now() + 60000).toISOString(), attempts: 8 };
  const ports = { store: { sweep: async () => 1, claim: async () => claim, finish: async (_c: unknown, absent: boolean) => { results.push(absent); return absent; } }, objects: { remove: async () => { deletes++; throw new Error("provider down"); } } };
  assert.equal((await processVoiceMaintenance(env, undefined, ports)).cleanup, "failed"); assert.deepEqual(results, [false]);
  claim.leaseUntil = new Date(0).toISOString(); assert.equal((await processVoiceMaintenance(env, undefined, ports)).cleanup, "retained"); assert.equal(deletes, 1);
});
