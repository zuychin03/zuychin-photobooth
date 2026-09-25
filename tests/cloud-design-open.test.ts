import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createCloudProjectClient, cloudSha256 } from "../lib/projects/cloud-client";
import { CLOUD_DESIGN_LIMITS, type CloudDesignRecord } from "../lib/projects/cloud-design";
import { PROJECT_BUCKET, projectAssetPath } from "../lib/projects/cloud-contract";
import { createProject, appendProjectMedia, PROJECT_SCHEMA_VERSION, type PhotoProject } from "../lib/projects/model";
import { inspectImageHeader } from "../lib/projects/images";
import { openCloudDesignCopy, type CloudDesignOpenOptions } from "../lib/projects/cloud-design-open";
import { closeRoomScope } from "../lib/rtc/scope-lifecycle";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const ownerId = randomUUID(), projectId = randomUUID(), data = new Uint8Array(await readFile(new URL("./fixtures/projects/b.png", import.meta.url))), blob = new Blob([data], { type: "image/png" }), info = inspectImageHeader(data), sha256 = await cloudSha256(await blob.arrayBuffer());
  const createdAt = "2026-01-01T00:00:00.000Z", capturedAt = "2026-01-02T00:00:00.000Z";
  const draft = createProject({ createdAt, captureTimeZone: "Australia/Sydney", participants: [{ id: "person", role: "A" }] });
  const project = appendProjectMedia(draft, ["retired", "active", "reference"].map(id => ({ id, kind: id === "reference" ? "reference" as const : "photo" as const, participantId: id === "reference" ? null : "person", bytes: blob.size, ...info })), { A: [null, null, null, "active"], B: [], C: [], D: [] }, capturedAt);
  const bindings = project.media.map(media => ({ mediaId: media.id, assetId: randomUUID(), ownerId, sha256 }));
  const receipt = { version: 1 as const, projectId, requestId: randomUUID(), revision: 0, contentHash: "a".repeat(64), savedAt: "2026-01-03T00:00:00.000Z" };
  let record: CloudDesignRecord = { ...receipt, unsupported: false, snapshot: { version: 1, project, bindings, participants: [{ participantId: "person", ownerId }] } };
  const assets = project.media.map(media => ({ id: bindings.find(b => b.mediaId === media.id)!.assetId, ownerId, sha256, kind: media.kind, mime: media.mime, bytes: media.bytes, width: media.width, height: media.height }));
  let identity: { ownerId: string; epoch: number } | null = { ownerId, epoch: 0 }, downloads = 0, grants = 0, reads = 0, writes = 0, closed = 0;
  let onDownload: (() => void) | undefined, onRead: ((count: number) => void) | undefined, beforeSave: (() => Promise<void>) | undefined, denied = false, corrupt = false;
  const checkpoints: string[] = [], rows = new Map<string, { project: PhotoProject; media: Map<string, Blob> }>();
  const client = createCloudProjectClient({ appOrigin: "https://app.example.invalid", storageOrigin: "https://store.example.invalid", identity: () => identity, accessToken: async () => "nonsecret-test-token", fetch: async (url, init) => {
    if (String(url).startsWith("https://store.example.invalid/")) {
      downloads++; onDownload?.(); return new Response(corrupt ? new Uint8Array(blob.size) : data, { headers: { "content-type": blob.type } });
    }
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith("/design")) {
      if (body.operation === "capabilities") return Response.json({ designVersion: 1, retirementVersion: 1, limits: CLOUD_DESIGN_LIMITS, referenceAssets: true });
      assert.equal(body.operation, "read"); checkpoints.push(body.checkpoint); reads++; onRead?.(reads); return Response.json({ design: record });
    }
    if (body.operation === "view") return Response.json({ project: { id: projectId, ownerId, kind: "personal", title: "Synthetic project", maxBytes: 64 * 1024 * 1024, status: "active", createdAt }, members: [{ userId: ownerId, status: "accepted" }], assets });
    assert.equal(body.operation, "read"); grants++;
    if (denied) return Response.json({ error: "access_denied" }, { status: 403 });
    return Response.json({ signedUrl: `https://store.example.invalid/storage/v1/object/sign/${PROJECT_BUCKET}/${projectAssetPath(projectId, ownerId, body.assetId)}?token=nonsecret-test`, expiresIn: 300 });
  } });
  const openRepository: CloudDesignOpenOptions["openRepository"] = async scope => ({ scope, close() { closed++; }, async save(next, media, expected) {
    assert.equal(expected, null); if (rows.has(next.id)) throw new Error("conflict"); await beforeSave?.();
    rows.set(next.id, { project: next, media: new Map(media) }); writes++; return next;
  }, async delete(id, expected) { assert.equal(expected, 0); assert.equal(rows.get(id)?.project.revision, 0); rows.delete(id); } });
  return { ownerId, projectId, project, receipt, assets, rows, blob, client, openRepository, checkpoints,
    options: { client, projectId, openRepository } satisfies CloudDesignOpenOptions,
    counts: () => ({ downloads, grants, reads, writes, closed }),
    onDownload: (fn: () => void) => { onDownload = fn; }, onRead: (fn: (count: number) => void) => { onRead = fn; }, beforeSave: (fn: () => Promise<void>) => { beforeSave = fn; },
    loseIdentity: () => { identity = null; }, deny: () => { denied = true; }, corrupt: () => { corrupt = true; },
    changeReceipt: () => { record = { ...record, revision: 1, contentHash: "b".repeat(64) }; },
    future: () => { record = { ...receipt, unsupported: true, schemaVersion: PROJECT_SCHEMA_VERSION + 1, rawSnapshot: JSON.stringify({ version: 1, project: { ...project, schemaVersion: PROJECT_SCHEMA_VERSION + 1 }, bindings, participants: [{ participantId: "person", ownerId }] }) }; },
  };
}

