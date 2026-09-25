import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createEventAudienceClient } from "../lib/events/audience-client";
import { createEventAudienceFixture, AUDIENCE_FIXTURE_EVENT, AUDIENCE_FIXTURE_TOKENS } from "../lib/events/audience-fixture";
import { takeEventAudienceFragment } from "../lib/events/audience-fragment";
import { createEventAudienceLifecycle, type EventAudienceLifecyclePorts } from "../lib/events/audience-lifecycle";
import type { EventAudiencePage } from "../lib/events/publication-contract";
import { EventClientError } from "../lib/events/client";

const appOrigin = "https://booth.example", storageOrigin = "https://storage.example";
async function fixture() {
  const old = process.env.NODE_ENV; Object.assign(process.env, { NODE_ENV: "development" });
  try { const data = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#a85e79" } }).jpeg().toBuffer(); return await createEventAudienceFixture({ appOrigin, storageOrigin, image: new Blob([new Uint8Array(data)], { type: "image/jpeg" }) }); }
  finally { if (old === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Object.assign(process.env, { NODE_ENV: old }); }
}
const decode = async () => ({ width: 12, height: 8, close() {} });
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test("audience fragment is synchronously scrubbed before validation and accepts only one token", () => {
  const paths: string[] = [], location = { hash: `#token=${AUDIENCE_FIXTURE_TOKENS.gallery}`, search: "", pathname: "/e/id/gallery" };
  assert.equal(takeEventAudienceFragment(location, path => paths.push(path)), AUDIENCE_FIXTURE_TOKENS.gallery); assert.deepEqual(paths, [location.pathname]);
  for (const invalid of [{ ...location, search: "?token=secret" }, { ...location, hash: `${location.hash}&token=x` }, { ...location, hash: "#invite=secret" }, { ...location, hash: "x".repeat(200) }]) { assert.equal(takeEventAudienceFragment(invalid, path => paths.push(path)), null); assert.equal(paths.at(-1), location.pathname); }
});

test("real audience client separates gallery/wall sessions and all four publication combinations", async () => {
  const f = await fixture(), gallery = createEventAudienceClient({ appOrigin, storageOrigin, eventId: f.eventId, destination: "gallery", fetch: f.fetch, decode }), wall = createEventAudienceClient({ appOrigin, storageOrigin, eventId: f.eventId, destination: "wall", fetch: f.fetch, decode });
  try {
    assert.equal((await gallery.capabilities()).publicationVersion, 1); await assert.rejects(gallery.session(), /access_denied/);
    await assert.rejects(gallery.exchange(f.tokens.wall), /access_denied/); await gallery.exchange(f.tokens.gallery);
    await assert.rejects(wall.session(), /access_denied/); await wall.exchange(f.tokens.wall);
    const g = await gallery.list(), w = await wall.list(); assert.equal(g.entries.length, 4); assert.equal(w.entries.length, 3); assert(w.nextCursor);
    assert.equal(g.entries[0].submissionId.endsWith("011"), true); assert.equal(w.entries[0].submissionId.endsWith("012"), true);
    assert(g.entries.every(x => !x.submissionId.endsWith("010") && !x.submissionId.endsWith("012")));
    assert((await gallery.download(g.entries[0], "image")).size > 0); assert((await wall.download(w.entries[0], "thumbnail")).size > 0); await assert.rejects(wall.download(w.entries[0], "image"), /access_denied/);
    f.withdrawGallery(true); assert.equal((await gallery.validate(g.entries.map(x => x.submissionId))).entries.length, 0); assert.equal((await wall.list()).entries.length, 3);
    f.replaceSession("gallery"); await assert.rejects(gallery.list(), /identity_changed/); assert.equal((await wall.list()).entries.length, 3);
  } finally { gallery.close(); wall.close(); f.close(); }
});

test("audience reports retry exactly without changing the destination or payload", async () => {
  const f = await fixture(), client = createEventAudienceClient({ appOrigin, storageOrigin, eventId: f.eventId, destination: "gallery", fetch: f.fetch, decode });
  try { await client.exchange(f.tokens.gallery); const entry = (await client.list()).entries[0], request = { requestId: crypto.randomUUID(), submissionId: entry.submissionId, reason: "privacy" as const, detail: "Please review this photo." }, first = await client.report(request); assert.deepEqual(await client.report(request), first); await assert.rejects(client.report({ ...request, detail: "Changed" }), /conflict/); await assert.rejects(client.report({ ...request, detail: "x".repeat(501) }), /invalid_request/); }
  finally { client.close(); f.close(); }
});

test("revocation during native decode discards the image and closes its bitmap", async () => {
  const f = await fixture(); let closed = 0;
  const client = createEventAudienceClient({ appOrigin, storageOrigin, eventId: f.eventId, destination: "gallery", fetch: f.fetch, decode: async () => { f.withdrawGallery(true); return { width: 12, height: 8, close() { closed++; } }; } });
  try { await client.exchange(f.tokens.gallery); const entry = (await client.list()).entries[0]; await assert.rejects(client.download(entry, "thumbnail"), /access_denied/); assert.equal(closed, 1); }
  finally { client.close(); f.close(); }
});

test("cancelled native work retains the single decode slot until the late result closes", async () => {
  const f = await fixture(); let begin = () => {}, release = () => {}, closed = 0;
  const entered = new Promise<void>(resolve => { begin = resolve; }), pending = new Promise<{ width: number; height: number; close(): void }>(resolve => { release = () => resolve({ width: 12, height: 8, close() { closed++; } }); });
  const client = createEventAudienceClient({ appOrigin, storageOrigin, eventId: f.eventId, destination: "gallery", fetch: f.fetch, decode: () => { begin(); return pending; } });
  try { await client.exchange(f.tokens.gallery); const entry = (await client.list()).entries[0], abort = new AbortController(), work = client.download(entry, "thumbnail", abort.signal); await entered; abort.abort(); await assert.rejects(work, /cancelled/); await assert.rejects(client.download(entry, "thumbnail"), /busy/); release(); await settle(); assert.equal(closed, 1); }
  finally { release(); client.close(); f.close(); }
});

test("audience bytes reject foreign URLs, tiny-chunk exhaustion and corrupt image hashes", async () => {
  const f = await fixture(); let mode: "foreign" | "chunks" | "corrupt" = "foreign", native = 0;
  const transport: typeof fetch = async (input, init) => {
    const response = await f.fetch(input, init);
    if (String(input).startsWith(storageOrigin)) {
      if (mode === "chunks") return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < 4097; i++) controller.enqueue(new Uint8Array()); controller.close(); } }), { headers: { "content-type": "image/jpeg" } });
      if (mode === "corrupt") { const bytes = new Uint8Array(await response.arrayBuffer()); bytes[bytes.length - 1] ^= 1; return new Response(bytes, { headers: { "content-type": "image/jpeg" } }); }
    } else if (JSON.parse(String(init?.body)).operation === "media" && mode === "foreign") { const body = await response.json(); return new Response(JSON.stringify({ ...body, signedUrl: body.signedUrl.replace(storageOrigin, "https://foreign.example") }), { headers: { "content-type": "application/json" } }); }
    return response;
  };
  const client = createEventAudienceClient({ appOrigin, storageOrigin, eventId: f.eventId, destination: "gallery", fetch: transport, decode: async () => { native++; return decode(); } });
  try { await client.exchange(f.tokens.gallery); const entry = (await client.list()).entries[0]; await assert.rejects(client.download(entry, "thumbnail"), /invalid_response/); mode = "chunks"; await assert.rejects(client.download(entry, "thumbnail"), /response_too_large/); mode = "corrupt"; await assert.rejects(client.download(entry, "thumbnail"), /invalid_image/); assert.equal(native, 0); }
  finally { client.close(); f.close(); }
});

