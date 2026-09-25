import assert from "node:assert/strict";
import test from "node:test";
import { createProject, validatePhotoProject } from "../lib/projects/model";
import { defaultCellEdit } from "../lib/projects/transforms";
import { validateTemplateDesign } from "../lib/templates/model";
import { STICKER_PACKS } from "../lib/decor";
import { acceptRecipeCommit, canonicalRecipe, chooseRecipeReconnect, hashRecipe, initialRecipeCommit, RecipeCoordinator, RecipeError, validateRecipeCommit, validateRecipeProposal, type RecipeContext, type RecipeEdit, type RecipeProposal } from "../lib/rtc/recipe-v2";
import { templateFixture } from "./helpers/template-fixture";
import { createStoryPlan, relaxStoryStep } from "../lib/stories/model";

const host = "00000000-0000-4000-8000-000000000001", guest = "00000000-0000-4000-8000-000000000002", outsider = "00000000-0000-4000-8000-000000000003";
const members = [{ id: host, role: "A" as const }, { id: guest, role: "B" as const }];
function context(): RecipeContext {
  return { hostId: host, members, availableMediaIds: new Set(), project: createProject({ id: "shared-project", mode: "duo", participants: members, createdAt: "2026-01-01T00:00:00.000Z", captureTimeZone: "UTC" }) };
}
function proposal(edit: RecipeEdit, baseRevision = 0, id = crypto.randomUUID()): RecipeProposal { return { schemaVersion: 1, id, baseRevision, edit }; }
const code = (expected: RecipeError["code"]) => (error: unknown) => error instanceof RecipeError && error.code === expected;
const ownCell = (zoom = 2): RecipeEdit => ({ kind: "cell", role: "B", cellIndex: 1, value: { ...defaultCellEdit(0), zoom } });

