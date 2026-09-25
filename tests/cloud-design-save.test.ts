import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createCloudDesignSaveCoordinator, type CloudDesignSaveOptions } from "../lib/projects/cloud-design-save";
import { validateDesignSaveRecord, type CloudDesignSaveRecord, type CloudDesignJournal } from "../lib/projects/cloud-design-journal";
import { createProject, appendProjectMedia } from "../lib/projects/model";
import type { CloudUploadJournal, CloudUploadRecord } from "../lib/projects/cloud-upload-journal";
import type { CloudProjectAsset } from "../lib/projects/cloud-contract";
import type { CloudDesignReceipt } from "../lib/projects/cloud-design";
import { createCloudUploadManager } from "../lib/projects/cloud-upload";

function fixture() {
  const owner = randomUUID(), cloudId = randomUUID(), data = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
  const local = appendProjectMedia(createProject({ scope: { kind: "account", ownerId: owner }, participants: [{ id: "person", role: "A" }] }), [{ id: "photo", kind: "photo", mime: "image/png", bytes: 4, width: 2, height: 2, participantId: "person" }], { A: ["photo"], B: [], C: [], D: [] }, new Date().toISOString());
  const records = new Map<string, CloudDesignSaveRecord>(), tracking = new Map<string, CloudUploadRecord>(), assets: CloudProjectAsset[] = [], calls: string[] = [];
  let active = true, file = data, failLoad = false, lostAck = false, receipt: CloudDesignReceipt | null = null, pending = false, failCommit = false;
  const journal: CloudDesignJournal = { ownerId: owner, list: async () => [...records.values()], get: async id => records.get(id) ?? null, put: async (value, expected) => { if ((records.get(value.id)?.revision ?? null) !== expected) throw new Error("CAS"); if (failCommit && value.phase === "complete") { failCommit = false; throw new Error("Quota"); } const checked = validateDesignSaveRecord(value); records.set(value.id, structuredClone(checked)); return checked; }, forget: async (id, revision) => { if (records.get(id)?.revision !== revision) throw new Error("CAS"); records.delete(id); }, close() {} };
  const uploadJournal: CloudUploadJournal = { ownerId: owner, get: async id => tracking.get(id) ?? null, list: async () => [...tracking.values()], put: async record => { tracking.set(record.id, structuredClone(record)); }, remove: async id => { tracking.delete(id); }, close() {} };
  const client = {
    ownerId: owner, assertActive() { if (!active) throw new Error("account_changed"); },
    async designCapabilities() { calls.push("capabilities"); return { designVersion: 1, retirementVersion: 1 }; },
    async view() { calls.push("view"); return { project: { id: cloudId, ownerId: owner, status: "active" }, members: [{ userId: owner, status: "accepted" }], assets: structuredClone(assets) }; },
    async read() { calls.push("read"); return {}; },
    async designSaveStatus() { calls.push("status"); return receipt; },
    async saveDesign(projectId: string, expected: number | null, requestId: string) { calls.push(`save:${requestId}`); assert.ok([...records.values()].some(r => r.phase === "saving" && r.requestId === requestId)); receipt = { version: 1, projectId, requestId, revision: expected === null ? 0 : expected + 1, contentHash: "a".repeat(64), savedAt: new Date().toISOString() }; if (lostAck) { lostAck = false; throw new Error("network_error"); } return receipt; },
  } as unknown as CloudDesignSaveOptions["client"];
  const options: CloudDesignSaveOptions = { client, journal, uploadJournal, inspect: async () => ({ mime: "image/png", width: 2, height: 2 }), loadBlob: async () => { if (failLoad) throw new Error("local_missing"); return file; }, uploads: { run: async id => {
    calls.push(`upload:${id}`); assert.ok([...records.values()].some(r => r.phase === "uploading" && r.uploads.some(p => p.assetId === id && p.record)));
    const record = tracking.get(id)!; assert.ok(record);
    if (!pending) { const { requestId: ignored, protection, ...metadata } = record.asset; void ignored; void protection; assets.push({ ...metadata, ownerId: owner }); await uploadJournal.put({ ...record, state: "ready" }); }
    return { state: pending ? "pending" : "ready", record, status: { assetId: id, assetStatus: pending ? "reserved" : "ready", status: pending ? "queued" : "complete" } } as Awaited<ReturnType<CloudDesignSaveOptions["uploads"]["run"]>>;
  } } };
  const input = { projectId: cloudId, project: local, expectedRevision: null, participants: [{ participantId: "person", ownerId: owner }] };
  return { owner, cloudId, local, records, tracking, assets, calls, options, input, coordinator: createCloudDesignSaveCoordinator(options), failLoad(value: boolean) { failLoad = value; }, file(value: Blob) { file = value; }, loseAck() { lostAck = true; }, pending(value: boolean) { pending = value; }, failCommit() { failCommit = true; }, revokeAccount() { active = false; } };
}
test("prepare freezes project, stable upload IDs and descriptors before all network mutations", async () => {
  const f = fixture(), prepared = await f.coordinator.prepare(f.input);
  assert.equal(prepared.phase, "prepared"); assert.equal(prepared.project.scope.kind, "device"); assert.equal(prepared.project.capture.cameraId, null); assert.equal(f.calls.length, 0);
  const result = await f.coordinator.run(prepared.id); assert.equal(result.kind, "complete"); assert.equal(result.record.receipt?.revision, 0);
  assert.equal(f.calls.filter(call => call.startsWith("upload:")).length, 1); assert.equal(f.calls.filter(call => call.startsWith("save:")).length, 1);
});
test("failed local preparation retains preallocated identities and explicit resume does not prepare new IDs", async () => {
  const f = fixture(); f.failLoad(true); await assert.rejects(f.coordinator.prepare(f.input), /local_missing/);
  const initial = [...f.records.values()][0]; assert.equal(initial.phase, "preparing"); assert.equal(f.calls.length, 0);
  await assert.rejects(f.coordinator.prepare(f.input), /pending/); assert.equal(f.records.size, 1);
  f.failLoad(false); const result = await f.coordinator.run(initial.id); assert.equal(result.record.uploads[0].assetId, initial.uploads[0].assetId); assert.equal(result.record.requestId, initial.requestId);
});
test("lost design acknowledgement and failed receipt persistence both reconcile without another upload or save", async () => {
  for (const failure of ["ack", "local"] as const) {
    const f = fixture(), prepared = await f.coordinator.prepare(f.input); if (failure === "ack") f.loseAck(); else f.failCommit();
    await assert.rejects(f.coordinator.run(prepared.id)); assert.equal(f.records.get(prepared.id)?.phase, "saving");
    const reopened = createCloudDesignSaveCoordinator(f.options), recovered = await reopened.run(prepared.id);
    assert.equal(recovered.kind, "complete"); assert.equal(recovered.record.requestId, prepared.requestId);
    assert.equal(f.calls.filter(c => c.startsWith("save:")).length, 1); assert.equal(f.calls.filter(c => c.startsWith("upload:")).length, 1);
  }
});
test("missing upload tracking is restored from frozen descriptors, while pending finalisation never saves a design", async () => {
  const f = fixture(), prepared = await f.coordinator.prepare(f.input); f.tracking.clear(); f.pending(true);
  const pending = await f.coordinator.run(prepared.id); assert.equal(pending.kind, "pending"); assert.ok(f.tracking.has(prepared.uploads[0].assetId)); assert.ok(!f.calls.some(c => c.startsWith("save:")));
  f.pending(false); const done = await f.coordinator.run(prepared.id); assert.equal(done.kind, "complete"); assert.equal(done.record.uploads[0].assetId, prepared.uploads[0].assetId);
});
test("changed bytes and fresh foreign descriptors fail before canonical save", async () => {
  const f = fixture(), prepared = await f.coordinator.prepare(f.input); f.file(new Blob([new Uint8Array([4, 3, 2, 1])], { type: "image/png" }));
  await assert.rejects(f.coordinator.run(prepared.id), /file_mismatch/); assert.ok(!f.calls.some(c => c.startsWith("upload:") || c.startsWith("save:")));
  const binding = prepared.bindings[0]; f.assets.push({ id: binding.assetId, ownerId: randomUUID(), kind: "photo", mime: "image/png", bytes: 4, width: 2, height: 2, sha256: binding.sha256 });
  await assert.rejects(f.coordinator.run(prepared.id), /access_changed/);
});

