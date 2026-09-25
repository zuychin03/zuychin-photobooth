import assert from "node:assert/strict";
import { test } from "node:test";
import { createChallengeCameraOriginals } from "../lib/memories/challenge-camera-originals";
import { cloudSha256 } from "../lib/projects/cloud-client";
import type { CloudUploadRecord } from "../lib/projects/cloud-upload";
import type { PhotoProject } from "../lib/projects/model";
import type { ProjectRepository } from "../lib/projects/storage";
import { closeRoomScope } from "../lib/rtc/scope-lifecycle";

const owner = "11111111-1111-4111-8111-111111111111", challenge = "22222222-2222-4222-8222-222222222222", assetId = "33333333-3333-4333-8333-333333333333";
async function fixture() {
  const file = new File(["camera original"], "photo.jpg", { type: "image/jpeg", lastModified: Date.now() - 1000 });
  const record: CloudUploadRecord = { id: assetId, ownerId: owner, projectId: "44444444-4444-4444-8444-444444444444", state: "prepared", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reservedUntil: null, asset: { id: assetId, requestId: "55555555-5555-4555-8555-555555555555", kind: "photo", mime: "image/jpeg", width: 32, height: 24, bytes: file.size, sha256: await cloudSha256(await file.arrayBuffer()), protection: { kind: "challenge", id: challenge } } };
  const rows = new Map<string, { project: PhotoProject; media: Map<string, Blob> }>(); let failure = false, lost = false, saves = 0;
  const open: Parameters<typeof createChallengeCameraOriginals>[0]["open"] = async scope => ({
    scope, close() {},
    async load(id) { const row = rows.get(`${scope.kind === "account" ? scope.ownerId : "device"}/${id}`); return row ? { kind: "current", readOnly: false, id, revision: row.project.revision, checkpoint: null, ...row } : null; },
    async save(project, media, expected) { if (failure) throw new DOMException("No space", "QuotaExceededError"); const key = `${scope.kind === "account" ? scope.ownerId : "device"}/${project.id}`, old = rows.get(key); if ((old?.project.revision ?? null) !== expected) throw new Error("conflict"); rows.set(key, { project, media: new Map([...(old?.media ?? []), ...media]) }); saves++; return project; },
  } as ProjectRepository);
  const make = (ownerId = owner) => createChallengeCameraOriginals({ ownerId, challengeId: challenge, open, assertActive(signal) { if (lost || signal?.aborted) throw new Error("inactive"); } });
  return { file, record, rows, make, fail: (value: boolean) => { failure = value; }, lose: () => { lost = true; }, saves: () => saves };
}

test("camera original is persisted at revision zero with sparse capture mapping and reloadable bytes", async () => {
  const f = await fixture(), store = f.make();
  await store.save(f.record, f.file, 3); await store.close();
  const reopened = f.make();
  assert.deepEqual(await reopened.list(), [assetId]);
  assert.equal(await (await reopened.load(f.record)).text(), await f.file.text());
  const project = [...f.rows.values()][0].project;
  assert.equal(project.revision, 0); assert.deepEqual(project.sourceOrder.A, [null, null, null, assetId]);
  assert.equal(project.capturedAt, new Date(f.file.lastModified).toISOString());
  await reopened.close();
});

test("repeating exact local save does not duplicate media or advance the manifest", async () => {
  const f = await fixture(), store = f.make();
  await store.save(f.record, f.file, 2); await store.save(f.record, f.file, 2);
  assert.equal(f.saves(), 1); await store.close();
});

test("retaking preserves the earlier original and updates only the selected sparse source position", async () => {
  const f = await fixture(), store = f.make(); await store.save(f.record, f.file, 3);
  const nextId = "77777777-7777-4777-8777-777777777777", next = { ...f.record, id: nextId, asset: { ...f.record.asset, id: nextId } };
  await store.save(next, f.file, 3);
  assert.deepEqual(await store.list(), [assetId, nextId]);
  assert.equal([...f.rows.values()][0].project.sourceOrder.A[3], nextId);
  assert.equal(await (await store.load(f.record)).text(), "camera original"); await store.close();
});

test("quota failure retains the caller File and retry saves the same upload identity", async () => {
  const f = await fixture(), store = f.make(); f.fail(true);
  await assert.rejects(store.save(f.record, f.file, 0), { name: "QuotaExceededError" });
  assert.equal(f.rows.size, 0); assert.equal(await f.file.text(), "camera original");
  f.fail(false); await store.save(f.record, f.file, 0); assert.deepEqual(await store.list(), [assetId]); await store.close();
});

test("foreign account and mismatched original bytes cannot be recovered", async () => {
  const f = await fixture(), store = f.make(); await store.save(f.record, f.file, 0);
  const foreign = f.make("66666666-6666-4666-8666-666666666666"); assert.deepEqual(await foreign.list(), []);
  await assert.rejects(foreign.load(f.record), /identity mismatch/);
  await assert.rejects(store.load({ ...f.record, asset: { ...f.record.asset, sha256: "0".repeat(64) } }), /differs/);
  await store.close(); await foreign.close();
});

test("scope closure blocks further writes and a newly opened scope can recover retained originals", async () => {
  const f = await fixture(), store = f.make(); await store.save(f.record, f.file, 0);
  await closeRoomScope({ kind: "account", ownerId: owner });
  assert.throws(() => store.save(f.record, f.file, 0), /closed/);
  const reopened = f.make(); assert.equal(await (await reopened.load(f.record)).text(), "camera original"); await reopened.close();
});

test("account loss prevents new storage operations", async () => {
  const f = await fixture(), store = f.make(); f.lose();
  assert.throws(() => store.save(f.record, f.file, 0), /inactive/); assert.equal(f.rows.size, 0); await store.close();
});

test("concurrent scope closers retain the same pending write until project deletion can safely start", async () => {
  const f = await fixture(); let release!: () => void, entered!: () => void, deleted = false;
  const pending = new Promise<void>(resolve => { release = resolve; }), writing = new Promise<void>(resolve => { entered = resolve; });
  const events: string[] = [];
  const store = createChallengeCameraOriginals({ ownerId: owner, challengeId: challenge, assertActive() {}, open: async scope => ({ scope, close() { events.push("close"); }, async load() { return null; }, async save(project: PhotoProject) { entered(); await pending; events.push("committed"); return project; } } as unknown as ProjectRepository) });
  const write = store.save(f.record, f.file, 0); const rejected = assert.rejects(write, /closed/); await writing;
  const first = closeRoomScope({ kind: "account", ownerId: owner });
  const second = closeRoomScope({ kind: "account", ownerId: owner }).then(() => { deleted = true; events.push("deleted"); });
  await Promise.resolve(); assert.equal(deleted, false);
  release(); await Promise.all([first, second, rejected]);
  assert.ok(events.indexOf("committed") < events.indexOf("deleted"));
});
