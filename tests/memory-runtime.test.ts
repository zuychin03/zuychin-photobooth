import test from "node:test";
import assert from "node:assert/strict";
import { openMemoryRuntime, type MemoryRuntimeOptions, type MemoryRuntimePorts } from "../lib/memories/memory-runtime";
import type { CloudIdentity } from "../lib/projects/cloud-client";

const ownerId = "00000000-0000-4000-8000-000000000001", other = "00000000-0000-4000-8000-000000000002";
function fixture() {
  const calls = { activity: 0, retained: 0, projects: 0, subscription: 0, invalidated: 0 };
  let listener: ((id: string | null) => void) | undefined, identity: (() => CloudIdentity | null) | undefined;
  const create = (key: "activity" | "retained" | "projects", readIdentity: () => CloudIdentity | null) => {
    identity = readIdentity;
    return { ownerId, close() { calls[key]++; }, assertActive() { if (!readIdentity()) throw new Error("account_changed"); } };
  };
  const ports: MemoryRuntimePorts = {
    activity: options => create("activity", options.identity) as ReturnType<MemoryRuntimePorts["activity"]>,
    retained: options => create("retained", options.identity) as ReturnType<MemoryRuntimePorts["retained"]>,
    projects: options => create("projects", options.identity) as ReturnType<MemoryRuntimePorts["projects"]>,
  };
  const options: MemoryRuntimeOptions = { ownerId, appOrigin: "https://app.test", storageOrigin: "https://storage.test", accessToken: async () => "fixture", subscribe(next) { listener = next; return () => { calls.subscription++; }; }, onInvalidated() { calls.invalidated++; } };
  return { calls, ports, options, emit: (id: string | null) => listener?.(id), identity: () => identity?.() };
}
test("memory reads share an identity and close all clients on account change without opening local storage", async () => {
  const f = fixture(), handle = openMemoryRuntime(f.options, f.ports), runtime = await handle.ready;
  assert.equal(runtime.activity.ownerId, ownerId); f.emit(ownerId); assert.equal(f.calls.activity, 0);
  f.emit(other); assert.equal(f.identity(), null); assert.deepEqual(f.calls, { activity: 1, retained: 1, projects: 1, subscription: 1, invalidated: 1 });
  handle.close(); assert.equal(f.calls.activity, 1); assert.throws(() => runtime.retained.assertActive(), /account_changed/);
});
test("memory setup cancelled before its microtask does not subscribe or construct clients", async () => {
  const f = fixture(), handle = openMemoryRuntime(f.options, f.ports); handle.close(); await assert.rejects(handle.ready, /cancelled/);
  assert.equal(f.identity(), undefined); assert.equal(f.calls.subscription, 0);
});
test("synchronous auth change during subscription cannot leak a subscription or publish a runtime", async () => {
  const f = fixture(), handle = openMemoryRuntime({ ...f.options, subscribe(listener) { listener(null); return () => { f.calls.subscription++; }; } }, f.ports);
  await assert.rejects(handle.ready, /account_changed/); assert.equal(f.calls.subscription, 1); assert.equal(f.identity(), undefined);
});
test("partial construction closes completed memory clients", async () => {
  const f = fixture(), handle = openMemoryRuntime(f.options, { ...f.ports, projects() { throw new Error("configuration"); } });
  await assert.rejects(handle.ready, /configuration/); assert.deepEqual(f.calls, { activity: 1, retained: 1, projects: 0, subscription: 1, invalidated: 0 });
});
test("same account reopened cannot revive the previous memory identity", async () => {
  const f = fixture(), first = openMemoryRuntime(f.options, f.ports); await first.ready; const epoch = f.identity()!.epoch; first.close();
  const g = fixture(), second = openMemoryRuntime(g.options, g.ports); await second.ready;
  assert.notEqual(g.identity()!.epoch, epoch); assert.equal(f.identity(), null); second.close();
});