test("real client integrity downloads reopen all originals and history into a new account copy", async () => {
  const f = await fixture(), result = await openCloudDesignCopy({ ...f.options, expectedReceipt: f.receipt });
  assert.equal(result.kind, "opened"); if (result.kind !== "opened") return;
  assert.notEqual(result.project.id, f.project.id); assert.deepEqual(result.project.scope, { kind: "account", ownerId: f.ownerId }); assert.equal(result.project.revision, 0);
  assert.equal(result.project.capturedAt, f.project.capturedAt); assert.equal(result.project.captureTimeZone, "Australia/Sydney"); assert.equal(result.project.capture.cameraId, null);
  assert.deepEqual(result.project.sourceOrder, f.project.sourceOrder); assert.deepEqual(result.project.history, f.project.history);
  assert.equal(result.source.canonicalIdentity.id, f.project.id); assert.equal(result.source.canonicalIdentity.createdAt, f.project.createdAt); assert.equal(result.source.projectId, f.projectId);
  assert.equal(result.source.bindings.length, 3); assert.equal(f.rows.get(result.project.id)?.media.size, 3);
  for (const original of f.rows.get(result.project.id)!.media.values()) assert.deepEqual(await original.arrayBuffer(), await f.blob.arrayBuffer());
  assert.deepEqual(f.counts(), { downloads: 3, grants: 6, reads: 2, writes: 1, closed: 1 });
});

test("previous checkpoint stays explicit and an existing local ID is never overwritten", async () => {
  const f = await fixture(), id = randomUUID();
  await openCloudDesignCopy({ ...f.options, checkpoint: "previous", newId: () => id });
  assert.deepEqual(f.checkpoints, ["previous", "previous"]);
  await assert.rejects(openCloudDesignCopy({ ...f.options, newId: () => id }), /conflict/);
  assert.equal(f.rows.size, 1); assert.equal(f.counts().writes, 1);
});

test("unsupported schema remains a raw read-only result with no download or repository write", async () => {
  const f = await fixture(); f.future();
  const result = await openCloudDesignCopy(f.options);
  assert.equal(result.kind, "unsupported"); if (result.kind === "unsupported") assert.equal(JSON.parse(result.record.rawSnapshot).project.schemaVersion, PROJECT_SCHEMA_VERSION + 1);
  assert.deepEqual(f.counts(), { downloads: 0, grants: 0, reads: 1, writes: 0, closed: 0 });
});