test("ready originals reconcile stale finalising tracking by status without retransmitting bytes", async () => {
  const f = fixture(), prepared = await f.coordinator.prepare(f.input), plan = prepared.uploads[0], frozen = plan.record!;
  const { requestId, protection, ...metadata } = frozen.asset; void requestId; void protection;
  f.assets.push({ ...metadata, ownerId: f.owner });
  f.tracking.set(plan.assetId, { ...frozen, state: "finalising" });
  f.failLoad(true);
  let checks = 0;
  const unexpected = async (): Promise<never> => { throw new Error("unexpected_upload_mutation"); };
  const uploads = createCloudUploadManager({ journal: f.options.uploadJournal, client: {
    ownerId: f.owner, assertActive: f.options.client.assertActive,
    reserve: unexpected, mintUpload: unexpected, upload: unexpected, finalise: unexpected,
    status: async assetId => { checks++; assert.equal(assetId, plan.assetId); return { assetId, assetStatus: "ready", status: "complete", attempts: 1, reservedUntil: "2099-01-01T00:00:00.000Z", failure: null }; },
  } });
  const result = await createCloudDesignSaveCoordinator({ ...f.options, uploads }).run(prepared.id);
  assert.equal(result.kind, "complete"); assert.equal(checks, 1);
  assert.equal(f.tracking.get(plan.assetId)?.state, "ready");
  assert.deepEqual(f.tracking.get(plan.assetId)?.asset, frozen.asset);
  assert.equal(result.record.requestId, prepared.requestId);
});

