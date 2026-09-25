import test from "node:test";
import assert from "node:assert/strict";
import { createCloudProjectClient, CloudClientError, cloudSha256 } from "../lib/projects/cloud-client";
import { CLOUD_PROJECT_LIMITS, PROJECT_BUCKET } from "../lib/projects/cloud-contract";

const owner = "11111111-1111-4111-8111-111111111111", project = "22222222-2222-4222-8222-222222222222", id = "33333333-3333-4333-8333-333333333333";
const app = "https://app.example", storage = "https://storage.example", path = `${project}/${owner}/${id}`;
const json = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
function client(fetcher: typeof fetch, extra: Partial<Parameters<typeof createCloudProjectClient>[0]> = {}) {
  return createCloudProjectClient({ appOrigin: app, storageOrigin: storage, identity: () => ({ ownerId: owner, epoch: 1 }), accessToken: async () => "test-session", fetch: fetcher, ...extra });
}
test("HTTP camelCase projections are allowlisted and same-origin bearer calls omit credentials", async () => {
  const c = client(async (input, init) => {
    assert.equal(input, `${app}/api/projects`); assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-session");
    return json({ id: project, ownerId: owner, kind: "personal", title: "Private", maxBytes: CLOUD_PROJECT_LIMITS.projectBytes, createdAt: "2026-09-23T00:00:00Z", status: "active", secret: "must disappear" });
  });
  const result = await c.create({ id: project, kind: "personal", title: "Private", maxBytes: CLOUD_PROJECT_LIMITS.projectBytes });
  assert.equal(result.ownerId, owner); assert.equal("secret" in result, false);
});
test("account changes during token refresh never issue a request", async () => {
  let identity = { ownerId: owner, epoch: 1 }, fetches = 0;
  const c = client(async () => { fetches++; return json({}); }, { identity: () => identity, accessToken: async () => { identity = { ...identity, epoch: 2 }; return "old"; } });
  await assert.rejects(c.list(), (error: unknown) => error instanceof CloudClientError && error.code === "account_changed"); assert.equal(fetches, 0);
});
test("account changes during response prevent delivery and preserve account_changed", async () => {
  let identity = { ownerId: owner, epoch: 1 };
  const c = client(async () => { identity = { ...identity, epoch: 2 }; return json({ projects: [], nextCursor: null }); }, { identity: () => identity });
  await assert.rejects(c.list(), /account_changed/); await assert.rejects(c.list(), /account_changed/);
});
test("deadline bounds an uncooperative fetch and oversized/chunk-heavy JSON is rejected", async () => {
  const c = client(() => new Promise(() => undefined), { timeoutMs: 5 }); await assert.rejects(c.list(), /timeout/);
  await assert.rejects(client(async () => new Response("{}", { headers: { "content-length": "999999" } })).list(), /response_too_large/);
  let chunks = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (++chunks <= 4100) controller.enqueue(new Uint8Array([32])); else controller.close(); } });
  await assert.rejects(client(async () => new Response(stream)).list(), /response_too_large/);
});
test("upload grant must bind exact provider path and token", async () => {
  for (const signedUrl of [`https://evil.example/storage/v1/object/upload/sign/${PROJECT_BUCKET}/${path}?token=x`, `${storage}/storage/v1/object/upload/sign/${PROJECT_BUCKET}/${path}?token=x&other=y`, `${storage}/storage/v1/object/upload/sign/${PROJECT_BUCKET}/${project}/${id}/${id}?token=x`]) {
    await assert.rejects(client(async () => json({ signedUrl, token: "x", path })).mintUpload(project, id));
  }
  const c = client(async () => json({ signedUrl: `${storage}/storage/v1/object/upload/sign/${PROJECT_BUCKET}/${path}?token=x`, token: "different", path }));
  await assert.rejects(c.mintUpload(project, id));
});
test("download verifies exact bytes and SHA after fresh signed read without bearer at Storage", async () => {
  const data = new Uint8Array([1, 2, 3]), hash = await cloudSha256(data.buffer), url = `${storage}/storage/v1/object/sign/${PROJECT_BUCKET}/${path}?token=read`;
  const asset = { id, ownerId: owner, projectId: project, kind: "photo" as const, mime: "image/png" as const, bytes: 3, width: 1, height: 1, sha256: hash };
  let calls = 0;
  const c = client(async (input, init) => { calls++; if (String(input).startsWith(app)) return json({ signedUrl: url, expiresIn: 300 }); assert.equal(new Headers(init?.headers).has("authorization"), false); return new Response(data); });
  assert.deepEqual(new Uint8Array(await (await c.download(asset)).arrayBuffer()), data); assert.equal(calls, 2);
  await assert.rejects(c.download({ ...asset, sha256: "a".repeat(64) }), /integrity_failed/);
  await assert.rejects(c.download({ ...asset, bytes: 2 }), /response_too_large/);
});
test("only bounded error codes and retry delays escape HTTP errors", async () => {
  await assert.rejects(client(async () => json({ error: "rate_limited", token: "secret" }, 429, { "retry-after": "12" })).list(), (error: unknown) => error instanceof CloudClientError && error.code === "rate_limited" && error.retryAfterSeconds === 12);
  await assert.rejects(client(async () => json({ error: "secret raw database message" }, 503)).list(), /unavailable/);
});
test("PUT is fixed-path non-overwrite and a conflict never means verified success", async () => {
  const c = client(async (_, init) => { assert.equal(init?.method, "PUT"); assert.equal(new Headers(init?.headers).get("x-upsert"), "false"); return json({}, 409); });
  const asset = { id, requestId: id, kind: "photo" as const, mime: "image/png" as const, bytes: 1, width: 1, height: 1, sha256: "a".repeat(64), protection: { kind: "none" as const, id: null } };
  const result = await c.upload(project, asset, new Blob(["x"]), { signedUrl: `${storage}/storage/v1/object/upload/sign/${PROJECT_BUCKET}/${path}?token=x`, token: "x", path });
  assert.equal(result.acknowledged, false);
});
