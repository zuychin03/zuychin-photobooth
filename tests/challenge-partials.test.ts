import assert from "node:assert/strict";
import test from "node:test";
import { parsePartialDetail, parsePartialList, parseChallengeUploadList, type PartialSummary } from "../lib/memories/challenge-contract";
import { createChallengeClient } from "../lib/memories/challenge-client";
import { createChallengeStore } from "../lib/server/challenge-store";
import { createChallengeHandler } from "../lib/server/challenge-requests";
import { templateFixture } from "./helpers/template-fixture";
import type { ProjectStorePorts } from "../lib/server/project-store";
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor = id(1), challengeId = id(2), partialId = id(3), projectId = id(4), digest = "b".repeat(64);
const summary = (): PartialSummary => ({ id: partialId, challengeId, projectId, digest, status: "pending", createdAt: "2030-01-01T00:00:00Z", revealedAt: null, accessLost: false, actorIncluded: true, actorConsent: null, contributors: [{ userId: actor, role: "A", consent: null, status: "available" }] });
const page = () => ({ version: 1, partials: [summary()], nextCursor: null });
function revealed() {
  const { canvas, requiredSources, slots, layers, decorations, look, defaults } = templateFixture();
  return { version: 1, ...summary(), status: "revealed", revealedAt: "2030-01-01T01:00:00Z", actorConsent: true, contributors: [{ userId: actor, role: "A", consent: true, status: "available" }], result: { projectionVersion: 1, recipeHash: "a".repeat(64), design: { canvas, requiredSources, slots, layers: layers.filter(l => l.kind !== "text" || !l.personal), decorations, look, defaults: { ...defaults, caption: "" } }, sources: [{ userId: actor, role: "A", sourceIndex: 0, assetId: id(5) }] } };
}
const env = { NODE_ENV: "production", PB_CLOUD_PROJECTS_ENABLED: "true", PB_CHALLENGES_ENABLED: "true", PB_PUBLIC_ORIGIN: "https://app.test", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "fixture-only" };
const core = { ready: true, version: 2, recipeVersion: 1, members: 4, slots: 16, sourcesPerMember: 4, proposals: 20, challengesPerProject: 32 };
function fixture() {
  const calls: { name: string; args: Record<string, unknown> }[] = []; let value: unknown = page(), capabilities: unknown = { ...core, partialVersion: 1, partialListMaximum: 20, ownUploadsVersion: 1, uploadListMaximum: 20 };
  const ports: ProjectStorePorts = { authenticate: async () => actor, rpc: async (name, args) => { calls.push({ name, args }); return { data: name === "pb_challenge_capabilities" ? capabilities : value, error: null }; } };
  return { calls, ports, result(v: unknown) { value = v; }, capabilities(v: unknown) { capabilities = v; } };
}
test("partial summaries expose consent only and reject hidden fields, wrong actor and pagination", () => {
  assert.deepEqual(parsePartialList(page(), challengeId, actor), page());
  for (const value of [{ ...page(), partials: [{ ...summary(), sources: [] }] }, { ...page(), partials: [{ ...summary(), actorConsent: true }] }, { ...page(), partials: [{ ...summary(), challengeId: id(8) }] }, { ...page(), partials: [summary(), summary()] }, { ...page(), nextCursor: id(8) }]) assert.throws(() => parsePartialList(value, challengeId, actor));
  assert.throws(() => parsePartialList(page(), challengeId, id(7))); assert.throws(() => parsePartialList(page(), challengeId, actor, partialId));
});
test("pending/excluded/lost/rejected partials cannot return a design or source mapping", () => {
  const good = revealed(); assert.ok(parsePartialDetail(good, partialId, digest, actor));
  for (const patch of [{ status: "pending", revealedAt: null }, { status: "rejected" }, { accessLost: true }, { actorConsent: false, contributors: [{ ...good.contributors[0], consent: false }] }]) assert.throws(() => parsePartialDetail({ ...good, ...patch }, partialId, digest, actor));
  assert.throws(() => parsePartialDetail({ ...good, actorIncluded: false, actorConsent: null }, partialId, digest, id(8)));
  assert.deepEqual(parsePartialDetail({ version: 1, ...summary(), result: null }, partialId, digest, actor), { version: 1, ...summary(), result: null });
  assert.throws(() => parsePartialDetail(good, partialId, "c".repeat(64), actor));
});
test("partial composition requires every included exact source, safe captions and frozen member roles", () => {
  const good = revealed();
  for (const sources of [[], [...good.result.sources, ...good.result.sources], [{ ...good.result.sources[0], userId: id(8) }], [{ ...good.result.sources[0], sourceIndex: 1 }]]) assert.throws(() => parsePartialDetail({ ...good, result: { ...good.result, sources } }, partialId, digest, actor));
  assert.throws(() => parsePartialDetail({ ...good, result: { ...good.result, design: { ...good.result.design, defaults: { caption: "excluded person's caption", showDate: false } } } }, partialId, digest, actor));
});
test("legacy partials remain explicit unsupported without revealing retained design", () => {
  const legacy = { id: partialId, challengeId, projectId, unsupported: true, reason: "recipe_unavailable" };
  assert.deepEqual(parsePartialList({ version: 1, partials: [legacy], nextCursor: null }, challengeId, actor).partials[0], legacy);
  assert.deepEqual(parsePartialDetail({ version: 1, ...legacy }, partialId, digest, actor), { version: 1, ...legacy });
  assert.throws(() => parsePartialDetail({ version: 1, ...legacy, result: null }, partialId, digest, actor));
});
test("store binds actor and exact digest and requires additive partial capability", async () => {
  const f = fixture(), store = await createChallengeStore("fixture-token", env, f.ports);
  await store.listPartials(challengeId); assert.deepEqual(f.calls.at(-1), { name: "pb_challenge_partial_list", args: { p_actor: actor, p_challenge: challengeId, p_after: null, p_limit: 20 } });
  f.result(revealed()); await store.partialDetail(partialId, digest); assert.equal(f.calls.at(-1)?.args.p_digest, digest);
  f.result({ ...revealed(), digest: "c".repeat(64) }); await assert.rejects(store.partialDetail(partialId, digest), /unavailable/);
  f.capabilities(core); const old = await createChallengeStore("fixture-token", env, f.ports); const count = f.calls.length;
  await assert.rejects(old.listPartials(challengeId), /unavailable/); await assert.rejects(old.partialDetail(partialId, digest), /unavailable/); assert.equal(f.calls.length, count);
});
test("HTTP and browser partial operations enforce envelopes and read rate without concealed projections", async () => {
  const f = fixture(), rates: string[] = [];
  const handler = createChallengeHandler({ project: async () => ({ rate: async rate => { rates.push(rate); } }), challenge: token => createChallengeStore(token, env, f.ports) }, () => env);
  const request = (body: unknown) => new Request("https://app.test/api/challenges", { method: "POST", headers: { origin: "https://app.test", authorization: "Bearer fixture", "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const body of [{ operation: "listPartials", challengeId, actor }, { operation: "listPartials", challengeId, limit: 21 }, { operation: "partialDetail", partialId }, { operation: "partialDetail", partialId, digest, includeHidden: true }]) assert.equal((await handler(request(body))).status, 400);
  assert.deepEqual(rates, []);
  const client = createChallengeClient({ appOrigin: "https://app.test", identity: () => ({ ownerId: actor, epoch: 1 }), accessToken: async () => "fixture", fetch: async (_url, init) => handler(request(JSON.parse(init!.body as string))) });
  assert.deepEqual(await client.listPartials(challengeId), page()); f.result(revealed()); assert.ok((await client.partialDetail(partialId, digest)));
  assert.deepEqual(rates, ["read", "read"]); client.close(); await assert.rejects(client.partialDetail(partialId, digest), /cancelled/);
});
test("authoritative uploads reject foreign, non-photo, oversized and unordered assets", () => {
  const asset = { id: id(8), ownerId: actor, kind: "photo", mime: "image/png", bytes: 100, width: 20, height: 20, sha256: "a".repeat(64) }, uploads = { version: 1, uploads: [asset], nextCursor: null };
  assert.deepEqual(parseChallengeUploadList(uploads, actor), uploads);
  for (const patch of [{ ownerId: id(9) }, { kind: "decoration" }, { bytes: 10485761 }, { signedUrl: "https://private.test" }]) assert.throws(() => parseChallengeUploadList({ ...uploads, uploads: [{ ...asset, ...patch }] }, actor));
  assert.throws(() => parseChallengeUploadList(uploads, actor, asset.id)); assert.throws(() => parseChallengeUploadList({ ...uploads, uploads: [asset, asset] }, actor));
});
test("authoritative upload discovery traverses browser/HTTP/store with actor-only pagination and read rate", async () => {
  const f = fixture(), rates: string[] = [], uploads = { version: 1, uploads: [{ id: id(8), ownerId: actor, kind: "photo", mime: "image/png", bytes: 100, width: 20, height: 20, sha256: "a".repeat(64) }], nextCursor: null }; f.result(uploads);
  const handler = createChallengeHandler({ project: async () => ({ rate: async rate => { rates.push(rate); } }), challenge: token => createChallengeStore(token, env, f.ports) }, () => env);
  const request = (body: unknown) => new Request("https://app.test/api/challenges", { method: "POST", headers: { origin: "https://app.test", authorization: "Bearer fixture", "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await handler(request({ operation: "listUploads", challengeId, ownerId: actor }))).status, 400); assert.equal((await handler(request({ operation: "listUploads", challengeId, limit: 21 }))).status, 400); assert.deepEqual(rates, []);
  const client = createChallengeClient({ appOrigin: "https://app.test", identity: () => ({ ownerId: actor, epoch: 1 }), accessToken: async () => "fixture", fetch: async (_url, init) => handler(request(JSON.parse(init!.body as string))) });
  assert.deepEqual(await client.listUploads(challengeId, id(7), 1), uploads);
  assert.deepEqual(f.calls.at(-1), { name: "pb_challenge_upload_list", args: { p_actor: actor, p_challenge: challengeId, p_after: id(7), p_limit: 1 } }); assert.deepEqual(rates, ["read"]);
  f.capabilities(core); const old = await createChallengeStore("fixture", env, f.ports); await assert.rejects(old.listUploads(challengeId), /unavailable/);
});
