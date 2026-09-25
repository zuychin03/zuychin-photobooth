import assert from "node:assert/strict";
import test from "node:test";
import { closeRoomScope, registerRoomScopeCloser, roomScopeEpoch, roomScopeKey } from "../lib/rtc/scope-lifecycle";

test("scope shutdown invokes every exact-account fence synchronously and awaits all drains", async () => {
  const scope = { kind: "account" as const, ownerId: "scope-test-a" }, calls: string[] = []; let release!: () => void;
  const removeA = registerRoomScopeCloser(scope, () => { calls.push("controller"); return new Promise<void>(resolve => { release = resolve; }); });
  const removeB = registerRoomScopeCloser(scope, () => { calls.push("journal"); });
  const other = registerRoomScopeCloser({ kind: "account", ownerId: "scope-test-ab" }, () => { calls.push("other"); });
  const device = registerRoomScopeCloser({ kind: "device" }, () => { calls.push("device"); });
  const epoch = roomScopeEpoch(scope); let complete = false; const closing = closeRoomScope(scope).then(() => { complete = true; });
  assert.deepEqual(calls, ["controller", "journal"]); assert.equal(roomScopeEpoch(scope), epoch + 1); await Promise.resolve(); assert.equal(complete, false);
  release(); await closing; assert.equal(complete, true); removeA(); removeB(); other(); device();
});

test("one failed closer does not skip the remaining account writers", async () => {
  const scope = { kind: "account" as const, ownerId: "scope-test-errors" }; let called = false;
  const first = registerRoomScopeCloser(scope, () => { throw new Error("fixture failure"); }), second = registerRoomScopeCloser(scope, () => { called = true; });
  await assert.rejects(closeRoomScope(scope), /close_failed/); assert(called); first(); second();
  assert.throws(() => roomScopeKey({ kind: "account", ownerId: "foreign/path" }), /invalid/);
});
