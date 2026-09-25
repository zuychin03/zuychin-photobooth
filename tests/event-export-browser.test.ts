import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createEventExportClient } from "../lib/events/export-client";
import { createEventExportFixture } from "../lib/events/export-fixture";
import { prepareEventExportBatch, confirmEventExportSaved, recheckEventExportBatch } from "../lib/events/export-coordinator";
import { eventZipCrc32, writeEventExportZip, EVENT_ZIP_MAX_BYTES } from "../lib/events/export-zip";
import { parseEventExportSummary } from "../lib/events/export-contract";

const ownerId = "00000000-0000-4000-8000-000000000001", eventId = "00000000-0000-4000-8000-000000000002", exportId = "00000000-0000-4000-8000-000000000003", appOrigin = "https://booth.example", storageOrigin = "https://storage.example";
test("HTTP Storage configuration is confined to a loopback app and loopback Storage", () => {
  const ports = { identity: () => ({ ownerId, epoch: 1 }), accessToken: async () => "synthetic" };
  for (const [app, storage] of [["http://127.0.0.1:3010", "http://127.0.0.1:55431"], ["http://localhost:3010", "http://[::1]:55431"], [appOrigin, storageOrigin]]) {
    const client = createEventExportClient({ ...ports, appOrigin: app, storageOrigin: storage }); client.close();
  }
  for (const [app, storage] of [[appOrigin, "http://127.0.0.1:55431"], ["https://localhost", "http://localhost:55431"], ["http://127.0.0.1:3010", "http://storage.example"], ["http://booth.example", storageOrigin], ["http://127.0.0.1:3010", "ftp://127.0.0.1:55431"], ["http://127.0.0.1:3010", "http://user:pass@127.0.0.1:55431"]]) {
    assert.throws(() => createEventExportClient({ ...ports, appOrigin: app, storageOrigin: storage }), /invalid_configuration/);
  }
});
test("loopback export verifies real JPEG bytes and rejects signed media origin or protocol changes before fetching", async () => {
  const localApp = "http://127.0.0.1:3010", localStorage = "http://127.0.0.1:55431";
  const jpeg = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#c54d6d" } }).jpeg().toBuffer();
  const ports = await createEventExportFixture({ appOrigin: localApp, storageOrigin: localStorage, eventId, ownerId, image: new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }) });
  let changedOrigin: string | null = null, downloads = 0;
  const client = createEventExportClient({ ...ports, appOrigin: localApp, storageOrigin: localStorage,
    fetch: async (input, init) => {
      if (new URL(String(input)).origin === localStorage) downloads++;
      const response = await ports.fetch(input, init);
      if (changedOrigin && init?.body && JSON.parse(String(init.body)).operation === "media") {
        const value = await response.json(); value.signedUrl = value.signedUrl.replace(localStorage, changedOrigin);
        return Response.json(value);
      }
      return response;
    },
    decode: async blob => { const info = await sharp(new Uint8Array(await blob.arrayBuffer())).metadata(); return { width: info.width!, height: info.height!, close() {} }; },
  });
  try {
    await client.create(eventId, exportId); const entry = (await client.page(eventId, exportId, 0)).entries[0];
    assert.deepEqual(await client.download(eventId, exportId, 0, entry), new Uint8Array(jpeg)); assert.equal(downloads, 1);
    for (const wrong of ["http://storage.example", "https://127.0.0.1:55431", "http://127.0.0.1:55432", "http://localhost:55431"]) {
      changedOrigin = wrong; await assert.rejects(client.download(eventId, exportId, 0, entry), /invalid_response/); assert.equal(downloads, 1);
    }
  } finally { client.close(); ports.close(); }
});
async function fixture() {
  const jpeg = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#c54d6d" } }).jpeg().toBuffer(), image = new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" });
  const ports = await createEventExportFixture({ appOrigin, storageOrigin, eventId, ownerId, image }); let decoded = 0, closed = 0;
  const client = createEventExportClient({ appOrigin, storageOrigin, ...ports, decode: async blob => {
    const { info } = await sharp(new Uint8Array(await blob.arrayBuffer())).raw().toBuffer({ resolveWithObject: true }); decoded++; return { width: info.width, height: info.height, close: () => { closed++; } };
  } });
  return { ports, client, decoded: () => decoded, closed: () => closed, image };
}
function zipFiles(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), result = new Map<string, Uint8Array>(); let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    assert.equal(view.getUint16(at + 8, true), 0); const size = view.getUint32(at + 18, true), nameLength = view.getUint16(at + 26, true), extra = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.slice(at + 30, at + 30 + nameLength)), start = at + 30 + nameLength + extra, data = bytes.slice(start, start + size);
    assert.equal(eventZipCrc32(data), view.getUint32(at + 14, true)); assert(!result.has(name)); result.set(name, data); at = start + size;
  }
  assert.equal(view.getUint32(at, true), 0x02014b50); const end = bytes.length - 22; assert.equal(view.getUint32(end, true), 0x06054b50); assert.equal(view.getUint16(end + 10, true), result.size); assert.equal(view.getUint32(end + 16, true), at); assert.equal(view.getUint32(end + 12, true), end - at);
  return result;
}

