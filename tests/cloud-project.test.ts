import assert from "node:assert/strict";
import test from "node:test";
import { CLOUD_PROJECT_LIMITS, PROJECT_BUCKET, validateCloudAsset } from "../lib/projects/cloud-contract";
import { createProjectStore, createProjectFinalisationStore, ProjectServerError, type ProjectStorePorts } from "../lib/server/project-store";
const actor = "11111111-1111-4111-8111-111111111111", project = "22222222-2222-4222-8222-222222222222", asset = "33333333-3333-4333-8333-333333333333";
const env = { PB_CLOUD_PROJECTS_ENABLED: "true", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "fixture-not-a-secret" };
const input = () => ({ id: asset, requestId: project, kind: "photo" as const, mime: "image/png" as const, bytes: 100, width: 20, height: 20, sha256: "a".repeat(64), protection: { kind: "none" as const, id: null } });
const ready = { version: 1, ready: true, members: 4, files: 24, projectBytes: CLOUD_PROJECT_LIMITS.projectBytes, readSeconds: 300, uploadSeconds: 7200, finalisationVersion: 1, apiVersion: 1 };
function fixture() {
  const calls: { name: string; args: Record<string, unknown> }[] = []; let authenticated: string | null = actor, response: unknown = {}, authCalls = 0;
  const ports: ProjectStorePorts = { authenticate: async () => { authCalls++; return authenticated; }, rpc: async (name, args) => { calls.push({ name, args }); return { data: name === "pb_project_capabilities" ? ready : response, error: null }; } };
  return { calls, ports, setActor(value: string | null) { authenticated = value; }, response(value: unknown) { response = value; }, get authCalls() { return authCalls; } };
}
test("cloud projects fail closed before auth or RPC when disabled or misconfigured", async () => {
  const f = fixture();
  for (const bad of [{ ...env, PB_CLOUD_PROJECTS_ENABLED: "false" }, { ...env, SUPABASE_SERVICE_ROLE_KEY: "" }, { ...env, NEXT_PUBLIC_SUPABASE_URL: "http://foreign.invalid" }]) await assert.rejects(createProjectStore("fixture-token", bad, f.ports), /unavailable/);
  assert.equal(f.authCalls, 0); assert.equal(f.calls.length, 0);
  f.setActor(null); await assert.rejects(createProjectStore("invalid-fixture", env, f.ports), /access_denied/); assert.equal(f.calls.length, 0);
});
test("asset validation rejects unknown protection, URLs, accessors, dimensions and decorative MIME", () => {
  assert.deepEqual(validateCloudAsset(input()), input());
  for (const bad of [{ ...input(), url: "https://example.invalid" }, { ...input(), protection: { kind: "public", id: null } }, { ...input(), bytes: 0 }, { ...input(), width: 4097 }, { ...input(), width: 4096, height: 4096 }, { ...input(), kind: "decoration", mime: "image/jpeg" }]) assert.throws(() => validateCloudAsset(bad), /invalid_request/);
  let read = false; const accessor = { ...input(), get bytes() { read = true; return 100; } }; assert.throws(() => validateCloudAsset(accessor)); assert.equal(read, false);
});
test("verified actor is bound independently of a request payload and reserve is validated before RPC", async () => {
  const f = fixture(), store = await createProjectStore("fixture-token", env, f.ports);
  f.response({ ...input(), project_id: project, owner_id: actor, request_id: project, status: "reserved", reserved_until: "2030-01-01T00:00:00Z" });
  await store.reserve(project, input()); assert.equal(f.calls.at(-1)?.args.p_actor, actor);
  assert.throws(() => store.reserve(project, { ...input(), owner: project } as never)); assert.equal(f.calls.length, 2);
  assert.throws(() => store.reserve(project, { ...input(), protection: { kind: "challenge", id: asset } }), /protected_unavailable/); assert.equal(f.calls.length, 2);
  f.response({ project_id: project, user_id: project, status: "accepted" });
  await store.member(project, project, "accept"); assert.equal(f.calls.at(-1)?.args.p_actor, actor);
});
test("resolver returns only validated private descriptors and preserves denied results", async () => {
  const f = fixture(), store = await createProjectStore("fixture-token", env, f.ports);
  const descriptor = { assetId: asset, bucket: PROJECT_BUCKET, path: `${project}/${actor}/${asset}`, bytes: 100, mime: "image/png", sha256: "a".repeat(64), expiresIn: 300 };
  f.response(descriptor); assert.deepEqual(await store.resolveAsset(asset), descriptor);
  f.response({ ...descriptor, unrelatedPrivateMetadata: "must not escape" }); assert.deepEqual(await store.resolveAsset(asset), descriptor);
  for (const bad of [{ ...descriptor, bucket: "photobooth-strips" }, { ...descriptor, path: `../${asset}` }, { ...descriptor, expiresIn: 3600 }]) { f.response(bad); await assert.rejects(store.resolveAsset(asset)); }
  f.ports.rpc = async () => ({ data: null, error: { message: "PB_PROJECT_DENIED" } }); await assert.rejects(store.resolveAsset(asset), /access_denied/);
});
test("a missing or incompatible migration cannot produce a writable store", async () => {
  const f = fixture(); f.ports.rpc = async () => ({ data: { ...ready, version: 2 }, error: null });
  await assert.rejects(createProjectStore("fixture-token", env, f.ports), /unavailable/);
  f.ports.rpc = async () => ({ data: { ...ready, apiVersion: undefined }, error: null });
  await assert.rejects(createProjectStore("fixture-token", env, f.ports), /unavailable/);
});

