import test from "node:test";
import assert from "node:assert/strict";
import { currentCapturePreferences, DEFAULT_CAPTURE_PREFERENCES, parseCapturePreferences, resolveCapturePreferences, saveCapturePreferences } from "../lib/capture-preferences";
import { playShutter, playTick } from "../lib/sound";

test("capture feedback is opt-in and malformed saved preferences cannot enable it", () => {
  for (const raw of [null, "broken", '{"version":2,"sound":true,"flash":true}', '{"version":1,"sound":"true","flash":true,"motion":"system"}']) assert.deepEqual(parseCapturePreferences(raw), DEFAULT_CAPTURE_PREFERENCES);
  assert.deepEqual(resolveCapturePreferences(DEFAULT_CAPTURE_PREFERENCES, false), { sound: false, flash: false, reducedMotion: false });
});
test("system or explicit reduced motion always suppresses flash without forcing sound", () => {
  assert.deepEqual(resolveCapturePreferences({ sound: true, flash: true, motion: "system" }, true), { sound: true, flash: false, reducedMotion: true });
  assert.deepEqual(resolveCapturePreferences({ sound: false, flash: true, motion: "reduce" }, false), { sound: false, flash: false, reducedMotion: true });
  assert.equal(resolveCapturePreferences({ sound: false, flash: true, motion: "system" }, false).flash, true);
});
test("sound preference is checked at playback time and blocked storage keeps a quiet session choice", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window"), originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), originalAudio = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  let attempts = 0, reduced = false;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => ({ matches: reduced }), dispatchEvent() {} } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() { throw new Error("blocked"); } } });
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: class { constructor() { attempts++; throw new Error("No actual audio in tests"); } } });
  try {
    playTick(); playShutter(); assert.equal(attempts, 0);
    assert.equal(saveCapturePreferences({ sound: true, flash: true, motion: "system" }), false); playTick(); assert.equal(attempts, 1);
    reduced = true; assert.equal(currentCapturePreferences().flash, false);
    saveCapturePreferences(DEFAULT_CAPTURE_PREFERENCES); playShutter(); assert.equal(attempts, 1);
  } finally {
    for (const [key, descriptor] of [["window", originalWindow], ["localStorage", originalStorage], ["AudioContext", originalAudio]] as const) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
