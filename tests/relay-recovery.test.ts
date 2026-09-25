import test from "node:test";
import assert from "node:assert/strict";
import { importRelayPhotos, loadRelayOriginals, RelayOriginalEncoder, saveRelayOriginals } from "../lib/relay-recovery";
import type { openProjectRepository, ProjectRepository } from "../lib/projects/storage";
const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
const input = { id: "relay-one", ownerId: "account-one", layoutId: "duo-split", filterId: "none", role: "B" as const, originals: [blob], active: () => true };
const inspect = async () => ({ mime: "image/png" as const, width: 640, height: 480 });
test("relay originals persist byte-exact in the contributing account before continuation", async () => {
  let closed = false, saved = false;
  const open = (async (scope: Parameters<typeof openProjectRepository>[0], options: Parameters<typeof openProjectRepository>[1]) => ({ scope, close() { closed = true; }, async load() { return null; }, async save(...[project, media, revision]: Parameters<ProjectRepository["save"]>) { options?.assertActive?.(); assert.equal(revision, null); assert.equal(media.get("photo-0"), blob); assert.deepEqual(scope, { kind: "account", ownerId: "account-one" }); saved = true; return project; } })) as unknown as typeof openProjectRepository;
  const project = await saveRelayOriginals(input, open, inspect);
  assert.ok(saved && closed); assert.deepEqual(project.sourceOrder.B, ["photo-0"]); assert.equal(project.capturedAt, null);
});
test("local saving failure rejects the continuation and closes the repository", async () => {
  let closed = false;
  const open = (async () => ({ close() { closed = true; }, async load() { return null; }, async save() { throw new Error("Quota exceeded"); } })) as unknown as typeof openProjectRepository;
  await assert.rejects(saveRelayOriginals(input, open, inspect), /Quota/); assert.ok(closed);
});
test("account change during inspection never opens or writes a repository", async () => {
  let active = true, opened = false;
  await assert.rejects(saveRelayOriginals({ ...input, active: () => active }, (async () => { opened = true; throw new Error("unexpected"); }) as typeof openProjectRepository, async () => { active = false; return inspect(); }), /account/);
  assert.equal(opened, false);
});
test("photo import refuses wrong count before decode and releases late account-invalidated images", async () => {
  let calls = 0;
  await assert.rejects(importRelayPhotos([blob], 2, () => true, async () => { calls++; throw new Error("unexpected"); }), /exactly 2/); assert.equal(calls, 0);
  let active = true; const frame = { width: 640, height: 480 } as HTMLCanvasElement;
  await assert.rejects(importRelayPhotos([blob], 1, () => active, async () => { active = false; return frame; }), /closed/);
  assert.equal(frame.width, 0); assert.equal(frame.height, 0);
});

test("a refused second checkpoint retains the first original and exact retry appends without replacing bytes", async () => {
  let retained: Awaited<ReturnType<ProjectRepository["load"]>> = null, fail = false;
  const open = (async (scope: Parameters<typeof openProjectRepository>[0], options: Parameters<typeof openProjectRepository>[1]) => ({ scope, close() {}, async load() { return retained; }, async save(...[project, media, expected]: Parameters<ProjectRepository["save"]>) {
    options?.assertActive?.();
    assert.equal(expected, retained?.kind === "current" ? retained.project.revision : null);
    if (fail) throw new Error("Quota refused second checkpoint");
    retained = { kind: "current", readOnly: false, project, media: new Map(media), checkpoint: null, revision: project.revision, id: project.id };
    return project;
  } })) as unknown as typeof openProjectRepository;
  const second = new Blob([new Uint8Array([4, 5, 6])], { type: "image/png" });
  const full = { ...input, shots: 4, originals: [blob, second] };
  await saveRelayOriginals({ ...input, shots: 4 }, open, inspect);
  fail = true;
  await assert.rejects(saveRelayOriginals(full, open, inspect), /Quota/);
  const first = await loadRelayOriginals(input, open);
  assert.equal(first?.originals.length, 1); assert.equal(first?.project.capture.requiredShots, 4);
  assert.deepEqual(new Uint8Array(await first!.originals[0].arrayBuffer()), new Uint8Array(await blob.arrayBuffer()));
  fail = false;
  const saved = await saveRelayOriginals(full, open, inspect);
  assert.equal(saved.revision, 1); assert.equal(saved.media.length, 2);
  assert.equal((await saveRelayOriginals(full, open, inspect)).revision, 1);
  await assert.rejects(saveRelayOriginals({ ...full, originals: [second, blob] }, open, inspect), /differ/);
  assert.equal((await loadRelayOriginals(input, open))?.originals.length, 2);
});

test("encoder timeout retains its native allocation slot and leaves the source canvas intact", async () => {
  const encoder = new RelayOriginalEncoder(); let callback!: BlobCallback;
  const canvas = { width: 640, height: 480, toBlob(cb: BlobCallback) { callback = cb; } } as HTMLCanvasElement;
  await assert.rejects(encoder.encode(canvas, 5), /timed out/);
  assert.equal(encoder.busy, true); assert.equal(canvas.width, 640);
  await assert.rejects(encoder.encode(canvas), /still being prepared/);
  callback(blob); await encoder.settled(); assert.equal(encoder.busy, false);
  const retry = encoder.encode(canvas); callback(blob); assert.equal(await retry, blob);
});

test("encoder null and synchronous failure release the slot without deleting the retained photo", async () => {
  const encoder = new RelayOriginalEncoder();
  const canvas = { width: 640, height: 480, toBlob(cb: BlobCallback) { cb(null); } } as HTMLCanvasElement;
  await assert.rejects(encoder.encode(canvas), /retained/);
  assert.equal(encoder.busy, false); assert.equal(canvas.width, 640);
  canvas.toBlob = () => { throw new Error("Native encoder failed"); };
  await assert.rejects(encoder.encode(canvas), /Native encoder failed/);
  assert.equal(encoder.busy, false); assert.equal(canvas.height, 480);
});