test("displayed receipt mismatch fails before download, and changed final receipt fails before write", async () => {
  const f = await fixture(); await assert.rejects(openCloudDesignCopy({ ...f.options, expectedReceipt: { ...f.receipt, revision: 1 } }), /design_changed/); assert.equal(f.counts().downloads, 0);
  f.onRead(count => { if (count >= 3) f.changeReceipt(); });
  await assert.rejects(openCloudDesignCopy(f.options), /design_changed/); assert.equal(f.rows.size, 0);
});

test("every binding including retired originals rejects mismatched owner, kind, hash or dimensions", async () => {
  for (const change of [{ ownerId: randomUUID() }, { kind: "reference" as const }, { sha256: "f".repeat(64) }, { width: 2 }]) {
    const f = await fixture(); Object.assign(f.assets[0], change);
    await assert.rejects(openCloudDesignCopy(f.options)); assert.equal(f.counts().downloads, 0); assert.equal(f.rows.size, 0);
  }
});

test("corrupt provider bytes, access revocation and account switches cannot persist a copy", async () => {
  const corrupt = await fixture(); corrupt.corrupt(); await assert.rejects(openCloudDesignCopy(corrupt.options), /integrity_failed/); assert.equal(corrupt.rows.size, 0);
  const revoked = await fixture(); revoked.onDownload(() => { if (revoked.counts().downloads === 3) revoked.deny(); }); await assert.rejects(openCloudDesignCopy(revoked.options), /access_denied/); assert.equal(revoked.rows.size, 0); assert.equal(revoked.counts().downloads, 3);
  const changed = await fixture(); changed.onDownload(() => changed.loseIdentity()); await assert.rejects(openCloudDesignCopy(changed.options), /account_changed/); assert.equal(changed.rows.size, 0);
});

test("cancellation during an awaited write drains and removes only the new account copy", async () => {
  const f = await fixture(), entered = deferred(), finish = deferred(), controller = new AbortController();
  f.beforeSave(async () => { entered.resolve(); await finish.promise; });
  const work = openCloudDesignCopy({ ...f.options, signal: controller.signal }); await entered.promise; controller.abort();
  await assert.rejects(openCloudDesignCopy(f.options), /busy/); assert.equal(f.counts().closed, 0);
  finish.resolve(); await assert.rejects(work, /cancelled/); assert.equal(f.rows.size, 0); assert.equal(f.counts().closed, 1);
});

test("account scope cleanup waits for an in-flight write and its rollback before completing", async () => {
  const f = await fixture(), entered = deferred(), finish = deferred();
  f.beforeSave(async () => { entered.resolve(); await finish.promise; });
  const work = openCloudDesignCopy(f.options); await entered.promise;
  let drained = false; const cleanup = closeRoomScope({ kind: "account", ownerId: f.ownerId }).then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false); finish.resolve();
  await assert.rejects(work, /account_changed/); await cleanup; assert.equal(f.rows.size, 0); assert.equal(drained, true);
});

test("a failed cancellation cleanup exposes the exact account copy for recovery, never success", async () => {
  const f = await fixture(), controller = new AbortController();
  f.beforeSave(async () => { controller.abort(); });
  const openRepository: CloudDesignOpenOptions["openRepository"] = async scope => ({ ...await f.openRepository(scope), async delete() { throw new Error("storage unavailable"); } });
  await assert.rejects(openCloudDesignCopy({ ...f.options, openRepository, signal: controller.signal }), (error: unknown) => {
    assert.equal((error as { code: string }).code, "cleanup_failed");
    const recovery = (error as { recovery: { projectId: string; scope: unknown } }).recovery;
    assert.deepEqual(recovery.scope, { kind: "account", ownerId: f.ownerId }); assert.equal(f.rows.has(recovery.projectId), true); return true;
  });
  assert.equal(f.counts().closed, 1);
});
