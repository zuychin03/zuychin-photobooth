import assert from "node:assert/strict";
import test from "node:test";
import { createStripPreviewGesture } from "../lib/strip-preview-gesture";

function fixture() {
  const events: string[] = [];
  let timer: (() => void) | null = null;
  const gesture = createStripPreviewGesture({
    open: mode => events.push(mode), close: () => events.push("close"),
    schedule: callback => { timer = callback; return () => { timer = null; }; },
  });
  return { gesture, events, hold: () => timer?.() };
}

test("a short touch opens once and unrelated pointer releases do nothing", () => {
  const { gesture, events, hold } = fixture();
  gesture.start(7, 10, 10); gesture.end(8); assert.deepEqual(events, []);
  gesture.end(7); hold(); assert.deepEqual(events, ["tap"]);
  gesture.end(7); assert.deepEqual(events, ["tap"]);
});

test("scroll movement cancels before opening and cannot later become a tap", () => {
  const { gesture, events, hold } = fixture();
  gesture.start(1, 0, 0); gesture.move(1, 8, 8); hold(); gesture.end(1);
  assert.deepEqual(events, []);
});

test("held preview closes on release even when release belongs to the dialog", () => {
  const { gesture, events, hold } = fixture();
  gesture.start(1, 0, 0); hold(); gesture.move(1, 40, 40); gesture.end(1);
  assert.deepEqual(events, ["hold", "close"]);
});

test("pointer cancellation, a second contact and disposal close peeks without opening another preview", () => {
  for (const stop of ["cancel", "second", "dispose"] as const) {
    const { gesture, events, hold } = fixture();
    gesture.start(1, 0, 0); hold();
    if (stop === "second") gesture.otherPointer(2); else gesture.cancel();
    gesture.end(1); gesture.end(2); hold();
    assert.deepEqual(events, ["hold", "close"]);
  }
});

test("cancelled pending hold cannot open after leaving the tool", () => {
  const { gesture, events, hold } = fixture();
  gesture.start(1, 0, 0); gesture.cancel(); hold(); gesture.end(1);
  assert.deepEqual(events, []);
});