test("durable rate requests bind authenticated actor and preserve a bounded retry delay", async () => {
  const f = fixture(), store = await createProjectStore("fixture-token", env, f.ports);
  f.response({ allowed: true, retryAfterSeconds: 0 });
  for (const operation of ["read", "write", "upload"] as const) { await store.rate(operation); assert.deepEqual(f.calls.at(-1)?.args, { p_actor: actor, p_operation: operation }); }
  f.response({ allowed: false, retryAfterSeconds: 37 });
  await assert.rejects(store.rate("upload"), error => error instanceof ProjectServerError && error.code === "rate_limited" && error.status === 429 && error.retryAfterSeconds === 37);
  for (const data of [{ allowed: true, retryAfterSeconds: 1 }, { allowed: false, retryAfterSeconds: 0 }, { allowed: false, retryAfterSeconds: 61 }, { allowed: false, retryAfterSeconds: "5" }, {}]) { f.response(data); await assert.rejects(store.rate("read"), /unavailable/); }
  const before = f.calls.length; await assert.rejects(store.rate("admin" as never), /invalid_request/); assert.equal(f.calls.length, before);
});

test("project discovery binds actor and returns minimal accepted/invited pages with stable keyset cursors", async () => {
  const f = fixture(), store = await createProjectStore("fixture-token", env, f.ports);
  const item = { id: project, ownerId: asset, kind: "friend", title: "Invitation", createdAt: "2030-01-01T00:00:00Z", membership: "invited" };
  f.response({ projects: [{ ...item, assets: ["concealed"], members: ["secret"] }], nextCursor: project });
  assert.deepEqual(await store.list(undefined, 1), { projects: [item], nextCursor: project });
  assert.deepEqual(f.calls.at(-1)?.args, { p_actor: actor, p_after: null, p_limit: 1 });
  f.response({ projects: [{ ...item, id: asset, ownerId: actor, membership: "accepted" }], nextCursor: null });
  assert.equal((await store.list(project, 1)).projects[0].id, asset);
  assert.deepEqual(f.calls.at(-1)?.args, { p_actor: actor, p_after: project, p_limit: 1 });
  for (const invalid of [{ projects: [item], nextCursor: asset }, { projects: [item, item], nextCursor: null }, { projects: [{ ...item, membership: "revoked" }], nextCursor: null }, { projects: [{ ...item, ownerId: actor }], nextCursor: null }]) { f.response(invalid); await assert.rejects(store.list(), /unavailable/); }
  f.response({ projects: [item], nextCursor: null }); await assert.rejects(store.list(project), /unavailable/);
  const before = f.calls.length; await assert.rejects(store.list("not-a-cursor"), /invalid_request/); await assert.rejects(store.list(undefined, 51), /invalid_request/); assert.equal(f.calls.length, before);
});
test("upload mint envelope is bound to project, verified author, asset, no-overwrite and safe deadlines", async () => {
  const f = fixture(), store = await createProjectStore("fixture-token", env, f.ports), now = Date.now();
  const valid = { bucket: PROJECT_BUCKET, path: `${project}/${actor}/${asset}`, maxBytes: 100, overwrite: false, mintBefore: new Date(now + 30000).toISOString(), uploadUntil: new Date(now + 7230000).toISOString(), cleanupAfter: new Date(now + 7530000).toISOString() };
  f.response({ ...valid, extraneous: "do not forward" }); assert.deepEqual(await store.authoriseUpload(project, asset), valid);
  for (const bad of [{ ...valid, bucket: "photobooth-strips" }, { ...valid, path: `${actor}/${actor}/${asset}` }, { ...valid, path: `${project}/${project}/${asset}` }, { ...valid, overwrite: true }, { ...valid, maxBytes: CLOUD_PROJECT_LIMITS.assetBytes + 1 }, { ...valid, mintBefore: new Date(now - 1).toISOString() }, { ...valid, mintBefore: "tomorrow" }, { ...valid, uploadUntil: new Date(now + 7230001).toISOString() }, { ...valid, cleanupAfter: new Date(now + 7230000).toISOString() }]) {
    f.response(bad); await assert.rejects(store.authoriseUpload(project, asset), /unavailable/);
  }
  f.ports.rpc = async () => ({ data: null, error: { message: "PB_PROJECT_DENIED" } }); await assert.rejects(store.authoriseUpload(project, asset), /access_denied/);
});