test("account loss during ready-status reconciliation cannot mark tracking ready or save", async () => {
  const f = fixture(), prepared = await f.coordinator.prepare(f.input), plan = prepared.uploads[0], frozen = plan.record!;
  const { requestId, protection, ...metadata } = frozen.asset; void requestId; void protection;
  f.assets.push({ ...metadata, ownerId: f.owner }); f.tracking.set(plan.assetId, { ...frozen, state: "finalising" });
  const unexpected = async (): Promise<never> => { throw new Error("unexpected_upload_mutation"); };
  const uploads = createCloudUploadManager({ journal: f.options.uploadJournal, client: {
    ownerId: f.owner, assertActive: f.options.client.assertActive,
    reserve: unexpected, mintUpload: unexpected, upload: unexpected, finalise: unexpected,
    status: async assetId => { f.revokeAccount(); return { assetId, assetStatus: "ready", status: "complete", attempts: 1, reservedUntil: "2099-01-01T00:00:00.000Z", failure: null }; },
  } });
  await assert.rejects(createCloudDesignSaveCoordinator({ ...f.options, uploads }).run(prepared.id), /account_changed/);
  assert.equal(f.tracking.get(plan.assetId)?.state, "finalising");
  assert.ok(!f.calls.some(call => call.startsWith("save:")));
});

