import assert from "node:assert/strict";
import { test } from "node:test";
import { CameraController, type CameraResult } from "../lib/camera";
import { runCaptureSequence, type CaptureSequencePorts } from "../lib/capture-sequence";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fakeStream() { let stops = 0; return { stream: { getTracks: () => [{ stop: () => { stops++; } }] } as unknown as MediaStream, stops: () => stops }; }
function trackedStream(initiallyEnded = false) {
  const events = new EventTarget();
  let stops = 0, ended = initiallyEnded;
  const track = Object.assign(events, { kind: "video", stop() { stops++; ended = true; } });
  Object.defineProperty(track, "readyState", { get: () => ended ? "ended" : "live" });
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, stops: () => stops, end: () => { ended = true; events.dispatchEvent(new Event("ended")); } };
}

test("ending an active camera clears the stream and reports loss exactly once", async () => {
  const active = trackedStream(); let ended = 0;
  const camera = new CameraController(async () => ({ stream: active.stream, error: null }), () => { ended++; });
  await camera.start("user");
  active.end(); active.end();
  assert.equal(camera.stream, null);
  assert.equal(active.stops(), 1);
  assert.equal(ended, 1);
});

test("late ended events from a replaced or stopped stream cannot stop its successor", async () => {
  const old = trackedStream(), next = trackedStream(); let starts = 0, ended = 0;
  const camera = new CameraController(async () => ({ stream: starts++ ? next.stream : old.stream, error: null }), () => { ended++; });
  await camera.start("user"); await camera.start("environment");
  old.end();
  assert.equal(camera.stream, next.stream);
  assert.equal(next.stops(), 0);
  assert.equal(ended, 0);
  camera.stop(); next.end();
  assert.equal(ended, 0);
});

test("a permission result whose track already ended cannot become ready", async () => {
  const lost = trackedStream(true); let ended = 0;
  const camera = new CameraController(async () => ({ stream: lost.stream, error: null }), () => { ended++; });
  assert.deepEqual(await camera.start("user"), { stream: null, error: "no-camera" });
  assert.equal(camera.stream, null);
  assert.equal(ended, 1);
});

test("a camera permission result arriving after unmount is stopped immediately", async () => {
  const permission = deferred<CameraResult>(), stream = fakeStream();
  const camera = new CameraController(async () => permission.promise);
  const pending = camera.start("user");
  camera.stop();
  permission.resolve({ stream: stream.stream, error: null });
  assert.equal(await pending, null);
  assert.equal(stream.stops(), 1);
  assert.equal(camera.stream, null);
});

test("out-of-order camera starts cannot replace the latest selected camera", async () => {
  const first = deferred<CameraResult>(), second = deferred<CameraResult>();
  const old = fakeStream(), selected = fakeStream();
  const requests: (string | null | undefined)[] = [];
  const camera = new CameraController(async (_facing, id) => { requests.push(id); return id === "selected" ? second.promise : first.promise; });
  const a = camera.start("user", "old");
  const b = camera.start("environment", "selected");
  second.resolve({ stream: selected.stream, error: null });
  await b;
  first.resolve({ stream: old.stream, error: null });
  assert.equal(await a, null);
  assert.equal(camera.stream, selected.stream);
  assert.deepEqual(requests, ["old", "selected"]);
  assert.equal(old.stops(), 1);
  assert.equal(selected.stops(), 0);
  camera.stop();
  assert.equal(selected.stops(), 1);
});

test("switching stops the active stream before requesting another camera", async () => {
  const old = fakeStream();
  let requests = 0;
  const camera = new CameraController(async () => {
    if (++requests === 1) return { stream: old.stream, error: null };
    assert.equal(old.stops(), 1);
    return { stream: null, error: "denied" };
  });
  await camera.start("user");
  assert.deepEqual(await camera.start("environment"), { stream: null, error: "denied" });
  assert.equal(camera.stream, null);
});

