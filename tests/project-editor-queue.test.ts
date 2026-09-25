import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectEditorQueue, ProjectEditorRecoveryRegistry, projectEditorIdentity } from "../lib/projects/editor-queue";
import { createProject, type ProjectEditorSettings } from "../lib/projects/model";

function deferred() { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const initial = () => createProject().editor;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test("optimistic edits update immediately while only one write and latest snapshot are retained", async () => {
  const first = deferred(), second = deferred();
  const writes: Partial<ProjectEditorSettings>[] = [];
  const queue = new ProjectEditorQueue(initial(), async editor => { writes.push(editor); await (writes.length === 1 ? first.promise : second.promise); });
  queue.setField("caption", "first");
  await turn();
  for (let i = 0; i < 100; i++) queue.setField("caption", `latest-${i}`);
  queue.setField("frameId", "rose");
  assert.equal(queue.getSnapshot().editor.caption, "latest-99");
  assert.equal(queue.getSnapshot().editor.frameId, "rose");
  assert.equal(writes.length, 1);
  const flush = queue.flush();
  first.resolve();
  await turn();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].caption, "latest-99");
  assert.equal(writes[1].frameId, "rose");
  assert.equal(queue.getSnapshot().pending, true);
  second.resolve(); await flush;
  assert.equal(queue.getSnapshot().pending, false);
});

test("failed writes retain local edits and stop retrying until explicit flush", async () => {
  let calls = 0;
  const queue = new ProjectEditorQueue(initial(), async editor => { calls++; assert.equal(editor.caption, "keep me"); if (calls === 1) throw new Error("Disk full"); });
  queue.setField("caption", "keep me");
  await turn();
  assert.equal(calls, 1);
  assert.equal(queue.getSnapshot().error, "Disk full");
  assert.equal(queue.getSnapshot().pending, true);
  assert.equal(queue.getSnapshot().editor.caption, "keep me");
  await turn(); assert.equal(calls, 1);
  await queue.flush();
  assert.equal(calls, 2);
  assert.equal(queue.getSnapshot().error, null);
  assert.equal(queue.getSnapshot().pending, false);
});

test("flush reports unresolved failures and cannot claim export-ready", async () => {
  const queue = new ProjectEditorQueue(initial(), async () => { throw new Error("Storage blocked"); });
  queue.setField("caption", "unsaved");
  await assert.rejects(queue.flush(), /Storage blocked/);
  assert.equal(queue.getSnapshot().pending, true);
  assert.equal(queue.getSnapshot().editor.caption, "unsaved");
});

test("latest edit during failed in-flight save remains intact and retry writes newest snapshot", async () => {
  const first = deferred();
  const writes: Partial<ProjectEditorSettings>[] = [];
  const queue = new ProjectEditorQueue(initial(), async editor => { writes.push(editor); if (writes.length === 1) await first.promise; });
  queue.setField("caption", "old"); await turn();
  queue.setField("caption", "new");
  first.reject(new Error("Quota")); await turn();
  assert.equal(queue.getSnapshot().editor.caption, "new");
  assert.equal(writes.length, 1);
  await queue.flush();
  assert.equal(writes[1].caption, "new");
});

test("functional edits use latest local state and detached snapshots cannot be mutated by callers", async () => {
  const queue = new ProjectEditorQueue(initial(), async () => {});
  queue.setField("caption", "a");
  queue.setField("caption", previous => previous + "b");
  const places = { A: { dx: 0, dy: 0, scale: 1 } };
  queue.patch({ places }); places.A.scale = 1.6;
  assert.equal(queue.getSnapshot().editor.caption, "ab");
  assert.equal(queue.getSnapshot().editor.places.A?.scale, 1);
  assert(Object.isFrozen(queue.getSnapshot().editor.places.A));
  await queue.flush();
});

test("history replacement refuses unsaved changes and only adopts explicit committed editor state", async () => {
  const pending = deferred();
  const queue = new ProjectEditorQueue(initial(), async () => pending.promise);
  queue.setField("caption", "edit");
  assert.throws(() => queue.replaceFromProject(initial()), /Save pending/);
  pending.resolve(); await queue.flush();
  queue.replaceFromProject({ ...initial(), caption: "restored" });
  assert.equal(queue.getSnapshot().editor.caption, "restored");
  assert.equal(queue.getSnapshot().pending, false);
});

