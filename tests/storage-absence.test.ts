import test from "node:test";
import assert from "node:assert/strict";
import { isStorageObjectAbsent } from "../lib/server/storage-absence";
import { createEventObjects } from "../lib/server/event-objects";
import { createProjectObjects } from "../lib/server/project-objects";
import { createVoiceObjects } from "../lib/server/voice-objects";

const missing = { code: "NoSuchKey", error: "not_found", message: "Object not found", statusCode: "404" };
const json = (value: unknown = missing, status = 400) => Response.json(value, { status });
const origin = "https://storage.example", key = "synthetic-service-key";
const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];

test("Storage legacy400 absence requires the exact bounded NoSuchKey semantic404 envelope", async () => {
  assert.equal(await isStorageObjectAbsent(json()), true);
  assert.equal(await isStorageObjectAbsent(new Response(null, { status: 404 })), true);
  for (const status of [200, 401, 403, 429, 500, 503]) assert.equal(await isStorageObjectAbsent(json(missing, status)), false);
  for (const value of [{ ...missing, code: "NoSuchBucket" }, { ...missing, code: "AccessDenied" }, { ...missing, statusCode: "403" }, { ...missing, statusCode: 404 }, { ...missing, error: "unauthorized" }, { ...missing, message: "Permission denied" }, { ...missing, extra: true }, [], null]) assert.equal(await isStorageObjectAbsent(json(value)), false);
  for (const body of ["{bad", " ".repeat(4097), new Uint8Array([255, 254])]) assert.equal(await isStorageObjectAbsent(new Response(body, { status: 400, headers: { "content-type": "application/json" } })), false);
  assert.equal(await isStorageObjectAbsent(new Response(JSON.stringify(missing), { status: 400, headers: { "content-type": "text/plain" } })), false);
  for (const length of ["9000", "invalid", "1"]) assert.equal(await isStorageObjectAbsent(new Response(JSON.stringify(missing), { status: 400, headers: { "content-type": "application/json", "content-length": length } })), false);
});

test("Storage absence parsing bounds tiny chunks and aborts without certifying absence", async () => {
  let cancelled = false, chunks = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { chunks++; controller.enqueue(new Uint8Array(0)); }, cancel() { cancelled = true; } });
  assert.equal(await isStorageObjectAbsent(new Response(stream, { status: 400, headers: { "content-type": "application/json" } })), false);
  assert(cancelled); assert(chunks <= 66);
  const controller = new AbortController(), stalled = new ReadableStream<Uint8Array>({});
  const pending = isStorageObjectAbsent(new Response(stalled, { status: 400, headers: { "content-type": "application/json" } }), controller.signal);
  controller.abort(); await assert.rejects(pending);
});

function adapters(fetcher: typeof fetch) {
  return [
    () => createEventObjects({ origin, serviceRoleKey: key }, { fetch: fetcher }).removeAndConfirmAbsent({ eventId: ids[0], submissionId: ids[1], kind: "image" }),
    () => createProjectObjects({ origin, serviceRoleKey: key }, { fetch: fetcher }).removeAndConfirmAbsent({ bucket: "photobooth-projects-v2", path: ids.join("/") }),
    () => createVoiceObjects({ NEXT_PUBLIC_SUPABASE_URL: origin, SUPABASE_SERVICE_ROLE_KEY: key }, fetcher).remove({ actor: ids[0], activityId: ids[1], generation: ids[2], path: `${ids[0]}/${ids[1]}/${ids[2]}.wav`, samples: 1, bytes: 46, sha256: "a".repeat(64) }),
  ];
}
function fetcher(get: () => Response, calls: string[]): typeof fetch {
  return async (input, init) => {
    const url = String(input); calls.push(init!.method!);
    assert.equal(new Headers(init!.headers).get("authorization"), `Bearer ${key}`); assert.equal(init!.redirect, "error");
    const response = init!.method === "DELETE" ? Response.json([]) : init!.method === "HEAD" ? new Response(null, { status: 400 }) : get();
    if (init!.method === "GET") assert(new URL(url).pathname.startsWith("/storage/v1/object/authenticated/"));
    return Object.defineProperty(response, "url", { value: url });
  };
}

