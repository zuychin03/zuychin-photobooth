import assert from "node:assert/strict";
import test from "node:test";
import { createProjectHandler, type ProjectRequestPorts } from "../lib/server/project-requests";
import { ProjectServerError, type ProjectStore } from "../lib/server/project-store";
import { CLOUD_PROJECT_LIMITS, PROJECT_BUCKET, type ProjectUploadAuthorisation } from "../lib/projects/cloud-contract";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const env = { NODE_ENV: "production", PB_CLOUD_PROJECTS_ENABLED: "true", PB_PUBLIC_ORIGIN: "https://app.test" };
const request = (body: unknown, headers: Record<string, string> = {}) => new Request("https://app.test/api/projects", { method: "POST", headers: { origin: "https://app.test", authorization: "Bearer test-access", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
function fixture() {
  const calls: string[] = [], authorisation: ProjectUploadAuthorisation = { bucket: PROJECT_BUCKET, path: `${id(1)}/${id(2)}/${id(3)}`, maxBytes: CLOUD_PROJECT_LIMITS.assetBytes, overwrite: false, mintBefore: new Date(Date.now() + 60000).toISOString(), uploadUntil: new Date(Date.now() + 7260000).toISOString(), cleanupAfter: new Date(Date.now() + 7560000).toISOString() };
  const store: ProjectStore = {
    rate: async scope => { calls.push(`rate:${scope}`); },
    list: async () => { calls.push("list"); return { projects: [], nextCursor: null }; },
    create: async value => { calls.push("create"); return { ...value, ownerId: id(2), status: "active", createdAt: new Date().toISOString() }; },
    view: async () => { calls.push("view"); throw new ProjectServerError("access_denied", 403); },
    member: async (projectId, userId, action) => { calls.push(`member:${action}`); return { projectId, userId, status: action === "invite" ? "invited" : action === "accept" ? "accepted" : "revoked" }; },
    reserve: async () => { calls.push("reserve"); throw new ProjectServerError("capacity", 409); },
    authoriseUpload: async () => { calls.push("authorise"); return authorisation; },
    resolveAsset: async assetId => { calls.push("resolve"); return { assetId, bucket: PROJECT_BUCKET, path: authorisation.path, mime: "image/png", bytes: 10, sha256: "a".repeat(64), expiresIn: 300 }; },
    enqueueFinalisation: async assetId => { calls.push("enqueue"); return { assetId, status: "queued", assetStatus: "reserved", attempts: 0, failure: null, reservedUntil: new Date().toISOString() }; },
    finalisationStatus: async assetId => { calls.push("status"); return { assetId, status: "running", assetStatus: "reserved", attempts: 1, failure: null, reservedUntil: new Date().toISOString() }; },
    delete: async () => { calls.push("delete"); return { pending: true }; },
  };
  const ports: ProjectRequestPorts = { store: async token => { assert.equal(token, "test-access"); calls.push("authenticate"); return store; }, objects: () => { calls.push("objects"); return { mintUpload: async descriptor => { assert.equal(descriptor, authorisation); calls.push("mint"); return { signedUrl: "https://provider.test/upload?token=test-only", token: "test-only", path: descriptor.path }; }, signRead: async () => { calls.push("sign"); return { signedUrl: "https://provider.test/read?token=test-only" }; } }; } };
  return { calls, store, ports, handler: createProjectHandler(ports, () => env) };
}

test("project HTTP stays unavailable before auth or provider access when disabled", async () => {
  const f = fixture(), handler = createProjectHandler(f.ports, () => ({ ...env, PB_CLOUD_PROJECTS_ENABLED: "false" }));
  const response = await handler(request({ operation: "capabilities" }));
  assert.equal(response.status, 503); assert.deepEqual(f.calls, []); assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("project HTTP rejects cross-origin, missing-token, query, actor and path injection before store creation", async () => {
  const f = fixture();
  for (const [body, headers, expected] of [[{ operation: "list" }, { origin: "https://other.test" }, 403], [{ operation: "list" }, { authorization: "" }, 401], [{ operation: "view", projectId: id(1), actorId: id(2) }, {}, 400], [{ operation: "read", assetId: id(3), path: "private/other" }, {}, 400], [{ operation: "finalise", assetId: id(3), decoded: true }, {}, 400], [{ operation: "list", limit: 51 }, {}, 400]] as const) assert.equal((await f.handler(request(body, headers))).status, expected);
  const query = new Request("https://app.test/api/projects?accessToken=not-accepted", request({ operation: "list" }));
  assert.equal((await f.handler(query)).status, 400); assert.deepEqual(f.calls, []);
});

test("bounded project request bodies reject oversized and non-JSON content", async () => {
  const f = fixture();
  assert.equal((await f.handler(request({ operation: "list", padding: "x".repeat(9000) }))).status, 413);
  assert.equal((await f.handler(request({ operation: "list" }, { "content-type": "text/plain" }))).status, 415);
  assert.deepEqual(f.calls, []);
});

test("verified actor rate checks precede both metadata reads and mutations", async () => {
  const f = fixture();
  assert.equal((await f.handler(request({ operation: "list" }))).status, 200);
  assert.deepEqual(f.calls, ["authenticate", "rate:read", "list"]); f.calls.length = 0;
  assert.equal((await f.handler(request({ operation: "create", id: id(1), kind: "friend", title: "Our memories", maxBytes: CLOUD_PROJECT_LIMITS.projectBytes }))).status, 201);
  assert.deepEqual(f.calls, ["authenticate", "rate:write", "create"]);
});

test("signed uploads and reads are minted only after exact project authorisation", async () => {
  const f = fixture();
  assert.equal((await f.handler(request({ operation: "upload", projectId: id(1), assetId: id(3) }))).status, 200);
  assert.deepEqual(f.calls, ["authenticate", "rate:upload", "authorise", "objects", "mint"]); f.calls.length = 0;
  assert.equal((await f.handler(request({ operation: "read", assetId: id(3) }))).status, 200);
  assert.deepEqual(f.calls, ["authenticate", "rate:read", "resolve", "objects", "sign", "resolve"]);
});

test("revoked or concealed assets cannot reach privileged signing", async () => {
  const f = fixture(); f.store.resolveAsset = async () => { throw new ProjectServerError("access_denied", 403); };
  assert.equal((await f.handler(request({ operation: "read", assetId: id(3) }))).status, 403);
  assert(!f.calls.includes("objects"));
});

test("finalisation and deletion acknowledge pending work without accepting decoder assertions", async () => {
  const f = fixture();
  const queued = await f.handler(request({ operation: "finalise", assetId: id(3) }));
  assert.equal(queued.status, 202); assert.equal((await queued.json()).status, "queued");
  const removed = await f.handler(request({ operation: "delete", projectId: id(1), assetId: id(3) }));
  assert.equal(removed.status, 202); assert.deepEqual(await removed.json(), { pending: true });
  assert(!f.calls.includes("objects"));
});

test("permission withdrawn while a read is being signed suppresses the provider capability", async () => {
  const f = fixture(), resolve = f.store.resolveAsset; let reads = 0;
  f.store.resolveAsset = async asset => { if (++reads > 1) throw new ProjectServerError("access_denied", 403); return resolve(asset); };
  const response = await f.handler(request({ operation: "read", assetId: id(3) }));
  assert.equal(response.status, 403); assert(!((await response.text()).includes("test-only")));
});

test("rate exhaustion prevents provider or operation calls and includes a bounded retry delay", async () => {
  const f = fixture(); f.store.rate = async () => { throw new ProjectServerError("rate_limited", 429, 7); };
  const response = await f.handler(request({ operation: "upload", projectId: id(1), assetId: id(3) }));
  assert.equal(response.status, 429); assert.equal(response.headers.get("retry-after"), "7"); assert.deepEqual(f.calls, ["authenticate"]);
});

test("unexpected provider errors never expose tokens, paths or exception details", async () => {
  const f = fixture(); f.ports.objects = () => { throw new Error("service-secret and private-path"); };
  const response = await f.handler(request({ operation: "read", assetId: id(3) }));
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "unavailable" });
});
