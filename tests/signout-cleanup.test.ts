import test from "node:test";
import assert from "node:assert/strict";
import { cleanupSignedOutAccount, type SignOutCleanupPorts } from "../lib/projects/signout-cleanup";

function fixture() {
  const calls: string[] = [];
  const ports: SignOutCleanupPorts = {
    rooms: async () => { calls.push("rooms"); return { checkpoints: 1, transfers: 2, shots: 3 }; },
    drainEditors: async () => { calls.push("drain"); },
    projects: async () => { calls.push("projects"); return { removed: 2, retained: 0, incomplete: false }; },
    templates: async () => { calls.push("templates"); return { removed: 3, retained: 0, incomplete: false }; },
    uploads: async () => { calls.push("uploads"); return { removed: 4 }; },
  };
  return { calls, ports };
}
test("room cleanup failure does not skip editor, project, template or upload cleanup", async () => {
  const f = fixture(); f.ports.rooms = async () => { throw new Error("blocked room database"); };
  const result = await cleanupSignedOutAccount(f.ports);
  assert.deepEqual(new Set(f.calls), new Set(["drain", "projects", "templates", "uploads"]));
  assert.deepEqual(result, { cleanup: { removed: 9, retained: 0, incomplete: true }, cleanupError: true });
});
test("editor drain failure blocks only project deletion", async () => {
  const f = fixture(); f.ports.drainEditors = async () => { throw new Error("drain failed"); };
  const result = await cleanupSignedOutAccount(f.ports);
  assert.deepEqual(new Set(f.calls), new Set(["rooms", "templates", "uploads"]));
  assert.equal(result.cleanup.removed, 7); assert.equal(result.cleanup.incomplete, true); assert.equal(result.cleanupError, true); assert.equal(result.roomCleanup?.checkpoints, 1);
});
test("independent branches run while editor drain waits, project deletion waits for drain", async () => {
  const f = fixture(); let release!: () => void;
  f.ports.drainEditors = () => new Promise(resolve => { release = resolve; });
  const pending = cleanupSignedOutAccount(f.ports); await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(new Set(f.calls), new Set(["rooms", "templates", "uploads"]));
  release(); const result = await pending; assert.equal(f.calls.at(-1), "projects"); assert.equal(result.cleanup.removed, 9); assert.equal(result.cleanupError, false);
});
test("partial retention and rejected upload cleanup preserve accurate aggregate reporting", async () => {
  const f = fixture();
  f.ports.projects = async () => ({ removed: 1, retained: 2, incomplete: true });
  f.ports.uploads = async () => { throw new Error("blocked upload database"); };
  const result = await cleanupSignedOutAccount(f.ports);
  assert.deepEqual(result.cleanup, { removed: 4, retained: 2, incomplete: true }); assert.equal(result.cleanupError, true); assert.ok(result.roomCleanup);
});
test("synchronous branch failures are isolated and all-success results preserve counts", async () => {
  const f = fixture(); f.ports.templates = () => { throw new Error("unavailable storage"); };
  const partial = await cleanupSignedOutAccount(f.ports); assert.equal(partial.cleanup.removed, 6); assert.equal(partial.cleanupError, true);
  const result = await cleanupSignedOutAccount(fixture().ports);
  assert.deepEqual(result, { cleanup: { removed: 9, retained: 0, incomplete: false }, cleanupError: false, roomCleanup: { checkpoints: 1, transfers: 2, shots: 3 } });
});
