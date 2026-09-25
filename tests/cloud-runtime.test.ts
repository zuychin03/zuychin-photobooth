import type { ChallengeDraftJournal } from "../lib/memories/challenge-drafts";
import test from "node:test";
import assert from "node:assert/strict";
import { openAccountCloudRuntime, type AccountCloudRuntimePorts } from "../lib/projects/cloud-runtime";
import type { CloudIdentity, CloudProjectClient } from "../lib/projects/cloud-client";
import type { CloudUploadJournal, CloudUploadManager } from "../lib/projects/cloud-upload";
import type { ChallengeClient } from "../lib/memories/challenge-client";
import type { CloudDesignJournal } from "../lib/projects/cloud-design-journal";
import type { CloudDesignSaveCoordinator } from "../lib/projects/cloud-design-save";
const owner = "00000000-0000-4000-8000-000000000001", other = "00000000-0000-4000-8000-000000000002";
function fixture() {
  const closed = { client: 0, journal: 0, drafts: 0, designs: 0, challenges: 0, uploads: 0, subscription: 0, invalidated: 0 };
  let listener: ((value: string | null) => void) | undefined, identity: (() => CloudIdentity | null) | undefined;
  let finish!: (value: CloudUploadJournal) => void;
  const journal = { ownerId: owner, close() { closed.journal++; } } as CloudUploadJournal;
  const client = { ownerId: owner, close() { closed.client++; }, assertActive() { if (!identity?.()) throw new Error("account_changed"); } } as CloudProjectClient;
  const challenges = { ownerId: owner, close() { closed.challenges++; } } as ChallengeClient;
  const uploads = { close() { closed.uploads++; } } as CloudUploadManager;
  const ports: AccountCloudRuntimePorts = {
    client(options) { identity = options.identity; return client; },
    journal: async (_owner, options) => { assert.equal(options.identity()?.ownerId, owner); return new Promise(resolve => { finish = resolve; }); },
    drafts: async () => ({ ownerId: owner, close() { closed.drafts++; } } as ChallengeDraftJournal),
    designJournal: async () => ({ ownerId: owner, close() { closed.designs++; } } as CloudDesignJournal),
    designs: options => ({ ownerId: owner, close() { options.journal.close(); } } as CloudDesignSaveCoordinator),
    challenges: () => challenges, uploads: () => uploads,
  };
  const options = { ownerId: owner, appOrigin: "https://app.test", storageOrigin: "https://storage.test", accessToken: async () => "fixture", subscribe(callback: (id: string | null) => void) { listener = callback; return () => { closed.subscription++; }; }, onInvalidated() { closed.invalidated++; } };
  return { closed, ports, options, journal, client, identity: () => identity?.(), emit: (value: string | null) => listener?.(value), resolve: () => finish(journal) };
}
test("account runtime shares one fenced client, journal and challenge lifetime", async () => {
  const f = fixture(), handle = openAccountCloudRuntime(f.options, f.ports); await Promise.resolve(); f.resolve(); const runtime = await handle.ready;
  assert.equal(runtime.client, f.client); assert.equal(f.identity()?.ownerId, owner);
  f.emit(owner); assert.equal(f.closed.client, 0); f.emit(other);
  assert.equal(f.identity(), null); assert.deepEqual(f.closed, { client: 1, journal: 1, drafts: 1, designs: 1, challenges: 1, uploads: 1, subscription: 1, invalidated: 1 });
  handle.close(); assert.equal(f.closed.client, 1);
});
test("logout while IndexedDB opens closes a late journal without publishing a runtime", async () => {
  const f = fixture(), handle = openAccountCloudRuntime(f.options, f.ports); await Promise.resolve(); f.emit(null); f.resolve();
  await assert.rejects(handle.ready, /account_changed/); assert.equal(f.closed.journal, 1); assert.equal(f.closed.challenges, 0); assert.equal(f.closed.uploads, 0); assert.equal(f.closed.subscription, 1);
});
test("unmount before setup has no subscription or storage side effects", async () => {
  const f = fixture(), handle = openAccountCloudRuntime(f.options, f.ports); handle.close(); await assert.rejects(handle.ready, /cancelled/);
  assert.equal(f.identity(), undefined); assert.equal(f.closed.subscription, 0); assert.equal(f.closed.invalidated, 0);
});
test("synchronous changed-account callback during subscribe is fully cleaned up", async () => {
  const f = fixture(), handle = openAccountCloudRuntime({ ...f.options, subscribe(callback) { callback(other); return () => { f.closed.subscription++; }; } }, f.ports);
  await assert.rejects(handle.ready, /account_changed/); assert.equal(f.closed.subscription, 1); assert.equal(f.identity(), undefined);
});
test("construction failures close preceding resources and unsubscribe", async () => {
  const f = fixture(), handle = openAccountCloudRuntime(f.options, { ...f.ports, challenges: () => { throw new Error("configuration"); } }); await Promise.resolve(); f.resolve();
  await assert.rejects(handle.ready, /configuration/); assert.equal(f.closed.client, 1); assert.equal(f.closed.journal, 1); assert.equal(f.closed.subscription, 1);
});
test("reopening the same account receives a distinct epoch and cannot resurrect the old identity", async () => {
  const f = fixture(), first = openAccountCloudRuntime(f.options, f.ports); await Promise.resolve(); f.resolve(); await first.ready; const epoch = f.identity()!.epoch; first.close();
  const g = fixture(), next = openAccountCloudRuntime(g.options, g.ports); await Promise.resolve(); g.resolve(); await next.ready;
  assert.notEqual(g.identity()!.epoch, epoch); assert.equal(f.identity(), null); next.close();
});

