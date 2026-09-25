import assert from "node:assert/strict";
import test from "node:test";
import { validateChallengeCreate, prepareChallengeCreate, validateChallengeSubmission, type ChallengeCreate } from "../lib/memories/challenge-contract";
import { createChallengeStore } from "../lib/server/challenge-store";
import { validateTemplateDesign } from "../lib/templates/model";
import { templateFixture } from "./helpers/template-fixture";
import type { ProjectStorePorts } from "../lib/server/project-store";
const actor = "11111111-1111-4111-8111-111111111111", guest = "22222222-2222-4222-8222-222222222222", id = "33333333-3333-4333-8333-333333333333", project = "44444444-4444-4444-8444-444444444444";
const env = { PB_CLOUD_PROJECTS_ENABLED: "true", PB_CHALLENGES_ENABLED: "true", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "fixture-not-a-secret" };
const design = () => {
  const { canvas, slots, layers, decorations, look, defaults } = templateFixture();
  return validateTemplateDesign({ canvas, requiredSources: { A: 1, B: 1 }, slots: [...slots, { ...slots[0], id: "second", role: "B" }], layers, decorations, look, defaults });
};
const input = (): ChallengeCreate => ({ id, design: design(), policy: "all_submitted", expiresAt: "2030-01-01T00:00:00.000Z", members: [{ userId: actor, role: "A" }, { userId: guest, role: "B" }] });
const projection = () => ({ id, projectId: project, status: "open", policy: "all_submitted", recipeHash: "a".repeat(64), design: design(), expiresAt: input().expiresAt, revealedAt: null, revealHash: null, accessLost: false, members: input().members.map(m => ({ ...m, status: "accepted", submitted: false })), assignments: prepareChallengeCreate(input()).assignments, visibleSources: [] });
function fixture() {
  const calls: { name: string; args: Record<string, unknown> }[] = []; let verified: string | null = actor, result: unknown = projection();
  const ports: ProjectStorePorts = { authenticate: async () => verified, rpc: async (name, args) => { calls.push({ name, args }); return { data: name === "pb_challenge_capabilities" ? { version: 2, recipeVersion: 1, ready: true, members: 4, slots: 16, sourcesPerMember: 4, proposals: 20, challengesPerProject: 32 } : result, error: null }; } };
  return { calls, ports, result(value: unknown) { result = value; }, actor(value: string | null) { verified = value; } };
}
test("challenge feature/configuration/auth/schema failures cannot produce operations", async () => {
  const f = fixture();
  for (const bad of [{ ...env, PB_CHALLENGES_ENABLED: "false" }, { ...env, PB_CLOUD_PROJECTS_ENABLED: "false" }, { ...env, SUPABASE_SERVICE_ROLE_KEY: "" }]) await assert.rejects(createChallengeStore("fixture-token", bad, f.ports), /unavailable/);
  assert.equal(f.calls.length, 0); f.actor(null); await assert.rejects(createChallengeStore("fixture-token", env, f.ports), /access_denied/); assert.equal(f.calls.length, 0);
  f.actor(actor); f.ports.rpc = async () => ({ data: { version: 1, ready: true }, error: null }); await assert.rejects(createChallengeStore("fixture-token", env, f.ports), /unavailable/);
});
test("frozen roster and source assignment parser rejects ownership gaps and unbounded input", () => {
  assert.deepEqual(validateChallengeCreate(input()), input());
  for (const bad of [{ ...input(), members: [input().members[0]] }, { ...input(), members: [input().members[0], input().members[0]] }, { ...input(), design: { ...design(), requiredSources: { A: 1 } } }, { ...input(), design: { ...design(), slots: [{ ...design().slots[0], sourceIndex: 4 }, design().slots[1]] } }, { ...input(), recipeHash: "a".repeat(64) }, { ...input(), url: "https://example.invalid" }]) assert.throws(() => validateChallengeCreate(bad));
  let invoked = false; const members = input().members; Object.defineProperty(members, "0", { get() { invoked = true; return { userId: actor, role: "A" }; } }); assert.throws(() => validateChallengeCreate({ ...input(), members })); assert.equal(invoked, false);
});
test("submission parser permits only bounded immutable source indices and asset IDs", () => {
  const submission = { requestId: id, sources: [{ sourceIndex: 0, assetId: project }] }; assert.deepEqual(validateChallengeSubmission(submission), submission);
  for (const bad of [{ ...submission, sources: [...submission.sources, ...submission.sources] }, { ...submission, caption: "hidden content" }, { ...submission, sources: [{ sourceIndex: 0, assetId: "https://example.invalid/photo" }] }]) assert.throws(() => validateChallengeSubmission(bad));
});
test("verified identity is bound to RPCs while opaque projections strip unexpected private fields", async () => {
  const f = fixture(), store = await createChallengeStore("fixture-token", env, f.ports);
  f.result({ ...projection(), privateSources: [{ url: "https://example.invalid/hidden" }], caption: "hidden" }); assert.deepEqual(await store.create(project, input()), projection());
  assert.equal(f.calls.at(-1)?.args.p_actor, actor); assert.equal(f.calls.at(-1)?.args.p_project, project);
  await assert.rejects(store.create(project, { ...input(), actor: guest } as never)); assert.equal(f.calls.length, 2);
  f.result({ ...projection(), id: project }); await assert.rejects(store.view(id), /unavailable/);
  f.result({ ...projection(), visibleSources: [{ userId: project, sourceIndex: 0, assetId: id }] }); await assert.rejects(store.view(id), /unavailable/);
});
test("partial consent is exact-digest, per-actor and strict boolean; server denials remain denials", async () => {
  const f = fixture(), store = await createChallengeStore("fixture-token", env, f.ports), digest = "b".repeat(64);
  const response = { id: project, digest, status: "pending", contributors: [actor, guest], accessLost: false }; f.result({ ...response, snapshot: { assets: [id] } });
  assert.deepEqual(await store.consentPartial(project, digest, true), response); assert.equal(f.calls.at(-1)?.args.p_actor, actor); assert.equal(f.calls.at(-1)?.args.p_digest, digest);
  await assert.rejects(store.consentPartial(project, digest, "true" as never), /invalid_request/);
  f.ports.rpc = async () => ({ data: null, error: { message: "PB_CHALLENGE_NOT_READY" } }); await assert.rejects(store.commitPartial(project, digest), /not_ready/);
});

