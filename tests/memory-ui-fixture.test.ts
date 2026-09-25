import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createMemoryUIFixture } from "../lib/memories/memory-ui-fixture";
import { memoryAfter, type MemoryBrowse } from "../lib/memories/activity-browse";
import type { MemoryActivity } from "../lib/memories/activity-contract";

const query: MemoryBrowse = { year: 2026, timeZone: "Australia/Sydney", chapterId: null, after: null, limit: 20 };
const code = (value: string) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === value);
async function fixture() {
  const bytes = await sharp({ create: { width: 32, height: 48, channels: 3, background: "#eecabb" } }).png().toBuffer();
  return createMemoryUIFixture("https://app.test", { png: new Blob([new Uint8Array(bytes)], { type: "image/png" }), width: 32, height: 48 });
}
async function all(client: ReturnType<Awaited<ReturnType<typeof fixture>>["mount"]>["runtime"]["activity"], input = query) {
  const rows: MemoryActivity[] = []; let after = input.after;
  do { const page = await client.browse({ ...input, after }); rows.push(...page.items); after = page.nextCursor; } while (after);
  return rows;
}
test("real browse client pages chronologically beyond 20 rows with exact civil-year boundaries", async () => {
  const f = await fixture(), { activity } = f.mount(0).runtime;
  try {
    const first = await activity.browse(query), rows = await all(activity);
    assert.equal(first.items.length, 20); assert.ok(first.nextCursor); assert.ok(rows.length > 40);
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
    assert.ok(rows.every((row, index) => index === 0 || memoryAfter(row, rows[index - 1])));
    assert.ok(rows.some(row => row.occurredAt === "2025-12-31T20:30:00Z")); assert.ok(!rows.some(row => row.occurredAt === "2026-12-31T20:30:00Z"));
    assert.deepEqual(new Set(rows.filter(row => row.mine).map(row => row.availability)), new Set(["available", "archived", "archive_pending", "expired", "deleted", "unknown", "access_lost"]));
    const utc = await all(activity, { ...query, timeZone: "UTC" }); assert.ok(utc.some(row => row.occurredAt === "2026-12-31T20:30:00Z"));
  } finally { f.close(); }
});
test("chapters and occasion labels are exact-account private, including partner rows and filters", async () => {
  const f = await fixture(), a = f.mount(0).runtime.activity, b = f.mount(1).runtime.activity;
  try {
    const own = await a.chapters(), other = await b.chapters(); assert.notEqual(own[0].id, other[0].id); assert.match(other[0].title, /Bao/);
    const rows = await all(a); assert.ok(rows.some(row => !row.mine)); assert.ok(rows.filter(row => !row.mine).every(row => row.annotation === null));
    const filtered = await all(a, { ...query, chapterId: own[0].id }); assert.ok(filtered.length); assert.ok(filtered.every(row => row.mine && row.annotation?.chapterId === own[0].id));
    await assert.rejects(b.browse({ ...query, chapterId: own[0].id }), code("access_denied"));
    await assert.rejects(b.putChapter({ id: own[0].id, title: "Foreign edit", expectedRevision: own[0].revision }), code("access_denied"));
    const partner = rows.find(row => !row.mine)!; await assert.rejects(a.annotate({ id: partner.id, expectedRevision: 0, chapterId: null, occasion: "Private" }), code("access_denied"));
  } finally { f.close(); }
});
test("chapter and annotation lifecycle honours CAS, non-empty delete and lost acknowledgement recovery", async () => {
  const f = await fixture(), a = f.mount(0).runtime.activity;
  try {
    const id = "90000000-0000-4000-8000-000000000001", request = { id, expectedRevision: -1, title: "New chapter" };
    f.failNext("before"); await assert.rejects(a.putChapter(request), code("network_error")); assert.ok(!(await a.chapters()).some(row => row.id === id));
    f.failNext("after"); await assert.rejects(a.putChapter(request), code("network_error"));
    const created = (await a.chapters()).find(row => row.id === id)!; assert.equal(created.revision, 0);
    await assert.rejects(a.putChapter(request), code("conflict")); assert.equal((await a.chapters()).filter(row => row.id === id).length, 1);
    const renamed = await a.putChapter({ id, expectedRevision: 0, title: "Renamed chapter" }); assert.equal(renamed.revision, 1);
    await assert.rejects(a.putChapter({ id, expectedRevision: 0, title: "Stale" }), code("conflict"));
    const row = (await all(a)).find(row => row.mine)!;
    f.failNext("after"); await assert.rejects(a.annotate({ id: row.id, expectedRevision: row.annotation!.revision, chapterId: id, occasion: "Anniversary" }), code("network_error"));
    const recovered = (await all(a)).find(item => item.id === row.id)!; assert.equal(recovered.annotation!.occasion, "Anniversary");
    await assert.rejects(a.deleteChapter(id, 1), code("chapter_not_empty"));
    await a.annotate({ id: row.id, expectedRevision: recovered.annotation!.revision, chapterId: null, occasion: null });
    assert.deepEqual(await a.deleteChapter(id, 1), { deleted: true });
  } finally { f.close(); }
});
test("retained download verifies actual PNG headers and digest while unavailable or revoked originals fail closed", async () => {
  const f = await fixture(), runtime = f.mount(0).runtime;
  try {
    const rows = await all(runtime.activity), item = rows.find(row => row.availability === "archived")!, unavailable = rows.find(row => row.availability === "expired")!;
    const resolved = await runtime.retained.resolve(item.source!.id), downloaded = await runtime.retained.download(item.source!.id);
    assert.equal(resolved.availability, "archived"); assert.equal(downloaded.width, 32); assert.equal(downloaded.height, 48); assert.equal(downloaded.sha256.length, 64); assert.ok(downloaded.blob.size < 1024);
    await assert.rejects(runtime.retained.download(unavailable.source!.id), code("source_unavailable"));
    f.revokeAvailable(); await assert.rejects(runtime.retained.download(item.source!.id), code("access_denied"));
    const after = await all(runtime.activity); assert.ok(after.filter(row => row.availability === "access_lost").every(row => row.mine && row.source === null));
    assert.deepEqual(await runtime.projects.list(), { projects: [], nextCursor: null });
  } finally { f.close(); }
});
test("unpair removes partner discovery but retains own UTC counts and minimal participation; closed sessions cannot read", async () => {
  const f = await fixture(), session = f.mount(0), a = session.runtime.activity;
  try {
    const before = await a.summary(2026); assert.equal(before.timezone, "UTC"); assert.equal(before.basis, "own_source_records"); assert.equal(before.months.reduce((sum, month) => sum + month.total, 0), 37);
    assert.ok((await all(a)).some(row => !row.mine)); f.unpair();
    const after = await all(a); assert.ok(after.every(row => row.mine)); assert.ok(after.some(row => row.availability === "access_lost" && row.source === null));
    assert.deepEqual(await a.summary(2026), before); assert.equal((await a.chapters()).length, 1);
    session.close(); await assert.rejects(a.chapters(), code("account_changed"));
  } finally { f.close(); }
});
