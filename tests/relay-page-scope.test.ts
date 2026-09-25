import assert from "node:assert/strict";
import test from "node:test";
import { createRelayPageScope } from "../lib/relay-page-scope";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test("late relay or pairing load cannot publish into a replacement account", async () => {
  const a = createRelayPageScope(), closeA = a.activate(), load = deferred<string>(), currentA = a.capture();
  let visible: string | null = null, checked = false;
  const pending = load.promise.then(value => { if (currentA()) visible = value; }).finally(() => { if (currentA()) checked = true; });
  closeA(); const b = createRelayPageScope(); b.activate();
  visible = "B relay"; checked = true; load.resolve("A private relay"); await pending;
  assert.equal(visible, "B relay"); assert.equal(checked, true); assert.equal(currentA(), false); assert.equal(b.capture()(), true);
});

test("account loss while relay photos load prevents editor handoff and stale completion", async () => {
  const scope = createRelayPageScope(), close = scope.activate(), downloaded = deferred<void>(), current = scope.capture();
  const actions: string[] = [];
  const pending = (async () => { await downloaded.promise; if (!current()) return; actions.push("update editor"); actions.push("navigate"); })();
  close(); downloaded.resolve(); await pending; assert.deepEqual(actions, []);
});

test("Strict Mode reactivation never revives an earlier callback or notification", async () => {
  const scope = createRelayPageScope(), firstClose = scope.activate(), old = scope.capture(), saved = deferred<void>();
  let notifications = 0;
  const pending = saved.promise.then(() => { if (old()) notifications++; });
  firstClose(); const secondClose = scope.activate(), current = scope.capture(); firstClose();
  saved.resolve(); await pending; assert.equal(notifications, 0); assert.equal(old(), false); assert.equal(current(), true);
  secondClose(); assert.equal(current(), false);
});
