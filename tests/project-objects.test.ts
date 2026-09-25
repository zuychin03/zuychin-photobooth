import test from "node:test";
import assert from "node:assert/strict";
import { createProjectObjects, ProjectObjectError, type ProjectObjectDescriptor } from "../lib/server/project-objects";
import { CLOUD_PROJECT_LIMITS, PROJECT_BUCKET, type ProjectUploadAuthorisation, type ProjectAssetAccess } from "../lib/projects/cloud-contract";

const origin = "https://project.example", key = "test-service-key";
const ids = ["10000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002", "30000000-0000-4000-8000-000000000003"];
const path = ids.join("/"), object: ProjectObjectDescriptor = { bucket: PROJECT_BUCKET, path }, baseTime = Date.parse("2026-09-23T00:00:00Z");
const upload: ProjectUploadAuthorisation = { ...object, maxBytes: 123, overwrite: false, mintBefore: new Date(baseTime + 60_000).toISOString(), uploadUntil: new Date(baseTime + 60_000 + 7_200_000).toISOString(), cleanupAfter: new Date(baseTime + 60_000 + 7_200_000 + 300_000).toISOString() };
const access: ProjectAssetAccess = { ...object, assetId: ids[2], bytes: 3, mime: "image/png", sha256: "a".repeat(64), expiresIn: 300 };
function response(url: string, body: BodyInit | null, status = 200, headers?: HeadersInit): Response {
  return Object.defineProperty(new Response(body, { status, headers }), "url", { value: url });
}
function transport(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input, init) => handler(String(input), init!)) as typeof fetch;
}
const rejects = (work: Promise<unknown>, code: ProjectObjectError["code"]) => assert.rejects(work, error => error instanceof ProjectObjectError && error.code === code && error.message === code);

test("project objects mint exact non-overwriting provider upload and five-minute read URLs", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const store = createProjectObjects({ origin, serviceRoleKey: key }, { now: () => baseTime, fetch: transport((url, init) => {
    calls.push({ url, init });
    const endpoint = new URL(url).pathname.replace("/storage/v1", "");
    return response(url, JSON.stringify(url.includes("upload/sign") ? { url: `${endpoint}?token=upload-token` } : { signedURL: `${endpoint}?token=read-token` }));
  }) });
  assert.deepEqual(await store.mintUpload(upload), { signedUrl: `${origin}/storage/v1/object/upload/sign/${PROJECT_BUCKET}/${path}?token=upload-token`, token: "upload-token", path });
  assert.deepEqual(await store.signRead(access), { signedUrl: `${origin}/storage/v1/object/sign/${PROJECT_BUCKET}/${path}?token=read-token` });
  for (const call of calls) {
    assert.equal(call.init.redirect, "error"); assert.equal(call.init.cache, "no-store"); assert.equal(call.init.method, "POST");
    assert.equal(new Headers(call.init.headers).get("authorization"), `Bearer ${key}`);
    assert.equal(new Headers(call.init.headers).get("x-upsert"), null);
  }
  assert.equal(calls[0].init.body, "{}"); assert.deepEqual(JSON.parse(calls[1].init.body as string), { expiresIn: 300 });
});

test("project objects reject untrusted configuration and descriptors before network activity", async () => {
  for (const url of ["https://user:password@project.example", `${origin}/storage`, `${origin}?token=x`, "http://project.example"]) assert.throws(() => createProjectObjects({ origin: url, serviceRoleKey: key }), ProjectObjectError);
  let calls = 0;
  const store = createProjectObjects({ origin, serviceRoleKey: key }, { now: () => baseTime, fetch: transport(() => { calls++; throw new Error(); }) });
  for (const bad of [{ ...object, bucket: "another" }, { ...object, path: `${path}/../other` }, { ...object, path: path.replace(ids[0], "%2e%2e") }, { ...object, path: `https://other/${path}` }]) await rejects(store.download(bad as typeof object), "invalid_descriptor");
  await rejects(store.signRead({ ...access, expiresIn: 301 }), "invalid_descriptor");
  await rejects(store.signRead({ ...access, assetId: ids[0] }), "invalid_descriptor");
  await rejects(store.mintUpload({ ...upload, overwrite: true } as unknown as ProjectUploadAuthorisation), "invalid_descriptor");
  assert.equal(calls, 0);
});

test("mint expiry is checked before dispatch and after a late successful provider result", async () => {
  let time = baseTime, calls = 0;
  const store = createProjectObjects({ origin, serviceRoleKey: key }, { now: () => time, fetch: transport(url => { calls++; time += 60_000; return response(url, JSON.stringify({ url: `/object/upload/sign/${PROJECT_BUCKET}/${path}?token=secret` })); }) });
  await rejects(store.mintUpload(upload), "mint_expired"); assert.equal(calls, 1);
  await rejects(store.mintUpload(upload), "mint_expired"); assert.equal(calls, 1);
});

test("signed provider results reject foreign origin, wrong path, fragments and missing or duplicate tokens", async () => {
  const validPath = `/storage/v1/object/sign/${PROJECT_BUCKET}/${path}`;
  for (const signedURL of [`https://attacker.example${validPath}?token=x`, `${origin}${validPath}x?token=x`, `${origin}${validPath}?token=x#secret`, `${origin}${validPath}`, `${origin}${validPath}?token=`, `${origin}${validPath}?token=x&token=y`, `${origin}${validPath}?token=x&download=true`, `${origin}${validPath}?token=%0A`]) {
    const store = createProjectObjects({ origin, serviceRoleKey: key }, { fetch: transport(url => response(url, JSON.stringify({ signedURL }))) });
    await rejects(store.signRead(access), "provider_failure");
  }
});