function ports(overrides: Partial<CaptureSequencePorts<string>> = {}) {
  const events: string[] = [];
  let captures = 0;
  const adapter: CaptureSequencePorts<string> = {
    cancelled: () => false,
    pause: async milliseconds => { events.push(`pause:${milliseconds}`); },
    countdown: value => { events.push(`count:${value}`); },
    capture: () => { events.push("capture"); return `shot-${++captures}`; },
    persist: async (index, shot) => { events.push(`persist:${index}:${shot}`); },
    saved: index => { events.push(`saved:${index}`); },
    ...overrides,
  };
  return { adapter, events };
}

test("3, 5 and 10 second timers count down fully and capture only requested missing positions", async () => {
  for (const timer of [3, 5, 10] as const) {
    const { adapter, events } = ports();
    assert.equal(await runCaptureSequence([1, 3], timer, adapter), true);
    assert.deepEqual(events.filter(event => event.startsWith("persist:")), ["persist:1:shot-1", "persist:3:shot-2"]);
    assert.equal(events.filter(event => event === "pause:1000").length, timer * 2);
    assert(events.indexOf(`count:${timer}`) < events.indexOf("capture"));
  }
});

test("pending durable save blocks progress and the next countdown", async () => {
  const save = deferred<void>(), saving = deferred<void>();
  const { adapter, events } = ports({ persist: async () => { saving.resolve(); await save.promise; } });
  const sequence = runCaptureSequence([0, 1], 3, adapter);
  await saving.promise;
  assert.equal(events.filter(event => event === "capture").length, 1);
  assert.equal(events.filter(event => event.startsWith("saved:")).length, 0);
  save.resolve();
  assert.equal(await sequence, true);
  assert.deepEqual(events.filter(event => event.startsWith("saved:")), ["saved:0", "saved:1"]);
});

test("failed durable save leaves captured shot with the caller and never advances", async () => {
  let retained: string | null = null;
  const { adapter, events } = ports({ persist: async (_index, shot) => { retained = shot; throw new Error("Quota exceeded"); } });
  await assert.rejects(runCaptureSequence([0, 1], 3, adapter), /Quota/);
  assert.equal(retained, "shot-1");
  assert.equal(events.filter(event => event === "capture").length, 1);
  assert.equal(events.filter(event => event.startsWith("saved:")).length, 0);
  assert.equal(events.at(-1), "count:null");
});

test("leaving during countdown or saving cannot start another shot", async () => {
  let cancelled = false;
  const early = ports({ cancelled: () => cancelled, pause: async () => { cancelled = true; } });
  assert.equal(await runCaptureSequence([0, 1], 3, early.adapter), false);
  assert(!early.events.includes("capture"));
  cancelled = false;
  const late = ports({ cancelled: () => cancelled, persist: async () => { cancelled = true; } });
  assert.equal(await runCaptureSequence([0, 1], 3, late.adapter), false);
  assert.equal(late.events.filter(event => event === "capture").length, 1);
  assert(!late.events.includes("saved:0"));
});

test("single-shot retake persists exactly the chosen position", async () => {
  const { adapter, events } = ports();
  await runCaptureSequence([2], 3, adapter);
  assert.deepEqual(events.filter(event => event.startsWith("persist:")), ["persist:2:shot-1"]);
});

test("pose guidance advances before its full countdown and stops before an unstarted shot", async () => {
  let cancelled = false;
  const { adapter, events } = ports({ cancelled: () => cancelled, beforeShot: index => { events.push(`pose:${index}`); }, saved: index => { events.push(`saved:${index}`); cancelled = true; } });
  assert.equal(await runCaptureSequence([1, 3], 10, adapter), false);
  assert(events.indexOf("pose:1") < events.indexOf("count:10"));
  assert(!events.includes("pose:3")); assert.equal(events.filter(event => event === "pause:1000").length, 10);
});