test("ready originals cannot reconcile foreign or changed upload tracking", async () => {
  for (const field of ["ownerId", "projectId", "asset", "createdAt"] as const) {
    const f = fixture(), prepared = await f.coordinator.prepare(f.input), plan = prepared.uploads[0], frozen = plan.record!;
    const { requestId, protection, ...metadata } = frozen.asset; void requestId; void protection;
    f.assets.push({ ...metadata, ownerId: f.owner });
    const tracking = { ...frozen, state: "finalising" as const };
    if (field === "asset") tracking.asset = { ...frozen.asset, sha256: "f".repeat(64) };
    else tracking[field] = field === "createdAt" ? "2000-01-01T00:00:00.000Z" : randomUUID();
    f.tracking.set(plan.assetId, tracking);
    await assert.rejects(f.coordinator.run(prepared.id), /file_mismatch/);
    assert.ok(!f.calls.some(call => call.startsWith("upload:") || call.startsWith("save:")));
    assert.equal(f.tracking.get(plan.assetId)?.state, "finalising");
  }
});
test("completed associations retain canonical identity and bindings across reopened local copies and further edits", async () => {
  const f = fixture(), prepared = await f.coordinator.prepare(f.input), done = await f.coordinator.run(prepared.id); assert.equal(done.kind, "complete");
  const copy = { ...f.local, id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 0 };
  const canonicalIdentity = { id: prepared.project.id, createdAt: prepared.project.createdAt, capturedAt: prepared.project.capturedAt, captureTimeZone: prepared.project.captureTimeZone };
  const adopted = await f.coordinator.adoptOpen({ kind: "opened", project: copy, receipt: done.record.receipt!, source: { projectId: f.cloudId, checkpoint: "current", canonicalIdentity, bindings: prepared.bindings, participants: prepared.participants } });
  assert.equal(adopted.localProjectId, copy.id); assert.equal(adopted.project.id, canonicalIdentity.id);
  f.tracking.clear(); const next = await f.coordinator.prepare({ ...f.input, project: copy, expectedRevision: 0 });
  assert.equal(next.id, adopted.id); assert.deepEqual(next.bindings, prepared.bindings); assert.equal(next.uploads.length, 0); assert.equal(next.project.createdAt, canonicalIdentity.createdAt);
  const saved = await f.coordinator.run(next.id); assert.equal(saved.record.receipt?.revision, 1); assert.equal(f.calls.filter(c => c.startsWith("upload:")).length, 1);
});
test("account loss during local preparation leaves no transfer or canonical mutation", async () => {
  const f = fixture(), coordinator = createCloudDesignSaveCoordinator({ ...f.options, loadBlob: async () => { f.revokeAccount(); return new Blob([new Uint8Array([1, 2, 3, 4])]); } });
  await assert.rejects(coordinator.prepare(f.input), /account_changed/); assert.equal(f.calls.length, 0); assert.equal(f.tracking.size, 0); assert.equal(f.records.size, 1);
});

test("first capture advances a saved empty canonical design once without changing its identity", async () => {
  const f = fixture(), empty = createProject({ scope: { kind: "account", ownerId: f.owner }, participants: [{ id: "person", role: "A" }] });
  const prepared = await f.coordinator.prepare({ ...f.input, project: empty }); await f.coordinator.run(prepared.id);
  const captured = appendProjectMedia(empty, f.local.media, f.local.sourceOrder, new Date().toISOString());
  const next = await f.coordinator.prepare({ ...f.input, project: captured, expectedRevision: 0 });
  assert.equal(next.project.capturedAt, captured.capturedAt); assert.equal(next.project.createdAt, empty.createdAt); assert.equal(next.project.id, empty.id);
  await f.coordinator.run(next.id);
  const later = await f.coordinator.prepare({ ...f.input, project: { ...captured, capturedAt: new Date(Date.parse(captured.capturedAt!) + 1).toISOString(), updatedAt: new Date(Date.now() + 10).toISOString() }, expectedRevision: 1 });
  assert.equal(later.project.capturedAt, captured.capturedAt);
});

test("device and foreign-account projects cannot be confused with the account repository namespace", async () => {
  const f = fixture();
  await assert.rejects(f.coordinator.prepare({ ...f.input, project: { ...f.local, scope: { kind: "device" } } }), /account_changed/);
  await assert.rejects(f.coordinator.prepare({ ...f.input, project: { ...f.local, scope: { kind: "account", ownerId: randomUUID() } } }), /account_changed/);
  assert.equal(f.records.size, 0);
});
