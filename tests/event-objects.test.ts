import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createEventObjects, eventObjectLocation, EventObjectError, type EventObjectDescriptor, type EventObjectUpload } from "../lib/server/event-objects";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const origin = "https://storage.example", key = "synthetic-service-key", now = Date.parse("2026-09-23T00:00:00Z"), data = new Uint8Array([1, 2, 3]);
const image: EventObjectDescriptor = { eventId: uuid(1), submissionId: uuid(2), kind: "image" };
const upload: EventObjectUpload = { ...image, kind: "image", jobId: uuid(3), lease: uuid(4), leaseUntil: new Date(now + 120000).toISOString(), mime: "image/jpeg", bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
const response = (url: string, body: BodyInit | null, status = 200, headers?: HeadersInit) => Object.defineProperty(new Response(body, { status, headers }), "url", { value: url });
const transport = (work: (url: string, init: RequestInit) => Promise<Response> | Response): typeof fetch => async (url, init) => work(String(url), init!);
const store = (fetcher: typeof fetch, extra = {}) => createEventObjects({ origin, serviceRoleKey: key }, { fetch: fetcher, now: () => now, ...extra });

test("event descriptors derive only exact private paths and reject traversal or unsupported kinds", async () => {
  assert.deepEqual(eventObjectLocation(image), { bucket: "photobooth-events-v2", path: `${uuid(1)}/${uuid(2)}/image`, maxBytes: 2000000 });
  assert.equal(eventObjectLocation({ ...image, kind: "thumbnail" }).maxBytes, 100000);
  assert.equal(eventObjectLocation({ ...image, kind: "source" }).bucket, "photobooth-event-images-staging-v2");
  let calls = 0; const objects = store(transport(() => { calls++; throw new Error(); }));
  for (const bad of [{ ...image, eventId: "../private" }, { ...image, submissionId: "https://other.invalid" }, { ...image, kind: "voice" }]) await assert.rejects(objects.download(bad as EventObjectDescriptor), /invalid_descriptor/);
  assert.equal(calls, 0);
  for (const bad of ["http://storage.example", `${origin}/path`, `${origin}?token=x`, "https://user:secret@storage.example"]) assert.throws(() => createEventObjects({ origin: bad, serviceRoleKey: key }), /invalid_descriptor/);
});

test("derivative writes use exact lease metadata, private caching and no overwrite", async () => {
  const objects = store(transport((url, init) => {
    assert.equal(url, `${origin}/storage/v1/object/photobooth-events-v2/${uuid(1)}/${uuid(2)}/image`);
    const headers = new Headers(init.headers);
    assert.equal(init.method, "POST"); assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store"); assert.equal(init.credentials, "omit");
    assert.equal(headers.get("x-upsert"), "false"); assert.equal(headers.get("content-type"), "image/jpeg"); assert.equal(headers.get("cache-control"), "max-age=0");
    assert.deepEqual(JSON.parse(Buffer.from(headers.get("x-metadata")!, "base64").toString()), { eventJobId: uuid(3), eventLease: uuid(4) });
    assert.deepEqual(init.body, data); return response(url, "{}", 201);
  }));
  await objects.upload(upload, data);
  for (const bad of [{ ...upload, leaseUntil: new Date(now).toISOString() }, { ...upload, bytes: 4 }, { ...upload, sha256: "a".repeat(64) }, { ...upload, kind: "source" }]) await assert.rejects(objects.upload(bad as EventObjectUpload, data));
});

test("downloads and absence require exact provider status with no redirects or foreign response", async () => {
  assert.deepEqual(await store(transport(url => response(url, data))).download(image), data);
  assert.equal(await store(transport(url => response(url, "not found", 404))).download(image), null);
  for (const status of [400, 401, 403, 500]) await assert.rejects(store(transport(url => response(url, "private error", status))).download(image), /provider_failure/);
  await assert.rejects(store(transport(() => response("https://foreign.invalid", data))).download(image), /provider_failure/);
  await assert.rejects(store(transport(url => Object.defineProperty(response(url, data), "redirected", { value: true }))).download(image), /provider_failure/);
});

test("stream byte count, declared length and chunk count bound provider allocations", async () => {
  await assert.rejects(store(transport(url => response(url, data, 200, { "content-length": "2000001" }))).download(image), /object_too_large/);
  await assert.rejects(store(transport(url => response(url, data, 200, { "content-length": "4" }))).download(image), /size_mismatch/);
  await assert.rejects(store(transport(url => response(url, new Uint8Array(100001)))).download({ ...image, kind: "thumbnail" }), /object_too_large/);
  let chunks = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (++chunks <= 4097) controller.enqueue(new Uint8Array(0)); else controller.close(); } });
  await assert.rejects(store(transport(url => response(url, stream))).download(image), /object_too_large/);
});

test("provider control-response corruption is retryable and is never classified as corrupt photo bytes", async () => {
  await assert.rejects(store(transport(url => response(url, "unavailable", 503, { "content-length": "9000000" }))).download(image), /provider_failure/);
  await assert.rejects(store(transport(url => response(url, "{}", 201, { "content-length": "65537" }))).upload(upload, data), /provider_failure/);
});

test("deletion requires confirmed absence, never an unqualified400 or successful DELETE alone", async () => {
  for (const status of [200, 400, 404, 500]) {
    const objects = store(transport((url, init) => {
      if (init.method === "DELETE") { assert.deepEqual(JSON.parse(init.body as string), { prefixes: [`${uuid(1)}/${uuid(2)}/image`] }); return response(url, "[]"); }
      assert(["HEAD", "GET"].includes(init.method!)); return response(url, null, status);
    }));
    if (status === 404) assert.equal(await objects.removeAndConfirmAbsent(image), true);
    else if (status === 200) assert.equal(await objects.removeAndConfirmAbsent(image), false);
    else await assert.rejects(objects.removeAndConfirmAbsent(image), /provider_failure/);
  }
});

test("cancelled or expired requests retain their provider slot until ignored-abort work settles", async () => {
  const releases: (() => void)[] = [], abort = new AbortController();
  const objects = store(transport(url => new Promise(resolve => { releases.push(() => resolve(response(url, data))); })), { timeoutMs: 5 });
  const first = objects.download(image, abort.signal), second = objects.download(image);
  abort.abort();
  await assert.rejects(objects.download(image), (error: unknown) => error instanceof EventObjectError && error.code === "busy");
  await new Promise(resolve => setTimeout(resolve, 10));
  releases.forEach(release => release());
  await assert.rejects(first, /cancelled/); await assert.rejects(second, /deadline/);
  assert.deepEqual(await store(transport(url => response(url, data))).download(image), data);
});

test("late upload completion cannot assert success past its lease", async () => {
  let time = now;
  const objects = store(transport(url => { time += 120000; return response(url, "{}"); }), { now: () => time });
  await assert.rejects(objects.upload(upload, data), /lease_lost/);
});
