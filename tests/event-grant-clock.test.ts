import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createEventGuestClient } from "../lib/events/client";

const eventId = "11111111-1111-4111-8111-111111111111", guestId = "22222222-2222-4222-8222-222222222222", submissionId = "33333333-3333-4333-8333-333333333333";
const appOrigin = "https://app.example", storageOrigin = "https://storage.example", serverNow = Date.parse("2026-09-28T22:42:00Z");
const photo = new Blob([new Uint8Array(readFileSync("tests/fixtures/projects/a.png"))], { type: "image/png" });
function fixture(options: { ttl?: number; header?: string; afterResponse?: () => void } = {}) {
  let puts = 0;
  const client = createEventGuestClient({ appOrigin, storageOrigin, eventId, identity: () => ({ eventId, guestId, epoch: 1 }), fetch: async (url, init) => {
    if (String(url).startsWith(storageOrigin)) { assert.equal(init?.method, "PUT"); puts++; return new Response("{}"); }
    const upload = JSON.parse(String(init?.body)).operation === "upload", kind = upload ? "source" : "image", bucket = upload ? "photobooth-event-images-staging-v2" : "photobooth-events-v2", path = `${eventId}/${submissionId}/${kind}`;
    const response = new Response(JSON.stringify({ submissionId, bucket, path, signedUrl: `${storageOrigin}/storage/v1/object/${upload ? "upload/sign" : "sign"}/${bucket}/${path}?token=synthetic`, expiresAt: new Date(serverNow + (options.ttl ?? (upload ? 7200000 : 300000))).toISOString(), maxBytes: 2000000, ...(upload ? { overwrite: false } : { mime: "image/jpeg" }) }), { headers: { "content-type": "application/json", "x-pb-server-time": options.header ?? new Date(serverNow).toISOString() } });
    options.afterResponse?.(); return response;
  } });
  return { client, puts: () => puts };
}

test("server-clock upload and receipt grants survive slow and fast browser wall clocks", async t => {
  t.mock.method(performance, "now", () => 100);
  let browserNow = serverNow - 2000; t.mock.method(Date, "now", () => browserNow);
  for (const skew of [-2000, 86400000]) {
    browserNow = serverNow + skew;
    const f = fixture();
    try { const grant = await f.client.mintUpload(submissionId); assert.equal((await f.client.upload(submissionId, photo, grant)).acknowledged, true); assert.equal(f.puts(), 1); assert.equal((await f.client.media(submissionId)).mime, "image/jpeg"); }
    finally { f.client.close(); }
  }
});

test("a wall-clock jump after mint cannot prematurely expire a monotonic grant", async t => {
  let browserNow = serverNow, mono = 100; t.mock.method(Date, "now", () => browserNow); t.mock.method(performance, "now", () => mono);
  const f = fixture();
  try { const grant = await f.client.mintUpload(submissionId); browserNow += 86400000; mono += 100; await f.client.upload(submissionId, photo, grant); assert.equal(f.puts(), 1); }
  finally { f.client.close(); }
});

test("monotonic elapsed time expires a grant even if the browser wall clock stops", async t => {
  let mono = 100; t.mock.method(Date, "now", () => serverNow); t.mock.method(performance, "now", () => mono);
  const f = fixture({ ttl: 1000 });
  try { const grant = await f.client.mintUpload(submissionId); mono += 1000; await assert.rejects(f.client.upload(submissionId, photo, grant), /invalid_response/); assert.equal(f.puts(), 0); }
  finally { f.client.close(); }
});

test("request elapsed time is conservatively deducted before accepting a short grant", async t => {
  let mono = 100; t.mock.method(Date, "now", () => serverNow); t.mock.method(performance, "now", () => mono);
  const f = fixture({ ttl: 10, afterResponse: () => { mono += 20; } });
  try { await assert.rejects(f.client.mintUpload(submissionId), /invalid_response/); assert.equal(f.puts(), 0); }
  finally { f.client.close(); }
});

test("expiry during original inspection refuses the PUT before transferring bytes", async t => {
  let mono = 100; t.mock.method(Date, "now", () => serverNow); t.mock.method(performance, "now", () => mono);
  const original = new Blob([photo], { type: photo.type });
  t.mock.method(original, "arrayBuffer", async () => { const bytes = await photo.arrayBuffer(); mono += 1000; return bytes; });
  const f = fixture({ ttl: 1000 });
  try { const grant = await f.client.mintUpload(submissionId); await assert.rejects(f.client.upload(submissionId, original, grant), /invalid_response/); assert.equal(f.puts(), 0); }
  finally { f.client.close(); }
});

test("server-issued time does not admit expired or overlong grants", async t => {
  t.mock.method(Date, "now", () => serverNow); t.mock.method(performance, "now", () => 100);
  for (const ttl of [0, -1, 7200001]) {
    const f = fixture({ ttl }); try { await assert.rejects(f.client.mintUpload(submissionId), /invalid_response/); } finally { f.client.close(); }
  }
  const read = fixture({ ttl: 300001 }); try { await assert.rejects(read.client.media(submissionId), /invalid_response/); } finally { read.client.close(); }
});

test("malformed server-time headers fail closed instead of using the browser clock", async t => {
  t.mock.method(Date, "now", () => serverNow);
  for (const header of ["not-a-date", "2026-02-31T00:00:00Z", "2026-09-28T22:42:00Z, 2026-09-28T22:42:00Z"]) {
    const f = fixture({ header }); try { await assert.rejects(f.client.mintUpload(submissionId), /invalid_response/); } finally { f.client.close(); }
  }
});
