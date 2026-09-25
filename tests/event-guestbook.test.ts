import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { EVENT_MISSIONS, parseEventGuestbookNote, parseEventMissions, validateGuestbookText } from "../lib/events/guestbook-contract";
import { verifyEventActor } from "../lib/server/event-store";
import { createEventExportFixture } from "../lib/events/export-fixture";
import { createEventExportClient } from "../lib/events/export-client";
import { prepareEventExportBatch, recheckEventExportBatch } from "../lib/events/export-coordinator";
import { createEventGuestbookStore } from "../lib/server/event-guestbook-store";
const eventId = "10000000-0000-4000-8000-000000000001", ownerId = "10000000-0000-4000-8000-000000000002", submissionId = "20000000-0000-4000-8000-000000000001", exportId = "10000000-0000-4000-8000-000000000003";
const note = { version: 1, eventId, submissionId, revision: 2, message: "A lovely day. Cảm ơn!", signature: "Guest", withdrawn: false, mission: EVENT_MISSIONS[0], missionCompleted: true };

test("host and guest mission adapters normalise PostgreSQL offsets before strict browser parsing", async () => {
  const actor = await verifyEventActor({ getUser: async () => ({ data: { user: { id: ownerId } }, error: null }) });
  for (const endsAt of ["2026-09-25T13:30:00+00:00", "2026-09-26T00:00:00+10:30"]) {
    const raw = { version: 1, eventId, revision: 0, missionIds: [], endsAt, locked: false };
    assert.throws(() => parseEventMissions(raw, eventId));
    const store = createEventGuestbookStore({ rpc: async () => ({ data: raw, error: null }) });
    for (const result of [await store.missions(actor, eventId), await store.guestMissions(eventId, "a".repeat(64), ownerId)]) {
      assert.equal(result.endsAt, "2026-09-25T13:30:00.000Z");
      assert.deepEqual(parseEventMissions(result, eventId), result);
    }
  }
  const store = createEventGuestbookStore({ rpc: async () => ({ data: { version: 1, eventId, revision: 0, missionIds: [], endsAt: "invalid", locked: false }, error: null }) });
  await assert.rejects(store.guestMissions(eventId, "a".repeat(64), ownerId), /unavailable/);
});
test("guestbook bounds count Unicode characters and reject unsafe controls or invented mission labels", () => {
  assert.equal(validateGuestbookText("🙂".repeat(500), "A".repeat(80)).message.length, 1000);
  for (const message of ["x".repeat(501), "bad\u0001text", "broken\ud800"]) assert.throws(() => validateGuestbookText(message, ""));
  assert.throws(() => validateGuestbookText("", "x".repeat(81))); assert.throws(() => validateGuestbookText("", "two\nlines"));
  assert.deepEqual(parseEventGuestbookNote(note, eventId), note);
  assert.throws(() => parseEventGuestbookNote({ ...note, mission: { ...note.mission, label: "Arbitrary mission" } }, eventId));
  assert.throws(() => parseEventGuestbookNote({ ...note, withdrawn: true }, eventId));
});
test("SQL mission labels match the existing versioned story catalogue", async () => {
  const sql = await readFile("database/migrations/023_v2_event_guestbook.sql", "utf8");
  for (const mission of EVENT_MISSIONS) assert.ok(sql.includes(`('${mission.id}',1,'${mission.label.replaceAll("'", "''")}')`));
});
test("save acknowledgement separates accepted request revision from later current text", async () => {
  const requestId = crypto.randomUUID(), calls: unknown[] = [], store = createEventGuestbookStore({ rpc: async (_name, args) => { calls.push(args); return { data: { acceptedRequestId: requestId, acceptedRevision: 1, current: note }, error: null }; } });
  const result = await store.save(eventId, "a".repeat(64), ownerId, submissionId, { requestId, expectedRevision: 0, message: "Original", signature: "" });
  assert.equal(result.acceptedRevision, 1); assert.equal(result.current.revision, 2); assert.equal(result.current.message, note.message); assert.equal(calls.length, 1);
});
test("private UTF-8 notes enter ZIP and fresh withdrawal blocks its later download", async () => {
  const appOrigin = "https://booth.example", storageOrigin = "https://storage.example", jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#c54d6d" } }).jpeg().toBuffer();
  const fixture = await createEventExportFixture({ appOrigin, storageOrigin, eventId, ownerId, image: new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }) }); let withdrawn = false;
  const fetcher: typeof fetch = async (input, init) => {
    const body = init?.method === "POST" ? JSON.parse(String(init.body)) : null;
    if (body?.operation === "guestbook") return Response.json({ submissionId: body.index === 0 ? submissionId : `20000000-0000-4000-8000-${String(body.index + 1).padStart(12, "0")}`, revision: body.index === 0 ? 2 : null, status: body.index === 0 ? withdrawn ? "unavailable" : "available" : "not_collected", note: body.index === 0 && !withdrawn ? note : null });
    const response = await fixture.fetch(input, init);
    if (body?.operation !== "page") return response;
    const page = await response.json(); page.entries = page.entries.map((entry: { index: number }) => ({ ...entry, guestbookRevision: entry.index === 0 ? 2 : null })); return Response.json(page);
  };
  const client = createEventExportClient({ appOrigin, storageOrigin, ...fixture, fetch: fetcher, decode: async () => ({ width: 8, height: 8, close() {} }) });
  try {
    await client.create(eventId, exportId); const batch = await prepareEventExportBatch(client, eventId, exportId, 0);
    const bytes = new TextDecoder().decode(await batch.blob.arrayBuffer()); assert.ok(bytes.includes("guestbook.txt")); assert.ok(bytes.includes(note.message)); assert.ok(bytes.includes('"revision": 2'));
    withdrawn = true; await assert.rejects(recheckEventExportBatch(client, batch), /access_denied/);
  } finally { client.close(); fixture.close(); }
});
