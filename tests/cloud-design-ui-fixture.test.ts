import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createCloudDesignUIFixture } from "../lib/projects/cloud-design-ui-fixture";
import { createCloudProjectClient } from "../lib/projects/cloud-client";
import { validateCloudDesign } from "../lib/projects/cloud-design";
import { appendProjectMedia, createProject } from "../lib/projects/model";
import { portableProject } from "../lib/projects/bundle";

function fixture() {
  const owner = randomUUID(), partner = randomUUID(), outsider = randomUUID(), projectId = randomUUID(), assetId = randomUUID(), hash = "a".repeat(64);
  let available = true, active = true;
  const project = appendProjectMedia(createProject({ participants: [{ id: "person", role: "A" }] }), [{ id: "photo", participantId: "person", kind: "photo", bytes: 10, mime: "image/png", width: 2, height: 2 }], { A: ["photo"], B: [], C: [], D: [] }, new Date().toISOString());
  const snapshot = validateCloudDesign({ version: 1, project: portableProject(project), bindings: [{ mediaId: "photo", assetId, ownerId: owner, sha256: hash }], participants: [{ participantId: "person", ownerId: owner }] });
  const server = createCloudDesignUIFixture({ project: id => id === projectId && active ? { ownerId: owner, members: [{ userId: owner, status: "accepted" }, { userId: partner, status: "accepted" }] } : null, asset: id => available && id === assetId ? { id: assetId, projectId, ownerId: owner, kind: "photo", bytes: 10, mime: "image/png", width: 2, height: 2, sha256: hash } : null });
  const client = (actor = owner) => createCloudProjectClient({ appOrigin: "https://app.test", storageOrigin: "https://storage.test", identity: () => ({ ownerId: actor, epoch: 1 }), accessToken: async () => "synthetic-only", fetch: async (url, init) => { assert.equal(String(url), "https://app.test/api/projects/design"); return server.request(JSON.parse(String(init?.body)), actor); } });
  return { owner, partner, outsider, projectId, assetId, snapshot, server, client, revoke() { available = false; }, deactivate() { active = false; } };
}
test("actual client round-trips fixture caps, head, canonical save and current/previous projections", async () => {
  const f = fixture(), client = f.client(); assert.equal((await client.designCapabilities()).retirementVersion, 1); assert.equal(await client.designHead(f.projectId), null);
  const first = await client.saveDesign(f.projectId, null, randomUUID(), f.snapshot);
  const current = await client.readDesign(f.projectId); assert.equal(current?.contentHash, first.contentHash); assert.equal(await client.readDesign(f.projectId, "previous"), null);
  await f.server.advanceHead(f.projectId, f.owner);
  const next = await client.readDesign(f.projectId); assert.equal(next?.revision, 1); assert.equal((await client.readDesign(f.projectId, "previous"))?.requestId, first.requestId);
  assert.equal((await client.designHead(f.projectId))?.contentHash, next?.contentHash);
});
test("lost acknowledgement preserves one exact immutable receipt and rejects changed retries", async () => {
  const f = fixture(), client = f.client(), requestId = randomUUID(); f.server.loseNextAcknowledgement();
  await assert.rejects(client.saveDesign(f.projectId, null, requestId, f.snapshot));
  const status = await client.designSaveStatus(f.projectId, requestId); assert.equal(status?.revision, 0);
  assert.deepEqual(await client.saveDesign(f.projectId, null, requestId, f.snapshot), status);
  await assert.rejects(client.saveDesign(f.projectId, null, requestId, { ...f.snapshot, project: { ...f.snapshot.project, name: "Different" } }), /conflict/);
  assert.equal((await client.designHead(f.projectId))?.revision, 0);
});
test("concurrent expected revisions admit one winner; stale local work cannot replace the head", async () => {
  const f = fixture(), client = f.client(); await client.saveDesign(f.projectId, null, randomUUID(), f.snapshot);
  const race = await Promise.allSettled([client.saveDesign(f.projectId, 0, randomUUID(), f.snapshot), client.saveDesign(f.projectId, 0, randomUUID(), f.snapshot)]);
  assert.equal(race.filter(r => r.status === "fulfilled").length, 1); assert.equal((await client.designHead(f.projectId))?.revision, 1);
  await assert.rejects(client.saveDesign(f.projectId, 0, randomUUID(), f.snapshot), /conflict/);
});
test("a revoked original blocks both snapshots while owner head/status stay content-free", async () => {
  const f = fixture(), client = f.client(), first = await client.saveDesign(f.projectId, null, randomUUID(), f.snapshot); await f.server.advanceHead(f.projectId, f.owner); f.revoke();
  await assert.rejects(client.readDesign(f.projectId), /access_denied/); await assert.rejects(client.readDesign(f.projectId, "previous"), /access_denied/);
  const head = await client.designHead(f.projectId); assert.equal(head?.revision, 1); assert(!("snapshot" in head!)); assert.equal((await client.designSaveStatus(f.projectId, first.requestId))?.revision, 0);
  await assert.rejects(client.saveDesign(f.projectId, 1, randomUUID(), f.snapshot), /access_denied/);
});
test("accepted viewers can read but cannot save/head; unrelated and removed members cannot read", async () => {
  const f = fixture(), owner = f.client(); await owner.saveDesign(f.projectId, null, randomUUID(), f.snapshot);
  const partner = f.client(f.partner); assert.equal((await partner.readDesign(f.projectId))?.revision, 0);
  await assert.rejects(partner.designHead(f.projectId), /access_denied/); await assert.rejects(partner.saveDesign(f.projectId, 0, randomUUID(), f.snapshot), /access_denied/);
  await assert.rejects(f.client(f.outsider).readDesign(f.projectId), /access_denied/); f.deactivate(); await assert.rejects(owner.readDesign(f.projectId), /access_denied/);
});
test("retiring a source preserves the previous read gate and lifetime immutable binding", async () => {
  const f = fixture(), client = f.client(); await client.saveDesign(f.projectId, null, randomUUID(), f.snapshot);
  const empty = validateCloudDesign({ ...f.snapshot, project: { ...f.snapshot.project, media: [], sourceOrder: { A: [], B: [], C: [], D: [] } }, bindings: [] });
  f.revoke(); await client.saveDesign(f.projectId, 0, randomUUID(), empty); assert.equal((await client.readDesign(f.projectId))?.revision, 1); await assert.rejects(client.readDesign(f.projectId, "previous"), /access_denied/);
  const response = await f.server.request({ operation: "save", projectId: f.projectId, expectedRevision: 1, requestId: randomUUID(), snapshot: { ...empty, participants: [{ participantId: "person", ownerId: f.partner }] } }, f.owner);
  assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: "conflict" });
});
