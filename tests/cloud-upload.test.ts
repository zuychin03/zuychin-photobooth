import test from "node:test";
import assert from "node:assert/strict";
import { createCloudUploadManager, type CloudUploadJournal, type CloudUploadRecord } from "../lib/projects/cloud-upload";
import { CloudClientError, type CloudProjectClient } from "../lib/projects/cloud-client";
import type { ProjectFinalisationStatus } from "../lib/projects/cloud-contract";
const owner = "11111111-1111-4111-8111-111111111111", project = "22222222-2222-4222-8222-222222222222";
const blob = new Blob(["original"], { type: "image/png" });
function fixture() {
  const records = new Map<string, CloudUploadRecord>(), reservations: string[] = []; let changed = false, uploads = 0, polls = 0, ready = true, uncertain = false;
  const journal: CloudUploadJournal = { ownerId: owner, async get(id) { return records.get(id) ?? null; }, async list() { return [...records.values()]; }, async put(record) { records.set(record.id, structuredClone(record)); }, async remove(id) { records.delete(id); }, close() {} };
  const status = (id: string, queued: boolean): ProjectFinalisationStatus => ({ assetId: id, status: queued ? ready ? "complete" : "queued" : "not_queued", assetStatus: queued && ready ? "ready" : "reserved", attempts: 0, reservedUntil: "2026-09-24T00:00:00Z", failure: null });
  let queued = false;
  const client = {
    ownerId: owner, assertActive(signal?: AbortSignal) { if (changed) throw new CloudClientError("account_changed"); if (signal?.aborted) throw new CloudClientError("cancelled"); },
    async reserve(projectId, asset) { reservations.push(asset.id); return { ...asset, ownerId: owner, projectId, reservedUntil: "2026-09-24T00:00:00Z", status: "reserved" }; },
    async status(id) { polls++; return status(id, queued); }, async mintUpload() { return { signedUrl: "not-persisted", path: "not-persisted", token: "not-persisted" }; },
    async upload() { uploads++; if (uncertain) throw new CloudClientError("network_error"); return { acknowledged: true }; },
    async finalise(id) { queued = true; return status(id, true); },
  } satisfies Partial<CloudProjectClient>;
  const manager = createCloudUploadManager({ client: client, journal, inspect: async () => ({ mime: "image/png", width: 2, height: 2 }), sleep: async () => undefined });
  return { manager, records, journal, client, reservations, change: () => { changed = true; }, setPending: () => { ready = false; }, setUncertain: (value = true) => { uncertain = value; }, counts: () => ({ uploads, polls }) };
}
test("prepare journals stable identifiers and detected hash before any network operation", async () => {
  const f = fixture(), record = await f.manager.prepare(project, blob, { kind: "photo" });
  assert.equal(f.reservations.length, 0); assert.equal(record.asset.bytes, blob.size); assert.equal(record.asset.sha256.length, 64);
  assert.equal(JSON.stringify(record).includes("token"), false); assert.equal(record.id, record.asset.id);
  const result = await f.manager.run(record.id, blob); assert.equal(result.state, "ready");
  assert.equal(f.records.get(record.id)?.state, "ready");
});
test("uncertain PUT preserves identity and reload resumes verification without a new upload", async () => {
  const f = fixture(), record = await f.manager.prepare(project, blob, { kind: "photo" }); f.setUncertain();
  await assert.rejects(f.manager.run(record.id, blob), /network_error/); assert.equal(f.records.get(record.id)?.state, "uploading");
  const reopened = createCloudUploadManager({ client: f.client, journal: f.journal, inspect: async () => ({ mime: "image/png", width: 2, height: 2 }) });
  assert.equal((await reopened.run(record.id)).state, "ready"); assert.equal(f.counts().uploads, 1); assert.deepEqual(f.reservations, [record.id]);
});
test("reselected different bytes cannot replace a reserved original", async () => {
  const f = fixture(), record = await f.manager.prepare(project, blob, { kind: "photo" });
  await assert.rejects(f.manager.run(record.id, new Blob(["modified"])), /file_mismatch/); assert.equal(f.reservations.length, 0);
});
test("missing bytes after an uncertain PUT can still be replayed after status-only finalisation enqueue", async () => {
  const f = fixture(), record = await f.manager.prepare(project, blob, { kind: "photo" }); f.setUncertain(); f.setPending();
  await assert.rejects(f.manager.run(record.id, blob), /network_error/);
  assert.equal((await f.manager.run(record.id)).state, "pending"); assert.equal(f.records.get(record.id)?.state, "uploading");
  f.setUncertain(false); assert.equal((await f.manager.run(record.id, blob)).state, "pending");
  assert.equal(f.counts().uploads, 2); assert.deepEqual(f.reservations, [record.id]);
});
test("finalisation polling is bounded and queued bytes are never reported ready", async () => {
  const f = fixture(); f.setPending(); const record = await f.manager.prepare(project, blob, { kind: "photo" });
  assert.equal((await f.manager.run(record.id, blob)).state, "pending"); assert.equal(f.counts().polls, 6); assert.equal(f.records.get(record.id)?.state, "finalising");
});
test("account switch during image inspection prevents journal writes", async () => {
  const f = fixture(), manager = createCloudUploadManager({ client: f.client, journal: f.journal, inspect: async () => { f.change(); return { mime: "image/png", width: 2, height: 2 }; } });
  await assert.rejects(manager.prepare(project, blob, { kind: "photo" }), /account_changed/); assert.equal(f.records.size, 0);
});
test("cancelled run keeps durable retry metadata and performs no deletion", async () => {
  const f = fixture(), record = await f.manager.prepare(project, blob, { kind: "photo" }), controller = new AbortController(); controller.abort();
  await assert.rejects(f.manager.run(record.id, blob, controller.signal), /cancelled/); assert.equal(f.records.size, 1); assert.equal(f.counts().uploads, 0);
});
test("decoration byte and pixel limits apply before reservation", async () => {
  const f = fixture(); await assert.rejects(f.manager.prepare(project, new Blob([new Uint8Array(4 * 1024 * 1024 + 1)]), { kind: "decoration" }), /invalid_image/);
  const manager = createCloudUploadManager({ client: f.client, journal: f.journal, inspect: async () => ({ mime: "image/png", width: 4096, height: 4096 }) });
  await assert.rejects(manager.prepare(project, blob, { kind: "decoration" })); assert.equal(f.records.size, 0);
});
