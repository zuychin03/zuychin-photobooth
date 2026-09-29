import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = ts.createSourceFile("EventReminderPanel.tsx", readFileSync(new URL("../components/events/EventReminderPanel.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const hooks: ts.CallExpression[] = [];
function visit(node: ts.Node) { if (ts.isCallExpression(node) && ["useCallback", "useEffect"].includes(node.expression.getText(source))) hooks.push(node); ts.forEachChild(node, visit); }
visit(source);
const request = hooks.find(node => node.expression.getText(source) === "useCallback")!;
const availability = hooks.find(node => node.arguments[0].getText(source).includes("external.current = disabled"))!;
const retry = hooks.find(node => node.arguments[0].getText(source).includes("!disabled && !value"))!;
function callback(node: ts.CallExpression, ports: Record<string, unknown>) {
  const code = ts.transpileModule(`return (${node.arguments[0].getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(ports), code)(...Object.values(ports));
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

function fixture(failure = "cancelled") {
  const state = { value: null as unknown, pending: null as unknown, busy: false, error: null as string | null, lost: false, settled: 0, calls: 0 };
  const active = { current: null as AbortController | null }, external = { current: false }, live = { current: true };
  let rejectFirst: (() => void) | undefined;
  const projection = { settings: { email: false, push: false, status: "idle" } };
  const client = {
    read: async (_id: string, signal: AbortSignal) => {
      state.calls++;
      if (state.calls > 1) return projection;
      return new Promise((_, reject) => {
        rejectFirst = () => reject({ code: failure });
        signal.addEventListener("abort", () => queueMicrotask(() => rejectFirst?.()), { once: true });
      });
    },
    save: async (_id: string, _choice: unknown, signal: AbortSignal) => client.read(_id, signal),
    assertActive: (signal: AbortSignal) => signal.throwIfAborted(),
  };
  const onInitialReadSettled = () => { state.settled++; };
  const ports = {
    active, external, live, client, eventId: "synthetic-event", initialReadSettled: { current: false },
    callbacks: { current: { onInitialReadSettled } }, onInitialReadSettled,
    onBusyChange: undefined, onDirtyChange: undefined, eventError: (error: { code: string }) => error.code,
    setBusy: (value: boolean) => { state.busy = value; }, setError: (value: string | null) => { state.error = value; },
    setValue: (value: unknown) => { state.value = value; }, setPending: (value: unknown) => { state.pending = value; },
    setLost: (value: boolean) => { state.lost = value; }, setNotice() {},
  };
  const run = callback(request, ports) as (choice?: unknown) => Promise<void>;
  const disabled = (value: boolean) => callback(availability, { ...ports, disabled: value })();
  const retryRead = () => callback(retry, { ...ports, ...state, disabled: external.current, run })();
  return { state, active, live, projection, run, disabled, retryRead, reject: () => rejectFirst?.() };
}

test("a sibling interrupt defers the initial read and retries after availability returns", async () => {
  const f = fixture(), first = f.run();
  f.disabled(true); f.retryRead(); await tick(); assert.equal(f.state.calls, 1);
  await first;
  assert.equal(f.state.error, null); assert.equal(f.state.settled, 0);
  f.disabled(false); f.retryRead(); await tick();
  assert.equal(f.state.calls, 2); assert.deepEqual(f.state.value, f.projection); assert.equal(f.state.settled, 1);
});

test("rapid re-enable waits for the interrupted read to settle before retrying", async () => {
  const f = fixture(), first = f.run();
  f.disabled(true); f.disabled(false); f.retryRead(); await first;
  assert.equal(f.state.error, null);
  assert.match(retry.arguments[1].getText(source), /\bbusy\b/);
  f.retryRead(); await tick(); assert.equal(f.state.calls, 2);
});

test("an interrupted save retains its frozen choice and requires explicit recovery", async () => {
  const f = fixture(), choice = { expectedRevision: 0, email: true, push: false };
  f.state.pending = choice;
  const saving = f.run(choice); f.disabled(true); await saving; f.disabled(false); f.retryRead(); await tick();
  assert.strictEqual(f.state.pending, choice); assert.equal(f.state.error, "cancelled"); assert.equal(f.state.calls, 1);
});

test("access loss wins over interruption and a genuine read error does not retry", async () => {
  for (const code of ["access_denied", "identity_changed", "unavailable"]) {
    const f = fixture(code), first = f.run();
    if (code === "unavailable") f.reject(); else f.disabled(true);
    await first; f.disabled(false); f.retryRead(); await tick();
    assert.equal(f.state.calls, 1); assert(f.state.error);
    assert.equal(f.state.lost, code !== "unavailable"); assert.equal(f.state.value, null);
  }
});