test("project and reservation projections allowlist fields and reject wrong identities", async () => {
  const f = fixture(), store = await createProjectStore("fixture-token", env, f.ports);
  const summary = { id: project, owner_id: actor, kind: "friend", title: "Fixture", max_bytes: CLOUD_PROJECT_LIMITS.projectBytes, status: "active", created_at: "2030-01-01T00:00:00Z" };
  f.response({ ...summary, internal: "private" });
  const created = await store.create({ id: project, kind: "friend", title: "Fixture", maxBytes: CLOUD_PROJECT_LIMITS.projectBytes });
  assert.equal(created.ownerId, actor); assert(!("internal" in created));
  f.response({ ...summary, owner_id: asset }); await assert.rejects(store.create({ id: project, kind: "friend", title: "Fixture", maxBytes: CLOUD_PROJECT_LIMITS.projectBytes }), /unavailable/);
  f.response({ project: summary, members: [{ userId: actor, status: "accepted" }], assets: [{ ...input(), ownerId: actor }], concealed: "not returned" });
  const view = await store.view(project); assert.equal(view.assets[0].id, asset); assert(!("concealed" in view)); assert(!("protection" in view.assets[0]));
  f.response({ project: { ...summary, id: asset }, members: [{ userId: actor, status: "accepted" }], assets: [] }); await assert.rejects(store.view(project), /unavailable/);
  const reservation = { ...input(), project_id: project, owner_id: actor, request_id: project, status: "reserved", reserved_until: "2030-01-01T00:00:00Z", path: "private path", fingerprint: { hidden: true } };
  f.response(reservation); const saved = await store.reserve(project, input()); assert(!("path" in saved)); assert(!("fingerprint" in saved));
  f.response({ ...reservation, sha256: "b".repeat(64) }); await assert.rejects(store.reserve(project, input()), /unavailable/);
});

test("enqueue/status bind the verified actor and expose no worker leases", async () => {
  const f = fixture(), store = await createProjectStore("fixture-token", env, f.ports);
  const status = { assetId: asset, status: "queued", assetStatus: "reserved", attempts: 0, failure: null, reservedUntil: "2030-01-01T00:00:00Z" };
  f.response({ ...status, leaseToken: project, path: "private" }); assert.deepEqual(await store.enqueueFinalisation(asset), status);
  assert.deepEqual(f.calls.at(-1)?.args, { p_actor: actor, p_asset: asset });
  f.response({ ...status, assetId: project }); await assert.rejects(store.finalisationStatus(asset), /unavailable/);
  f.response({ ...status, attempts: 9 }); await assert.rejects(store.finalisationStatus(asset), /unavailable/);
});

