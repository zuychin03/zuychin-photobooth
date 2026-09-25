import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_THEN_NOW_ALIGNMENT, drawThenNowAlternatingFrame, drawThenNowComparison, drawThenNowGhost, prepareThenNowReference, thenNowDateFromInstant, thenNowDateLabel, thenNowOutputSize, thenNowPlacement, validateThenNowPlan, type ThenNowPlan } from "../lib/memories/then-and-now";
import { photoPlacement } from "../lib/projects/transforms";

const plan = (): ThenNowPlan => ({ version: 1, reference: { mediaId: "reference-1", provenance: { kind: "imported-image" }, date: null, crop: null }, alignment: { ...DEFAULT_THEN_NOW_ALIGNMENT }, ghostOpacity: 0.4 });
function canvas(width = 800, height = 600) {
  const draws: unknown[][] = [], texts: string[] = [], transforms: unknown[][] = [], states: number[] = [], fonts: string[] = [], clips: number[][] = [];
  const value = { width, height } as HTMLCanvasElement;
  const ctx = { canvas: value, globalAlpha: 1, save(this: { globalAlpha: number }) { states.push(this.globalAlpha); }, restore(this: { globalAlpha: number }) { this.globalAlpha = states.pop()!; }, beginPath() {}, rect(...args: number[]) { clips.push(args); }, clip() {}, translate(...args: unknown[]) { transforms.push(args); }, rotate(...args: unknown[]) { transforms.push(args); }, scale(...args: unknown[]) { transforms.push(args); }, drawImage(...args: unknown[]) { draws.push(args); }, fillRect() {}, fillText(this: { font: string }, text: string) { texts.push(text); fonts.push(this.font); } } as unknown as CanvasRenderingContext2D;
  value.getContext = (() => ctx) as unknown as typeof value.getContext;
  return { value, ctx, draws, texts, transforms, fonts, clips };
}
test("reference provenance is descriptive and cannot contain synthetic access grants or URLs", () => {
  const p = validateThenNowPlan(plan()); assert(Object.isFrozen(p)); assert(Object.isFrozen(p.reference.provenance));
  assert.throws(() => validateThenNowPlan({ ...plan(), accessible: true }));
  for (const provenance of [{ kind: "imported-image", url: "https://example.invalid/old.jpg" }, { kind: "project-original", projectId: "p", sourceMediaId: "m", authorised: true }, { kind: "room" }]) assert.throws(() => validateThenNowPlan({ ...plan(), reference: { ...plan().reference, provenance } }));
  const project = validateThenNowPlan({ ...plan(), reference: { ...plan().reference, provenance: { kind: "project-original", projectId: "p", sourceMediaId: "m" } } }); assert.equal(project.reference.mediaId, "reference-1");
  let accessed = false; assert.throws(() => validateThenNowPlan({ ...plan(), get ghostOpacity() { accessed = true; return 1; } })); assert.equal(accessed, false);
});
test("a flattened strip always requires an explicit bounded selected crop", () => {
  const p = plan(); p.reference.provenance = { kind: "imported-strip" };
  assert.throws(() => validateThenNowPlan(p));
  p.reference.crop = { x: 0.1, y: 0.2, width: 0.8, height: 0.3 }; assert.deepEqual(validateThenNowPlan(p).reference.crop, p.reference.crop);
  for (const crop of [{ x: 0, y: 0, width: 0, height: 1 }, { x: 0.5, y: 0, width: 0.6, height: 1 }, { x: 0, y: -1, width: 1, height: 1 }]) assert.throws(() => validateThenNowPlan({ ...p, reference: { ...p.reference, crop } }));
});
test("fixed reference dates retain unknown and use the captured timezone rather than import time", () => {
  assert.equal(thenNowDateLabel(null), "Unknown date"); assert.equal(thenNowDateLabel("2000-02-29"), "29/02/2000");
  assert.throws(() => thenNowDateLabel("2001-02-29")); assert.throws(() => thenNowDateLabel("2020-01-01T00:00:00Z"));
  assert.equal(thenNowDateFromInstant(null, "Australia/Sydney"), null);
  assert.equal(thenNowDateFromInstant("2026-10-03T15:30:00Z", "Australia/Sydney"), "2026-10-04");
  assert.equal(thenNowDateFromInstant("2026-10-03T15:30:00Z", "America/Los_Angeles"), "2026-10-03");
});
test("reference alignment uses the compositor geometry after applying the selected crop", () => {
  const edit = { zoom: 1.5, offsetX: -0.3, offsetY: 0.6, rotation: 90 as const, mirror: true }, crop = { x: 0.25, y: 0.1, width: 0.5, height: 0.8 };
  const actual = thenNowPlacement(1200, 800, crop, { width: 400, height: 600 }, edit);
  const expected = photoPlacement(600, 640, 400, 600, { ...edit, sourceIndex: 0, filterId: null });
  assert.deepEqual(actual, { ...expected, sourceX: 300, sourceY: 80, sourceWidth: 600, sourceHeight: 640 });
  assert.throws(() => validateThenNowPlan({ ...plan(), ghostOpacity: 1.1 }));
  assert.throws(() => validateThenNowPlan({ ...plan(), alignment: { ...edit, zoom: 5 } }));
});
test("ghost and comparison reuse identical crop/placement, preserve originals and label flattened material", () => {
  const size = thenNowOutputSize(800, 1.5, "comparison"), reference = canvas(1000, 2000), current = canvas(1000, 1000), ghost = canvas(size.width, size.height), comparison = canvas(size.width, size.height);
  const p = plan(); p.reference.provenance = { kind: "imported-strip" }; p.reference.crop = { x: 0, y: 0.25, width: 1, height: 0.5 };
  drawThenNowGhost(ghost.ctx, reference.value, p, { x: 20, y: 20, width: 370, height: 370 / 1.5 });
  drawThenNowComparison(comparison.ctx, reference.value, current.value, p, { ...size, currentDate: "2026-09-23" });
  assert.deepEqual(ghost.draws[0], comparison.draws[0]); assert.deepEqual(ghost.transforms, comparison.transforms.slice(0, 3));
  assert.equal(ghost.ctx.globalAlpha, 1); assert.equal(reference.value.width, 1000); assert.equal(reference.value.height, 2000); assert.equal(current.value.width, 1000);
  assert.deepEqual(comparison.texts, ["Then · Unknown date", "Now · 23/09/2026", "Selected strip crop"]);
});
test("output geometry preserves camera aspect and readable labels at sidebar display size", () => {
  const reference = canvas(), current = canvas();
  for (const mode of ["comparison", "alternating"] as const) {
    for (const aspect of [0.25, 4 / 3, 1.5, 4]) {
      const size = thenNowOutputSize(960, aspect, mode), output = canvas(size.width, size.height);
      if (mode === "comparison") drawThenNowComparison(output.ctx, reference.value, current.value, plan(), { ...size, currentDate: null });
      else drawThenNowAlternatingFrame(output.ctx, reference.value, current.value, plan(), "then", { ...size, currentDate: null });
      assert(Math.abs(output.clips[0][2] / output.clips[0][3] - aspect) < 1e-12);
      assert(Number.parseFloat(output.fonts[0]) * 320 / size.width >= 12);
      assert(size.width <= 2048 && size.height <= 2048 && size.width * size.height <= 4 * 1024 * 1024);
    }
  }
});
test("an unselected full strip is labelled honestly in comparison and alternating frames", () => {
  const p = plan(); p.reference.provenance = { kind: "imported-strip" }; p.reference.crop = { x: 0, y: 0, width: 1, height: 1 };
  const reference = canvas(), current = canvas();
  for (const mode of ["comparison", "alternating"] as const) {
    const size = thenNowOutputSize(640, 1.5, mode), output = canvas(size.width, size.height);
    if (mode === "comparison") drawThenNowComparison(output.ctx, reference.value, current.value, p, { ...size, currentDate: null });
    else drawThenNowAlternatingFrame(output.ctx, reference.value, current.value, p, "then", { ...size, currentDate: null });
    assert(output.texts.includes("Whole strip reference")); assert(!output.texts.includes("Selected strip crop"));
  }
});
test("alternating frames label their actual source and reject unbounded outputs", () => {
  const reference = canvas(), current = canvas(), output = canvas(), p = plan();
  drawThenNowAlternatingFrame(output.ctx, reference.value, current.value, p, "then", { width: 800, height: 600, currentDate: null });
  drawThenNowAlternatingFrame(output.ctx, reference.value, current.value, p, "now", { width: 800, height: 600, currentDate: null });
  assert.equal(output.draws[0][0], reference.value); assert.equal(output.draws[1][0], current.value); assert.deepEqual(output.texts, ["Then · Unknown date", "Now · Unknown date"]);
  const enormous = canvas(4096, 4096); assert.throws(() => drawThenNowComparison(enormous.ctx, reference.value, current.value, p, { width: 4096, height: 4096, currentDate: null })); assert.equal(enormous.draws.length, 0);
});
test("optional preparation retains immutable encoded bytes and disposes only owned decode/preview canvases", async () => {
  const source = canvas(4096, 2048), preview = canvas(), blob = new Blob([new Uint8Array([1, 2, 3])]);
  const prepared = await prepareThenNowReference(blob, plan(), { decode: async () => source.value, createCanvas: () => preview.value });
  assert.equal(prepared.canvas.width, 1024); assert.equal(prepared.canvas.height, 512); assert.equal(source.value.width, 0); assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3]);
  prepared.dispose(); prepared.dispose(); assert.equal(prepared.canvas.width, 0);
});
test("cancelled decoding cannot publish a preview or release its allocation slot before settling", async () => {
  let resolve!: (value: HTMLCanvasElement) => void; const controller = new AbortController(), source = canvas(); let created = 0;
  const blob = new Blob(["fixture"]), pending = prepareThenNowReference(blob, plan(), { signal: controller.signal, decode: () => new Promise(done => { resolve = done; }), createCanvas: () => { created++; return canvas().value; } });
  controller.abort(); await assert.rejects(prepareThenNowReference(blob, plan()), /still being prepared/);
  resolve(source.value); await assert.rejects(pending, error => error instanceof DOMException && error.name === "AbortError");
  assert.equal(created, 0); assert.equal(source.value.width, 0);
});