test("disposing an editor prevents its queued private state from writing into the next project", async () => {
  const pending = deferred();
  const writes: Partial<ProjectEditorSettings>[] = [];
  const queue = new ProjectEditorQueue(initial(), async editor => { writes.push(editor); await pending.promise; });
  queue.setField("caption", "first"); await turn();
  queue.setField("caption", "private queued text");
  queue.dispose(); pending.resolve(); await turn();
  assert.equal(writes.length, 1);
  await assert.rejects(queue.flush(), /closed/);
  assert.throws(() => queue.setField("caption", "late edit"), /closed/);
});

test("strict-effect cleanup and reactivation keeps the current mounted queue usable", async () => {
  const writes: Partial<ProjectEditorSettings>[] = [];
  const queue = new ProjectEditorQueue(initial(), async editor => { writes.push(editor); });
  queue.dispose(); queue.activate();
  queue.setField("caption", "mounted"); await queue.flush();
  assert.equal(writes[0].caption, "mounted");
});

test("normal SPA unmount finishes the latest queued edit and releases recovery warning", async () => {
  const first = deferred(), writes: string[] = [], pendingCounts: number[] = [];
  const registry = new ProjectEditorRecoveryRegistry(8, count => pendingCounts.push(count));
  const queue = registry.acquire("device/project", initial(), async editor => { writes.push(editor.caption!); if (writes.length === 1) await first.promise; });
  queue.setField("caption", "first"); await turn();
  queue.setField("caption", "latest"); queue.detach();
  assert.equal(registry.size, 1);
  first.resolve(); await queue.flush();
  assert.deepEqual(writes, ["first", "latest"]);
  assert.equal(registry.size, 0);
  assert.deepEqual(pendingCounts, [1, 0]);
});

test("identity-fenced navigation failure retains latest edits for the original project's reopening", async () => {
  const first = deferred(), registry = new ProjectEditorRecoveryRegistry();
  let active = "project-a";
  const writes: string[] = [];
  const boundPersist = async (editor: Partial<ProjectEditorSettings>) => {
    if (active !== "project-a") throw new Error("The active project changed");
    if (editor.caption === "first") await first.promise;
    writes.push(`project-a:${editor.caption}`);
  };
  const queue = registry.acquire("account/owner-a/project-a", initial(), boundPersist);
  queue.setField("caption", "first"); await turn();
  queue.setField("caption", "latest retained"); queue.detach();
  active = "project-b"; first.resolve(); await turn();
  assert.deepEqual(writes, ["project-a:first"]);
  assert.equal(queue.getSnapshot().error, "The active project changed");
  const other = registry.acquire("account/owner-a/project-b", initial(), async () => {});
  assert.equal(other.getSnapshot().editor.caption, "");
  const anotherOwner = registry.acquire("account/owner-b/project-a", initial(), async () => {});
  assert.equal(anotherOwner.getSnapshot().editor.caption, "");
  const recovered = registry.acquire("account/owner-a/project-a", initial(), boundPersist);
  assert.equal(recovered, queue);
  assert.equal(recovered.getSnapshot().editor.caption, "latest retained");
  active = "project-a"; recovered.setPersist(boundPersist); await recovered.flush();
  assert.deepEqual(writes, ["project-a:first", "project-a:latest retained"]);
  assert.equal(registry.size, 0);
});

test("unsaved registry never evicts dirty drafts and refuses editing beyond its bound", async () => {
  const registry = new ProjectEditorRecoveryRegistry(2);
  const fail = async () => { throw new Error("Quota exceeded"); };
  const a = registry.acquire("a", initial(), fail), b = registry.acquire("b", initial(), fail), c = registry.acquire("c", initial(), fail);
  a.setField("caption", "keep a"); b.setField("caption", "keep b"); await turn();
  c.setField("caption", "cannot accept yet");
  assert.equal(registry.size, 2);
  assert.equal(c.getSnapshot().editor.caption, "");
  assert.equal(c.getSnapshot().pending, false);
  assert.match(c.getSnapshot().error!, /2 unsaved projects/);
  assert.equal(registry.acquire("a", initial(), fail).getSnapshot().editor.caption, "keep a");
  a.discardUnsaved();
  assert.equal(registry.size, 1);
  c.setField("caption", "accepted after space freed"); await turn();
  assert.equal(c.getSnapshot().editor.caption, "accepted after space freed");
  assert.equal(registry.size, 2);
  assert.equal(registry.acquire("b", initial(), fail).getSnapshot().editor.caption, "keep b");
});

