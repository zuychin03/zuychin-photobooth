import test from "node:test";
import assert from "node:assert/strict";
import { openVoiceRuntime, type VoiceRuntimeOptions, type VoiceRuntimePorts } from "../lib/memories/voice-runtime";
import type { CloudIdentity } from "../lib/projects/cloud-client";

const ownerId = "00000000-0000-4000-8000-000000000001", other = "00000000-0000-4000-8000-000000000002";
function fixture() {
  const calls = { client: 0, journal: 0, subscribe: 0, unsubscribe: 0, invalidated: 0, makeClient: 0, openJournal: 0 };
  let listener: ((id: string | null) => void) | undefined, identity: (() => CloudIdentity | null) | undefined;
  const client = () => ({ ownerId, close() { calls.client++; }, assertActive() { if (!identity?.()) throw new Error("account_changed"); } }) as ReturnType<VoiceRuntimePorts["client"]>;
  const journal = () => ({ ownerId, close() { calls.journal++; }, assertActive() { if (!identity?.()) throw new Error("account_changed"); } }) as Awaited<ReturnType<VoiceRuntimePorts["journal"]>>;
  const ports: VoiceRuntimePorts = {
    client(options) { calls.makeClient++; identity = options.identity; return client(); },
    async journal() { calls.openJournal++; return journal(); },
  };
  const options: VoiceRuntimeOptions = { ownerId, appOrigin: "https://app.test", accessToken: async () => "fixture", subscribe(next) { calls.subscribe++; listener = next; return () => { calls.unsubscribe++; }; }, onInvalidated() { calls.invalidated++; } };
  return { calls, ports, options, client, journal, emit: (id: string | null) => listener?.(id), identity: () => identity?.() };
}
test("close before setup does not subscribe or open client and private journal", async () => {
  const f = fixture(), handle = openVoiceRuntime(f.options, f.ports); handle.close();
  await assert.rejects(handle.ready, /cancelled/); assert.equal(f.calls.subscribe, 0); assert.equal(f.calls.makeClient, 0); assert.equal(f.calls.openJournal, 0);
});
test("synchronous auth invalidation during subscribe unsubscribes exactly once", async () => {
  const f = fixture(), handle = openVoiceRuntime({ ...f.options, subscribe(next) { next(null); return () => { f.calls.unsubscribe++; }; } }, f.ports);
  await assert.rejects(handle.ready, /account_changed/); assert.equal(f.calls.unsubscribe, 1); assert.equal(f.calls.invalidated, 1); assert.equal(f.calls.makeClient, 0); handle.close(); assert.equal(f.calls.unsubscribe, 1);
});
test("invalidation during client construction closes the late client and never opens journal", async () => {
  const f = fixture(), handle = openVoiceRuntime(f.options, { ...f.ports, client(options) { const client = f.ports.client(options); f.emit(other); return client; } });
  await assert.rejects(handle.ready, /account_changed/); assert.equal(f.calls.client, 1); assert.equal(f.calls.openJournal, 0); assert.equal(f.identity(), null);
});
test("late journal arrival after account invalidation is closed and never published", async () => {
  const f = fixture(); let resolve!: (value: ReturnType<typeof f.journal>) => void;
  const handle = openVoiceRuntime(f.options, { ...f.ports, journal: () => new Promise(done => { resolve = done; }) });
  await Promise.resolve(); f.emit(null); assert.equal(f.calls.client, 1); resolve(f.journal());
  await assert.rejects(handle.ready, /account_changed/); assert.equal(f.calls.journal, 1); assert.equal(f.calls.unsubscribe, 1); assert.equal(f.calls.invalidated, 1); handle.close(); assert.equal(f.calls.journal, 1);
});
test("explicit close also disposes a late journal without claiming auth invalidation", async () => {
  const f = fixture(); let resolve!: (value: ReturnType<typeof f.journal>) => void;
  const handle = openVoiceRuntime(f.options, { ...f.ports, journal: () => new Promise(done => { resolve = done; }) });
  await Promise.resolve(); handle.close(); resolve(f.journal()); await assert.rejects(handle.ready);
  assert.equal(f.calls.journal, 1); assert.equal(f.calls.client, 1); assert.equal(f.calls.invalidated, 0);
});
test("journal failure closes client and subscription; successful close is idempotent", async () => {
  const f = fixture(), failed = openVoiceRuntime(f.options, { ...f.ports, journal: async () => { throw new Error("storage_denied"); } });
  await assert.rejects(failed.ready, /storage_denied/); assert.equal(f.calls.client, 1); assert.equal(f.calls.unsubscribe, 1);
  const g = fixture(), handle = openVoiceRuntime(g.options, g.ports), runtime = await handle.ready;
  g.emit(ownerId); assert.equal(g.calls.client, 0); handle.close(); handle.close();
  assert.equal(g.calls.client, 1); assert.equal(g.calls.journal, 1); assert.equal(g.calls.unsubscribe, 1); assert.throws(() => runtime.client.assertActive(), /account_changed/);
});
test("reopening the same account never revives an old runtime epoch", async () => {
  const f = fixture(), first = openVoiceRuntime(f.options, f.ports); await first.ready; const epoch = f.identity()!.epoch; first.close();
  const g = fixture(), second = openVoiceRuntime(g.options, g.ports); await second.ready;
  assert.notEqual(g.identity()!.epoch, epoch); assert.equal(f.identity(), null); second.close();
});
test("journal still closes when client teardown throws", async () => {
  const f = fixture(), handle = openVoiceRuntime(f.options, { ...f.ports, client(options) { const client = f.ports.client(options); return { ...client, close() { client.close(); throw new Error("teardown"); } }; } });
  await handle.ready; assert.throws(handle.close, /teardown/);
  assert.equal(f.calls.journal, 1); assert.equal(f.calls.unsubscribe, 1); assert.equal(f.identity(), null); handle.close();
});