test("worker claims validate metadata, paths, lease bounds and failed/empty outcomes", async () => {
  const f = fixture(), worker = await createProjectFinalisationStore(env, f.ports), now = Date.now();
  const descriptor = { ...input(), assetId: asset, projectId: project, ownerId: actor, bucket: PROJECT_BUCKET, path: `${project}/${actor}/${asset}`, reservedUntil: new Date(now + 600000).toISOString(), leaseUntil: new Date(now + 60000).toISOString(), leaseToken: project, attempts: 1 };
  f.response({ ...descriptor, secret: "not returned" }); const claim = await worker.claim(); assert(claim); assert(!("secret" in claim));
  for (const bad of [{ ...descriptor, bucket: "public" }, { ...descriptor, path: `${project}/${project}/${asset}` }, { ...descriptor, leaseUntil: new Date(now - 1).toISOString() }, { ...descriptor, leaseUntil: new Date(now + 700000).toISOString() }, { ...descriptor, width: 4097 }, { ...descriptor, attempts: 9 }]) { f.response(bad); await assert.rejects(worker.claim(), /unavailable/); }
  f.response({}); assert.equal(await worker.claim(), null);
  const status = { assetId: asset, status: "complete", assetStatus: "ready", attempts: 1, failure: null, reservedUntil: descriptor.reservedUntil };
  f.response(status);
  const verified = { mime: input().mime, bytes: 100, width: 20, height: 20, sha256: input().sha256, decoded: true as const };
  const before = f.calls.length;
  await assert.rejects(worker.finish(claim, { kind: "verified", verified: { ...verified, width: 21 } }), /invalid_request/); assert.equal(f.calls.length, before);
  assert.deepEqual(await worker.finish(claim, { kind: "verified", verified }), status);
  assert.deepEqual(f.calls.at(-1)?.args, { p_asset: asset, p_lease: project, p_outcome: "verified", p_verified: verified });
  f.response({ ...status, status: "failed", assetStatus: "reserved", failure: "access_lost" }); assert.equal((await worker.finish(claim, { kind: "retry" })).status, "failed");
  f.ports.rpc = async () => ({ data: null, error: { message: "PB_PROJECT_LEASE" } }); await assert.rejects(worker.finish(claim, { kind: "retry" }), /lease_lost/);
});

test("maintenance validates cleanup identity and never converts unknown absence into success", async () => {
  const f = fixture(), worker = await createProjectFinalisationStore(env, f.ports);
  const raw = { asset_id: asset, bucket: PROJECT_BUCKET, path: `${project}/${actor}/${asset}`, lease_token: project, lease_until: new Date(Date.now() + 60000).toISOString(), attempts: 2, status: "running", confirmed_absent: false };
  f.response({ ...raw, private: "not returned" }); const claim = await worker.claimCleanup(); assert(claim); assert(!("private" in claim));
  for (const bad of [{ ...raw, path: `${project}/${actor}/${project}` }, { ...raw, status: "complete" }, { ...raw, confirmed_absent: true }, { ...raw, lease_until: "2000-01-01T00:00:00Z" }]) { f.response(bad); await assert.rejects(worker.claimCleanup(), /unavailable/); }
  const before = f.calls.length; await assert.rejects(worker.finishCleanup(claim, null as never), /invalid_request/); assert.equal(f.calls.length, before);
  f.response({ complete: false }); assert.deepEqual(await worker.finishCleanup(claim, false), { complete: false });
  assert.deepEqual(f.calls.at(-1)?.args, { p_asset: asset, p_lease: project, p_confirmed_absent: false });
  f.response({ complete: true }); await assert.rejects(worker.finishCleanup(claim, false), /unavailable/);
  f.response({ expired: 2 }); assert.deepEqual(await worker.sweep(2), { expired: 2 });
  f.response({ expired: 3 }); await assert.rejects(worker.sweep(2), /unavailable/); await assert.rejects(worker.sweep(26), /invalid_request/);
});