test("host-ordered story seeds and relaxed prompts reach followers without guest authorisation to replace them", async () => {
  const ctx = context(), initial = await initialRecipeCommit(ctx), coordinator = new RecipeCoordinator(initial, () => ctx);
  const story = relaxStoryStep(createStoryPlan("quiet-company", 123), 1, true);
  await assert.rejects(coordinator.commit(guest, proposal({ kind: "shared", patch: { story } })), code("ownership_denied"));
  const committed = await coordinator.commit(host, proposal({ kind: "shared", patch: { story } }));
  const accepted = await acceptRecipeCommit(initial, committed, host, ctx);
  assert.deepEqual(accepted.recipe.editor.story, story); assert.notEqual(accepted.recipeHash, initial.recipeHash);
  coordinator.close();
});
test("a host waiting alone can save an initial recipe without authorising a solo room capture", async () => {
  const ctx: RecipeContext = { ...context(), members: [members[0]], project: createProject({ mode: "solo", participants: [members[0]] }) };
  const initial = await initialRecipeCommit(ctx);
  assert.deepEqual(Object.keys(initial.recipe.owners), ["A"]);
  const coordinator = new RecipeCoordinator(initial, () => ctx);
  assert.equal((await coordinator.commit(host, proposal({ kind: "shared", patch: { caption: "Waiting for friends" } }))).revision, 1);
});
function templateContext(decorations = false): RecipeContext {
  const initial = context(), fixture = templateFixture(decorations);
  const design = validateTemplateDesign({ canvas: fixture.canvas, requiredSources: { A: 1, B: 1 }, slots: [{ ...fixture.slots[0], companions: [{ role: "B", sourceIndex: 0, crop: fixture.slots[0].crop, sliceX: [0.5, 1] }], splitFallback: true }], layers: fixture.layers, decorations: fixture.decorations, look: fixture.look, defaults: fixture.defaults });
  const media = fixture.decorations.map(item => ({ ...item, participantId: null }));
  return { ...initial, availableMediaIds: new Set(media.map(item => item.id)), project: validatePhotoProject({ ...initial.project, media, editor: { ...initial.project.editor, template: design } }) };
}
test("host orders concurrent proposals, rejects stale base, retries idempotently and does not poison the queue", async () => {
  const ctx = context(), initial = await initialRecipeCommit(ctx), coordinator = new RecipeCoordinator(initial, () => ctx);
  const edit = proposal(ownCell()), other = proposal({ kind: "shared", patch: { caption: "Hello" } });
  const results = await Promise.allSettled([coordinator.commit(guest, edit), coordinator.commit(host, other)]);
  assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].status, "rejected");
  if (results[1].status === "rejected") assert(code("recovery_required")(results[1].reason));
  const first = coordinator.snapshot;
  assert.equal(first.revision, 1); assert.equal(first.recipe.editor.cellEdits["1:B"].zoom, 2);
  assert.equal(await coordinator.commit(guest, edit), first);
  await assert.rejects(coordinator.commit(guest, { ...edit, edit: ownCell(3) }), code("ownership_denied"));
  const next = await coordinator.commit(host, proposal({ kind: "shared", patch: { caption: "Hello" } }, 1));
  assert.equal(next.revision, 2); assert.equal(next.recipe.editor.caption, "Hello");
  assert.equal(initial.recipe.editor.caption, ""); assert(Object.isFrozen(next.recipe.editor));
});
test("authoritative member identity restricts shared changes and all foreign photo/cutout edits", async () => {
  const ctx = context(), initial = await initialRecipeCommit(ctx), coordinator = new RecipeCoordinator(initial, () => ctx);
  await assert.rejects(coordinator.commit(guest, proposal({ kind: "shared", patch: { frameId: "rose" } })), code("ownership_denied"));
  await assert.rejects(coordinator.commit(guest, proposal({ kind: "cell", role: "A", cellIndex: 0, value: defaultCellEdit(0) })), code("ownership_denied"));
  await assert.rejects(coordinator.commit(host, proposal({ kind: "placement", role: "B", value: { dx: 0, dy: 0, scale: 1 } })), code("ownership_denied"));
  await assert.rejects(coordinator.commit(outsider, proposal(ownCell())), code("ownership_denied"));
  assert.equal(coordinator.snapshot.revision, 0);
  const edited = await coordinator.commit(guest, proposal({ kind: "placement", role: "B", value: { dx: .2, dy: -.1, scale: 1.2 } }));
  assert.equal(edited.recipe.editor.places.B?.scale, 1.2);
});
test("sticker ownership survives collisions, updates, removals and host commits", async () => {
  const ctx = context(), coordinator = new RecipeCoordinator(await initialRecipeCommit(ctx), () => ctx);
  const sticker = { key: 100, ...STICKER_PACKS[0].stickers[0], x: .5, y: .4, scale: 1, rotation: 0 };
  const added = await coordinator.commit(guest, proposal({ kind: "sticker", role: "B", key: 100, value: sticker }));
  assert.equal(added.recipe.stickerOwners["100"], guest);
  await assert.rejects(coordinator.commit(host, proposal({ kind: "sticker", role: "A", key: 100, value: null }, 1)), code("ownership_denied"));
  await assert.rejects(coordinator.commit(host, proposal({ kind: "sticker", role: "A", key: 100, value: { ...sticker, x: .1 } }, 1)), code("ownership_denied"));
  const removed = await coordinator.commit(guest, proposal({ kind: "sticker", role: "B", key: 100, value: null }, 1));
  assert.equal(removed.recipe.editor.stickers.length, 0); assert.deepEqual(Object.keys(removed.recipe.stickerOwners), []);
});
test("template companion edits retain the primary, slice, private text, PNG and exact required sources", async () => {
  const ctx = templateContext(true), initial = await initialRecipeCommit(ctx), coordinator = new RecipeCoordinator(initial, () => ctx);
  const adjusted = await coordinator.commit(guest, proposal({ kind: "template-cell", role: "B", slotId: "slot-one", value: { ...defaultCellEdit(3), zoom: 3, rotation: 90 } }));
  const before = initial.recipe.editor.template!, after = adjusted.recipe.editor.template!;
  assert.deepEqual(after.slots[0].crop, before.slots[0].crop);
  assert.deepEqual(after.slots[0].companions?.[0].sliceX, [0.5, 1]);
  assert.equal(after.slots[0].companions?.[0].crop.rotation, 90); assert.equal(after.requiredSources.B, 4);
  assert.deepEqual(after.layers, before.layers); assert.deepEqual(after.decorations, before.decorations);
  await assert.rejects(coordinator.commit(host, proposal({ kind: "shared", patch: { template: { ...after, slots: [{ ...after.slots[0], companions: [{ ...after.slots[0].companions![0], crop: { ...after.slots[0].companions![0].crop, zoom: 1 } }] }] } } }, 1)), code("ownership_denied"));
  const hostLook = await coordinator.commit(host, proposal({ kind: "shared", patch: { frameId: "rose" } }, 1));
  assert.equal(hostLook.recipe.editor.frameId, "rose"); assert.equal(hostLook.recipe.editor.template?.slots[0].companions?.[0].crop.zoom, 3);
});
test("missing original bytes, missing decorations and changed declaration metadata reject without dropping layers", async () => {
  const ctx = templateContext(true);
  await assert.rejects(initialRecipeCommit({ ...ctx, availableMediaIds: new Set() }), code("media_unavailable"));
  await assert.rejects(initialRecipeCommit({ ...ctx, project: { ...ctx.project, media: [] } }), code("media_unavailable"));
  const coordinator = new RecipeCoordinator(await initialRecipeCommit(ctx), () => ctx);
  const template = ctx.project.editor.template!;
  await assert.rejects(coordinator.commit(host, proposal({ kind: "shared", patch: { template: { ...template, decorations: template.decorations.map(item => ({ ...item, bytes: item.bytes + 1 })) } } })), code("media_unavailable"));
  assert.equal(coordinator.snapshot.revision, 0);
  const photo = { id: "existing-photo", kind: "photo" as const, mime: "image/jpeg" as const, bytes: 10, width: 1, height: 1, participantId: host };
  const withPhoto = validatePhotoProject({ ...ctx.project, capturedAt: ctx.project.createdAt, media: [...ctx.project.media, photo], sourceOrder: { ...ctx.project.sourceOrder, A: [photo.id] } });
  await assert.rejects(initialRecipeCommit({ ...ctx, project: withPhoto }), code("media_unavailable"));
});
test("current role reuse, host changes and project/account switches cannot inherit a coordinator", async () => {
  let ctx = context(); const coordinator = new RecipeCoordinator(await initialRecipeCommit(ctx), () => ctx);
  const original = ctx;
  ctx = { ...ctx, members: [members[0], { id: outsider, role: "B" }] };
  await assert.rejects(coordinator.commit(outsider, proposal(ownCell())), code("recovery_required"));
  ctx = { ...original, hostId: guest };
  await assert.rejects(coordinator.commit(guest, proposal(ownCell())), code("recovery_required"));
  ctx = { ...original, project: { ...original.project, id: "another-project" } };
  await assert.rejects(coordinator.commit(guest, proposal(ownCell())), code("recovery_required"));
  ctx = { ...original, project: { ...original.project, scope: { kind: "account", ownerId: "another-account" } } };
  await assert.rejects(coordinator.commit(guest, proposal(ownCell())), code("recovery_required"));
  assert.equal(coordinator.snapshot.revision, 0);
});
test("canonical hash is property-order independent and includes member/sticker ownership", async () => {
  const initial = await initialRecipeCommit(context()), recipe = initial.recipe;
  const reversed = { stickerOwners: recipe.stickerOwners, owners: { B: guest, A: host }, editor: Object.fromEntries(Object.entries(recipe.editor).reverse()) as typeof recipe.editor };
  assert.equal(canonicalRecipe(recipe), canonicalRecipe(reversed)); assert.equal(await hashRecipe(recipe), await hashRecipe(reversed));
  assert.notEqual(await hashRecipe({ ...recipe, owners: { A: guest, B: host } }), initial.recipeHash);
  assert.equal(initial.recipeHash.length, 64);
});
test("followers require authenticated host, exact next revision, verified hash and owner-preserving changes", async () => {
  const ctx = context(), initial = await initialRecipeCommit(ctx), coordinator = new RecipeCoordinator(initial, () => ctx);
  const next = await coordinator.commit(guest, proposal(ownCell()));
  assert.equal((await acceptRecipeCommit(initial, next, host, ctx)).revision, 1);
  assert.equal(await acceptRecipeCommit(next, next, host, ctx), next);
  await assert.rejects(acceptRecipeCommit(initial, next, guest, ctx), code("ownership_denied"));
  await assert.rejects(acceptRecipeCommit(initial, { ...next, revision: 3 }, host, ctx), code("recovery_required"));
  await assert.rejects(acceptRecipeCommit(initial, { ...next, recipeHash: "0".repeat(64) }, host, ctx), code("invalid_recipe"));
  const malicious = { ...next.recipe, editor: { ...next.recipe.editor, caption: "Guest changed shared text" } };
  await assert.rejects(acceptRecipeCommit(initial, { ...next, recipe: malicious, recipeHash: await hashRecipe(malicious) }, host, ctx), code("ownership_denied"));
});
test("reconnect is an explicit choice, preserves local fork and does not require media to keep it", async () => {
  const ctx = context(), initial = await initialRecipeCommit(ctx), coordinator = new RecipeCoordinator(initial, () => ctx);
  const newer = await coordinator.commit(host, proposal({ kind: "shared", patch: { caption: "Host copy" } }));
  const local = { ...initial.recipe, editor: { ...initial.recipe.editor, caption: "Local unsaved copy" } };
  const kept = await chooseRecipeReconnect(local, null, outsider, ctx, "keep-local-fork");
  assert.equal(kept.kind, "local-fork"); if (kept.kind === "local-fork") { assert.equal(kept.connected, false); assert.equal(kept.recipe.editor.caption, "Local unsaved copy"); }
  const accepted = await chooseRecipeReconnect(local, newer, host, ctx, "accept-host");
  assert.equal(accepted.kind, "host"); if (accepted.kind === "host") { assert.equal(accepted.commit.revision, 1); assert.equal(accepted.preservedLocalFork.editor.caption, "Local unsaved copy"); }
  await assert.rejects(chooseRecipeReconnect(local, newer, outsider, ctx, "accept-host"), code("ownership_denied"));
});
test("wire inputs reject executable data, URLs, new media references, unknown fields and unbounded values", () => {
  let accessed = false; const hostile = { schemaVersion: 1, id: crypto.randomUUID(), baseRevision: 0, get edit() { accessed = true; return ownCell(); } };
  assert.throws(() => validateRecipeProposal(hostile), code("invalid_recipe")); assert.equal(accessed, false);
  for (const value of [
    { ...proposal(ownCell()), token: "secret" },
    proposal({ kind: "shared", patch: { frameId: "https://example.test/frame.svg" } }),
    proposal({ kind: "shared", patch: { caption: "x".repeat(501) } }),
    proposal({ kind: "cell", role: "B", cellIndex: 1, value: { ...defaultCellEdit(0), sourceIndex: 4 } }),
    proposal({ kind: "placement", role: "B", value: { dx: 1, dy: 0, scale: 1 } }),
    { ...proposal(ownCell()), edit: { kind: "shared", patch: { sourceOrder: { A: ["foreign-photo"] } } } },
    { ...proposal(ownCell()), edit: { kind: "shared", patch: { media: [{ url: "file:///private" }] } } },
  ]) assert.throws(() => validateRecipeProposal(value));
  assert.throws(() => validateRecipeProposal({ ...proposal(ownCell()), schemaVersion: 2 }), code("update_required"));
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.throws(() => validateRecipeProposal(cyclic));
});
test("ownership maps cannot invent members, omit stickers or add roles absent from the recipe", async () => {
  const initial = await initialRecipeCommit(context());
  assert.throws(() => validateRecipeCommit({ ...initial, recipe: { ...initial.recipe, owners: { A: host, B: host } } }));
  assert.throws(() => validateRecipeCommit({ ...initial, recipe: { ...initial.recipe, stickerOwners: { 1: guest } } }));
  assert.throws(() => validateRecipeCommit({ ...initial, recipe: { ...initial.recipe, editor: { ...initial.recipe.editor, cellEdits: { "0:C": defaultCellEdit(0) } } } }));
});
test("bounded queue rejects excess work and closing fences in-flight hash completion", async () => {
  const ctx = context(), coordinator = new RecipeCoordinator(await initialRecipeCommit(ctx), () => ctx);
  const tasks = Array.from({ length: 16 }, () => coordinator.commit(guest, proposal(ownCell())));
  await assert.rejects(coordinator.commit(guest, proposal(ownCell())), code("queue_full"));
  coordinator.close();
  const result = await Promise.allSettled(tasks); assert(result.every(item => item.status === "rejected"));
  assert.equal(coordinator.snapshot.revision, 0);
  await assert.rejects(coordinator.commit(guest, proposal(ownCell())), code("closed"));
});
test("closing or replacing the project while SHA-256 is pending cannot publish a late revision", async () => {
  const ctx = context(), initial = await initialRecipeCommit(ctx);
  const coordinator = new RecipeCoordinator(initial, () => ctx);
  const pending = coordinator.commit(guest, proposal(ownCell()));
  await Promise.resolve(); coordinator.close();
  await assert.rejects(pending, code("closed")); assert.equal(coordinator.snapshot.revision, 0);
  let reads = 0;
  const switched = new RecipeCoordinator(initial, () => ++reads < 3 ? ctx : { ...ctx, project: { ...ctx.project, id: "switched-during-hash" } });
  await assert.rejects(switched.commit(guest, proposal(ownCell())), code("recovery_required"));
  assert.equal(reads, 3); assert.equal(switched.snapshot.revision, 0);
});
test("template and free sticker layers share the 32-layer budget and oversized templates cannot bypass proposal bytes", async () => {
  const ctx = templateContext(), template = ctx.project.editor.template!;
  const sticker = STICKER_PACKS[0].stickers[0];
  const crowded = validateTemplateDesign({ ...template, layers: Array.from({ length: 32 }, (_, index) => ({ kind: "sticker", id: `sticker-${index}`, slug: sticker.slug, style: "flat", x: .1, y: .1, width: .1, height: .1, rotation: 0 })) });
  const crowdedContext = { ...ctx, project: validatePhotoProject({ ...ctx.project, editor: { ...ctx.project.editor, template: crowded } }) };
  const coordinator = new RecipeCoordinator(await initialRecipeCommit(crowdedContext), () => crowdedContext);
  await assert.rejects(coordinator.commit(guest, proposal({ kind: "sticker", role: "B", key: 1, value: { key: 1, ...sticker, x: .5, y: .5, scale: 1, rotation: 0 } })), code("invalid_recipe"));
  const text = template.layers[0];
  assert.equal(text.kind, "text");
  const large = validateTemplateDesign({ ...template, layers: Array.from({ length: 16 }, (_, index) => ({ ...text, id: `text-${index}`, text: "🌻".repeat(500) })) });
  assert.throws(() => validateRecipeProposal(proposal({ kind: "shared", patch: { template: large } })), code("invalid_recipe"));
});

