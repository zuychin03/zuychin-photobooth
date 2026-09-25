import assert from "node:assert/strict";
import test from "node:test";
import { SharedPreviewPainter, createSharedStillCutouts, previewSourceSize, sharedPersonRect, type SharedPreviewConfig, type SharedPreviewOptions, type SharedPreviewStatus } from "../lib/shared-preview";
import { getScene } from "../lib/scenes";
import type { Role } from "../lib/layouts";

function canvas() {
  const calls: { method: string; args: unknown[] }[] = [];
  const context = new Proxy({ globalCompositeOperation: "source-over" }, { get(target, key) { if (key in target) return target[key as keyof typeof target]; return (...args: unknown[]) => { calls.push({ method: String(key), args }); }; } });
  const element = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
  return { element, calls };
}
const video = () => ({ videoWidth: 1920, videoHeight: 1080, readyState: 4 }) as HTMLVideoElement;
const config = (count: 2 | 4 = 2): SharedPreviewConfig => ({ inputs: (["A", "B", "C", "D"] as Role[]).slice(0, count).map(role => ({ role, video: video(), mirror: role === "A" })), intendedRoles: (["A", "B", "C", "D"] as Role[]).slice(0, count), localRole: "A", scene: { ...getScene("studio-cream")!, draw() {} }, places: {} });
function fixture(options: Partial<SharedPreviewOptions> = {}) {
  const target = canvas(), owned: ReturnType<typeof canvas>[] = [], status: SharedPreviewStatus[] = [];
  const painter = new SharedPreviewPainter(target.element, { onStatus: value => status.push(value), createCanvas: () => { const value = canvas(); owned.push(value); return value.element; }, schedule: () => 1 as unknown as ReturnType<typeof setTimeout>, cancel() {}, ...options });
  return { painter, target, owned, status };
}

test("shared placement matches compositor role ordering, bottom alignment and scale", () => {
  const place = { dx: 0.1, dy: -0.15, scale: 1.2 };
  const pair = sharedPersonRect(600, 400, 160, 90, 1, 2, place), group = sharedPersonRect(600, 400, 160, 90, 3, 4, place);
  assert.equal(pair.height, 400 * 0.92 * 1.2); assert.equal(group.height, 400 * 0.8 * 1.2);
  assert.equal(pair.x + pair.width / 2, 600 * (2 / 3 + 0.1)); assert.equal(group.x + group.width / 2, 600 * (4 / 5 + 0.1));
  assert.equal(pair.y + pair.height, 400 * 0.85); assert.deepEqual(previewSourceSize(3840, 2160), { width: 640, height: 360 });
  assert.deepEqual(previewSourceSize(1080, 3840), { width: 180, height: 640 }); assert.throws(() => previewSourceSize(Infinity, 1));
});

test("plain and missing-peer previews never download segmentation or claim all-person Together", async () => {
  let constructions = 0;
  const f = fixture({ createSegmenter: async () => { constructions++; throw new Error("Must stay lazy"); } });
  f.painter.start({ ...config(), scene: null }); await f.painter.renderFrame();
  assert.equal(f.status.at(-1)?.mode, "originals"); assert.deepEqual(f.status.at(-1)?.displayedRoles, ["A", "B"]);
  const missing = config(); missing.inputs = missing.inputs.slice(0, 1); f.painter.update(missing); await f.painter.renderFrame();
  assert.equal(f.status.at(-1)?.mode, "local-only"); assert.deepEqual(f.status.at(-1)?.missingRoles, ["B"]); assert.equal(constructions, 0);
  const blocked = config(); Object.defineProperty(blocked.inputs[1].video, "paused", { value: true }); f.painter.update(blocked); await f.painter.renderFrame();
  assert.equal(f.status.at(-1)?.mode, "local-only"); assert.deepEqual(f.status.at(-1)?.missingRoles, ["B"]); assert.equal(constructions, 0);
  await f.painter.dispose();
});

test("two-person Together bounds snapshots, mirrors each input once, and does not queue inference", async () => {
  let active = 0, maximum = 0, release!: () => void, calls = 0;
  const f = fixture({ createSegmenter: async () => ({ async segment(source, mask) { calls++; active++; maximum = Math.max(maximum, active); assert(source.width <= 640 && source.height <= 640); if (calls === 1) await new Promise<void>(resolve => { release = resolve; }); mask.width = 16; mask.height = 16; active--; }, close() {} }) });
  f.painter.start(config()); const work = f.painter.renderFrame(); await new Promise(resolve => setImmediate(resolve));
  await f.painter.renderFrame(); assert.equal(calls, 1); release(); await work;
  assert.equal(calls, 2); assert.equal(maximum, 1); assert.equal(f.status.at(-1)?.mode, "together");
  assert.equal(f.owned.flatMap(item => item.calls).filter(call => call.method === "scale" && call.args[0] === -1).length, 2);
  assert(f.status.at(-1)!.fps <= 8); await f.painter.dispose(); assert(f.owned.every(item => item.element.width === 0));
});

