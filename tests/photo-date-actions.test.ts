import test from "node:test";
import assert from "node:assert/strict";
import { createPhotoDate, deletePhotoDate } from "../lib/photo-dates";
import type { createClient } from "../lib/supabase/client";

function fixture() {
  let row: Record<string, unknown> | null = null, inserts = 0, removes = 0, failDelete = false, loseInsert = false;
  const client = { from(table: string) {
    assert.equal(table, "pb_photo_dates"); let operation = "select", value: Record<string, unknown>;
    const builder = { select() { return builder; }, eq(_key: string, id: string) { assert.equal(id, "date-1"); return builder; }, abortSignal(signal: AbortSignal) { if (signal.aborted) throw new Error("cancelled"); return builder; }, async maybeSingle() { return { data: row, error: null }; },
      insert(next: Record<string, unknown>) { operation = "insert"; value = next; return builder; }, delete() { operation = "delete"; return builder; },
      then(resolve: (value: { error: null | { message: string; code?: string } }) => unknown) {
        if (operation === "insert") { inserts++; row = value; return Promise.resolve(resolve({ error: loseInsert ? { message: "acknowledgement lost" } : null })); }
        removes++; if (failDelete) return Promise.resolve(resolve({ error: { message: "permission denied", code: "42501" } })); row = null; return Promise.resolve(resolve({ error: null }));
      } };
    return builder;
  } } as unknown as ReturnType<typeof createClient>;
  return { client, denyDelete() { failDelete = true; }, allowDelete() { failDelete = false; }, loseInsert() { loseInsert = true; }, get row() { return row; }, get inserts() { return inserts; }, get removes() { return removes; } };
}
const desired = { title: "A photo date", scheduledAt: "2026-09-25T09:00:00.000Z", cadence: "weekly" as const };
test("a resolved database deletion error remains failure and the reminder stays present", async () => {
  const f = fixture(); await createPhotoDate("owner", "couple", desired, { id: "date-1", client: f.client }); f.denyDelete();
  await assert.rejects(deletePhotoDate("date-1", { client: f.client }), { message: "permission denied" }); assert(f.row);
  f.allowDelete(); await deletePhotoDate("date-1", { client: f.client }); assert.equal(f.row, null);
});
test("lost creation acknowledgement replays the exact ID without inserting another reminder", async () => {
  const f = fixture(); f.loseInsert(); const options = { id: "date-1", client: f.client };
  await assert.rejects(createPhotoDate("owner", "couple", desired, options)); assert(f.row);
  await createPhotoDate("owner", "couple", desired, options); assert.equal(f.inserts, 1);
  await assert.rejects(createPhotoDate("owner", "couple", { ...desired, title: "Changed" }, options), /changed/); assert.equal(f.inserts, 1);
});
test("an aborted actor action cannot begin a reminder insert or deletion", async () => {
  const f = fixture(), abort = new AbortController(); abort.abort();
  await assert.rejects(createPhotoDate("owner", "couple", desired, { id: "date-1", client: f.client, signal: abort.signal }));
  await assert.rejects(deletePhotoDate("date-1", { client: f.client, signal: abort.signal })); assert.equal(f.inserts, 0); assert.equal(f.removes, 0);
});
