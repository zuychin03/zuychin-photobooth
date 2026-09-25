import { createChallengeCameraOriginals } from "./challenge-camera-originals";
import { openProjectRepository, type ProjectRepository } from "../projects/storage";
import { removeLocalAccountCopies } from "../projects/account-cleanup";
import { cloudSha256 } from "../projects/cloud-client";
import type { CloudUploadRecord } from "../projects/cloud-upload";
import { closeRoomScope } from "../rtc/scope-lifecycle";

async function fixtureFile(mime: "image/png" | "image/jpeg"): Promise<File> {
  const canvas = document.createElement("canvas"); canvas.width = 120; canvas.height = 80;
  const ctx = canvas.getContext("2d");
  if (!ctx) { canvas.width = canvas.height = 0; throw new Error("Fixture canvas unavailable"); }
  ctx.fillStyle = "#bc355d"; ctx.fillRect(0, 0, 120, 80); ctx.fillStyle = "#efe2b4"; ctx.fillRect(17, 11, 40, 37);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const encoding = new Promise<Blob>((resolve, reject) => {
    try { canvas.toBlob(blob => {
      canvas.width = canvas.height = 0;
      if (blob) resolve(blob); else reject(new Error("Fixture encoding failed"));
    }, mime, 0.9); } catch (error) { canvas.width = canvas.height = 0; reject(error); }
  });
  try {
    const blob = await Promise.race([encoding, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture encoding timed out")), 5000); })]);
    if (blob.type !== mime) throw new Error("Native fixture encoder did not support the requested format");
    return new File([blob], `synthetic.${mime === "image/png" ? "png" : "jpg"}`, { type: mime, lastModified: Date.now() - 1000 });
  } finally { clearTimeout(timer); }
}

export async function runChallengeCameraOriginalsProbe(): Promise<{ passed: number; checks: string[] }> {
  if (process.env.NODE_ENV !== "development") throw new Error("Development probe unavailable");
  const databaseName = `pb-challenge-camera-probe-${crypto.randomUUID()}`, ownerId = crypto.randomUUID(), otherOwner = crypto.randomUUID(), challengeId = crypto.randomUUID(), cloudProjectId = crypto.randomUUID();
  const scope = { kind: "account" as const, ownerId }, checks: string[] = [], repositories: ProjectRepository[] = [], cameras: ReturnType<typeof createChallengeCameraOriginals>[] = [];
  let currentOwner: string | null = ownerId;
  const open: typeof openProjectRepository = async projectScope => {
    const repository = await openProjectRepository(projectScope, { databaseName, timeoutMs: 5000 }); repositories.push(repository); return repository;
  };
  const camera = (actor = ownerId) => {
    const store = createChallengeCameraOriginals({ ownerId: actor, challengeId, open, assertActive(signal) { if (currentOwner !== actor || signal?.aborted) throw new Error("Probe identity changed"); } }); cameras.push(store); return store;
  };
  const check = (condition: boolean, name: string) => { if (!condition) throw new Error(name); checks.push(name); };
  const denied = async (operation: () => Promise<unknown>) => { try { await operation(); return false; } catch { return true; } };
  async function record(file: File, actor = ownerId): Promise<CloudUploadRecord> {
    const id = crypto.randomUUID(), at = new Date().toISOString();
    return { id, ownerId: actor, projectId: cloudProjectId, asset: { id, requestId: crypto.randomUUID(), kind: "photo", mime: file.type as "image/png" | "image/jpeg", bytes: file.size, width: 120, height: 80, sha256: await cloudSha256(await file.arrayBuffer()), protection: { kind: "challenge", id: challengeId } }, state: "prepared", createdAt: at, updatedAt: at, reservedUntil: null };
  }
  try {
    const png = await fixtureFile("image/png"), jpeg = await fixtureFile("image/jpeg"), first = await record(png), retake = await record(jpeg);
    const initial = camera(); await initial.save(first, png, 3);
    const inspector = await open(scope); let loaded = await inspector.load(initial.projectId);
    check(loaded?.kind === "current" && loaded.project.sourceOrder.A.length === 4 && loaded.project.sourceOrder.A.slice(0, 3).every(id => id === null) && loaded.project.sourceOrder.A[3] === first.id, "Native repository preserves sparse source index 3 without shifting the photo");
    await initial.save(retake, jpeg, 3); loaded = await inspector.load(initial.projectId);
    check(loaded?.kind === "current" && loaded.project.sourceOrder.A[3] === retake.id && loaded.project.media.length === 2 && loaded.media.has(first.id) && loaded.media.has(retake.id), "Retake changes the active slot while retaining both original files");
    const revision = loaded?.revision; await initial.save(retake, jpeg, 3);
    check((await inspector.load(initial.projectId))?.revision === revision, "Exact repeated save does not create another metadata revision");
    await initial.close(); inspector.close(); const reopened = camera();
    for (const [saved, original] of [[first, png], [retake, jpeg]] as const) {
      const file = await reopened.load(saved);
      check(file instanceof File && file.type === original.type && file.size === original.size && file.name.endsWith(original.type === "image/png" ? ".png" : ".jpg") && await cloudSha256(await file.arrayBuffer()) === saved.asset.sha256, `Close and reopen preserves exact ${original.type} bytes and matching filename extension`);
    }
    check((await reopened.list()).length === 2, "Reopened recovery inventory includes retired and current shots");
    check(await denied(() => reopened.load({ ...first, ownerId: otherOwner })) && await denied(() => reopened.load({ ...first, asset: { ...first.asset, protection: { kind: "challenge", id: crypto.randomUUID() } } })), "Foreign owner and challenge records cannot read a saved original");
    check(await denied(() => reopened.save({ ...first, id: crypto.randomUUID() }, png, 3)) && await denied(() => reopened.save({ ...first, asset: { ...first.asset, sha256: "0".repeat(64) } }, png, 3)), "Mismatched upload identity or file bytes cannot overwrite originals");
    currentOwner = otherOwner;
    check(await denied(() => reopened.load(first)), "Identity change fences an already-open camera original handle");
    const foreign = camera(otherOwner), otherRecord = await record(png, otherOwner); await foreign.save(otherRecord, png, 0);
    currentOwner = ownerId;
    await closeRoomScope(scope);
    check(await denied(() => reopened.save(retake, jpeg, 3)), "Scope cleanup closes and drains camera writers before deleting copies");
    const cleanup = await removeLocalAccountCopies(ownerId, open);
    check(cleanup.removed === 1 && cleanup.retained === 0 && !cleanup.incomplete, "Exact synthetic-account cleanup removes the isolated camera project");
    const clean = camera(); check((await clean.list()).length === 0 && await denied(() => clean.load(first)), "Reopen after cleanup cannot resurrect prior originals");
    currentOwner = otherOwner;
    check(await cloudSha256(await (await foreign.load(otherRecord)).arrayBuffer()) === otherRecord.asset.sha256, "The other synthetic account retains its original after owner cleanup");
    return { passed: checks.length, checks };
  } finally {
    await Promise.allSettled(cameras.map(camera => camera.close()));
    for (const repository of repositories) repository.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName), timer = setTimeout(() => reject(new Error("Camera probe database cleanup timed out")), 5000);
      request.onsuccess = () => { clearTimeout(timer); resolve(); }; request.onerror = () => { clearTimeout(timer); reject(request.error); };
    });
  }
}
