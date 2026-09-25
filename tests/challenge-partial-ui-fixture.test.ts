import assert from "node:assert/strict";
import test from "node:test";
import { createChallengeUIFixture } from "../lib/memories/challenge-ui-fixture";
import { createChallengeClient } from "../lib/memories/challenge-client";
import { challengeDesign } from "../lib/memories/challenge-ui";
import type { CloudAssetInput } from "../lib/projects/cloud-contract";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function fixture() {
  const members = [{ userId: id(1), status: "accepted" }, { userId: id(2), status: "invited" }];
  const assets = new Map<string, { input: CloudAssetInput; ownerId: string; projectId: string; status: string }>();
  const transport = createChallengeUIFixture({ project: projectId => projectId === id(10) ? { ownerId: id(1), members } : null, accept: (_id, owner) => { members.find(member => member.userId === owner)!.status = "accepted"; }, asset: assetId => assets.get(assetId), assets: () => [...assets.values()] });
  const client = (ownerId: string) => createChallengeClient({ appOrigin: "http://127.0.0.1:3005", identity: () => ({ ownerId, epoch: 1 }), accessToken: async () => "synthetic", fetch: async (_url, init) => transport.request(JSON.parse(String(init?.body)), ownerId) });
  const a = client(id(1)), b = client(id(2));
  await a.create(id(10), { id: id(20), ...challengeDesign("duo-alternate", [id(1), id(2)]), policy: "all_submitted", expiresAt: new Date(Date.now() + 3600000).toISOString() });
  await b.manage(id(20), "accept"); await a.manage(id(20), "open");
  for (const [actor, indices] of [[a, [0, 2]], [b, [1, 3]]] as const) {
    const sources = indices.map(sourceIndex => {
      const assetId = id(30 + sourceIndex), input: CloudAssetInput = { id: assetId, requestId: id(40 + sourceIndex), kind: "photo", mime: "image/png", bytes: 100, width: 20, height: 20, sha256: "a".repeat(64), protection: { kind: "challenge", id: id(20) } };
      assets.set(assetId, { input, ownerId: actor.ownerId, projectId: id(10), status: "ready" }); return { sourceIndex, assetId };
    });
    await actor.submit(id(20), { requestId: id(actor === a ? 50 : 51), sources });
  }
  return { a, b, assets, transport };
}

test("synthetic partial transport preserves excluded-proposer consent, retry and withdrawal screens", async () => {
  const { a, b } = await fixture(), p = await a.proposePartial(id(20), id(60), [id(2)]);
  assert.deepEqual(await a.proposePartial(id(20), id(60), [id(2)]), p);
  await assert.rejects(a.consentPartial(p.id, p.digest, true), { code: "access_denied" });
  await assert.rejects(a.commitPartial(p.id, p.digest), { code: "not_ready" });
  const pending = await b.partialDetail(p.id, p.digest); assert.ok(!("unsupported" in pending));
  assert.equal(pending.result, null); assert.equal(pending.actorConsent, null);
  await b.consentPartial(p.id, p.digest, true); await b.commitPartial(p.id, p.digest);
  const excluded = await a.partialDetail(p.id, p.digest); assert.ok(!("unsupported" in excluded)); assert.equal(excluded.result, null);
  await a.manage(id(20), "withdraw");
  const included = await b.partialDetail(p.id, p.digest); assert.ok(!("unsupported" in included)); assert.equal(included.accessLost, false);
  assert.deepEqual(included.result?.sources.map(source => source.sourceIndex), [1, 3]);
  assert.deepEqual(included.result?.design.slots.map(slot => slot.role), ["B", "B"]);
  await b.consentPartial(p.id, p.digest, false);
  const rejected = await b.partialDetail(p.id, p.digest); assert.ok(!("unsupported" in rejected)); assert.equal(rejected.result, null); assert.equal(rejected.accessLost, true);
  await assert.rejects(b.consentPartial(p.id, p.digest, true), { code: "conflict" });
});

test("synthetic projection matches the strict client parser and invalidates on source deletion", async () => {
  const { a, b, assets } = await fixture(), p = await a.proposePartial(id(20), id(60), [id(1), id(2)]);
  await a.consentPartial(p.id, p.digest, true);
  await assert.rejects(a.commitPartial(p.id, p.digest), { code: "not_ready" });
  await b.consentPartial(p.id, p.digest, true); await a.commitPartial(p.id, p.digest);
  const current = await b.partialDetail(p.id, p.digest); assert.ok(!("unsupported" in current)); assert.equal(current.result?.sources.length, 4);
  assert.equal((await b.listPartials(id(20))).partials.length, 1);
  assets.get(id(30))!.status = "deleted";
  const lost = await b.partialDetail(p.id, p.digest); assert.ok(!("unsupported" in lost)); assert.equal(lost.result, null); assert.equal(lost.accessLost, true);
});

test("stale contributor choice receives a definitive rejection and a valid remaining subset can be proposed", async () => {
  const { a, b } = await fixture(); await b.manage(id(20), "withdraw");
  await assert.rejects(a.proposePartial(id(20), id(60), [id(1), id(2)]), { code: "invalid_request", status: 400 });
  assert.equal((await a.listPartials(id(20))).partials.length, 0);
  const next = await a.proposePartial(id(20), id(61), [id(1)]);
  assert.equal(next.status, "pending"); assert.deepEqual(next.contributors, [id(1)]);
});