test("explicit discard restores the last confirmed editor and refuses an ambiguous in-flight discard", async () => {
  const pending = deferred(), registry = new ProjectEditorRecoveryRegistry();
  let fail = false;
  const queue = registry.acquire("project", initial(), async () => { await pending.promise; if (fail) throw new Error("Quota"); });
  queue.setField("caption", "committed");
  assert.throws(() => queue.discardUnsaved(), /current save/);
  pending.resolve(); await queue.flush();
  fail = true; queue.setField("caption", "discard me"); await turn();
  queue.discardUnsaved();
  assert.equal(queue.getSnapshot().editor.caption, "committed");
  assert.equal(queue.getSnapshot().pending, false);
  assert.equal(queue.getSnapshot().error, null);
  assert.equal(registry.size, 0);
});

test("discard can adopt the latest durable editor after a conflicting external writer", async () => {
  const registry = new ProjectEditorRecoveryRegistry();
  const queue = registry.acquire("project", initial(), async () => { throw new Error("Stale revision"); });
  queue.setField("caption", "uncommitted local edit"); await turn();
  queue.discardUnsaved({ ...initial(), caption: "external writer's durable edit" });
  assert.equal(queue.getSnapshot().editor.caption, "external writer's durable edit");
  assert.equal(queue.getSnapshot().pending, false);
  assert.equal(registry.size, 0);
});

test("intentional deletion drains active writes, cancels successors and permanently retires the old queue", async () => {
  const pending = deferred(), registry = new ProjectEditorRecoveryRegistry();
  const writes: string[] = [];
  const queue = registry.acquire("deleted", initial(), async editor => { await pending.promise; writes.push(editor.caption!); });
  queue.setField("caption", "in flight"); await turn();
  queue.setField("caption", "must never resurrect");
  let completed = false;
  const deletion = registry.discardIdentity("deleted").then(() => { completed = true; });
  await turn(); assert.equal(completed, false);
  pending.resolve(); await deletion; await turn();
  assert.deepEqual(writes, ["in flight"]);
  assert.equal(registry.size, 0);
  queue.activate();
  assert.throws(() => queue.setField("caption", "stale callback"), /closed/);
  assert.equal(registry.size, 0);
  const replacement = registry.acquire("deleted", initial(), async () => {});
  assert.notEqual(replacement, queue);
  assert.equal(replacement.getSnapshot().editor.caption, "");
});

test("intentional account-copy removal discards only the exact account scope", async () => {
  const registry = new ProjectEditorRecoveryRegistry(), fail = async () => { throw new Error("Quota"); };
  const identities = [
    { id: "same", scope: { kind: "device" } as const },
    { id: "same", scope: { kind: "account", ownerId: "owner-a" } as const },
    { id: "another", scope: { kind: "account", ownerId: "owner-a" } as const },
    { id: "same", scope: { kind: "account", ownerId: "owner-ab" } as const },
  ];
  for (const identity of identities) registry.acquire(projectEditorIdentity(identity), initial(), fail).setField("caption", identity.id);
  await turn();
  await registry.discardScope({ kind: "account", ownerId: "owner-a" });
  assert.equal(registry.size, 2);
  assert.equal(registry.acquire(projectEditorIdentity(identities[1]), initial(), fail).getSnapshot().pending, false);
  assert.equal(registry.acquire(projectEditorIdentity(identities[0]), initial(), fail).getSnapshot().pending, true);
  assert.equal(registry.acquire(projectEditorIdentity(identities[3]), initial(), fail).getSnapshot().pending, true);
});

test("template preparation flushes every coalesced pending edit for the exact project identity", async () => {
  const registry = new ProjectEditorRecoveryRegistry(), pending = deferred(), writes: string[] = [];
  const queue = registry.acquire("device/project", initial(), async editor => { if (!writes.length) await pending.promise; writes.push(editor.caption!); });
  queue.setField("caption", "first"); await turn(); queue.setField("caption", "latest");
  let finished = false;
  const flush = registry.flushIdentity("device/project").then(() => { finished = true; });
  await registry.flushIdentity("account:other/project"); await turn(); assert.equal(finished, false);
  pending.resolve(); await flush;
  assert.deepEqual(writes, ["first", "latest"]); assert.equal(registry.size, 0);
});
