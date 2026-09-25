import assert from "node:assert/strict";
import test from "node:test";
import { CHALLENGE_LIMITS, parseChallengeList, type ChallengeSummary } from "../lib/memories/challenge-contract";
import { createChallengeClient } from "../lib/memories/challenge-client";
import { createChallengeStore } from "../lib/server/challenge-store";
import { createChallengeHandler } from "../lib/server/challenge-requests";
import type { ProjectStorePorts } from "../lib/server/project-store";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const project = id(1), actor = id(2);
const summary = (n = 3): ChallengeSummary => ({ id: id(n), projectId: project, status: "draft", policy: "all_submitted", membership: "invited", createdAt: "2030-01-01T00:00:00Z", expiresAt: "2030-01-02T00:00:00Z", unsupported: false });
const env = { NODE_ENV: "production", PB_CLOUD_PROJECTS_ENABLED: "true", PB_CHALLENGES_ENABLED: "true", PB_PUBLIC_ORIGIN: "https://app.test", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "fixture-only" };
const core = { ready: true, version: 2, recipeVersion: 1, members: 4, slots: 16, sourcesPerMember: 4, proposals: 20, challengesPerProject: 32 };
const page = () => ({ version: 1, challenges: [summary()], nextCursor: null });
function fixture() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let result: unknown = page(), capabilities: unknown = { ...core, discoveryVersion: 1, listMaximum: 20 };
  const ports: ProjectStorePorts = { authenticate: async () => actor, rpc: async (name, args) => { calls.push({ name, args }); return { data: name === "pb_challenge_capabilities" ? capabilities : result, error: null }; } };
  return { ports, calls, result(value: unknown) { result = value; }, capabilities(value: unknown) { capabilities = value; } };
}
test("discovery parser bounds exact-project sorted pages and rejects concealed extra fields", () => {
  assert.deepEqual(parseChallengeList(page(), project), page());
  assert.equal(parseChallengeList({ version: 1, challenges: [{ ...summary(), unsupported: true, membership: "withdrawn" }], nextCursor: null }, project).challenges[0].unsupported, true);
  for (const bad of [
    { ...page(), version: 2 }, { ...page(), challenges: [{ ...summary(), projectId: id(9) }] },
    { ...page(), challenges: [summary(), summary()] }, { ...page(), challenges: [summary(4), summary(3)] },
    { ...page(), challenges: [{ ...summary(), design: { defaults: { caption: "concealed" } } }] },
    { ...page(), challenges: [{ ...summary(), assetId: id(8) }] }, { ...page(), challenges: [{ ...summary(), membership: "revoked" }] },
    { ...page(), nextCursor: id(7) }, { ...page(), challenges: Array.from({ length: 21 }, (_, n) => summary(n + 3)) },
  ]) assert.throws(() => parseChallengeList(bad, project));
  assert.throws(() => parseChallengeList(page(), project, id(3)));
  assert.throws(() => parseChallengeList(page(), project, undefined, 0));
  assert.deepEqual(parseChallengeList({ ...page(), nextCursor: id(3) }, project, undefined, 1).nextCursor, id(3));
});
test("service discovery binds verified actor, exact project, cursor and bounded limit", async () => {
  const f = fixture(), store = await createChallengeStore("fixture-token", env, f.ports);
  assert.deepEqual(await store.list(project, undefined, 20), page());
  assert.deepEqual(f.calls.at(-1), { name: "pb_challenge_list", args: { p_actor: actor, p_project: project, p_after: null, p_limit: 20 } });
  f.result({ version: 1, challenges: [summary(4)], nextCursor: null }); await store.list(project, id(3), 1);
  assert.equal(f.calls.at(-1)?.args.p_after, id(3)); assert.equal(f.calls.at(-1)?.args.p_limit, 1);
  const before = f.calls.length; for (const bad of [0, 21, 1.1]) await assert.rejects(store.list(project, undefined, bad)); assert.equal(f.calls.length, before);
  f.result({ ...page(), challenges: [{ ...summary(), projectId: id(9) }] }); await assert.rejects(store.list(project), /unavailable/);
});
test("old core-compatible SQL remains usable but cannot claim discovery support", async () => {
  const f = fixture(); f.capabilities(core); const store = await createChallengeStore("fixture-token", env, f.ports);
  f.result({ id: id(3), projectId: project, unsupported: true, reason: "recipe_unavailable" });
  assert.equal("unsupported" in await store.view(id(3)), true);
  const before = f.calls.length; await assert.rejects(store.list(project), /unavailable/); assert.equal(f.calls.length, before);
  f.capabilities({ ...core, discoveryVersion: 1, listMaximum: 50 }); const incompatible = await createChallengeStore("fixture-token", env, f.ports);
  await assert.rejects(incompatible.list(project), /unavailable/);
});
test("discovery HTTP validates envelope before auth and uses the read rate before listing", async () => {
  const f = fixture(), order: string[] = [];
  const handler = createChallengeHandler({ project: async () => { order.push("auth"); return { rate: async kind => { order.push(`rate:${kind}`); } }; }, challenge: async token => { order.push("challenge"); return createChallengeStore(token, env, f.ports); } }, () => env);
  const request = (body: unknown) => new Request("https://app.test/api/challenges", { method: "POST", headers: { origin: "https://app.test", authorization: "Bearer fixture-token", "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const bad of [{ operation: "list", projectId: project, actorId: actor }, { operation: "list", projectId: project, limit: 21 }, { operation: "list", projectId: project, after: null }, { operation: "list" }]) assert.equal((await handler(request(bad))).status, 400);
  assert.deepEqual(order, []);
  const response = await handler(request({ operation: "list", projectId: project })); assert.equal(response.status, 200); assert.deepEqual(await response.json(), page());
  assert.deepEqual(order, ["auth", "rate:read", "challenge"]); assert.equal(response.headers.get("cache-control"), "private, no-store");
  f.ports.rpc = async name => name === "pb_challenge_capabilities" ? { data: { ...core, discoveryVersion: 1, listMaximum: 20 }, error: null } : { data: null, error: { message: "PB_CHALLENGE_DENIED" } };
  assert.equal((await handler(request({ operation: "list", projectId: project }))).status, 403);
});
test("browser discovery uses its list marker without requiring it for core capabilities", async () => {
  const requests: Record<string, unknown>[] = []; let response: unknown = page();
  const client = createChallengeClient({ appOrigin: "https://app.test", identity: () => ({ ownerId: actor, epoch: 1 }), accessToken: async () => "fixture-token", fetch: async (_, init) => {
    const body = JSON.parse(init!.body as string); requests.push(body);
    return new Response(JSON.stringify(body.operation === "capabilities" ? { enabled: true, version: 2, limits: CHALLENGE_LIMITS } : response), { headers: { "content-type": "application/json" } });
  } });
  await client.capabilities(); assert.deepEqual(await client.list(project), page()); assert.deepEqual(requests.at(-1), { operation: "list", projectId: project, limit: 20 });
  const count = requests.length; await assert.rejects(client.list(project, undefined, 21), /invalid_request/); assert.equal(requests.length, count);
  response = { challenges: [], nextCursor: null }; await assert.rejects(client.list(project), /invalid_response/);
  response = page(); await assert.rejects(client.list(project, id(3)), /invalid_response/);
});
