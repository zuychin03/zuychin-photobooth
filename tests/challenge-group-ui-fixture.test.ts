import assert from "node:assert/strict";
import test from "node:test";
import { createChallengeUIFixture } from "../lib/memories/challenge-ui-fixture";
import { createChallengeClient } from "../lib/memories/challenge-client";
import { challengeDesign, challengeLayouts } from "../lib/memories/challenge-ui";
import { cloudFixturePeople } from "../lib/projects/cloud-fixture-people";
import type { CloudAssetInput } from "../lib/projects/cloud-contract";
import { createStoryPlan } from "../lib/stories/model";
import { prepareChallengeCreate } from "../lib/memories/challenge-contract";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function group(count: 3 | 4) {
  const people = cloudFixturePeople(count), members = people.map(person => ({ userId: person.ownerId, status: "accepted" }));
  const assets = new Map<string, { input: CloudAssetInput; ownerId: string; projectId: string; status: string }>();
  const server = createChallengeUIFixture({ project: () => ({ ownerId: people[0].ownerId, members }), accept: () => {}, asset: key => assets.get(key), assets: () => [...assets.values()] });
  const client = (ownerId: string) => createChallengeClient({ appOrigin: "http://localhost:3005", identity: () => ({ ownerId, epoch: 1 }), accessToken: async () => "synthetic", fetch: async (_url, init) => server.request(JSON.parse(String(init?.body)), ownerId) });
  const clients = people.map(person => client(person.ownerId));
  const view = await clients[0].create(id(100), { id: id(200), ...challengeDesign(challengeLayouts(count)[0].id, people.map(person => person.ownerId)), policy: "all_submitted", expiresAt: new Date(Date.now() + 3600000).toISOString() });
  assert.ok(!("unsupported" in view));
  for (const actor of clients.slice(1)) await actor.manage(view.id, "accept");
  await clients[0].manage(view.id, "open");
  let serial = 300;
  const submit = async (index: number) => {
    const actor = clients[index], sources = view.assignments.filter(item => item.userId === actor.ownerId).map(item => {
      const assetId = id(serial++), input: CloudAssetInput = { id: assetId, requestId: id(serial++), kind: "photo", mime: "image/png", bytes: 100, width: 20, height: 20, sha256: "a".repeat(64), protection: { kind: "challenge", id: view.id } };
      assets.set(assetId, { input, ownerId: actor.ownerId, projectId: view.projectId, status: "ready" });
      return { assetId, sourceIndex: item.sourceIndex };
    });
    return actor.submit(view.id, { requestId: id(serial++), sources });
  };
  return { clients, client, server, view, submit };
}

for (const count of [3, 4] as const) test(`${count}-person fixture keeps incomplete originals concealed and reveals only after the final submission`, async () => {
  const { clients, view, submit } = await group(count);
  for (let index = 0; index < count - 1; index++) await submit(index);
  const waiting = await clients[count - 1].view(view.id); assert.ok(!("unsupported" in waiting));
  assert.equal(waiting.status, "open"); assert.deepEqual(waiting.visibleSources, []);
  const result = await submit(count - 1); assert.ok(!("unsupported" in result));
  assert.equal(result.status, "revealed");
  assert.equal(new Set(result.visibleSources.map(source => source.userId)).size, count);
});

test("four-person partial exact retry survives client replacement and full challenge cancellation", async () => {
  const { clients, client, view, submit } = await group(4);
  await submit(0); await submit(2);
  const contributors = [clients[0].ownerId, clients[2].ownerId];
  const proposal = await clients[1].proposePartial(view.id, id(900), contributors);
  clients[1].close();
  const replacement = client(clients[1].ownerId);
  assert.deepEqual(await replacement.proposePartial(view.id, id(900), contributors), proposal);
  assert.equal((await replacement.listPartials(view.id)).partials.length, 1);
  await clients[0].manage(view.id, "cancel");
  for (const index of [0, 2]) await clients[index].consentPartial(proposal.id, proposal.digest, true);
  await clients[0].commitPartial(proposal.id, proposal.digest);
  const result = await clients[2].partialDetail(proposal.id, proposal.digest); assert.ok(!("unsupported" in result));
  assert.deepEqual(new Set(result.result?.sources.map(source => source.userId)), new Set(contributors));
  const excluded = await replacement.partialDetail(proposal.id, proposal.digest); assert.ok(!("unsupported" in excluded));
  assert.equal(excluded.result, null);
});

test("lost partial acknowledgement is targeted, commits once and reconciles after deadline expiry", async () => {
  const { clients, client, server, view, submit } = await group(4);
  await submit(0); await submit(2);
  const contributors = [clients[0].ownerId, clients[2].ownerId];
  server.loseNextProposalAcknowledgement();
  await clients[1].listPartials(view.id);
  await assert.rejects(clients[1].proposePartial(view.id, id(901), contributors), { code: "unavailable" });
  assert.equal((await clients[1].listPartials(view.id)).partials.length, 1);
  assert.equal(server.expireContributions(view.projectId), 1);
  assert.equal(server.expireContributions(view.projectId), 0);
  const sameClient = await clients[0].view(view.id); assert.ok(!("unsupported" in sameClient));
  assert.equal(sameClient.status, "expired");
  assert.equal(sameClient.expiresAt, view.expiresAt);
  clients[1].close();
  const replacement = client(clients[1].ownerId), proposal = await replacement.proposePartial(view.id, id(901), contributors);
  assert.equal(proposal.id, id(901));
  assert.equal((await replacement.listPartials(view.id)).partials.length, 1);
  const expired = await replacement.view(view.id); assert.ok(!("unsupported" in expired));
  assert.equal(expired.status, "expired");
  assert.equal(expired.expiresAt, view.expiresAt);
  await assert.rejects(submit(3), { code: "expired" });
  for (const index of [0, 2]) await clients[index].consentPartial(proposal.id, proposal.digest, true);
  await clients[0].commitPartial(proposal.id, proposal.digest);
  const result = await clients[2].partialDetail(proposal.id, proposal.digest); assert.ok(!("unsupported" in result));
  assert.equal(result.status, "revealed"); assert.ok(result.result);
});

test("older synthetic server advertises no story support and refuses guided creation without erasing its request", async () => {
  const { clients, server, view } = await group(3);
  const { assignments, ...request } = prepareChallengeCreate({ id: id(950), design: view.design, members: view.members.map(({ userId, role }) => ({ userId, role })), policy: view.policy, expiresAt: view.expiresAt, story: createStoryPlan("quiet-company", 55) });
  assert.equal(assignments.length, view.assignments.length);
  server.setStorySupport(false);
  assert.equal((await clients[0].capabilities()).storyVersion, 0);
  await assert.rejects(clients[0].create(view.projectId, request), { code: "update_required" });
  server.setStorySupport(true);
  const restored = await clients[0].create(view.projectId, request); assert.ok(!("unsupported" in restored));
  assert.deepEqual(restored.story, request.story);
});