test("account loss while request recovery opens closes both journals before exposing UI", async () => {
  const f = fixture(); let finish!: (value: ChallengeDraftJournal) => void, entered!: () => void;
  const opening = new Promise<void>(resolve => { entered = resolve; }); let closed = 0;
  const handle = openAccountCloudRuntime(f.options, { ...f.ports, drafts: async () => { entered(); return new Promise(resolve => { finish = resolve; }); } });
  await Promise.resolve(); f.resolve(); await opening; f.emit(other);
  finish({ ownerId: owner, close() { closed++; } } as ChallengeDraftJournal);
  await assert.rejects(handle.ready, /account_changed/);
  assert.equal(closed, 1); assert.equal(f.closed.journal, 1); assert.equal(f.closed.uploads, 0); assert.equal(f.closed.challenges, 0);
});

test("unsupported request recovery does not publish a runtime that silently ignores drafts", async () => {
  const f = fixture(), handle = openAccountCloudRuntime(f.options, { ...f.ports, drafts: async () => { throw new Error("journal_readonly"); } });
  await Promise.resolve(); f.resolve(); await assert.rejects(handle.ready, /journal_readonly/);
  assert.equal(f.closed.journal, 1); assert.equal(f.closed.client, 1); assert.equal(f.closed.uploads, 0);
});

test("account loss while design recovery opens closes its late connection", async () => {
  const f = fixture(); let finish!: (value: CloudDesignJournal) => void, entered!: () => void;
  const opening = new Promise<void>(resolve => { entered = resolve; }); let closed = 0;
  const handle = openAccountCloudRuntime(f.options, { ...f.ports, designJournal: async () => { entered(); return new Promise(resolve => { finish = resolve; }); } });
  await Promise.resolve(); f.resolve(); await opening; f.emit(other);
  finish({ ownerId: owner, close() { closed++; } } as CloudDesignJournal);
  await assert.rejects(handle.ready, /account_changed/);
  assert.equal(closed, 1); assert.equal(f.closed.journal, 1); assert.equal(f.closed.uploads, 0);
});
