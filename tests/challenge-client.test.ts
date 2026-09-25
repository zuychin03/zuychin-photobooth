import test from "node:test";
import assert from "node:assert/strict";
import { createChallengeClient, ChallengeClientError, parseChallengeResponse, parsePartialResponse } from "../lib/memories/challenge-client";
import { CHALLENGE_LIMITS, prepareChallengeCreate, type ChallengeCreate } from "../lib/memories/challenge-contract";
import { validateTemplateDesign } from "../lib/templates/model";
import { templateFixture } from "./helpers/template-fixture";

const owner = "11111111-1111-4111-8111-111111111111", guest = "22222222-2222-4222-8222-222222222222", id = "33333333-3333-4333-8333-333333333333", project = "44444444-4444-4444-8444-444444444444", partialId = "55555555-5555-4555-8555-555555555555", asset = "66666666-6666-4666-8666-666666666666", digest = "b".repeat(64);
function input(): ChallengeCreate {
  const { canvas, slots, layers, decorations, look, defaults } = templateFixture();
  const design = validateTemplateDesign({ canvas, requiredSources: { A: 1, B: 1 }, slots: [...slots, { ...slots[0], id: "second", role: "B" }], layers, decorations, look, defaults });
  return { id, design, policy: "all_submitted", expiresAt: "2030-01-01T00:00:00.000Z", members: [{ userId: owner, role: "A" }, { userId: guest, role: "B" }] };
}
const projection = () => ({ id, projectId: project, status: "open", policy: "all_submitted", recipeHash: "a".repeat(64), design: input().design, expiresAt: input().expiresAt, revealedAt: null, revealHash: null, accessLost: false, members: input().members.map(m => ({ ...m, status: "accepted", submitted: true })), assignments: prepareChallengeCreate(input()).assignments, visibleSources: [{ userId: owner, sourceIndex: 0, assetId: asset }] });
const partial = () => ({ id: partialId, digest, status: "pending", contributors: [owner, guest], accessLost: false });
const json = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
function client(fetcher: typeof fetch, extra: Partial<Parameters<typeof createChallengeClient>[0]> = {}) {
  return createChallengeClient({ appOrigin: "https://app.example", identity: () => ({ ownerId: owner, epoch: 1 }), accessToken: async () => "synthetic-token", fetch: fetcher, ...extra });
}
test("challenge projections retain validated frozen design but discard concealed extras at every level", () => {
  const v = projection(), parsed = parseChallengeResponse({ ...v, privateSources: [{ assetId: project }], members: v.members.map(m => ({ ...m, email: "private" })), assignments: v.assignments.map(a => ({ ...a, thumbnail: "private" })), visibleSources: v.visibleSources.map(s => ({ ...s, signedUrl: "private" })) }, id);
  assert.deepEqual(parsed, v); assert.equal(JSON.stringify(parsed).includes("private"), false);
});
test("wrong identities, assignments, hashes, duplicate sources and roster corruption are rejected", () => {
  const v = projection();
  for (const altered of [
    { ...v, id: project }, { ...v, projectId: "https://not-an-id" }, { ...v, recipeHash: "bad" }, { ...v, revealHash: "bad" },
    { ...v, members: [v.members[0], v.members[0]] }, { ...v, members: [{ ...v.members[0], role: "C" }, v.members[1]] },
    { ...v, assignments: [...v.assignments].reverse() }, { ...v, assignments: [{ ...v.assignments[0], sourceIndex: 3 }, v.assignments[1]] },
    { ...v, visibleSources: [v.visibleSources[0], v.visibleSources[0]] },
    { ...v, visibleSources: [{ userId: guest, sourceIndex: 3, assetId: asset }] },
    { ...v, visibleSources: [v.visibleSources[0], { userId: guest, sourceIndex: 0, assetId: asset }] },
    { ...v, members: v.members.map(m => ({ ...m, submitted: false })) },
  ]) assert.throws(() => parseChallengeResponse(altered, id), /invalid_response/);
});
test("unsupported legacy projections cannot expose sources or consent metadata", async () => {
  const unavailable = { id, projectId: project, unsupported: true, reason: "recipe_unavailable" };
  assert.deepEqual(parseChallengeResponse({ ...unavailable, visibleSources: projection().visibleSources }, id), unavailable);
  const p = { id: partialId, challengeId: id, unsupported: true, reason: "recipe_unavailable" };
  assert.deepEqual(parsePartialResponse({ ...p, digest, contributors: [owner] }, partialId), p);
  await assert.rejects(client(async () => json(unavailable)).manage(id, "open"), /update_required/);
  await assert.rejects(client(async () => json(p)).commitPartial(partialId, digest), /update_required/);
});
test("all operations use only the fixed same-origin endpoint and never retrieve media", async () => {
  const operations: string[] = [];
  const c = client(async (url, init) => {
    assert.equal(url, "https://app.example/api/challenges"); assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit"); assert.equal(init?.cache, "no-store");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-token");
    const body = JSON.parse(init!.body as string); operations.push(body.operation);
    if (body.operation === "capabilities") return json({ enabled: true, version: 2, limits: CHALLENGE_LIMITS });
    if (body.operation === "commitPartial") return json({ ...partial(), status: "revealed" });
    if (body.operation === "consentPartial") return json({ ...partial(), status: body.consent ? "pending" : "rejected" });
    if (["partial", "proposePartial"].includes(body.operation)) return json(partial());
    return json(projection());
  });
  await c.capabilities(); await c.create(project, input()); await c.view(id); await c.manage(id, "accept"); await c.submit(id, { requestId: asset, sources: [{ sourceIndex: 0, assetId: asset }] });
  await c.proposePartial(id, partialId, [guest, owner]); await c.partial(partialId); await c.consentPartial(partialId, digest, true); await c.consentPartial(partialId, digest, false); await c.commitPartial(partialId, digest);
  assert.deepEqual(operations, ["capabilities", "create", "view", "manage", "submit", "proposePartial", "partial", "consentPartial", "consentPartial", "commitPartial"]);
});
test("create checks exact requested recipe and project, subsequent views cannot rewrite frozen context", async () => {
  await assert.rejects(client(async () => json({ ...projection(), projectId: asset })).create(project, input()), /invalid_response/);
  await assert.rejects(client(async () => json({ ...projection(), design: { ...input().design, defaults: { caption: "Unexpected", showDate: true } } })).create(project, input()), /invalid_response/);
  let response = projection(); const c = client(async () => json(response)); await c.view(id);
  response = { ...response, recipeHash: "c".repeat(64) }; await assert.rejects(c.view(id), /invalid_response/);
});
test("partial mutation checks exact ID, contributors, digest and committed state", async () => {
  await assert.rejects(client(async () => json({ ...partial(), id })).partial(partialId), /invalid_response/);
  await assert.rejects(client(async () => json({ ...partial(), contributors: [owner] })).proposePartial(id, partialId, [owner, guest]), /invalid_response/);
  await assert.rejects(client(async () => json({ ...partial(), digest: "c".repeat(64) })).consentPartial(partialId, digest, true), /invalid_response/);
  await assert.rejects(client(async () => json(partial())).commitPartial(partialId, digest), /invalid_response/);
  await assert.rejects(client(async () => json({ ...partial(), status: "revealed", accessLost: true })).commitPartial(partialId, digest), /invalid_response/);
});
test("invalid mutation inputs issue no request and unsupported capability versions fail closed", async () => {
  let calls = 0; const c = client(async () => { calls++; return json(projection()); });
  await assert.rejects(c.submit(id, { requestId: asset, sources: [{ sourceIndex: 4, assetId: asset }] }));
  await assert.rejects(c.manage(id, "delete" as never)); await assert.rejects(c.consentPartial(partialId, digest, "true" as never));
  await assert.rejects(c.proposePartial(id, partialId, [owner, owner])); assert.equal(calls, 0);
  await assert.rejects(client(async () => json({ enabled: true, version: 1, limits: CHALLENGE_LIMITS })).capabilities(), /invalid_response/);
});
test("account change before token resolution prevents a request, and during response prevents delivery", async () => {
  let epoch = 1, calls = 0;
  const c = client(async () => { calls++; return json(projection()); }, { identity: () => ({ ownerId: owner, epoch }), accessToken: async () => { epoch++; return "old"; } });
  await assert.rejects(c.view(id), /account_changed/); assert.equal(calls, 0); await assert.rejects(c.view(id), /account_changed/);
  const next = client(async () => { epoch++; return json(projection()); }, { identity: () => ({ ownerId: owner, epoch }) }); await assert.rejects(next.view(id), /account_changed/);
});
test("cancellation, stalled transport, byte and chunk limits are bounded", async () => {
  const abort = new AbortController(); abort.abort(); await assert.rejects(client(async () => json(projection())).view(id, abort.signal), /cancelled/);
  await assert.rejects(client(() => new Promise(() => undefined), { timeoutMs: 5 }).view(id), /timeout/);
  await assert.rejects(client(async () => new Response("{}", { headers: { "content-length": String(CHALLENGE_LIMITS.responseBytes + 1) } })).view(id), /response_too_large/);
  let chunks = 0; const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (++chunks <= 4100) controller.enqueue(new Uint8Array([32])); else controller.close(); } });
  await assert.rejects(client(async () => new Response(stream)).view(id), /response_too_large/);
});
test("errors omit raw provider details and preserve bounded retry delay", async () => {
  await assert.rejects(client(async () => json({ error: "raw secret SQL" }, 500)).view(id), (error: unknown) => error instanceof ChallengeClientError && error.code === "unavailable" && !error.message.includes("SQL"));
  await assert.rejects(client(async () => json({ error: "rate_limited" }, 429, { "retry-after": "8" })).view(id), (error: unknown) => error instanceof ChallengeClientError && error.retryAfterSeconds === 8);
});
