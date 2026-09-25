import assert from "node:assert/strict";
import test from "node:test";
import { assertTemplateWrite, openTemplateShelf } from "../lib/templates/storage";
import { validateTemplateRecipe } from "../lib/templates/model";
import { templateFixture } from "./helpers/template-fixture";

test("shelf CAS rejects stale, skipped and mismatched scope writes without changing inputs", () => {
  const previous = templateFixture(), next = validateTemplateRecipe({ ...previous, revision: 1 });
  assert.doesNotThrow(() => assertTemplateWrite(null, previous, null, previous.scope));
  assert.doesNotThrow(() => assertTemplateWrite(previous, next, 0, previous.scope));
  assert.throws(() => assertTemplateWrite(next, next, 0, previous.scope), /another tab/);
  assert.throws(() => assertTemplateWrite(previous, previous, 0, previous.scope), /exactly once/);
  assert.throws(() => assertTemplateWrite(null, next, null, previous.scope), /exactly once/);
  assert.throws(() => assertTemplateWrite(previous, next, 0, { kind: "device" }), /scope/);
  assert.equal(previous.revision, 0);
});
test("shelf refuses identity rebinding and clock regression", () => {
  const previous = templateFixture(), next = { ...previous, revision: 1 };
  for (const change of [{ id: "other" }, { createdAt: "2026-09-22T00:00:00.000Z" }, { updatedAt: "2026-09-22T00:00:00.000Z" }]) {
    assert.throws(() => assertTemplateWrite(previous, { ...next, ...change }, 0, previous.scope), /cannot change/);
  }
});
test("unavailable IndexedDB fails honestly before any saved claim", async () => {
  await assert.rejects(openTemplateShelf({ kind: "device" }), /unavailable/);
});
test("late database opens after the timeout are closed and never returned", async () => {
  let closed = false;
  const request = { onblocked: null as (() => void) | null, onupgradeneeded: null, onerror: null, onsuccess: null as (() => void) | null, result: { close: () => { closed = true; } } };
  const indexedDB = { open: () => request } as unknown as IDBFactory;
  await assert.rejects(openTemplateShelf({ kind: "device" }, { indexedDB, timeoutMs: 1 }), /did not open/);
  request.onsuccess?.(); assert.equal(closed, true);
});
