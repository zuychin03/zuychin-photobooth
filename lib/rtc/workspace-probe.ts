import { openRoomWorkspaceStore, type RoomWorkspaceStore } from "./workspace-store";
import { hashRecipe, initialRecipeCommit } from "./recipe-v2";
import type { RoomCapture, RoomState } from "../server/room-contract";
import { openTransferJournal, transferHash, type TransferJournal } from "./transfer-store";
import { retainOutgoing } from "./transfer";
import type { TransferManifest } from "./protocol";

export async function runRoomWorkspaceProbe(): Promise<{ checks: string[] }> {
  const prefix = `pb-room-workspace-probe-${crypto.randomUUID()}`, names = [`${prefix}-metadata`, `${prefix}-projects`, `${prefix}-transfers`];
  const roomId = crypto.randomUUID(), sessionId = crypto.randomUUID(), selfId = crypto.randomUUID(), guestId = crypto.randomUUID();
  const binding = { scope: { kind: "device" as const }, roomId, sessionId, selfId }, options = { databaseName: names[0], projectDatabaseName: names[1] };
  const stores: RoomWorkspaceStore[] = [], journals: TransferJournal[] = [], checks: string[] = [];
  const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 192;
  const ctx = canvas.getContext("2d")!, pixels = ctx.createImageData(canvas.width, canvas.height); let seed = 19;
  for (let i = 0; i < pixels.data.length; i += 4) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels.data[i] = seed & 255; pixels.data[i + 1] = (seed >>> 8) & 255; pixels.data[i + 2] = (seed >>> 16) & 255; pixels.data[i + 3] = 255; }
  ctx.putImageData(pixels, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Probe PNG failed")), "image/png"));
  const state: RoomState = { roomId, sessionId, selfId, hostId: selfId, selfRole: "A", code: "ABC234", connectionEpoch: crypto.randomUUID(), rosterRevision: 1, status: "open", locked: false, serverNow: Date.now(), expiresAt: Date.now() + 60000, capture: null, members: [{ id: selfId, role: "A", displayName: "Fixture A", status: "admitted", connectionEpoch: crypto.randomUUID() }, { id: guestId, role: "B", displayName: "Fixture B", status: "admitted", connectionEpoch: crypto.randomUUID() }] };
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
  try {
    const first = await openRoomWorkspaceStore(binding, options); stores.push(first);
    const draft = await first.loadDraft(state), recipe = await initialRecipeCommit({ project: draft.project, hostId: selfId, members: draft.project.participants, availableMediaIds: new Set() });
    await first.saveRecipe(recipe);
    const capture: RoomCapture = { captureId: crypto.randomUUID(), rosterRevision: 1, recipeHash: recipe.recipeHash, shotIds: Array.from({ length: draft.project.capture.requiredShots }, (_, index) => `shot-${index}`), fireAt: Date.now() - 1000, intervalMs: 1000, profile: { maxPhotoBytes: 256 * 1024, maxPhotoPixels: 65536, shotsPerMember: draft.project.capture.requiredShots }, memberIds: [selfId, guestId], acks: [selfId, guestId], state: "committed" };
    await first.prepareRound(capture, recipe); assert(await first.saveFrame({ capture, role: "A", shotIndex: 0, blob }) === capture.captureId, "Capture project identity differs");
    const saved = await first.loadRound(capture.captureId); await first.saveFrame({ capture, role: "A", shotIndex: 0, blob });
    assert((await first.loadRound(capture.captureId))!.project.revision === saved!.project.revision, "Exact frame retry added a revision"); checks.push("native PNG inspection, atomic source commit and exact retry");
    const journal = await openTransferJournal(binding, { databaseName: names[2] }); journals.push(journal);
    const manifest: TransferManifest = { id: crypto.randomUUID(), roomId, sessionId, memberId: selfId, captureId: capture.captureId, shotId: capture.shotIds[0], role: "A", mime: "image/png", width: canvas.width, height: canvas.height, bytes: blob.size, sha256: await transferHash(new Uint8Array(await blob.arrayBuffer())), chunkSize: 16384, chunks: Math.ceil(blob.size / 16384), expiresAt: state.expiresAt };
    assert(manifest.chunks > 1, "Fixture must exercise more than one transfer chunk");
    let interrupted = false;
    try { await retainOutgoing({ ...journal, putChunk: async (id, index, bytes) => { if (index === 1) throw new Error("fixture_interrupted"); await journal.putChunk(id, index, bytes); } }, manifest, blob); }
    catch (error) { interrupted = error instanceof Error && error.message === "fixture_interrupted"; }
    assert(interrupted && (await journal.get(manifest.id))?.chunks[0], "Staging did not fail after its first persisted chunk");
    journal.close(); await first.close();
    const reopened = await openRoomWorkspaceStore(binding, options); stores.push(reopened);
    const restored = await reopened.loadDraft(state), round = await reopened.loadRound(capture.captureId);
    assert(restored.recipe?.recipeHash === recipe.recipeHash && round?.project.media.length === 1 && round.project.sourceOrder.A[0] === "room-A-0", "Reload lost checkpoint or source"); checks.push("close/reopen restores recipe revision, frozen roster and real project source");
    const loadedBlob = await reopened.loadSavedFrame(capture.captureId, "A", 0), recoveredJournal = await openTransferJournal(binding, { databaseName: names[2] }); journals.push(recoveredJournal);
    assert(loadedBlob && await transferHash(new Uint8Array(await loadedBlob.arrayBuffer())) === manifest.sha256, "Recovered project source differs from the original");
    const staged = await retainOutgoing(recoveredJournal, { ...manifest, id: crypto.randomUUID() }, loadedBlob!);
    assert(staged.manifest.id === manifest.id && (await recoveredJournal.list()).length === 1 && staged.chunks.every(Boolean), "Recovered original did not refill its single original staging identity");
    assert(await transferHash(new Uint8Array(await new Blob(staged.chunks.map(chunk => chunk!.blob)).arrayBuffer())) === manifest.sha256, "Refilled staging changed original bytes"); checks.push("real saved original repairs partial outgoing staging after both databases reopen");
    ctx.fillStyle = "#111111"; ctx.fillRect(0, 0, 16, 12);
    const changed = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Probe PNG failed")), "image/png"));
    let refused = false; try { await reopened.saveFrame({ capture, role: "A", shotIndex: 0, blob: changed }); } catch { refused = true; }
    assert(refused && (await reopened.loadRound(capture.captureId))!.project.revision === round!.project.revision, "Different source overwrote an original"); checks.push("different retry bytes preserve the first original");
    const account = await openRoomWorkspaceStore({ ...binding, scope: { kind: "account", ownerId: "room-probe-account" } }, options); stores.push(account);
    assert(await account.loadRound(capture.captureId) === null, "Device round leaked into account scope"); checks.push("exact device/account workspace isolation");
    const nextRecipe = { ...recipe.recipe, editor: { ...recipe.recipe.editor, caption: "Probe finishing" } }, next = { ...recipe, recipe: nextRecipe, recipeHash: await hashRecipe(nextRecipe), revision: 1, proposalId: crypto.randomUUID() };
    await reopened.saveRecipe(next); const finished = await reopened.updateRoundRecipe(capture.captureId, next);
    assert(finished.initialRecipeHash === recipe.recipeHash && finished.recipe.recipeHash === next.recipeHash && finished.project.media.length === 1, "Finishing changed capture identity or source inventory"); checks.push("finishing persists independently of original capture hash");
    const changedRoster = { ...state, rosterRevision: 2, members: state.members.slice(0, 1) }, nextDraft = await reopened.loadDraft(changedRoster);
    assert(nextDraft.project.id !== draft.project.id && (await reopened.loadRound(capture.captureId))?.participants.length === 2, "Roster update replaced a frozen round"); checks.push("new roster retains previous draft and frozen round");
    return { checks };
  } finally {
    await Promise.all(stores.map(store => store.close())); for (const journal of journals) journal.close(); canvas.width = canvas.height = 0;
    await Promise.all(names.map(name => new Promise<void>((resolve, reject) => {
      if (!name.startsWith("pb-room-workspace-probe-")) { reject(new Error("Refusing non-fixture database")); return; }
      const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error("Fixture cleanup blocked"));
    })));
  }
}