test("frozen sources derive from actual primary and companion cells, deduplicating repeats without filling gaps", () => {
  const base = design(), crop = base.slots[0].crop;
  const sparse = { ...base, requiredSources: { A: 3, B: 4 }, slots: [{ ...base.slots[0], sourceIndex: 2, companions: [{ role: "B", sourceIndex: 3, crop }] }, { ...base.slots[0], id: "repeat", sourceIndex: 2 }] };
  const prepared = prepareChallengeCreate({ ...input(), design: sparse, members: [...input().members].reverse() });
  assert.deepEqual(prepared.assignments, [{ slot: 0, userId: actor, sourceIndex: 2 }, { slot: 1, userId: guest, sourceIndex: 3 }]);
  assert.deepEqual(prepared.members, input().members);
  assert.throws(() => validateChallengeCreate({ ...input(), assignments: prepared.assignments }));
  for (const bad of [{ ...sparse, requiredSources: { A: 4, B: 4 } }, { ...sparse, requiredSources: { A: 3, B: 4, C: 1 } }, { ...base, account: { ownerId: actor } }, { ...base, cameraId: "private-device" }]) assert.throws(() => validateChallengeCreate({ ...input(), design: bad }));
});

test("recipe input accepts only bounded known design fields and explicit cloud decoration identities", () => {
  const base = design();
  for (const bad of [{ ...base, look: { ...base.look, materialId: "https://example.invalid/image" } }, { ...base, slots: [{ ...base.slots[0], url: "https://example.invalid/photo" }, base.slots[1]] }, { ...base, decorations: [{ id: assetId(), kind: "photo", mime: "image/png", bytes: 10, width: 1, height: 1 }] }]) assert.throws(() => validateChallengeCreate({ ...input(), design: bad }));
  const decoration = { id: assetId(), kind: "decoration", mime: "image/png", bytes: 100, width: 20, height: 20 };
  const decorated = { ...base, decorations: [decoration], layers: [{ id: "png", kind: "decoration", mediaId: decoration.id, fit: "contain", x: 0, y: 0, width: 0.1, height: 0.1, rotation: 0 }] };
  assert.equal(validateChallengeCreate({ ...input(), design: decorated }).design.decorations.length, 1);
  assert.throws(() => validateChallengeCreate({ ...input(), design: { ...decorated, decorations: [{ ...decoration, id: "local-only" }], layers: [{ ...decorated.layers[0], mediaId: "local-only" }] } }));
  let read = false; const malicious = { ...base, get defaults() { read = true; return base.defaults; } };
  assert.throws(() => validateChallengeCreate({ ...input(), design: malicious })); assert.equal(read, false);
});
function assetId() { return "55555555-5555-4555-8555-555555555555"; }

test("server prepares assignment payload without caller hashes and rejects altered returned design or mapping", async () => {
  const f = fixture(), store = await createChallengeStore("fixture-token", env, f.ports);
  await store.create(project, input());
  const body = f.calls.at(-1)?.args.p_body as Record<string, unknown>;
  assert(!("recipeHash" in body)); assert.deepEqual(body.assignments, prepareChallengeCreate(input()).assignments);
  f.result({ ...projection(), design: { ...design(), defaults: { caption: "Changed by incompatible server", showDate: true } } }); await assert.rejects(store.create(project, input()), /unavailable/);
  f.result({ ...projection(), assignments: [{ slot: 0, userId: guest, sourceIndex: 0 }, { slot: 1, userId: actor, sourceIndex: 0 }] }); await assert.rejects(store.view(id), /unavailable/);
  f.result({ id, projectId: project, unsupported: true, reason: "recipe_unavailable", hiddenOriginals: [assetId()] });
  assert.deepEqual(await store.view(id), { id, projectId: project, unsupported: true, reason: "recipe_unavailable" });
  await assert.rejects(store.create(project, input()), /update_required/);
});

test("legacy partial history returns unavailable without a digest and cannot report consent or commit success", async () => {
  const f = fixture(), store = await createChallengeStore("fixture-token", env, f.ports);
  const unavailable = { id: project, challengeId: id, unsupported: true, reason: "recipe_unavailable" };
  f.result({ ...unavailable, digest: "a".repeat(64), status: "pending", contributors: [actor], snapshot: { private: true } });
  assert.deepEqual(await store.partial(project), unavailable);
  for (const consent of [true, false]) await assert.rejects(store.consentPartial(project, "a".repeat(64), consent), /update_required/);
  await assert.rejects(store.commitPartial(project, "a".repeat(64)), /update_required/);
  await assert.rejects(store.proposePartial(id, project, [actor]), /update_required/);
  f.ports.rpc = async () => ({ data: null, error: { message: "PB_CHALLENGE_UPDATE_REQUIRED" } });
  await assert.rejects(store.consentPartial(project, "a".repeat(64), true), /update_required/);
  await assert.rejects(store.commitPartial(project, "a".repeat(64)), /update_required/);
});
