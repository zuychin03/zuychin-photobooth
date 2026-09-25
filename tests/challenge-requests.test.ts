import assert from "node:assert/strict";
import test from "node:test";
import { createChallengeHandler, type ChallengeRequestPorts } from "../lib/server/challenge-requests";
import { createChallengeStore, ChallengeServerError, type ChallengeStore } from "../lib/server/challenge-store";
import { ProjectServerError } from "../lib/server/project-store";
import { CHALLENGE_LIMITS, prepareChallengeCreate, type ChallengeCreate, type ChallengeView, type PartialReveal } from "../lib/memories/challenge-contract";
import { validateTemplateDesign } from "../lib/templates/model";
import { templateFixture } from "./helpers/template-fixture";
import { readSmallJson, RequestValidationError } from "../lib/server/request-security";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const env = { NODE_ENV: "production", PB_CLOUD_PROJECTS_ENABLED: "true", PB_CHALLENGES_ENABLED: "true", PB_PUBLIC_ORIGIN: "https://app.test", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "fixture-not-a-secret" };
const request = (body: unknown, headers: Record<string, string> = {}) => new Request("https://app.test/api/challenges", { method: "POST", headers: { origin: "https://app.test", authorization: "Bearer fixture-access", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
function challenge(): ChallengeCreate {
  const { canvas, slots, layers, decorations, look, defaults } = templateFixture();
  return { id: id(1), design: validateTemplateDesign({ canvas, requiredSources: { A: 1, B: 1 }, slots: [...slots, { ...slots[0], id: "guest", role: "B" }], layers, decorations, look, defaults }), policy: "all_submitted", expiresAt: "2030-01-01T00:00:00.000Z", members: [{ userId: id(3), role: "A" }, { userId: id(4), role: "B" }] };
}
function projection(): ChallengeView {
  const input = challenge();
  return { id: input.id, projectId: id(2), design: input.design, status: "open", policy: input.policy, recipeHash: "a".repeat(64), expiresAt: input.expiresAt, revealedAt: null, revealHash: null, accessLost: false, members: input.members.map(m => ({ ...m, status: "accepted", submitted: false })), assignments: prepareChallengeCreate(input).assignments, visibleSources: [] };
}
const partial: PartialReveal = { id: id(5), digest: "b".repeat(64), status: "pending", contributors: [id(3)], accessLost: false };
function fixture() {
  const calls: string[] = [], values: unknown[][] = [];
  const store: ChallengeStore = {
    listUploads: async () => ({ version: 1, uploads: [], nextCursor: null }),
    listPartials: async () => ({ version: 1, partials: [], nextCursor: null }),
    partialDetail: async () => { throw new ChallengeServerError("access_denied", 403); },
    list: async (...args) => { calls.push("list"); values.push(args); return { version: 1, challenges: [], nextCursor: null }; },
    create: async (...args) => { calls.push("create"); values.push(args); return projection(); },
    view: async (...args) => { calls.push("view"); values.push(args); return projection(); },
    manage: async (...args) => { calls.push("manage"); values.push(args); return projection(); },
    submit: async (...args) => { calls.push("submit"); values.push(args); return projection(); },
    proposePartial: async (...args) => { calls.push("proposePartial"); values.push(args); return partial; },
    partial: async (...args) => { calls.push("partial"); values.push(args); return partial; },
    consentPartial: async (...args) => { calls.push("consentPartial"); values.push(args); return partial; },
    commitPartial: async (...args) => { calls.push("commitPartial"); values.push(args); return partial; },
  };
  const rate = { rate: async (scope: string) => { calls.push(`rate:${scope}`); } };
  const ports: ChallengeRequestPorts = { project: async token => { assert.equal(token, "fixture-access"); calls.push("authenticate-project"); return rate; }, challenge: async token => { assert.equal(token, "fixture-access"); calls.push("authenticate-challenge"); return store; } };
  return { calls, values, store, ports, rate, handler: createChallengeHandler(ports, () => env) };
}
function privateResponse(response: Response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

test("challenge HTTP requires both explicit flags before authentication or operation", async () => {
  const f = fixture();
  for (const flags of [{ PB_CHALLENGES_ENABLED: undefined }, { PB_CLOUD_PROJECTS_ENABLED: "false" }, { PB_CHALLENGES_ENABLED: "TRUE" }]) {
    const response = await createChallengeHandler(f.ports, () => ({ ...env, ...flags }))(request({ operation: "capabilities" }));
    assert.equal(response.status, 503); privateResponse(response); assert.deepEqual(await response.json(), { enabled: false, error: "unavailable" });
  }
  assert.deepEqual(f.calls, []);
});

test("origin, TLS, method, query and bearer failures have no store side effects", async () => {
  const f = fixture(), body = { operation: "capabilities" };
  for (const [req, status] of [
    [request(body, { origin: "https://other.test", host: "other.test" }), 403],
    [request(body, { "sec-fetch-site": "cross-site" }), 403],
    [request(body, { authorization: "" }), 401],
    [request(body, { authorization: "Bearer first,second" }), 401],
    [new Request("http://app.test/api/challenges", request(body)), 503],
    [new Request("https://app.test/api/challenges?token=fixture", request(body)), 400],
    [new Request("https://app.test/api/challenges"), 405],
  ] as const) { const response = await f.handler(req); assert.equal(response.status, status); privateResponse(response); }
  assert.deepEqual(f.calls, []);
  assert.equal((await f.handler(request(body, { host: "forged.test" }))).status, 200);
});

test("local HTTP is allowed only in development and still requires exact same origin", async () => {
  const f = fixture(), local = new Request("http://127.0.0.1:3005/api/challenges", request({ operation: "capabilities" }, { origin: "http://127.0.0.1:3005" }));
  assert.equal((await createChallengeHandler(f.ports, () => ({ ...env, NODE_ENV: "development", PB_PUBLIC_ORIGIN: undefined }))(local)).status, 200);
  const missing = await createChallengeHandler(f.ports, () => ({ ...env, PB_PUBLIC_ORIGIN: undefined }))(request({ operation: "capabilities" }));
  assert.equal(missing.status, 503); assert.deepEqual(await missing.json(), { error: "unavailable" });
});

test("strict envelopes reject actor, hash, assignment, storage and malformed consent input before stores", async () => {
  const f = fixture();
  const bad = [
    { operation: "create", projectId: id(2), challenge: { ...challenge(), recipeHash: "a".repeat(64) } },
    { operation: "create", projectId: id(2), challenge: { ...challenge(), assignments: [] } },
    { operation: "create", projectId: id(2), challenge: { ...challenge(), design: { ...challenge().design, url: "https://private.test" } } },
    { operation: "view", challengeId: id(1), actor: id(3) },
    { operation: "submit", challengeId: id(1), submission: { requestId: id(6), sources: [{ sourceIndex: 0, assetId: id(7), path: "private/photo" }] } },
    { operation: "manage", challengeId: id(1), action: "reveal" },
    { operation: "consentPartial", partialId: id(5), digest: partial.digest, consent: "true" },
    { operation: "commitPartial", partialId: id(5), digest: "A".repeat(64) },
    { operation: "proposePartial", challengeId: id(1), partialId: id(5), contributors: [id(3), id(3)] },
    { operation: "proposePartial", challengeId: id(1), partialId: id(5), contributors: Array.from({ length: 5 }, (_, n) => id(n)) },
    { operation: "partial", partialId: "https://private.test/asset" },
    { operation: "capabilities", signedUrl: "https://private.test" },
    { operation: "constructor" }, null, [],
  ];
  for (const body of bad) assert.equal((await f.handler(request(body))).status, 400, JSON.stringify(body));
  assert.deepEqual(f.calls, []);
});

test("request bytes, encoding and media type are bounded before authentication", async () => {
  const f = fixture();
  assert.equal((await f.handler(request({ operation: "capabilities" }, { "content-length": String(CHALLENGE_LIMITS.requestBytes + 1) }))).status, 413);
  assert.equal((await f.handler(request({ operation: "capabilities", padding: "🙂".repeat(17000) }))).status, 413);
  assert.equal((await f.handler(request({ operation: "capabilities" }, { "content-type": "text/plain" }))).status, 415);
  const invalidUtf8 = new Request("https://app.test/api/challenges", { method: "POST", headers: request({}).headers, body: new Uint8Array([0xff]) });
  assert.equal((await f.handler(invalidUtf8)).status, 400); assert.deepEqual(f.calls, []);
});

test("a stalled request body is cancelled at its deadline without authentication", async () => {
  const f = fixture(); let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"operation":')); }, cancel() { cancelled = true; } });
  const req = new Request("https://app.test/api/challenges", { method: "POST", headers: request({}).headers, body: stream, duplex: "half" } as RequestInit);
  const response = await f.handler(req); assert.equal(response.status, 408); assert.equal(cancelled, true); assert.deepEqual(f.calls, []); privateResponse(response);
});

test("tiny and empty request chunks cannot allocate an unbounded queue", async () => {
  for (const size of [0, 1]) {
    for (const small of [false, true]) {
      const f = fixture(); let chunks = 0, cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) { chunks++; controller.enqueue(new Uint8Array(size)); },
        cancel() { cancelled = true; return new Promise(() => {}); },
      });
      const req = new Request("https://app.test/api/challenges", { method: "POST", headers: request({}).headers, body: stream, duplex: "half" } as RequestInit);
      if (small) await assert.rejects(readSmallJson(req), error => error instanceof RequestValidationError && error.status === 413);
      else assert.equal((await f.handler(req)).status, 413);
      assert.equal(cancelled, true); assert.ok(chunks <= 4098); assert.deepEqual(f.calls, []);
    }
  }
});

test("every operation is rate gated before challenge construction and receives only its typed arguments", async () => {
  const f = fixture(), submission = { requestId: id(6), sources: [{ sourceIndex: 0, assetId: id(7) }] };
  const operations = [
    [{ operation: "capabilities" }, "read", 200, []],
    [{ operation: "create", projectId: id(2), challenge: challenge() }, "write", 201, [id(2), challenge()]],
    [{ operation: "view", challengeId: id(1) }, "read", 200, [id(1)]],
    [{ operation: "manage", challengeId: id(1), action: "withdraw" }, "write", 200, [id(1), "withdraw"]],
    [{ operation: "submit", challengeId: id(1), submission }, "write", 200, [id(1), submission]],
    [{ operation: "proposePartial", challengeId: id(1), partialId: id(5), contributors: [id(3)] }, "write", 201, [id(1), id(5), [id(3)]]],
    [{ operation: "partial", partialId: id(5) }, "read", 200, [id(5)]],
    [{ operation: "consentPartial", partialId: id(5), digest: partial.digest, consent: false }, "write", 200, [id(5), partial.digest, false]],
    [{ operation: "commitPartial", partialId: id(5), digest: partial.digest }, "write", 200, [id(5), partial.digest]],
  ] as const;
  for (const [body, scope, status, args] of operations) {
    f.calls.length = 0; f.values.length = 0;
    const response = await f.handler(request(body)); assert.equal(response.status, status); privateResponse(response);
    assert.deepEqual(f.calls, ["authenticate-project", `rate:${scope}`, "authenticate-challenge", ...(body.operation === "capabilities" ? [] : [body.operation])]);
    assert.deepEqual(f.values, body.operation === "capabilities" ? [] : [args]);
  }
});

test("rate and authentication denials stop before challenge access with bounded retry advice", async () => {
  const f = fixture();
  for (const delay of [7, 0, 61, Infinity]) {
    f.calls.length = 0; f.rate.rate = async () => { throw new ProjectServerError("rate_limited", 429, delay); };
    const response = await f.handler(request({ operation: "view", challengeId: id(1) }));
    assert.equal(response.status, 429); assert.equal(response.headers.get("retry-after"), String(delay === 7 ? 7 : 60)); assert.deepEqual(f.calls, ["authenticate-project"]);
  }
  f.ports.project = async () => { throw new ProjectServerError("access_denied", 401); };
  assert.equal((await f.handler(request({ operation: "capabilities" }))).status, 401);
});

test("lost access and unsupported history remain explicit without manufacturing reveal success", async () => {
  const f = fixture(); f.store.view = async () => ({ ...projection(), accessLost: true, visibleSources: [] });
  assert.equal((await (await f.handler(request({ operation: "view", challengeId: id(1) }))).json()).accessLost, true);
  f.store.view = async () => ({ id: id(1), projectId: id(2), unsupported: true, reason: "recipe_unavailable" });
  assert.equal((await (await f.handler(request({ operation: "view", challengeId: id(1) }))).json()).unsupported, true);
  f.store.partial = async () => ({ id: id(5), challengeId: id(1), unsupported: true, reason: "recipe_unavailable" });
  const legacy = await (await f.handler(request({ operation: "partial", partialId: id(5) }))).json(); assert.equal(legacy.unsupported, true); assert(!("digest" in legacy));
  f.store.commitPartial = async () => { throw new ChallengeServerError("update_required", 409); };
  assert.equal((await f.handler(request({ operation: "commitPartial", partialId: id(5), digest: partial.digest }))).status, 409);
  f.store.view = async () => { throw new ChallengeServerError("access_denied", 403); };
  assert.equal((await f.handler(request({ operation: "view", challengeId: id(1) }))).status, 403);
});

test("real challenge adapter strips private RPC extras and rejects incompatible schema behind the HTTP boundary", async () => {
  const f = fixture(); let compatible = true;
  f.ports.challenge = async token => createChallengeStore(token, env, { authenticate: async () => id(3), rpc: async name => ({ data: name === "pb_challenge_capabilities" ? { ready: true, version: compatible ? 2 : 1, recipeVersion: 1, members: 4, slots: 16, sourcesPerMember: 4, proposals: 20, challengesPerProject: 32 } : { ...projection(), hiddenSources: [id(7)], signedUrl: "https://provider.test/private", storagePath: "private/path" }, error: null }) });
  const response = await f.handler(request({ operation: "view", challengeId: id(1) }));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), projection());
  compatible = false; assert.equal((await f.handler(request({ operation: "capabilities" }))).status, 503);
});

test("unexpected and spoofed typed error details never escape the public error allowlist", async () => {
  const f = fixture();
  for (const error of [new Error("private-token and provider/path"), new ChallengeServerError("private-token", 403), new ChallengeServerError("access_denied", 200), new ProjectServerError("constructor", 503)]) {
    f.store.view = async () => { throw error; };
    const response = await f.handler(request({ operation: "view", challengeId: id(1) })); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "unavailable" }); privateResponse(response);
  }
});
