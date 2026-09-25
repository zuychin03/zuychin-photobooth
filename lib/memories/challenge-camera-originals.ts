import { CLOUD_PROJECT_LIMITS, cloudUuid } from "../projects/cloud-contract";
import type { CloudUploadRecord } from "../projects/cloud-upload";
import { cloudSha256 } from "../projects/cloud-client";
import { createProject, appendProjectMedia, validatePhotoProject, type ProjectScope } from "../projects/model";
import { openProjectRepository, type ProjectRepository } from "../projects/storage";
import { registerRoomScopeCloser, roomScopeEpoch } from "../rtc/scope-lifecycle";

export function createChallengeCameraOriginals(options: {
  ownerId: string; challengeId: string; assertActive(signal?: AbortSignal): void;
  open?: typeof openProjectRepository;
}) {
  const scope: ProjectScope = { kind: "account", ownerId: cloudUuid(options.ownerId) };
  const projectId = `challenge-${cloudUuid(options.challengeId)}`, epoch = roomScopeEpoch(scope);
  let closed = false, repository: ProjectRepository | null = null, unregister: (() => void) | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  const active = (signal?: AbortSignal) => { options.assertActive(signal); if (closed || roomScopeEpoch(scope) !== epoch || signal?.aborted) throw new Error("Camera original storage closed"); };
  let closing: Promise<void> | null = null;
  const close = () => {
    closed = true; repository?.close();
    closing ??= tail.catch(() => {}).then(() => { unregister?.(); unregister = null; });
    return closing;
  };
  function run<T>(work: (repo: ProjectRepository) => Promise<T>, signal?: AbortSignal): Promise<T> {
    active(signal);
    unregister ??= registerRoomScopeCloser(scope, close);
    const next = tail.then(async () => {
      active(signal);
      if (!repository) {
        const opened = await (options.open ?? openProjectRepository)(scope);
        try { active(signal); } catch (error) { opened.close(); throw error; }
        repository = opened;
      }
      const result = await work(repository); active(signal); return result;
    });
    tail = next.catch(() => {}); return next;
  }
  function checkRecord(record: CloudUploadRecord) {
    if (record.ownerId !== options.ownerId || record.asset.kind !== "photo" || record.asset.protection.kind !== "challenge" || record.asset.protection.id !== options.challengeId || record.id !== record.asset.id) throw new Error("Camera original identity mismatch");
  }
  async function checkBlob(blob: Blob, record: CloudUploadRecord, signal?: AbortSignal) {
    if (!blob.size || blob.size > CLOUD_PROJECT_LIMITS.assetBytes || blob.size !== record.asset.bytes || blob.type !== record.asset.mime) throw new Error("Camera original differs from upload");
    const hash = await cloudSha256(await blob.arrayBuffer()); active(signal);
    if (hash !== record.asset.sha256) throw new Error("Camera original differs from upload");
  }
  return {
    projectId, close,
    list: (signal?: AbortSignal) => run(async repo => {
      const loaded = await repo.load(projectId); active(signal);
      return loaded?.kind === "current" ? loaded.project.media.filter(media => media.kind === "photo").map(media => media.id) : [];
    }, signal),
    save: (record: CloudUploadRecord, file: File, sourceIndex: number, signal?: AbortSignal) => run(async repo => {
      checkRecord(record); if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex > 3) throw new Error("Invalid camera source position");
      await checkBlob(file, record, signal);
      const loaded = await repo.load(projectId); active(signal);
      if (loaded && loaded.kind !== "current") throw new Error("Keep a local copy. This camera project requires recovery or a newer app");
      const existing = loaded?.media.get(record.id);
      if (existing) { await checkBlob(existing, record, signal); return; }
      const timestamp = new Date().toISOString();
      const base = loaded?.kind === "current" ? loaded.project : createProject({ id: projectId, scope, name: "Challenge camera originals", createdAt: timestamp, participants: [{ id: options.ownerId, role: "A" }], capture: { requiredShots: 4 } });
      const order = [...base.sourceOrder.A]; while (order.length <= sourceIndex) order.push(null); order[sourceIndex] = record.id;
      const next = appendProjectMedia(base, [{ id: record.id, kind: "photo", mime: record.asset.mime, bytes: file.size, width: record.asset.width, height: record.asset.height, participantId: options.ownerId }], { ...base.sourceOrder, A: order }, new Date(Math.min(file.lastModified, Date.now())).toISOString(), timestamp);
      const project = loaded ? next : validatePhotoProject({ ...next, revision: 0, history: { past: [], future: [] } });
      active(signal); await repo.save(project, new Map([[record.id, file]]), loaded ? base.revision : null); active(signal);
    }, signal),
    load: (record: CloudUploadRecord, signal?: AbortSignal) => run(async repo => {
      checkRecord(record); const loaded = await repo.load(projectId); active(signal);
      if (loaded?.kind !== "current") throw new Error("Saved camera original unavailable. Open Projects for recovery or choose your saved file");
      const declaration = loaded.project.media.find(media => media.id === record.id), blob = loaded.media.get(record.id);
      if (!declaration || !blob || declaration.kind !== "photo" || declaration.participantId !== options.ownerId || declaration.width !== record.asset.width || declaration.height !== record.asset.height) throw new Error("Saved camera original unavailable");
      await checkBlob(blob, record, signal);
      const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[record.asset.mime];
      if (!extension) throw new Error("Saved camera original type unavailable");
      return new File([blob], `challenge-original-${record.id}.${extension}`, { type: blob.type });
    }, signal),
  };
}
