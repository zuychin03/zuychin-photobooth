export type MediaJobKind = "archive" | "retention_archive" | "release" | "delete" | "relay_cleanup" | "upload_cleanup";
export interface MediaJob {
  id: string;
  kind: MediaJobKind;
  source_type: "strip" | "relay" | "upload";
  source_id: string | null;
  owner: string;
  snapshot: Record<string, unknown>;
  checkpoint: Record<string, unknown>;
  stage: string;
  lease_token: string;
  attempts: number;
  max_attempts: number;
}

export interface LifecycleStrip {
  id: string;
  owner: string;
  storage_path: string;
  kept: boolean;
  purged: boolean;
  cloudinary_public_id: string | null;
  cloudinary_url: string | null;
  layout_id?: string | null;
}

export interface ArchiveReference { publicId: string; url: string }

export interface MediaWorkerStore {
  checkpoint(job: MediaJob, stage: string, checkpoint: Record<string, unknown>): Promise<void>;
  finish(job: MediaJob, outcome: "complete" | "retry" | "failed", code?: string): Promise<void>;
  readStrip(id: string): Promise<LifecycleStrip | null>;
  persistArchive(strip: LifecycleStrip, archive: ArchiveReference): Promise<void>;
  markArchiveVerified(strip: LifecycleStrip): Promise<void>;
  clearArchive(strip: LifecycleStrip): Promise<void>;
  markPurged(strip: LifecycleStrip): Promise<void>;
  deleteStrip(id: string, owner: string): Promise<void>;
  cleanupPaths(job: MediaJob): Promise<string[]>;
  sourceExists(path: string): Promise<boolean>;
  download(path: string): Promise<Blob>;
  removeStorage(paths: string[]): Promise<void>;
}

export interface ArchiveProvider {
  configured(): boolean;
  upload(blob: Blob, owner: string, id: string): Promise<ArchiveReference>;
  verify(publicId: string, url: string): Promise<boolean>;
  remove(publicId: string): Promise<void>;
}

