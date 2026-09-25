import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_EXPORT_LIMITS, parseEventExportAccess, parseEventExportPage, validateEventExportUpdates } from "../lib/events/export-contract";
import { createEventExportStore } from "../lib/server/event-export-store";
import { createEventExportHandler, type EventExportRequestPorts } from "../lib/server/event-export-requests";
import { EVENT_LIMITS } from "../lib/events/contract";
import { EventStoreError, verifyEventActor } from "../lib/server/event-store";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const event = id(1), exportId = id(2), owner = id(3), submission = id(4), expiresAt = "2099-01-01T00:00:00.000Z", createdAt = "2026-09-23T00:00:00.000Z";
const summary = { version: 1 as const, eventId: event, exportId, generation: 0, createdAt, expiresAt, total: 1, afterSubmissionId: null, nextSubmissionCursor: null, revision: 0 };
const descriptor = { bucket: "photobooth-events-v2" as const, path: `${event}/${submission}/image`, bytes: 100, mime: "image/jpeg" as const, width: 40, height: 30, sha256: "a".repeat(64) };
const entry = { index: 0, submissionId: submission, createdAt, expiresAt, state: "ready", caption: null, captionStatus: "not_collected", media: descriptor, unavailable: null, progress: { status: "pending", error: null } };
const page = { summary, entries: [entry], nextCursor: null };
const access = { ...descriptor, submissionId: submission, expiresAt, maxAgeSeconds: 300 };
const env = { PB_EVENTS_ENABLED: "true", NEXT_PUBLIC_SUPABASE_URL: "https://storage.example", SUPABASE_SERVICE_ROLE_KEY: "synthetic-key", PB_EVENT_TRANSPORT_SECRET: "synthetic-transport-secret-32-characters", PB_PUBLIC_ORIGIN: "https://booth.example" };
const actor = () => verifyEventActor({ getUser: async () => ({ data: { user: { id: owner } }, error: null }) });

test("export pages validate exact identity, private image path, bounded inventory and absent captions", () => {
  assert.deepEqual(parseEventExportPage(page, event, exportId), page);
  for (const changed of [{ ...entry, caption: "not actually collected" }, { ...entry, index: 1 }, { ...entry, media: { ...descriptor, bytes: 2000001 } }, { ...entry, media: { ...descriptor, path: `${id(9)}/${submission}/image` } }, { ...entry, media: { ...descriptor, width: 4096, height: 4096 } }, { ...entry, media: { ...descriptor, sha256: "not-hash" } }, { ...entry, media: { ...descriptor, url: "https://private.invalid" } }]) assert.throws(() => parseEventExportPage({ ...page, entries: [changed] }, event, exportId));
  assert.throws(() => parseEventExportPage(page, event, id(8)));
  assert.throws(() => parseEventExportPage({ ...page, nextCursor: 0 }, event, exportId));
  assert.throws(() => parseEventExportPage({ ...page, entries: [] }, event, exportId));
});

test("unavailable historical entries remain explicit failed items and cannot masquerade as prepared bytes", () => {
  const failed = { ...entry, state: "deleted", media: null, unavailable: "deleted", progress: { status: "failed", error: "unavailable" } };
  assert.equal(parseEventExportPage({ ...page, entries: [failed] }, event, exportId).entries[0].media, null);
  assert.throws(() => parseEventExportPage({ ...page, entries: [{ ...failed, progress: { status: "prepared", error: null } }] }, event, exportId));
});

test("checkpoint inputs reject duplicate indices, raw errors, pending resets and unbounded batches", () => {
  const update = { index: 0, status: "prepared" as const, error: null };
  assert.deepEqual(validateEventExportUpdates([update]), [update]);
  for (const value of [[], [update, update], [{ ...update, status: "pending" }], [{ ...update, status: "failed", error: "https://secret.invalid" }], [{ ...update, extra: "value" }], Array.from({ length: 11 }, (_, index) => ({ ...update, index }))]) assert.throws(() => validateEventExportUpdates(value));
});

test("read descriptors reject staging paths and invalid lifetimes", () => {
  assert.deepEqual(parseEventExportAccess(access, event), access);
  for (const changed of [{ ...access, bucket: "photobooth-event-images-staging-v2" }, { ...access, maxAgeSeconds: 301 }, { ...access, path: `${event}/${submission}/source` }]) assert.throws(() => parseEventExportAccess(changed, event));
});

test("export store binds verified actor and fails closed on missing schema, malformed projection or forged actor", async () => {
  let schema = true, result: unknown = summary; const calls: { name: string; args: Record<string, unknown> }[] = [];
  const store = createEventExportStore(env, { rpc: async (name, args) => {
    calls.push({ name, args });
    if (name === "pb_event_export_capabilities") return { data: { ...EVENT_EXPORT_LIMITS, version: schema ? 1 : 2 }, error: null };
    if (name === "pb_event_capabilities") return { data: { version: 1, ready: true, deploymentBytes: 250000000, allocatedBytes: 0, limits: EVENT_LIMITS }, error: null };
    return { data: result, error: null };
  } });
  assert.deepEqual(await store.create(await actor(), event, exportId), summary);
  assert.equal(calls.at(-1)!.args.p_actor, owner); assert.equal(calls.at(-1)!.args.p_after, null);
  await assert.rejects(store.create({ id: owner } as Awaited<ReturnType<typeof actor>>, event, exportId), /access_denied/);
  result = { ...summary, eventId: id(7) }; await assert.rejects(store.create(await actor(), event, exportId), /unavailable/);
  schema = false; const before = calls.filter(x => x.name === "pb_event_export_create").length;
  await assert.rejects(store.create(await actor(), event, exportId), /unavailable/); assert.equal(calls.filter(x => x.name === "pb_event_export_create").length, before);
});