test("four-person Together requires a bounded two-person trial, slow trials preserve all original tiles", async () => {
  let time = 0, calls = 0;
  const f = fixture({ now: () => time, createSegmenter: async () => ({ segment(_source, mask) { calls++; time += 60; mask.width = mask.height = 4; }, close() {} }) });
  f.painter.start(config(4)); await f.painter.renderFrame();
  assert.equal(calls, 2); assert.equal(f.status.at(-1)?.mode, "originals"); assert.equal(f.status.at(-1)?.reason, "slow-segmentation"); assert.deepEqual(f.status.at(-1)?.displayedRoles, ["A", "B", "C", "D"]);
  await f.painter.renderFrame(); assert.equal(calls, 2); await f.painter.dispose();
  let fastCalls = 0;
  const fast = fixture({ now: () => 0, createSegmenter: async () => ({ segment(_source, mask) { fastCalls++; mask.width = mask.height = 4; }, close() {} }) });
  fast.painter.start(config(4)); await fast.painter.renderFrame(); assert.equal(fastCalls, 2); assert.equal(fast.status.at(-1)?.mode, "warming");
  await fast.painter.renderFrame(); assert.equal(fastCalls, 6); assert.equal(fast.status.at(-1)?.mode, "together"); assert.equal(fast.status.at(-1)?.displayedRoles.length, 4); await fast.painter.dispose();
});

test("stop during lazy construction holds the allocation slot and closes the late model without repaint", async () => {
  let resolveModel!: (model: { segment(): void; close(): void }) => void, closed = 0, secondConstructed = 0;
  const first = fixture({ createSegmenter: () => new Promise(resolve => { resolveModel = resolve; }) });
  first.painter.start(config()); const running = first.painter.renderFrame(); await new Promise(resolve => setImmediate(resolve));
  const disposal = first.painter.dispose(), afterStop = first.target.calls.length;
  const second = fixture({ createSegmenter: async () => { secondConstructed++; return { segment() {}, close() {} }; } }); second.painter.start(config()); await second.painter.renderFrame(); assert.equal(secondConstructed, 0);
  resolveModel({ segment() { throw new Error("Late model cannot infer"); }, close() { closed++; } }); await running; await disposal;
  assert.equal(closed, 1); assert.equal(first.target.calls.length, afterStop); assert.equal(first.status.at(-1)?.mode, "stopped"); await second.painter.dispose();
});

test("config replacement and disposal fence late masks without closing borrowed assets or streams", async () => {
  let release!: () => void, closed = 0;
  const f = fixture({ createSegmenter: async () => ({ async segment() { await new Promise<void>(resolve => { release = resolve; }); }, close() { closed++; } }) });
  f.painter.start(config()); const running = f.painter.renderFrame(); await new Promise(resolve => setImmediate(resolve));
  f.painter.update({ ...config(), scene: null }); const before = f.target.calls.length; release(); await running;
  assert.equal(f.target.calls.length, before); await f.painter.renderFrame(); assert.equal(f.status.at(-1)?.mode, "originals");
  await f.painter.dispose(); assert.equal(closed, 1);
});

test("still cutouts use one model, bound snapshots, and leave borrowed sources intact", async () => {
  const source = canvas().element; source.width = 1920; source.height = 1080; let models = 0, closed = 0, segments = 0;
  const outputs = await createSharedStillCutouts(new Map([["photo-A", source], ["photo-B", source]]), { createCanvas: () => canvas().element, createSegmenter: async () => { models++; return { segment(target, mask) { segments++; assert(target.width <= 640 && target.height <= 640); mask.width = mask.height = 4; }, close() { closed++; } }; } });
  assert.equal(models, 1); assert.equal(segments, 2); assert.equal(closed, 1); assert.equal(outputs.size, 2); assert.equal(source.width, 1920);
  assert([...outputs.values()].every(output => output.width === 640 && output.height === 360)); outputs.forEach(output => { output.width = output.height = 0; });
});

test("cancelled still construction retains the shared slot then closes its late model", async () => {
  const source = canvas().element; source.width = source.height = 8; const controller = new AbortController();
  let release!: (model: { segment(): void; close(): void }) => void, closed = 0;
  const pending = createSharedStillCutouts(new Map([["photo-A", source]]), { signal: controller.signal, createCanvas: () => canvas().element, createSegmenter: () => new Promise(resolve => { release = resolve; }) });
  controller.abort();
  await assert.rejects(createSharedStillCutouts(new Map([["photo-B", source]]), { createCanvas: () => canvas().element }), /busy/);
  release({ segment() { throw new Error("Cancelled model cannot infer"); }, close() { closed++; } }); await assert.rejects(pending, /cancelled/); assert.equal(closed, 1);
});
