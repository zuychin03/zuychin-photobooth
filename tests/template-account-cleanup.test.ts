import assert from "node:assert/strict";
import test from "node:test";
import { removeLocalAccountTemplates } from "../lib/templates/account-cleanup";

test("intentional account cleanup only deletes supported templates in the exact requested scope", async () => {
  let closed = false, calls = 0;
  const rows = [{ id: "current", revision: 3, readOnly: false, name: "Current", updatedAt: null }, { id: "future", revision: 7, readOnly: true, name: "Future", updatedAt: null }];
  const result = await removeLocalAccountTemplates("account-owner", async scope => {
    assert.deepEqual(scope, { kind: "account", ownerId: "account-owner" });
    return { list: async () => rows, delete: async (id, revision) => { calls++; assert.equal(id, "current"); assert.equal(revision, 3); rows.splice(0, 1); }, close: () => { closed = true; } };
  });
  assert.equal(calls, 1); assert.equal(closed, true); assert.deepEqual(result, { removed: 1, retained: 1, incomplete: false });
});
test("failed deletion is reported and storage always closes", async () => {
  let closed = false;
  const result = await removeLocalAccountTemplates("account-owner", async () => ({ list: async () => [{ id: "changed", revision: 1, readOnly: false, name: "Changed", updatedAt: null }], delete: async () => { throw new Error("Stale revision"); }, close: () => { closed = true; } }));
  assert.deepEqual(result, { removed: 0, retained: 1, incomplete: true }); assert.equal(closed, true);
});