test("ZIP output is deterministic, standard store-only and strictly bounded", async () => {
  assert.equal(eventZipCrc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  const photos = [{ index: 0, submissionId: exportId, bytes: new Uint8Array([1, 2, 3]) }], a = writeEventExportZip(photos, { version: 1 }, []), b = writeEventExportZip(photos, { version: 1 }, []);
  assert.deepEqual(new Uint8Array(await a.arrayBuffer()), new Uint8Array(await b.arrayBuffer())); assert(a.size <= EVENT_ZIP_MAX_BYTES);
  const files = zipFiles(new Uint8Array(await a.arrayBuffer())); assert.equal(files.size, 3); assert.deepEqual(files.get(`photos/000-${exportId}.jpg`), photos[0].bytes);
  assert.throws(() => writeEventExportZip([{ ...photos[0], submissionId: "../private" }], {}, []));
  assert.throws(() => writeEventExportZip([...photos, ...photos], {}, [])); assert.throws(() => writeEventExportZip(photos, "x".repeat(131073), []));
});

test("real client sequentially verifies bytes and native decode, then makes manifest and failed report", async () => {
  const f = await fixture(); await f.client.create(eventId, exportId);
  const batch = await prepareEventExportBatch(f.client, eventId, exportId, 0), files = zipFiles(new Uint8Array(await batch.blob.arrayBuffer()));
  assert.equal(batch.included.length, 9); assert.equal(batch.failures.length, 1); assert.equal(files.size, 11); assert.equal(f.decoded(), 9); assert.equal(f.closed(), 9);
  const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json"))), report = JSON.parse(new TextDecoder().decode(files.get("failures.json")));
  assert.equal(manifest.entries[2].file, null); assert.equal(manifest.entries[0].captionStatus, "not_collected"); assert.equal(report.failures[0].reason, "unavailable");
  assert(!JSON.stringify(manifest).includes("signedUrl")); assert(!JSON.stringify(manifest).includes("/image"));
  assert.equal((await f.client.page(eventId, exportId, 0)).entries[0].progress.status, "prepared");
  await confirmEventExportSaved(f.client, batch); assert.equal((await f.client.page(eventId, exportId, 0)).entries[0].progress.status, "confirmed_saved");
  const next = await prepareEventExportBatch(f.client, eventId, exportId, 0, batch.nextCursor!); assert.equal(next.included.length, 2); assert.equal(next.nextCursor, null); f.client.close();
});

test("lost creation and checkpoint acknowledgements reconcile exact identities without extra snapshots", async () => {
  const f = await fixture(); f.ports.loseCreate(); await assert.rejects(f.client.create(eventId, exportId), /network_error/);
  await f.client.create(eventId, exportId); assert.equal((await f.client.list(eventId)).exports.length, 1);
  f.ports.loseCheckpoint(); await assert.rejects(prepareEventExportBatch(f.client, eventId, exportId, 0), /network_error/);
  assert.equal((await f.client.page(eventId, exportId, 0)).entries[0].progress.status, "prepared");
  const retry = await prepareEventExportBatch(f.client, eventId, exportId, 0); assert.equal(retry.summary.revision, 1); f.client.close();
});

test("corrupt delivery makes a failed-item report and never enters decoder", async () => {
  const f = await fixture(); await f.client.create(eventId, exportId); f.ports.corrupt(true);
  const batch = await prepareEventExportBatch(f.client, eventId, exportId, 0); assert.equal(batch.included.length, 0); assert.equal(batch.failures.length, 10); assert.equal(f.decoded(), 0);
  assert(batch.failures.some(x => x.reason === "integrity_failed")); assert.equal(zipFiles(new Uint8Array(await batch.blob.arrayBuffer())).size, 2); f.client.close();
});

test("revocation after preparation prevents publishing, and account epoch invalidates retained client", async () => {
  const f = await fixture(); await f.client.create(eventId, exportId); const batch = await prepareEventExportBatch(f.client, eventId, exportId, 0);
  f.ports.revoke(); await assert.rejects(recheckEventExportBatch(f.client, batch), /access_denied/);
  f.ports.restore(); f.ports.switchAccount(); await assert.rejects(f.client.list(eventId), /identity_changed/); f.client.close();
});

test("all-failure and empty batches reauthorise before publication or saved confirmation", async () => {
  const f = await fixture();
  try {
    await f.client.create(eventId, exportId); f.ports.corrupt(true);
    const failed = await prepareEventExportBatch(f.client, eventId, exportId, 0), empty = await prepareEventExportBatch(f.client, eventId, exportId, 0, 11);
    assert.equal(failed.included.length, 0); assert.equal(failed.failures.length, 10); assert.equal(empty.included.length, 0); assert.equal(empty.failures.length, 0);
    f.ports.revoke();
    for (const batch of [failed, empty]) {
      await assert.rejects(recheckEventExportBatch(f.client, batch), /access_denied/);
      await assert.rejects(confirmEventExportSaved(f.client, batch), /access_denied/);
    }
    f.ports.restore(); f.ports.expire();
    for (const batch of [failed, empty]) {
      await assert.rejects(recheckEventExportBatch(f.client, batch), /expired/);
      await assert.rejects(confirmEventExportSaved(f.client, batch), /expired/);
    }
  } finally { f.client.close(); }
});

test("batch authority rejects an unexpected generation or an expired successful page", async () => {
  const f = await fixture();
  try {
    await f.client.create(eventId, exportId); const batch = await prepareEventExportBatch(f.client, eventId, exportId, 0, 11), page = await f.client.page(eventId, exportId, 0, 11);
    for (const change of [{ generation: 1 }, { eventId: ownerId }, { exportId: ownerId }]) {
      const wrong = { ...f.client, page: async () => ({ ...page, summary: { ...page.summary, ...change } }) };
      await assert.rejects(recheckEventExportBatch(wrong, batch), /invalid_response/);
      await assert.rejects(confirmEventExportSaved(wrong, batch), /invalid_response/);
    }
    const expired = { ...f.client, page: async () => ({ ...page, summary: { ...page.summary, expiresAt: "2020-01-01T00:00:00.000Z" } }) };
    await assert.rejects(recheckEventExportBatch(expired, batch), /expired/);
    await assert.rejects(confirmEventExportSaved(expired, batch), /expired/);
  } finally { f.client.close(); }
});

test("retirement permits explicit bounded slot reuse and old generation requests remain fenced", async () => {
  const f = await fixture(); const snapshot = await f.client.create(eventId, exportId), ticket = await f.client.retire(eventId, exportId, 0, snapshot.revision);
  assert.deepEqual(await f.client.retire(eventId, exportId, 0, snapshot.revision), ticket); assert.equal((await f.client.list(eventId)).retired.length, 1);
  await assert.rejects(f.client.create(eventId, exportId), /conflict/); await f.client.create(eventId, exportId, undefined, ticket.generation);
  await assert.rejects(f.client.page(eventId, exportId, 0), /conflict/); await assert.rejects(f.client.retire(eventId, exportId, 0, 0), /conflict/);
  assert.equal((await f.client.page(eventId, exportId, 1)).summary.generation, 1); f.client.close();
});

test("aborted native decode holds its resource slot and closes late result", async () => {
  const f = await fixture(); await f.client.create(eventId, exportId); const entry = (await f.client.page(eventId, exportId, 0)).entries[0];
  let started = () => {}, release = () => {}, closed = 0;
  const entered = new Promise<void>(resolve => { started = resolve; }), decode = new Promise<{ width: number; height: number; close(): void }>(resolve => { release = () => resolve({ width: 32, height: 24, close() { closed++; } }); });
  const client = createEventExportClient({ appOrigin, storageOrigin, ...f.ports, decode: () => { started(); return decode; } }), abort = new AbortController();
  const pending = client.download(eventId, exportId, 0, entry, abort.signal); await entered; abort.abort(); await assert.rejects(pending, /cancelled/);
  await assert.rejects(client.list(eventId), /busy/); release(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(closed, 1);
  assert.equal((await client.list(eventId)).exports.length, 1); client.close(); f.client.close();
});

test("export timestamps reject impossible calendar dates", async () => {
  const f = await fixture(), snapshot = await f.client.create(eventId, exportId);
  for (const createdAt of ["2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01", "invalid"]) assert.throws(() => parseEventExportSummary({ ...snapshot, createdAt }, eventId));
  f.client.close();
});

test("rehearsal expiry denies existing exports and stop clears the retained fixture", async () => {
  const f = await fixture();
  await f.client.create(eventId, exportId);
  f.ports.expire();
  await assert.rejects(f.client.list(eventId), /expired/);
  await assert.rejects(f.client.access(eventId, exportId, 0, 0), /expired/);
  f.ports.close(); assert.equal(f.ports.identity(), null); assert.deepEqual(f.ports.calls, []);
  await assert.rejects(f.ports.fetch(`${appOrigin}/api/events/${eventId}/exports`), /Fixture stopped/);
  f.client.close();
});
