import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { createRetainedStripHandler, type RetainedStripRequestPorts } from "../lib/server/retained-strip-requests";
import { createRetainedStripStore, parseRetainedDescriptor, type RetainedStripDescriptor } from "../lib/server/retained-strip-store";
import { createRetainedStripObjects } from "../lib/server/retained-strip-objects";
import { createRetainedStripClient } from "../lib/memories/retained-strip-client";
import { RETAINED_STRIP_LIMITS, RetainedStripError, readRetainedBody } from "../lib/memories/retained-strip-contract";
import { inspectImageHeader } from "../lib/projects/images";
import { verifyProjectOriginal, verifyRetainedStrip } from "../lib/server/image-finalise";
import type { ProjectStorePorts } from "../lib/server/project-store";
const id = "10000000-0000-4000-8000-000000000001", owner = "10000000-0000-4000-8000-000000000002", other = "10000000-0000-4000-8000-000000000003";
const env = { PB_MEMORIES_ENABLED: "true", PB_PUBLIC_ORIGIN: "https://booth.example.test", NEXT_PUBLIC_SUPABASE_URL: "https://db.example.test", SUPABASE_SERVICE_ROLE_KEY: "fixture-service", NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME: "fixture-cloud", CLOUDINARY_API_KEY: "12345", CLOUDINARY_API_SECRET: "fixture-secret" };
const descriptor: RetainedStripDescriptor = { version: 1, id, ownerId: owner, originalCoupleId: other, storagePath: `${owner}/${id}.png`, availability: "available", archive: null };
const png = () => readFile(new URL("./fixtures/projects/b.png", import.meta.url));
const endpoint = `https://booth.example.test/api/media/strips/${id}/read`;
const request = (body: unknown = { operation: "download" }, headers: Record<string, string> = {}) => new Request(endpoint, { method: "POST", headers: { origin: env.PB_PUBLIC_ORIGIN, authorization: "Bearer fixture", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
function fixture() {
  const calls: string[] = []; let current = descriptor;
  const ports: RetainedStripRequestPorts = {
    store: async () => { calls.push("store"); return { actor: owner, rate: async () => { calls.push("rate"); }, resolve: async () => { calls.push("resolve"); return structuredClone(current); } }; },
    objects: () => ({ read: async (_d, download) => { calls.push("provider"); return download ? new Uint8Array(await png()) : null; } }),
  };
  return { ports, calls, change: (next: RetainedStripDescriptor) => { current = next; }, handler: () => createRetainedStripHandler(ports, () => env) };
}
test("retained read denies disabled, wrong origin/auth/shape before privileged work", async () => {
  const f = fixture();
  assert.equal((await createRetainedStripHandler(f.ports, () => ({ ...env, PB_MEMORIES_ENABLED: "false" }))(request(), id)).status, 503);
  for (const [input, status] of [[request({}, { origin: "https://evil.test" }), 403], [request({}, { authorization: "" }), 401], [request({ operation: "download", owner }), 400]] as const) assert.equal((await f.handler()(input, id)).status, status);
  assert.deepEqual(f.calls, []);
});
test("route verifies real PNG and rechecks descriptor before private binary response", async () => {
  const f = fixture(), response = await f.handler()(request(), id), bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "image/png"); assert.match(response.headers.get("cache-control")!, /no-store/); assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-strip-id"), id); assert.equal(response.headers.get("x-strip-sha256"), createHash("sha256").update(bytes).digest("hex")); assert.deepEqual(bytes, new Uint8Array(await png())); assert.deepEqual(f.calls, ["store", "rate", "resolve", "provider", "resolve"]);
});
test("changed source identity or revoked actor after provider read returns no image", async () => {
  for (const revoke of [false, true]) {
    const f = fixture(); let reads = 0;
    f.ports.store = async () => ({ actor: owner, rate: async () => {}, resolve: async () => { if (++reads === 2 && revoke) throw new RetainedStripError("access_denied", 403); return { ...descriptor, availability: reads === 2 ? "archive_pending" : "available" }; } });
    const response = await f.handler()(request(), id); assert.equal(response.status, revoke ? 403 : 409); assert.equal(response.headers.get("content-type"), "application/json"); assert.equal(response.headers.get("x-strip-sha256"), null);
  }
});
test("rate denial prevents provider access and retains bounded retry header", async () => {
  const f = fixture(); f.ports.store = async () => ({ actor: owner, rate: async () => { throw new RetainedStripError("rate_limited", 429, 15); }, resolve: async () => descriptor });
  const response = await f.handler()(request(), id); assert.equal(response.status, 429); assert.equal(response.headers.get("retry-after"), "15"); assert(!f.calls.includes("provider"));
});
test("store binds actor twice, rejects missing capability and path rebinding", async () => {
  let actor: string | null = owner, cap = true; const calls: Record<string, unknown>[] = [];
  const ports: ProjectStorePorts = { authenticate: async () => actor, rpc: async (name, args) => { calls.push(args); return { error: null, data: name === "pb_retained_strip_capabilities" ? cap ? { version: 1, ready: true, maximumBytes: RETAINED_STRIP_LIMITS.bytes } : {} : name === "pb_project_rate" ? { allowed: true, retryAfterSeconds: 0 } : descriptor }; } };
  const store = await createRetainedStripStore("fixture", env, ports); await store.rate(); assert.deepEqual(await store.resolve(id), descriptor); assert(calls.some(a => a.p_actor === owner && a.p_id === id));
  actor = other; await assert.rejects(store.resolve(id), /access_denied/); cap = false; await assert.rejects(createRetainedStripStore("fixture", env, ports));
  assert.throws(() => parseRetainedDescriptor({ ...descriptor, storagePath: `${other}/${id}.png` }, id));
  assert.throws(() => parseRetainedDescriptor({ ...descriptor, availability: "archived", archive: null }, id));
});
function responseAt(url: string, body: BodyInit | null, init: ResponseInit = {}) { const response = new Response(body, init); Object.defineProperty(response, "url", { value: url }); return response; }
test("Storage transport fetches only exact authorised private path with bounded PNG body", async () => {
  const bytes = await png(); let calls = 0;
  const objects = createRetainedStripObjects(env, async (input, init) => { calls++; const url = String(input); assert.equal(url, `${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/photobooth-strips/${owner}/${id}.png`); assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store"); assert(init?.signal); return responseAt(url, init?.method === "HEAD" ? null : bytes, { headers: { "content-type": "image/png", "content-length": String(bytes.length) } }); });
  assert.equal(await objects.read(descriptor, false, new AbortController().signal), null); assert.deepEqual(await objects.read(descriptor, true, new AbortController().signal), new Uint8Array(bytes)); assert.equal(calls, 2);
});
test("provider redirect, wrong MIME and over-limit body fail without following or returning bytes", async () => {
  for (const mode of ["redirect", "mime", "size"]) {
    const objects = createRetainedStripObjects(env, async input => responseAt(mode === "redirect" ? "https://evil.test" : String(input), "x", { headers: { "content-type": mode === "mime" ? "image/svg+xml" : "image/png", "content-length": mode === "size" ? String(RETAINED_STRIP_LIMITS.bytes + 1) : "1" } }));
    await assert.rejects(objects.read(descriptor, true, new AbortController().signal), /source_unavailable/);
  }
});
test("archive requires fresh exact authenticated resource and signs only private download", async () => {
  const bytes = await png(), info = inspectImageHeader(bytes), publicId = `zuychin-photobooth/${owner}/${id}`, archive = { publicId, url: `https://res.cloudinary.com/fixture-cloud/image/authenticated/v9/${publicId}.png`, verifiedAt: "2026-01-01T00:00:00Z" };
  let wrong = false, downloads = 0;
  const objects = createRetainedStripObjects(env, async (input, init) => { const url = String(input), parsed = new URL(url); assert.equal(parsed.origin, "https://api.cloudinary.com"); if (parsed.pathname.includes("/resources/")) return responseAt(url, JSON.stringify({ public_id: publicId, secure_url: archive.url, type: wrong ? "upload" : "authenticated", resource_type: "image", format: "png", version: 9, bytes: bytes.length, width: info.width, height: info.height }), { headers: { "content-type": "application/json" } }); downloads++; assert.equal(parsed.pathname, "/v1_1/fixture-cloud/image/download"); assert.equal(parsed.searchParams.get("type"), "authenticated"); assert.equal(parsed.searchParams.get("public_id"), publicId); assert.equal(init?.headers, undefined); return responseAt(url, bytes, { headers: { "content-type": "image/png", "content-length": String(bytes.length) } }); });
  assert.deepEqual(await objects.read({ ...descriptor, availability: "archived", archive }, true, new AbortController().signal), new Uint8Array(bytes)); assert.equal(downloads, 1);
  wrong = true; await assert.rejects(objects.read({ ...descriptor, availability: "archived", archive }, true, new AbortController().signal)); assert.equal(downloads, 1);
});
test("native retained verifier accepts actual PNG, rejects relabelled JPEG, corruption and oversized dimensions", async () => {
  const bytes = await png(); assert.equal((await verifyRetainedStrip(bytes)).verified.mime, "image/png");
  await assert.rejects(verifyRetainedStrip(await sharp(bytes).jpeg().toBuffer()), /invalid_image/);
  const broken = Buffer.from(bytes); broken[broken.length - 1] ^= 1; await assert.rejects(verifyRetainedStrip(broken));
  await assert.rejects(verifyRetainedStrip(await sharp({ create: { width: 4097, height: 1, channels: 3, background: "red" } }).png().toBuffer()));
});
test("browser downloads through real handler and validates immutable response digest/dimensions", async () => {
  const f = fixture(), client = createRetainedStripClient({ appOrigin: env.PB_PUBLIC_ORIGIN, identity: () => ({ ownerId: owner, epoch: 1 }), accessToken: async () => "fixture", fetch: async (_input, init) => f.handler()(request(JSON.parse(String(init?.body))), id) });
  const resolved = await client.resolve(id); assert.equal(resolved.availability, "available"); assert(!JSON.stringify(resolved).includes("cloudinary"));
  const result = await client.download(id); assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()), new Uint8Array(await png())); client.close(); await assert.rejects(client.download(id), /cancelled/);
});
test("browser rejects switched account, tampered digest and mismatched source identity", async () => {
  for (const mode of ["account", "digest", "identity"]) {
    const f = fixture(); let current = owner;
    const client = createRetainedStripClient({ appOrigin: env.PB_PUBLIC_ORIGIN, identity: () => ({ ownerId: current, epoch: 1 }), accessToken: async () => "fixture", fetch: async () => { const response = await f.handler()(request(), id); if (mode === "account") current = other; else response.headers.set(mode === "digest" ? "x-strip-sha256" : "x-strip-id", mode === "digest" ? "a".repeat(64) : other); return response; } });
    await assert.rejects(client.download(id), mode === "account" ? /account_changed/ : mode === "digest" ? /integrity_failed/ : /invalid_response/);
  }
});
test("finite client timeout and chunk ceiling abort work without retaining a read capability", async () => {
  const client = createRetainedStripClient({ appOrigin: env.PB_PUBLIC_ORIGIN, identity: () => ({ ownerId: owner, epoch: 1 }), accessToken: async () => "fixture", timeoutMs: 5, fetch: async () => new Promise<Response>(() => {}) });
  await assert.rejects(client.download(id), /timeout/);
  let cancelled = false, count = 0; const response = new Response(new ReadableStream({ pull(controller) { if (count++ < 4097) controller.enqueue(new Uint8Array([1])); else controller.close(); }, cancel() { cancelled = true; } }));
  await assert.rejects(readRetainedBody(response, RETAINED_STRIP_LIMITS.bytes, new AbortController().signal), /response_too_large/); assert.equal(cancelled, true);
});

test("cancelled callers do not release read slots while late provider work remains active", async () => {
  const f = fixture(), pending: ((value: null) => void)[] = [];
  f.ports.objects = () => ({ read: async () => new Promise<null>(resolve => { pending.push(resolve); }) });
  const abort = new AbortController(), first = f.handler()(new Request(request({ operation: "resolve" }), { signal: abort.signal }), id), second = f.handler()(request({ operation: "resolve" }), id);
  while (pending.length < 2) await new Promise(resolve => setImmediate(resolve));
  abort.abort(); assert.equal((await first).status, 408);
  assert.equal((await f.handler()(request({ operation: "resolve" }), id)).status, 503);
  pending.forEach(resolve => resolve(null)); assert.equal((await second).status, 200); await new Promise(resolve => setImmediate(resolve));
  f.ports.objects = () => ({ read: async () => null }); assert.equal((await f.handler()(request({ operation: "resolve" }), id)).status, 200);
});

test("production object adapter retains late transport work after cancellation until it can discard the response", async () => {
  let release!: (response: Response) => void, requested = "", settled = false;
  const controller = new AbortController(), objects = createRetainedStripObjects(env, async input => { requested = String(input); return new Promise<Response>(resolve => { release = resolve; }); });
  const pending = objects.read(descriptor, true, controller.signal).finally(() => { settled = true; });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  controller.abort(); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  release(responseAt(requested, await png(), { headers: { "content-type": "image/png" } })); await assert.rejects(pending); assert.equal(settled, true);
});

test("real 10–16 MiB retained PNG downloads through native server and browser without widening project limits", async () => {
  const bytes = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: "#be5267" } }).png({ compressionLevel: 0 }).toBuffer();
  assert(bytes.length > 10 * 1024 * 1024 && bytes.length < RETAINED_STRIP_LIMITS.bytes); assert.throws(() => inspectImageHeader(bytes), /10 MiB/);
  const digest = createHash("sha256").update(bytes).digest("hex"); await assert.rejects(verifyProjectOriginal(bytes, { mime: "image/png", kind: "photo", bytes: bytes.length, width: 2048, height: 2048, sha256: digest }));
  const f = fixture(); f.ports.objects = () => ({ read: async () => new Uint8Array(bytes) });
  const client = createRetainedStripClient({ appOrigin: env.PB_PUBLIC_ORIGIN, identity: () => ({ ownerId: owner, epoch: 1 }), accessToken: async () => "fixture", fetch: async () => f.handler()(request(), id) });
  const result = await client.download(id); assert.equal(result.blob.size, bytes.length); assert.equal(result.width, 2048); assert.equal(result.height, 2048); assert.equal(result.sha256, digest);
});
