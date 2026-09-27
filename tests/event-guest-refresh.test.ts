import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = ts.createSourceFile("EventGuestWorkspace.tsx", readFileSync(new URL("../components/events/EventGuestWorkspace.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler: string | undefined;
let initialise: string | undefined;
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" && node.arguments[0]?.getText(source).includes("session.journal.list()")) initialise = node.arguments[0].getText(source);
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "button" && node.children.some(child => ts.isJsxText(child) && child.text.trim() === "Check event")) {
    const click = node.openingElement.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "onClick");
    if (click && ts.isJsxAttribute(click) && click.initializer && ts.isJsxExpression(click.initializer)) handler = click.initializer.expression?.getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert(handler, "The guest event refresh control must have an executable handler");
const code = ts.transpileModule(`return (${handler});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

async function refresh(options: { endsAt?: string; supported?: boolean; missionFailure?: boolean; abort?: boolean } = {}) {
  const abort = new AbortController(), calls: string[] = [];
  const frozen = Object.freeze({ requestId: "unchanged-request", missionChoice: Object.freeze({ version: 1, missionId: "same-energy-1" }) });
  const request = { current: frozen };
  const state = { context: { closesAt: "03:30" }, missions: { endsAt: "03:30" }, ownConsent: false, missionId: "same-energy-1" };
  const client = {
    capabilities: async () => ({ guestbookVersion: options.supported === false ? 0 : 1, ownConsentVersion: 1 }),
    context: async () => ({ closesAt: "09:45" }),
    missions: async () => { calls.push("missions"); if (options.missionFailure) throw new Error("unavailable"); if (options.abort) abort.abort(); return { endsAt: options.endsAt ?? "09:45" }; },
    assertActive: (signal: AbortSignal) => signal.throwIfAborted(),
  };
  let pending: Promise<void> | undefined;
  const ports = {
    session: { client }, alive: { current: true }, request, refreshGeneration: { current: 0 },
    run: (job: (signal: AbortSignal) => Promise<void>) => { pending = job(abort.signal); return pending; },
    setContext: (value: typeof state.context) => { state.context = value; },
    setMissions: (value: typeof state.missions) => { state.missions = value; },
    setOwnConsentAvailable: (value: boolean) => { state.ownConsent = value; },
    setMissionId: (value: string) => { state.missionId = value; },
  };
  const click = new Function(...Object.keys(ports), code)(...Object.values(ports)) as () => void;
  click();
  let failure: unknown;
  try { await pending; } catch (error) { failure = error; }
  assert.strictEqual(request.current, frozen);
  assert.equal(state.missionId, "same-energy-1");
  return { state, calls, failure };
}

test("Check event refreshes the server-default mission deadline with an extended contribution window", async () => {
  const { state, failure } = await refresh();
  assert.equal(failure, undefined); assert.equal(state.context.closesAt, "09:45"); assert.equal(state.missions.endsAt, "09:45");
});

test("a late initial missions response cannot overwrite a completed Check event refresh", async () => {
  assert(initialise);
  let finishInitial: ((value: { endsAt: string }) => void) | undefined;
  const initialMissions = new Promise<{ endsAt: string }>(resolve => { finishInitial = resolve; });
  const state = { missions: { endsAt: "03:30" }, context: { closesAt: "03:30" }, ownConsent: false };
  let missionCalls = 0, pending: Promise<void> | undefined;
  const ports = {
    session: { journal: { list: async () => [] }, client: {
      capabilities: async () => ({ guestbookVersion: 1, ownConsentVersion: 1 }),
      missions: async () => ++missionCalls === 1 ? initialMissions : { endsAt: "09:45" },
      context: async () => ({ closesAt: "09:45" }),
      assertActive: (signal: AbortSignal) => signal.throwIfAborted(),
    } },
    alive: { current: false }, work: { current: null as AbortController | null }, refreshGeneration: { current: 0 },
    document: { addEventListener() {}, removeEventListener() {} },
    setOwnConsentAvailable: (value: boolean) => { state.ownConsent = value; },
    setMissions: (value: typeof state.missions) => { state.missions = value; },
    setContext: (value: typeof state.context) => { state.context = value; },
    setRecords() {}, setCameraOn() {}, invalidate: () => false,
    eventGuestError: (error: unknown) => String(error), setError: (error: unknown) => { throw error; },
    run: (job: (signal: AbortSignal) => Promise<void>) => { pending = job(new AbortController().signal); return pending; },
  };
  const setup = ts.transpileModule(`return (${initialise});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const cleanup = new Function(...Object.keys(ports), setup)(...Object.values(ports))() as () => void;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(missionCalls, 1);
  new Function(...Object.keys(ports), code)(...Object.values(ports))();
  await pending;
  assert.equal(state.missions.endsAt, "09:45");
  finishInitial!({ endsAt: "03:30" });
  await new Promise(resolve => setImmediate(resolve));
  cleanup();
  assert.equal(state.context.closesAt, "09:45");
  assert.equal(state.missions.endsAt, "09:45");
});

test("Check event preserves an independently configured mission deadline and frozen mission choice", async () => {
  const { state } = await refresh({ endsAt: "06:00" });
  assert.equal(state.context.closesAt, "09:45"); assert.equal(state.missions.endsAt, "06:00");
});

test("Check event does not call unsupported mission APIs", async () => {
  const { state, calls, failure } = await refresh({ supported: false });
  assert.equal(failure, undefined); assert.deepEqual(calls, []); assert.equal(state.context.closesAt, "09:45"); assert.equal(state.missions, null);
});

test("Check event does not publish a partially refreshed view after mission failure or cancellation", async () => {
  for (const options of [{ missionFailure: true }, { abort: true }]) {
    const { state, failure } = await refresh(options);
    assert(failure); assert.equal(state.context.closesAt, "03:30"); assert.equal(state.missions.endsAt, "03:30");
  }
});