export class MediaOperationError extends Error {
  constructor(readonly code: string, readonly retryable = true) {
    super(code);
    this.name = "MediaOperationError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STRIP_BYTES = 16 * 1024 * 1024;

function expectedArchive(owner: string, id: string): string {
  return `zuychin-photobooth/${owner}/${id}`;
}

function validateArchive(reference: ArchiveReference, owner: string, id: string): void {
  let url: URL;
  try { url = new URL(reference.url); } catch { throw new MediaOperationError("invalid_archive_reference", false); }
  if (reference.publicId !== expectedArchive(owner, id) || url.protocol !== "https:" || url.username || url.password) {
    throw new MediaOperationError("invalid_archive_reference", false);
  }
}

function stripFromSnapshot(job: MediaJob): LifecycleStrip {
  const value = job.snapshot;
  if (!job.source_id || value.id !== job.source_id || value.owner !== job.owner
    || value.storage_path !== `${job.owner}/${job.source_id}.png`
    || typeof value.kept !== "boolean" || typeof value.purged !== "boolean"
    || (value.cloudinary_public_id !== null && typeof value.cloudinary_public_id !== "string")
    || (value.cloudinary_url !== null && typeof value.cloudinary_url !== "string")) {
    throw new MediaOperationError("invalid_job_snapshot", false);
  }
  return value as unknown as LifecycleStrip;
}

export async function executeMediaJob(job: MediaJob, store: MediaWorkerStore, archive: ArchiveProvider): Promise<{ outcome: "complete" | "retry" | "failed"; code?: string }> {
  const checkpoint = { ...job.checkpoint };
  let stage = job.stage;
  const save = async (nextStage: string, fields: Record<string, unknown> = {}) => {
    Object.assign(checkpoint, fields);
    const order = ["pending", "uploaded", "reference_verified", "storage_removed", "cloudinary_removed", "row_deleted", "complete"];
    const target = order.indexOf(nextStage) < order.indexOf(stage) ? stage : nextStage;
    await store.checkpoint(job, target, checkpoint);
    stage = target;
  };
  const fence = () => save(stage);
  try {
    if (!UUID.test(job.id) || !UUID.test(job.owner) || !UUID.test(job.lease_token) || (job.source_id !== null && !UUID.test(job.source_id))) {
      throw new MediaOperationError("invalid_job_identity", false);
    }
    await fence();
    if (job.kind === "relay_cleanup" || job.kind === "upload_cleanup") {
      const paths = await store.cleanupPaths(job);
      const allowedOwners = new Set([job.owner]);
      if (job.kind === "relay_cleanup" && typeof job.snapshot.partner === "string" && UUID.test(job.snapshot.partner)) allowedOwners.add(job.snapshot.partner);
      if (paths.length > 8 || paths.some(path => !allowedOwners.has(path.split("/")[0]) || path.includes("..") || path.includes("\\"))) {
        throw new MediaOperationError("invalid_cleanup_paths", false);
      }
      await fence();
      if (paths.length) await store.removeStorage(paths);
      await save("storage_removed", { storage_removed: true });
    } else {
      const snapshot = stripFromSnapshot(job);
      const live = await store.readStrip(snapshot.id);
      if (live && (live.owner !== snapshot.owner || live.storage_path !== snapshot.storage_path)) {
        throw new MediaOperationError("source_identity_changed", false);
      }
      if (job.kind === "archive" || job.kind === "retention_archive") {
        if (!live) throw new MediaOperationError("source_row_missing", false);
        if (!archive.configured()) throw new MediaOperationError("archive_unavailable");
        let reference: ArchiveReference | null = live.cloudinary_public_id && live.cloudinary_url
          ? { publicId: live.cloudinary_public_id, url: live.cloudinary_url } : null;
        if (!reference && typeof checkpoint.cloudinary_public_id === "string" && typeof checkpoint.cloudinary_url === "string") {
          const recovered = { publicId: checkpoint.cloudinary_public_id, url: checkpoint.cloudinary_url };
          validateArchive(recovered, live.owner, live.id);
          if (await archive.verify(recovered.publicId, recovered.url)) {
            await store.persistArchive(live, recovered);
            reference = recovered;
          }
        }
        if (!reference) {
          const source = await store.download(live.storage_path);
          if (!source.size || source.size > MAX_STRIP_BYTES) throw new MediaOperationError("invalid_source_size", false);
          await fence();
          reference = await archive.upload(source, live.owner, live.id);
          validateArchive(reference, live.owner, live.id);
          await save("uploaded", { cloudinary_public_id: reference.publicId, cloudinary_url: reference.url });
          await store.persistArchive(live, reference);
        }
        validateArchive(reference, live.owner, live.id);
        const persisted = await store.readStrip(live.id);
        if (!persisted?.kept || persisted.cloudinary_public_id !== reference.publicId || persisted.cloudinary_url !== reference.url) {
          throw new MediaOperationError("archive_reference_not_durable");
        }
        if (!await archive.verify(reference.publicId, reference.url)) throw new MediaOperationError("archive_not_verified");
        await store.markArchiveVerified(persisted);
        await save("reference_verified", { cloudinary_public_id: reference.publicId, cloudinary_url: reference.url, archive_verified: true });
        if (job.kind === "retention_archive") {
          await fence();
          await store.removeStorage([live.storage_path]);
          await save("storage_removed", { storage_removed: true });
          await store.markPurged(persisted);
        }
      } else if (job.kind === "release") {
        if (!live) throw new MediaOperationError("source_row_missing", false);
        if (live.purged || !await store.sourceExists(live.storage_path)) {
          throw new MediaOperationError("archive_is_only_copy", false);
        }
        if (live.cloudinary_public_id) {
          if (!archive.configured()) throw new MediaOperationError("archive_unavailable");
          if (live.cloudinary_public_id !== expectedArchive(live.owner, live.id)) throw new MediaOperationError("invalid_archive_reference", false);
          await fence();
          await archive.remove(live.cloudinary_public_id);
        }
        await save("cloudinary_removed", { cloudinary_removed: true });
        await store.clearArchive(live);
      } else if (job.kind === "delete") {
        if (job.snapshot.retention === true && live && (live.kept || live.layout_id === "recap")) throw new MediaOperationError("keepsake_protected", false);
        const source = live ?? snapshot;
        const publicId = source.cloudinary_public_id ?? snapshot.cloudinary_public_id
          ?? (typeof checkpoint.cloudinary_public_id === "string" ? checkpoint.cloudinary_public_id : null)
          ?? (archive.configured() ? expectedArchive(source.owner, source.id) : null);
        if (publicId && !archive.configured()) throw new MediaOperationError("archive_unavailable");
        if (publicId && publicId !== expectedArchive(source.owner, source.id)) throw new MediaOperationError("invalid_archive_reference", false);
        await fence();
        await store.removeStorage([source.storage_path]);
        await save("storage_removed", { storage_removed: true });
        if (publicId) {
          await fence();
          await archive.remove(publicId);
        }
        await save("cloudinary_removed", { cloudinary_removed: true });
        await store.deleteStrip(source.id, source.owner);
        await save("row_deleted", { row_deleted: true });
      } else {
        throw new MediaOperationError("unsupported_job_kind", false);
      }
    }
    await store.finish(job, "complete");
    return { outcome: "complete" };
  } catch (error) {
    const failure = error instanceof MediaOperationError ? error : new MediaOperationError("operation_failed");
    const outcome = failure.retryable && job.attempts < job.max_attempts ? "retry" : "failed";
    try { await store.finish(job, outcome, failure.code); } catch { /* The lease may have expired; its durable job remains recoverable. */ }
    return { outcome, code: failure.code };
  }
}