function clock() {
  let now = Date.now(), counter = 0; const tasks = new Map<number, { at: number; callback: () => void }>(), revoked: string[] = [];
  const ports: EventAudienceLifecyclePorts = { now: () => now, schedule(callback, milliseconds) { const id = ++counter; tasks.set(id, { at: now + milliseconds, callback }); return id; }, cancel(handle) { tasks.delete(handle as number); }, createUrl: () => `blob:fixture-${++counter}`, revokeUrl: url => { revoked.push(url); } };
  return { ports, revoked, async advance(ms: number) { const until = now + ms; let count = 0; while (true) { const item = [...tasks].filter(([, x]) => x.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!item) break; if (++count > 100) throw new Error("Timer loop"); tasks.delete(item[0]); now = item[1].at; item[1].callback(); await settle(); } now = until; await settle(); } };
}
const page = (count: number): EventAudiencePage => ({ version: 1, eventId: AUDIENCE_FIXTURE_EVENT, destination: "gallery", eventTitle: "Fixture", checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), entries: Array.from({ length: count }, (_, i) => ({ submissionId: `72000000-0000-4000-8000-${String(i + 10).padStart(12, "0")}`, revision: 0, createdAt: new Date().toISOString() })), nextCursor: null });

test("a still wall continues authority checks without rotating and resumes at the normal interval", async () => {
  const time = clock(), cursors: (string | undefined)[] = []; let allowed = true;
  const cursor = "72000000-0000-4000-8000-000000000020";
  const client = { destination: "wall" as const, assertActive() {}, list: async (after?: string) => { cursors.push(after); return { ...page(allowed ? 3 : 0), destination: "wall" as const, nextCursor: cursor }; }, download: async () => new Blob(["photo"]) };
  const controller = createEventAudienceLifecycle(client, () => {}, time.ports);
  controller.setRotationEnabled(false); controller.start(); await settle(); await time.advance(20000);
  assert(cursors.length >= 5); assert(cursors.every(value => value === undefined));
  allowed = false; await time.advance(5000); assert.equal(controller.getState().images.length, 0);
  allowed = true; controller.setRotationEnabled(true); await time.advance(10000); assert.equal(cursors.at(-1), undefined);
  await time.advance(5000); assert.equal(cursors.at(-1), cursor); controller.close();
});

