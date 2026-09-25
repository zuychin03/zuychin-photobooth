import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { renderWeeklyRecap, weeklyRecapGeometry, weeklyStripUrl, type WeeklyRecapPorts } from "../lib/recap";

async function fixture(count = 2) {
  const bytes = await sharp({ create: { width: 2030, height: 1184, channels: 3, background: "#ca5678" } }).png().toBuffer();
  const calls: string[] = [], canvases: HTMLCanvasElement[] = [];
  let live = 0, maximum = 0, active = true, changed = false;
  const canvas = () => { const value = { width: 0, height: 0, getContext: () => ({ drawImage() {} }) } as unknown as HTMLCanvasElement; canvases.push(value); return value; };
  const sources = Array.from({ length: count }, (_, i) => ({ id: String(i), async resolve() { calls.push(`resolve:${i}`); return { url: `https://synthetic.invalid/${i}`, fingerprint: changed ? "changed" : String(i) }; } }));
  const ports: WeeklyRecapPorts = {
    async fetch(url, init) { calls.push(`fetch:${url}`); assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store"); return new Response(bytes, { headers: { "Content-Type": "image/png" } }); },
    async decode() { calls.push("decode"); maximum = Math.max(maximum, ++live); return { width: 2030, height: 1184, close() { calls.push("close"); live--; } }; }, canvas,
    compose(sources) { calls.push("compose"); assert(sources.every(c => c.width <= 640 && c.height <= 640)); const size = weeklyRecapGeometry(sources), out = canvas(); out.width = size.outputWidth; out.height = size.outputHeight; return out; },
    async encode() { calls.push("encode"); return new Blob([bytes], { type: "image/png" }); },
  };
  return { sources, ports, calls, canvases, bytes, options: { assertActive() { if (!active) throw new Error("account_changed"); } }, revoke() { active = false; }, change() { changed = true; }, get maximum() { return maximum; } };
}
test("weekly layout retains margins and uniformly scales four Quad strips into the output policy", () => {
  const geometry = weeklyRecapGeometry(Array.from({ length: 4 }, () => ({ width: 2030, height: 1184 })));
  assert.equal(geometry.outputWidth, 4096); assert(geometry.outputHeight < 4096); assert(geometry.outputWidth * geometry.outputHeight <= 12 * 1024 * 1024);
  assert(Math.abs(geometry.outputWidth / geometry.outputHeight - geometry.width / geometry.height) < .01);
  const portrait = weeklyRecapGeometry([{ width: 536, height: 1600 }, { width: 536, height: 1600 }]); assert.equal(portrait.renderScale, 2); assert.equal(portrait.outputWidth, 1784);
  for (const items of [[], Array.from({ length: 21 }, () => ({ width: 1, height: 1 })), [{ width: 4096, height: 4096 }]]) assert.throws(() => weeklyRecapGeometry(items));
});
test("private recap URLs are constrained to the configured exact signed strip path", () => {
  const path = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png", base = "https://storage.example", good = `${base}/storage/v1/object/sign/photobooth-strips/${path}?token=synthetic`;
  assert.equal(weeklyStripUrl(good, base, path), good);
  for (const url of [good.replace("storage.example", "foreign.example"), good.replace("photobooth-strips", "public"), `${good}&token=other`, `${good}#private`, good.replace("/sign/", "/public/")]) assert.throws(() => weeklyStripUrl(url, base, path));
});
test("real PNGs are downloaded sequentially and immediately reduced; all resources release", async () => {
  const f = await fixture(4), result = await renderWeeklyRecap(f.sources, "Synthetic week", f.options, f.ports);
  assert.equal(f.maximum, 1); assert(result.width <= 4096); assert.equal(result.blob.type, "image/png");
  assert.deepEqual(f.calls.filter(c => c === "decode" || c === "close"), Array.from({ length: 4 }, () => ["decode", "close"]).flat());
  assert.equal(f.calls.filter(c => c.startsWith("resolve:")).length, 8); assert(f.canvases.every(c => c.width === 0 && c.height === 0));
});
test("wrong MIME, excessive declared bytes and oversized PNG header refuse native decode", async () => {
  for (const kind of ["mime", "bytes", "dimensions"]) {
    const f = await fixture(1);
    const bytes = kind === "dimensions" ? await sharp({ create: { width: 4097, height: 1, channels: 3, background: "red" } }).png().toBuffer() : f.bytes;
    f.ports.fetch = async () => new Response(bytes, { headers: { "Content-Type": kind === "mime" ? "image/svg+xml" : "image/png", ...(kind === "bytes" ? { "Content-Length": "16777217" } : {}) } });
    await assert.rejects(renderWeeklyRecap(f.sources, "Week", f.options, f.ports)); assert(!f.calls.includes("decode"));
  }
});
test("account change or source replacement during encoding prevents returning private output", async () => {
  for (const mode of ["account", "source"]) {
    const f = await fixture(); f.ports.encode = async () => { if (mode === "account") f.revoke(); else f.change(); return new Blob([f.bytes], { type: "image/png" }); };
    await assert.rejects(renderWeeklyRecap(f.sources, "Week", f.options, f.ports), mode === "account" ? /account_changed/ : /source photo changed/);
    assert(f.canvases.every(c => c.width === 0));
  }
});
test("cancelled native decode stays occupied until its late bitmap closes, then retry succeeds", async () => {
  const f = await fixture(1), abort = new AbortController(); let finish!: (value: Awaited<ReturnType<WeeklyRecapPorts["decode"]>>) => void, began!: () => void, closed = false;
  const started = new Promise<void>(resolve => { began = resolve; }); f.ports.decode = () => new Promise(resolve => { finish = resolve; began(); });
  const task = renderWeeklyRecap(f.sources, "Week", { ...f.options, signal: abort.signal }, f.ports); await started; abort.abort();
  await assert.rejects(task, /cancelled/); await assert.rejects(renderWeeklyRecap(f.sources, "Week", f.options, f.ports), /still settling/);
  finish({ width: 2030, height: 1184, close() { closed = true; } }); await new Promise(resolve => setImmediate(resolve));
  assert(closed); assert(!f.calls.includes("compose"));
  const retry = await fixture(1); await renderWeeklyRecap(retry.sources, "Week", retry.options, retry.ports);
});
test("native timeout refuses output and keeps the late encoder allocation until it settles", async () => {
  const f = await fixture(1); let finish!: (blob: Blob) => void;
  f.ports.encode = () => new Promise(resolve => { finish = resolve; });
  await assert.rejects(renderWeeklyRecap(f.sources, "Week", { ...f.options, nativeTimeoutMs: 5 }, f.ports), /too long/);
  await assert.rejects(renderWeeklyRecap(f.sources, "Week", f.options, f.ports), /still settling/); assert(f.canvases.some(c => c.width > 0));
  finish(new Blob([f.bytes], { type: "image/png" })); await new Promise(resolve => setImmediate(resolve)); assert(f.canvases.every(c => c.width === 0));
});
