import assert from "node:assert/strict";
import test from "node:test";
import { loadRecentProjects } from "../lib/projects/recent";
import type { ProjectScope } from "../lib/projects/model";

test("recent projects read only device and exact account metadata, sorted and bounded to three", async () => {
  const scopes: ProjectScope[] = [], closed: ProjectScope[] = [];
  const result = await loadRecentProjects("account-a", () => {}, async scope => {
    scopes.push(scope);
    return { close: () => { closed.push(scope); }, list: async () => [1, 2, 3].map(n => ({ id: `project-${n}`, name: `Draft ${n}`, revision: 0, readOnly: n === 3, updatedAt: `2026-09-2${n}T00:00:00.000Z` })) };
  });
  assert.deepEqual(scopes, [{ kind: "device" }, { kind: "account", ownerId: "account-a" }]);
  assert.deepEqual(closed, scopes);
  assert.equal(result.length, 3);
  assert.equal(new Set(result.map(item => item.key)).size, 3);
  assert.equal(result[0].updatedAt, "2026-09-23T00:00:00.000Z");
  assert.equal(result[0].readOnly, true);
});

test("signed-out recent projects never open an account repository", async () => {
  let opened = 0;
  assert.deepEqual(await loadRecentProjects(null, () => {}, async scope => {
    assert.deepEqual(scope, { kind: "device" }); opened++;
    return { close() {}, list: async () => [] };
  }), []);
  assert.equal(opened, 1);
});

test("account replacement during a late repository open or list discards metadata and closes the handle", async () => {
  for (const stage of ["open", "list"]) {
    let active = true, closes = 0, lists = 0;
    await assert.rejects(loadRecentProjects("old-owner", () => { if (!active) throw new Error("account_changed"); }, async () => {
      if (stage === "open") active = false;
      return { close() { closes++; }, list: async () => { lists++; active = false; return [{ id: "private", name: "Private name", revision: 0, readOnly: false, updatedAt: null }]; } };
    }), /account_changed/);
    assert.equal(closes, 1);
    assert.equal(lists, stage === "open" ? 0 : 1);
  }
});
