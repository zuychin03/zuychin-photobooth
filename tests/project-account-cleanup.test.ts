import assert from "node:assert/strict";
import test from "node:test";
import { removeLocalAccountCopies } from "../lib/projects/account-cleanup";
import type { ProjectListItem } from "../lib/projects/storage";

const row = (id: string, readOnly = false, revision = 2): ProjectListItem => ({ id, name: id, readOnly, revision, updatedAt: "2026-09-23T00:00:00.000Z" });

test("account removal opens only the requested account and preserves unsupported/corrupt drafts", async () => {
  let rows = [row("current"), row("future", true), row("corrupt", true)], closed = false;
  const calls: [string, number][] = [];
  const result = await removeLocalAccountCopies("account-a", async scope => {
    assert.deepEqual(scope, { kind: "account", ownerId: "account-a" });
    return { list: async () => rows, delete: async (id, revision) => { calls.push([id, revision]); rows = rows.filter(item => item.id !== id); }, close: () => { closed = true; } };
  });
  assert.deepEqual(calls, [["current", 2]]);
  assert.deepEqual(result, { removed: 1, retained: 2, incomplete: false });
  assert(closed);
});

test("racing revision or deletion failure keeps that draft while continuing independent removals", async () => {
  let rows = [row("changed", false, 5), row("safe", false, 3)];
  const result = await removeLocalAccountCopies("account-a", async () => ({ list: async () => rows, delete: async (id, revision) => {
    if (id === "changed") { assert.equal(revision, 5); throw new Error("revision conflict"); }
    rows = rows.filter(item => item.id !== id);
  }, close: () => {} }));
  assert.deepEqual(result, { removed: 1, retained: 1, incomplete: true });
});

test("a draft appearing during cleanup is reported as retained", async () => {
  let reads = 0;
  const result = await removeLocalAccountCopies("account-a", async () => ({ list: async () => ++reads === 1 ? [] : [row("new-from-another-tab")], delete: async () => { throw new Error("must not delete an unlisted revision"); }, close: () => {} }));
  assert.deepEqual(result, { removed: 0, retained: 1, incomplete: false });
});

test("unreadable storage cannot be reported as successful account cleanup", async () => {
  let closed = false;
  await assert.rejects(removeLocalAccountCopies("account-a", async () => ({ list: async () => { throw new Error("database unavailable"); }, delete: async () => {}, close: () => { closed = true; } })), /unavailable/);
  assert(closed);
  await assert.rejects(removeLocalAccountCopies("account-a", async () => { throw new Error("blocked open"); }), /blocked/);
});