test("all three cleanup adapters confirm legacy400 through one authenticated GET after DELETE and HEAD", async () => {
  const calls: string[] = [];
  for (const remove of adapters(fetcher(() => json(), calls))) { assert.equal(await remove(), true); assert.deepEqual(calls.splice(0), ["DELETE", "HEAD", "GET"]); }
  for (const remove of adapters(fetcher(() => json({ ...missing, code: "NoSuchBucket" }), calls))) await assert.rejects(remove());
  for (const remove of adapters(fetcher(() => json(missing, 403), calls))) await assert.rejects(remove());
});

test("cleanup absence probes use a fresh cacheNonce without changing the exact object path", async () => {
  const nonces = new Set<string>();
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, origin);
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${key}`);
    if (init?.method === "GET") {
      assert.deepEqual([...url.searchParams.keys()], ["cacheNonce"]);
      const nonce = url.searchParams.get("cacheNonce")!;
      assert.match(nonce, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      assert(!nonces.has(nonce)); nonces.add(nonce);
      assert([
        `/storage/v1/object/authenticated/photobooth-events-v2/${ids[0]}/${ids[1]}/image`,
        `/storage/v1/object/authenticated/photobooth-projects-v2/${ids.join("/")}`,
        `/storage/v1/object/authenticated/photobooth-voice-captions/${ids.join("/")}.wav`,
      ].includes(url.pathname));
    } else assert.equal(url.search, "");
    const response = init?.method === "DELETE" ? Response.json([]) : init?.method === "HEAD" ? new Response(null, { status: 400 }) : json();
    return Object.defineProperty(response, "url", { value: url.href });
  };
  for (const remove of adapters(transport)) { assert.equal(await remove(), true); assert.equal(await remove(), true); }
  assert.equal(nonces.size, 6);
});

test("cleanup refuses a missing or changed response nonce and redirects before certifying absence", async () => {
  for (const change of ["missing", "changed", "redirected"] as const) {
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const response = init?.method === "DELETE" ? Response.json([]) : init?.method === "HEAD" ? new Response(null, { status: 400 }) : json();
      if (init?.method === "GET") {
        if (change === "missing") url.search = "";
        if (change === "changed") url.searchParams.set("cacheNonce", "different");
        if (change === "redirected") Object.defineProperty(response, "redirected", { value: true });
      }
      return Object.defineProperty(response, "url", { value: url.href });
    };
    for (const remove of adapters(transport)) await assert.rejects(remove());
  }
});

test("cleanup presence probes cancel200 bodies without downloading remaining originals", async () => {
  let cancelled = 0;
  const transport = fetcher(() => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }), { headers: { "content-length": "2000000000" } }), []);
  for (const remove of adapters(transport)) assert.equal(await remove(), false);
  assert.equal(cancelled, 3);
});

test("ordinary object reads retain their original URLs without cleanup nonces", async () => {
  let reads = 0;
  const data = new Uint8Array(46);
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.method, "GET"); assert.equal(url.search, ""); reads++;
    return Object.defineProperty(new Response(data, { headers: { "content-length": String(data.length) } }), "url", { value: url.href });
  };
  assert.deepEqual(await createEventObjects({ origin, serviceRoleKey: key }, { fetch: transport }).download({ eventId: ids[0], submissionId: ids[1], kind: "source" }), data);
  assert.deepEqual(await createProjectObjects({ origin, serviceRoleKey: key }, { fetch: transport }).download({ bucket: "photobooth-projects-v2", path: ids.join("/"), bytes: data.length }), data);
  assert.deepEqual(await createVoiceObjects({ NEXT_PUBLIC_SUPABASE_URL: origin, SUPABASE_SERVICE_ROLE_KEY: key }, transport).read({ actor: ids[0], activityId: ids[1], generation: ids[2], path: `${ids.join("/")}.wav`, samples: 1, bytes: data.length, sha256: "a".repeat(64) }), data);
  assert.equal(reads, 3);
});

test("event derivative preflight recognises missing legacy400 but does not convert provider corruption into an invalid photo", async () => {
  const object = { eventId: ids[0], submissionId: ids[1], kind: "image" as const };
  const transport = (get: () => Response): typeof fetch => async input => Object.defineProperty(get(), "url", { value: String(input) });
  assert.equal(await createEventObjects({ origin, serviceRoleKey: key }, { fetch: transport(() => json()) }).download(object), null);
  for (const body of ["bad JSON", " ".repeat(4097)]) await assert.rejects(createEventObjects({ origin, serviceRoleKey: key }, { fetch: transport(() => new Response(body, { status: 400, headers: { "content-type": "application/json" } })) }).download(object), /provider_failure/);
});
