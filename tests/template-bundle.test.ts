import assert from "node:assert/strict";
import test from "node:test";
import { exportTemplateBundle, importTemplateBundle, templateBlobHash } from "../lib/templates/bundle";
import { validateTemplateRecipe } from "../lib/templates/model";
import { inspectTemplateFixture, templateFixture, templatePixel, templateTimestamp } from "./helpers/template-fixture";

const options = { inspect: inspectTemplateFixture, newId: () => "imported-template", now: () => templateTimestamp };
const blobs = () => new Map([["png-one", templatePixel()]]);
async function bundle() { return exportTemplateBundle(templateFixture(true), blobs(), options); }
test("portable template round-trip preserves PNG bytes and strips account and private text", async () => {
  const output = await importTemplateBundle(await bundle(), options);
  assert.equal(output.recipe.id, "imported-template"); assert.equal(output.recipe.revision, 0); assert.deepEqual(output.recipe.scope, { kind: "device" });
  assert.equal(output.recipe.defaults.caption, ""); assert.equal(output.recipe.layers[0].kind === "text" && output.recipe.layers[0].text, "");
  assert.equal(await templateBlobHash(output.decorations.get("png-one")!), await templateBlobHash(templatePixel()));
  const bytes = new Uint8Array(await (await bundle()).arrayBuffer()), length = new DataView(bytes.buffer).getUint32(10), manifest = new TextDecoder().decode(bytes.subarray(18, 18 + length));
  for (const privateValue of ["private-owner", "Private names", "Our anniversary"]) assert(!manifest.includes(privateValue));
  const included = await importTemplateBundle(await exportTemplateBundle(templateFixture(true), blobs(), { ...options, includeText: true }), options);
  assert.equal(included.recipe.defaults.caption, "Our anniversary");
});
test("recipes with no decoration need no image decode", async () => {
  const inspect = async () => { throw new Error("Unexpected inspection"); };
  const output = await importTemplateBundle(await exportTemplateBundle(templateFixture(), new Map(), { inspect }), { ...options, inspect });
  assert.equal(output.decorations.size, 0);
});
test("truncation, trailing bytes, version and framing limits reject before image decode", async () => {
  const original = await bundle(); let inspected = 0;
  const inspect = async (blob: Blob) => { inspected++; return inspectTemplateFixture(blob); };
  for (const size of [0, 17, original.size - 1]) await assert.rejects(importTemplateBundle(original.slice(0, size), { ...options, inspect }));
  await assert.rejects(importTemplateBundle(new Blob([original, "x"]), { ...options, inspect }), /trailing/);
  for (const [offset, value, size] of [[8, 2, 2], [10, 65537, 4], [14, 9, 4]]) {
    const bytes = new Uint8Array(await original.arrayBuffer()), view = new DataView(bytes.buffer);
    if (size === 2) view.setUint16(offset, value); else view.setUint32(offset, value);
    await assert.rejects(importTemplateBundle(new Blob([bytes]), { ...options, inspect }), /version|bounds/);
  }
  assert.equal(inspected, 0);
});
test("PNG integrity, signature, decoded size and missing inventory failures are never accepted", async () => {
  const bytes = new Uint8Array(await (await bundle()).arrayBuffer()); bytes[bytes.length - 1] ^= 1;
  let inspected = false;
  await assert.rejects(importTemplateBundle(new Blob([bytes]), { ...options, inspect: async blob => { inspected = true; return inspectTemplateFixture(blob); } }), /integrity/);
  assert.equal(inspected, false);
  await assert.rejects(exportTemplateBundle(templateFixture(true), new Map(), options), /inventory/);
  await assert.rejects(importTemplateBundle(await bundle(), { ...options, inspect: async () => ({ mime: "image/jpeg", width: 1, height: 1 }) }), /PNG/);
  await assert.rejects(importTemplateBundle(await bundle(), { ...options, inspect: async () => ({ mime: "image/png", width: 2048, height: 2048 }) }), /dimensions/);
});
test("export applies real decoder failure rather than trusting the declaration", async () => {
  const recipe = validateTemplateRecipe(templateFixture(true));
  await assert.rejects(exportTemplateBundle(recipe, blobs(), { inspect: async () => { throw new Error("Native decoder rejected malformed PNG"); } }), /Native decoder/);
});
