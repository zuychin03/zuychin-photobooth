import assert from "node:assert/strict";
import test from "node:test";
import { applyTemplateToProject, createProject, validatePhotoProject } from "../lib/projects/model";
import { inspectImageHeader } from "../lib/projects/images";
import { designFromRecipe } from "../lib/templates/application";
import { validateTemplateDecorations } from "../lib/templates/bundle";
import { validateTemplateDesign } from "../lib/templates/model";
import { prepareTemplateMedia } from "../lib/templates/project-media";
import { templateFixture, templatePixel, templateTimestamp } from "./helpers/template-fixture";

const draft = () => createProject({ id: "template-media-project", createdAt: templateTimestamp, captureTimeZone: "Australia/Sydney" });
async function distinctPng(index: number): Promise<Blob> {
  const original = new Uint8Array(await templatePixel().arrayBuffer()), content = new TextEncoder().encode(`fixture\0${index}`);
  const chunk = new Uint8Array(12 + content.length), view = new DataView(chunk.buffer);
  view.setUint32(0, content.length); chunk.set(new TextEncoder().encode("tEXt"), 4); chunk.set(content, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, chunk.length - 4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  view.setUint32(chunk.length - 4, (crc ^ 0xffffffff) >>> 0);
  return new Blob([original.slice(0, -12), chunk, original.slice(-12)], { type: "image/png" });
}
async function fixture(count = 1) {
  const base = designFromRecipe(templateFixture()), incoming = new Map<string, Blob>();
  for (let index = 0; index < count; index++) incoming.set(`shelf-png-${index}`, await distinctPng(index));
  const design = validateTemplateDesign({ ...base,
    decorations: Array.from(incoming, ([id, blob]) => ({ id, kind: "decoration", mime: "image/png", bytes: blob.size, width: 1, height: 1 })),
    layers: Array.from(incoming.keys(), (mediaId, index) => ({ id: `layer-${index}`, kind: "decoration", mediaId, fit: "contain", x: index / 10, y: 0, width: 0.1, height: 0.1, rotation: 0 })),
  });
  return { design, incoming };
}

test("reapplying an eight-PNG shelf recipe reuses verified originals across new Blob objects and IDs", async () => {
  const project = draft(), { design, incoming } = await fixture(8);
  const first = await prepareTemplateMedia(project, new Map(), design, incoming);
  assert.equal(first.additions.size, 8);
  const saved = applyTemplateToProject(project, first.template, first.media, templateTimestamp);
  const reloadedBlobs = new Map(await Promise.all(Array.from(incoming, async ([id, blob]) => [id, new Blob([await blob.arrayBuffer()], { type: blob.type })] as const)));
  assert.notEqual(reloadedBlobs.get("shelf-png-0"), incoming.get("shelf-png-0"));
  const next = await prepareTemplateMedia(saved, first.additions, design, reloadedBlobs);
  assert.equal(next.additions.size, 0); assert.equal(next.media.length, 0);
  const reapplied = applyTemplateToProject(saved, next.template, next.media, templateTimestamp);
  assert.equal(reapplied.media.length, 8); assert.deepEqual(reapplied.media, saved.media);
  assert.deepEqual(next.template.decorations.map(item => item.id), saved.editor.template!.decorations.map(item => item.id));
  assert.deepEqual(next.template.layers.map(item => item.kind === "decoration" ? item.mediaId : ""), first.template.layers.map(item => item.kind === "decoration" ? item.mediaId : ""));
  assert.deepEqual(design.decorations.map(item => item.id), Array.from(incoming.keys()));
});

test("changed PNG bytes allocate a new immutable identity even when the recipe reuses the old ID", async () => {
  const project = draft(), { design, incoming } = await fixture();
  const first = await prepareTemplateMedia(project, new Map(), design, incoming), saved = applyTemplateToProject(project, first.template, first.media, templateTimestamp);
  const previousId = first.template.decorations[0].id, different = await distinctPng(9);
  assert.equal(different.size, first.template.decorations[0].bytes);
  const next = await prepareTemplateMedia(saved, first.additions, first.template, new Map([[previousId, different]]));
  assert.equal(next.additions.size, 1); assert.notEqual(next.template.decorations[0].id, previousId);
  assert.equal(saved.media[0].id, previousId); assert.equal(first.additions.size, 1);
});

test("equal encoded hashes cannot reuse a declaration with different dimensions", async () => {
  const project = draft(), { design, incoming } = await fixture();
  const first = await prepareTemplateMedia(project, new Map(), design, incoming), saved = applyTemplateToProject(project, first.template, first.media, templateTimestamp);
  const wrongDimensions = validateTemplateDesign({ ...design, decorations: design.decorations.map(item => ({ ...item, width: 2 })) });
  const next = await prepareTemplateMedia(saved, first.additions, wrongDimensions, incoming);
  assert.equal(next.additions.size, 1); assert.notEqual(next.template.decorations[0].id, saved.media[0].id);
  await assert.rejects(validateTemplateDecorations({ ...templateFixture(), ...next.template }, next.additions, async blob => inspectImageHeader(new Uint8Array(await blob.arrayBuffer()))), /dimensions/);
});

test("missing originals and photo-owned candidates cannot masquerade as reusable decoration files", async () => {
  const project = draft(), { design, incoming } = await fixture();
  const first = await prepareTemplateMedia(project, new Map(), design, incoming), saved = applyTemplateToProject(project, first.template, first.media, templateTimestamp);
  const withoutBytes = await prepareTemplateMedia(saved, new Map(), design, incoming);
  assert.equal(withoutBytes.additions.size, 1); assert.notEqual(withoutBytes.template.decorations[0].id, saved.media[0].id);
  const photo = validatePhotoProject({ ...project, capturedAt: templateTimestamp, media: [{ ...design.decorations[0], kind: "photo", participantId: project.participants[0].id }] });
  const fromPhoto = await prepareTemplateMedia(photo, incoming, design, incoming);
  assert.equal(fromPhoto.additions.size, 1); assert.notEqual(fromPhoto.template.decorations[0].id, photo.media[0].id);
});

test("missing, wrong-type and wrong-size incoming decoration bytes reject before preparation returns", async () => {
  const project = draft(), { design, incoming } = await fixture(), blob = incoming.get("shelf-png-0")!;
  for (const files of [new Map<string, Blob>(), new Map([["shelf-png-0", blob.slice(0, blob.size, "image/jpeg")]]), new Map([["shelf-png-0", blob.slice(0, blob.size - 1, "image/png")]])]) {
    await assert.rejects(prepareTemplateMedia(project, new Map(), design, files), /missing or differs/);
  }
  assert.equal(project.media.length, 0); assert.equal(incoming.size, 1);
});

test("separate declared decoration IDs remain unique even when their PNG pixels and bytes match", async () => {
  const project = draft(), { design, incoming } = await fixture(2), firstBlob = incoming.get("shelf-png-0")!;
  incoming.set("shelf-png-1", firstBlob);
  const prepared = await prepareTemplateMedia(project, new Map(), design, incoming);
  assert.equal(new Set(prepared.template.decorations.map(item => item.id)).size, 2);
  const saved = applyTemplateToProject(project, prepared.template, prepared.media, templateTimestamp);
  const again = await prepareTemplateMedia(saved, prepared.additions, design, incoming);
  assert.equal(again.additions.size, 0); assert.equal(new Set(again.template.decorations.map(item => item.id)).size, 2);
});