test("provider signing JSON is bounded and malformed responses never expose capabilities", async () => {
  for (const body of ["not JSON", "[]", JSON.stringify({ signedURL: "x".repeat(65 * 1024) })]) {
    const store = createProjectObjects({ origin, serviceRoleKey: key }, { fetch: transport(url => response(url, body)) });
    await assert.rejects(store.signRead(access), error => error instanceof ProjectObjectError && ["provider_failure", "object_too_large"].includes(error.code));
  }
});

test("failed provider deletion cannot be mistaken for confirmed absence", async () => {
  let calls = 0;
  const store = createProjectObjects({ origin, serviceRoleKey: key }, { fetch: transport(url => { calls++; return response(url, "uncertain", 500); }) });
  await rejects(store.removeAndConfirmAbsent(object), "provider_failure"); assert.equal(calls, 1);
});

test("download reads bounded chunks and verifies optional exact size and Content-Length", async () => {
  const store = createProjectObjects({ origin, serviceRoleKey: key }, { fetch: transport(url => response(url, new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close(); } }), 200, { "content-length": "3" })) });
  assert.deepEqual(await store.download({ ...object, bytes: 3 }), new Uint8Array([1, 2, 3]));
  await rejects(store.download({ ...object, bytes: 4 }), "size_mismatch");
  const wrongLength = createProjectObjects({ origin, serviceRoleKey: key }, { fetch: transport(url => response(url, new Uint8Array([1]), 200, { "content-length": "2" })) });
  await rejects(wrongLength.download(object), "size_mismatch");
});

test("oversized Content-Length is rejected before pulling body and oversized chunked streams are cancelled", async () => {
  let pulls = 0, cancelled = 0;
  const store = createProjectObjects({ origin, serviceRoleKey: key }, { fetch: transport(url => response(url, new ReadableStream({ pull() { pulls++; }, cancel() { cancelled++; } }, { highWaterMark: 0 }), 200, { "content-length": String(CLOUD_PROJECT_LIMITS.assetBytes + 1) })) });
  await rejects(store.download(object), "object_too_large"); assert.equal(pulls, 0); assert.equal(cancelled, 1);
  const streamed = createProjectObjects({ origin, serviceRoleKey: key }, { fetch: transport(url => response(url, new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(2)); }, cancel() { cancelled++; } }, { highWaterMark: 0 }))) });
  await rejects(streamed.download({ ...object, bytes: 3 }), "object_too_large"); assert.equal(cancelled, 2);
});

test("redirects, changed response origins and provider exception secrets fail with sanitised errors", async () => {
  for (const make of [(url: string) => response(url, null, 302, { Location: "https://other.example" }), () => response("https://other.example", "private"), () => { throw new Error(`provider leaked ${key}`); }]) {
    const store = createProjectObjects({ origin, serviceRoleKey: key }, { fetch: transport(make) });
    await rejects(store.download(object), "provider_failure");
  }
});

test("delete does not accept unqualified HEAD400 or provider failure as absence", async () => {
  for (const status of [200, 400, 401, 403, 404, 429, 500]) {
    const calls: { url: string; init: RequestInit }[] = [];
    const store = createProjectObjects({ origin, serviceRoleKey: key }, { fetch: transport((url, init) => { calls.push({ url, init }); return response(url, init.method === "DELETE" ? "[]" : null, init.method === "DELETE" ? 200 : status); }) });
    if (status === 200 || status === 404) assert.equal(await store.removeAndConfirmAbsent(object), status === 404);
    else await rejects(store.removeAndConfirmAbsent(object), "provider_failure");
    assert.equal(calls.length, status === 400 ? 3 : 2); assert.equal(calls[1].init.method, "HEAD"); assert.equal(calls[1].url, `${origin}/storage/v1/object/${PROJECT_BUCKET}/${path}`);
    assert.deepEqual(JSON.parse(calls[0].init.body as string), { prefixes: [path] });
    assert.equal(new Headers(calls[1].init.headers).get("authorization"), `Bearer ${key}`);
  }
});

test("ten-second deadline aborts and cancels a stalled body instead of publishing a late result", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false, signal: AbortSignal | undefined;
  const store = createProjectObjects({ origin, serviceRoleKey: key }, { fetch: transport((url, init) => { signal = init.signal!; return response(url, new ReadableStream({ cancel() { cancelled = true; } })); }) });
  const promise = store.download(object), assertion = rejects(promise, "deadline");
  await Promise.resolve(); await Promise.resolve(); t.mock.timers.tick(10_000); await assertion;
  assert.equal(signal?.aborted, true); assert.equal(cancelled, true);
});

test("ten-second deadline rejects a transport that ignores abort and discards its late response", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish!: (response: Response) => void, cancelled = false, requested = "";
  const store = createProjectObjects({ origin, serviceRoleKey: key }, { fetch: transport(url => { requested = url; return new Promise(resolve => { finish = resolve; }); }) });
  const assertion = rejects(store.download(object), "deadline"); t.mock.timers.tick(10_000); await assertion;
  finish(response(requested, new ReadableStream({ cancel() { cancelled = true; } })));
  await Promise.resolve(); await Promise.resolve(); assert.equal(cancelled, true);
});
