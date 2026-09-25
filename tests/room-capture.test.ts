import assert from "node:assert/strict";
import test from "node:test";
import { CaptureRunner, type CaptureProgress } from "../lib/rtc/capture-v2";
import { captureFixture, memoryJournal } from "./helpers/room-fixture";
test("capture writes its durable claim before firing and a reloaded runner cannot fire those shots twice", async () => {
  const { journal, markers } = memoryJournal(), capture = captureFixture(), events: CaptureProgress[] = [], shots: number[] = [];
  let now = 9000;
  const options = { journal, expiresAt: 50000, now: () => now, wait: async (ms: number) => { now += ms; }, authorised: async () => true,
    capture: async (_capture: typeof capture, index: number) => { assert(markers.has(`${capture.captureId}/${capture.shotIds[index]}`)); assert.equal(now, capture.fireAt + index * capture.intervalMs); shots.push(index); }, onProgress: (event: CaptureProgress) => events.push(event) };
  await new CaptureRunner(options).run(capture); assert.deepEqual(shots, [0, 1]); assert.equal(events.at(-1)?.kind, "capture-complete");
  now = 9000; await new CaptureRunner(options).run(capture); assert.deepEqual(shots, [0, 1]); assert.equal(events.at(-1)?.kind, "capture-incomplete");
});
test("a missed deadline never catches up and authorisation loss stops future shots", async () => {
  const capture = captureFixture(), events: CaptureProgress[] = []; let fired = 0, now = 20000;
  const options = { journal: memoryJournal().journal, expiresAt: 50000, now: () => now, wait: async (ms: number) => { now += ms; }, authorised: async () => false, capture: async () => { fired++; }, onProgress: (event: CaptureProgress) => events.push(event) };
  await new CaptureRunner({ ...options, authorised: async () => true }).run(capture); assert.equal(fired, 0);
  now = 9000; await new CaptureRunner(options).run(capture); assert.equal(fired, 0); assert.equal(events.at(-1)?.kind, "capture-incomplete");
});
test("storage-claim failure prevents capture and a failed local save never advances to another shot", async () => {
  const capture = captureFixture(); let now = 9000, fired = 0;
  const options = { journal: memoryJournal().journal, expiresAt: 50000, now: () => now, wait: async (ms: number) => { now += ms; }, authorised: async () => true, capture: async () => { fired++; throw new Error("quota_failed"); }, onProgress() {} };
  await new CaptureRunner({ ...options, journal: { ...options.journal, claimShot: async () => { throw new Error("quota_failed"); } } }).run(capture); assert.equal(fired, 0);
  now = 9000; await new CaptureRunner(options).run(capture); assert.equal(fired, 1);
});


test("cancelling during the final durable save preserves its receipt but cannot announce completion", async () => {
  const capture = { ...captureFixture(), shotIds: ["final"], profile: { ...captureFixture().profile, shotsPerMember: 1 } };
  let now = 9000, finished = 0; const events: CaptureProgress[] = [];
  const runner = new CaptureRunner({ journal: { ...memoryJournal().journal, finishShot: async () => { finished++; } }, expiresAt: 50000, now: () => now, wait: async ms => { now += ms; }, authorised: async () => true, capture: async () => { runner.cancel(); }, onProgress: event => events.push(event) });
  await runner.run(capture); assert.equal(finished, 1); assert(events.some(event => event.kind === "shot-saved"));
  assert.equal(events.at(-1)?.kind, "capture-incomplete"); assert(!events.some(event => event.kind === "capture-complete"));
});