test("host commits and follower acceptance cannot omit an admitted role from the standard layout", async () => {
  const people = [{ id: host, role: "A" as const }, { id: guest, role: "B" as const }, { id: outsider, role: "C" as const }, { id: "00000000-0000-4000-8000-000000000004", role: "D" as const }];
  const project = createProject({ mode: "group", participants: people });
  const ctx: RecipeContext = { project: validatePhotoProject({ ...project, editor: { ...project.editor, layoutId: "quad" } }), hostId: host, members: people, availableMediaIds: new Set() };
  const initial = await initialRecipeCommit(ctx), coordinator = new RecipeCoordinator(initial, () => ctx);
  await assert.rejects(coordinator.commit(host, proposal({ kind: "shared", patch: { layoutId: "trio" } })), code("invalid_recipe"));
  const recipe = { ...initial.recipe, editor: { ...initial.recipe.editor, layoutId: "trio" } };
  await assert.rejects(acceptRecipeCommit(initial, { ...initial, revision: 1, proposalId: crypto.randomUUID(), recipe, recipeHash: await hashRecipe(recipe) }, host, ctx), code("invalid_recipe"));
  for (const roles of [[people[0], people[3]], [people[0], people[2]]]) {
    const sparse = createProject({ mode: "group", participants: roles });
    const sparseContext = { ...ctx, members: roles, project: validatePhotoProject({ ...sparse, editor: { ...sparse.editor, layoutId: roles[1].role === "D" ? "quad" : "trio" } }) };
    assert.equal((await initialRecipeCommit(sparseContext)).recipe.owners[roles[1].role], roles[1].id);
  }
});
test("templates must represent every member, including companions, independently of underlying layout", async () => {
  const ctx = templateContext(), template = ctx.project.editor.template!;
  const omitted = validateTemplateDesign({ ...template, requiredSources: { A: 1 }, slots: template.slots.map(slot => Object.fromEntries(Object.entries(slot).filter(([key]) => !["companions", "splitFallback"].includes(key)))) });
  await assert.rejects(initialRecipeCommit({ ...ctx, project: validatePhotoProject({ ...ctx.project, editor: { ...ctx.project.editor, template: omitted } }) }), code("invalid_recipe"));
  assert.deepEqual(Object.keys((await initialRecipeCommit(ctx)).recipe.editor.template!.requiredSources), ["A", "B"]);
  const base = context(), split = { ...base, project: validatePhotoProject({ ...base.project, editor: { ...base.project.editor, layoutId: "duo-split" } }) };
  assert.deepEqual(Object.keys((await initialRecipeCommit(split)).recipe.owners), ["A", "B"]);
});