function fixture() {
  let authenticated = 0, allowed = true, accessCalls = 0, providerCalls = 0, changed = false, denied = false, cancelled: (() => void) | undefined;
  const operations: string[] = [];
  const ports: EventExportRequestPorts = {
    authenticate: async token => { assert.equal(token, "synthetic-bearer"); authenticated++; return actor(); },
    stores: () => ({
      base: { transportReady: async () => {}, rate: async () => ({ allowed, retryAfterSeconds: allowed ? 0 : 42 }) },
      objects: { mintUpload: async () => { throw new Error("not used"); }, signRead: async () => { providerCalls++; cancelled?.(); return { signedUrl: "https://storage.example/synthetic-signed-path", expiresAt: new Date(Date.now() + 290000).toISOString() }; } },
      exports: {
        capabilities: async () => EVENT_EXPORT_LIMITS,
        retire: async () => ({ exportId, generation: 1 }),
        create: async (who, scope, exported, after) => { assert.equal(who.id, owner); assert.equal(scope, event); assert.equal(exported, exportId); assert.equal(after, undefined); operations.push("create"); return summary; },
        list: async () => { operations.push("list"); return { version: 1, exports: [summary], retired: [] }; },
        page: async () => parseEventExportPage(page, event, exportId),
        checkpoint: async (_who, _scope, _exported, _generation, revision, updates) => { assert.equal(revision, 0); assert.equal(updates[0].status, "prepared"); operations.push("checkpoint"); return { ...summary, revision: 1 }; },
        access: async () => { if (++accessCalls > 1 && denied) throw new EventStoreError("access_denied", 403); return { ...access, sha256: accessCalls > 1 && changed ? "b".repeat(64) : access.sha256 }; },
      },
    }),
  };
  const request = (body: unknown, options: { auth?: boolean; origin?: string; controller?: AbortController } = {}) => new Request(`https://booth.example/api/events/${event}/exports`, { method: "POST", signal: options.controller?.signal, headers: { origin: options.origin ?? env.PB_PUBLIC_ORIGIN, "content-type": "application/json", ...(options.auth === false ? {} : { authorization: "Bearer synthetic-bearer" }) }, body: JSON.stringify(body) });
  const handler = createEventExportHandler(ports, () => env);
  return { run: (body: unknown) => handler(request(body), event), request, handler, operations, authCount: () => authenticated, providerCount: () => providerCalls, accessCount: () => accessCalls, rateDeny: () => { allowed = false; }, change: () => { changed = true; }, revoke: () => { denied = true; }, onMint: (fn: () => void) => { cancelled = fn; } };
}

test("export HTTP requires same-origin bearer, finite allowlisted body and durable actor rate", async () => {
  const f = fixture();
  assert.equal((await f.handler(f.request({ operation: "list" }, { auth: false }), event)).status, 401);
  assert.equal((await f.handler(f.request({ operation: "list" }, { origin: "https://foreign.example" }), event)).status, 403);
  assert.equal((await f.run({ operation: "create", exportId, generation: 0, actor: owner })).status, 400); assert.equal(f.authCount(), 0);
  f.rateDeny(); const limited = await f.run({ operation: "list" }); assert.equal(limited.status, 429); assert.equal(limited.headers.get("retry-after"), "42"); assert.equal(f.operations.length, 0);
});

test("export HTTP preserves stable snapshot identity and CAS checkpoint without asserting file persistence", async () => {
  const f = fixture(), created = await f.run({ operation: "create", exportId, generation: 0 }); assert.equal(created.status, 201); assert.deepEqual(await created.json(), summary);
  const checkpoint = await f.run({ operation: "checkpoint", exportId, generation: 0, revision: 0, updates: [{ index: 0, status: "prepared", error: null }] }); assert.equal(checkpoint.status, 200); assert.equal((await checkpoint.json()).revision, 1);
  assert.equal(checkpoint.headers.get("cache-control"), "private, no-store"); assert.equal(checkpoint.headers.get("referrer-policy"), "no-referrer");
});

test("export media rechecks exact descriptor and authority after signing, including abort", async () => {
  const f = fixture(), result = await f.run({ operation: "media", exportId, generation: 0, index: 0 }); assert.equal(result.status, 200);
  const body = await result.json(); assert.equal(body.sha256, descriptor.sha256); assert.equal(body.retainedUntil, expiresAt); assert.equal(body.maxAgeSeconds, undefined); assert.equal(f.accessCount(), 2);
  for (const transition of ["change", "revoke"] as const) { const race = fixture(); race[transition](); const denied = await race.run({ operation: "media", exportId, generation: 0, index: 0 }); assert.equal(denied.status, 403); assert(!(await denied.text()).includes("signedUrl")); }
  const abort = fixture(), controller = new AbortController(); abort.onMint(() => controller.abort()); const stopped = await abort.handler(abort.request({ operation: "media", exportId, generation: 0, index: 0 }, { controller }), event); assert.equal(stopped.status, 503); assert.equal(abort.providerCount(), 1);
});

test("post-download authority checks require no new signed URL or provider request", async () => {
  const f = fixture(), response = await f.run({ operation: "access", exportId, generation: 0, index: 0 });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), access); assert.equal(f.providerCount(), 0);
  f.revoke(); assert.equal((await f.run({ operation: "access", exportId, generation: 0, index: 0 })).status, 403);
});