test("hard freshness deadline clears every URL while a permission refresh is still stalled", async () => {
  const time = clock(); let calls = 0, resolve: (value: EventAudiencePage) => void = () => {};
  const delayed = new Promise<EventAudiencePage>(done => { resolve = done; }), client = { destination: "gallery" as const, assertActive(signal?: AbortSignal) { if (signal?.aborted) throw new EventClientError("cancelled"); }, list: async () => ++calls === 1 ? page(12) : delayed, download: async () => new Blob(["x"]) };
  const controller = createEventAudienceLifecycle(client, () => {}, time.ports); controller.start(); await settle(); assert.equal(controller.getState().images.length, 12);
  await time.advance(5000); assert.equal(calls, 2); assert.equal(controller.getState().images.length, 12);
  await time.advance(5000); assert.equal(controller.getState().images.length, 0); assert.equal(controller.getState().page, null); assert.equal(time.revoked.length, 12);
  resolve(page(12)); await settle(); assert.equal(controller.getState().images.length, 0); controller.close();
});

test("poll revocation, offline, hidden and close release photos without late repaint", async () => {
  const time = clock(); let allowed = true;
  const client = { destination: "wall" as const, assertActive() {}, list: async () => ({ ...page(allowed ? 3 : 0), destination: "wall" as const }), download: async () => new Blob(["x"]) };
  const controller = createEventAudienceLifecycle(client, () => {}, time.ports); controller.start(); await settle(); assert.equal(controller.getState().images.length, 3);
  allowed = false; await time.advance(5000); assert.equal(controller.getState().images.length, 0); assert.equal(time.revoked.length, 3);
  allowed = true; controller.pause("offline"); controller.start(); await settle(); assert.equal(controller.getState().images.length, 3);
  controller.pause("hidden"); assert.equal(controller.getState().images.length, 0); assert.equal(controller.getState().phase, "paused"); controller.close(); await time.advance(20000); assert.equal(controller.getState().images.length, 0);
});

test("permission polls continue while one thumbnail is decoding, without another decode queue", async () => {
  const time = clock(); let polls = 0, downloads = 0, release: (blob: Blob) => void = () => {};
  const pending = new Promise<Blob>(resolve => { release = resolve; }), client = { destination: "gallery" as const, assertActive(signal?: AbortSignal) { if (signal?.aborted) throw new EventClientError("cancelled"); }, list: async () => { polls++; return page(2); }, download: async () => { downloads++; return pending; } };
  const controller = createEventAudienceLifecycle(client, () => {}, time.ports); controller.start(); await settle(); assert.equal(downloads, 1);
  await time.advance(5000); assert.equal(polls, 2); assert.equal(downloads, 1);
  controller.pause("offline"); release(new Blob(["late"])); await settle(); assert.equal(controller.getState().images.length, 0); assert.equal(downloads, 1); controller.close();
});

test("download readiness stays busy after the first preview until all thumbnail work settles", async () => {
  const time = clock(); let downloads = 0, release: (blob: Blob) => void = () => {};
  const pending = new Promise<Blob>(resolve => { release = resolve; }), client = { destination: "gallery" as const, assertActive() {}, list: async () => page(2), download: async () => ++downloads === 1 ? new Blob(["first"]) : pending };
  const controller = createEventAudienceLifecycle(client, () => {}, time.ports); controller.start(); await settle();
  assert.equal(controller.getState().images.length, 1); assert.equal(controller.getState().mediaBusy, true);
  await time.advance(5000); assert.equal(controller.getState().mediaBusy, true);
  release(new Blob(["second"])); await settle(); assert.equal(controller.getState().images.length, 2); assert.equal(controller.getState().mediaBusy, false); controller.close();
});
