import { CLOUD_PROJECT_LIMITS, cloudUuid, validateCloudAsset, type CloudAssetInput, type ProjectFinalisationStatus, type ProjectProtection } from "./cloud-contract";
import { CloudClientError, cloudSha256, type CloudProjectClient } from "./cloud-client";
import { inspectProjectImage, type ProjectImageInfo } from "./images";
import { validateCloudUploadRecord, type CloudUploadJournal, type CloudUploadRecord } from "./cloud-upload-journal";
export { openCloudUploadJournal } from "./cloud-upload-journal";
export type { CloudUploadJournal, CloudUploadRecord } from "./cloud-upload-journal";

export interface CloudUploadResult { state: "ready" | "pending" | "failed"; record: CloudUploadRecord; status: ProjectFinalisationStatus }
export interface CloudUploadOptions {
  client: Pick<CloudProjectClient, "ownerId" | "assertActive" | "reserve" | "status" | "mintUpload" | "upload" | "finalise">; journal: CloudUploadJournal;
  inspect?: (blob: Blob) => Promise<ProjectImageInfo>; now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const cancel = () => { clearTimeout(timer); reject(new CloudClientError("cancelled")); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
  signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel();
});
export function createCloudUploadManager(options: CloudUploadOptions) {
  const { client, journal } = options, inspect = options.inspect ?? inspectProjectImage, now = options.now ?? Date.now;
  const lifetime = new AbortController(); let running = false, preparing = false;
  if (journal.ownerId !== client.ownerId) throw new CloudClientError("account_changed");
  function active(signal?: AbortSignal) { if (lifetime.signal.aborted) throw new CloudClientError("cancelled"); client.assertActive(signal); }
  async function checked<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> { const result = await promise; active(signal); return result; }
  async function describe(blob: Blob, kind: CloudAssetInput["kind"], signal?: AbortSignal) {
    active(signal);
    if (blob.size < 1 || blob.size > (kind === "decoration" ? 4 * 1024 * 1024 : CLOUD_PROJECT_LIMITS.assetBytes)) throw new CloudClientError("invalid_image");
    const info = await checked(inspect(blob), signal), bytes = await checked(blob.arrayBuffer(), signal), sha256 = await checked(cloudSha256(bytes), signal);
    return { ...info, bytes: blob.size, sha256 };
  }
  async function save(record: CloudUploadRecord, state: CloudUploadRecord["state"], signal?: AbortSignal) {
    active(signal); const next = { ...record, state, updatedAt: new Date(now()).toISOString() }; await checked(journal.put(next), signal); return next;
  }
  return {
    async prepare(projectId: string, blob: Blob, input: { kind: CloudAssetInput["kind"]; protection?: ProjectProtection }, signal?: AbortSignal): Promise<CloudUploadRecord> {
      active(signal); cloudUuid(projectId); if (preparing || running) throw new CloudClientError("busy"); preparing = true;
      try {
        const description = await describe(blob, input.kind, signal);
        const asset = validateCloudAsset({ id: crypto.randomUUID(), requestId: crypto.randomUUID(), kind: input.kind, ...description, protection: input.protection ?? { kind: "none", id: null } });
        const timestamp = new Date(now()).toISOString(), record: CloudUploadRecord = { id: asset.id, ownerId: client.ownerId, projectId, asset, state: "prepared", createdAt: timestamp, updatedAt: timestamp, reservedUntil: null };
        await checked(journal.put(record), signal); return record;
      } finally { preparing = false; }
    },
    async run(id: string, blob?: Blob, signal?: AbortSignal): Promise<CloudUploadResult> {
      active(signal); if (running || preparing) throw new CloudClientError("busy"); running = true;
      const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
      try {
        const existing = await checked(journal.get(cloudUuid(id)), combined);
        if (!existing) throw new CloudClientError("journal_missing");
        let record = validateCloudUploadRecord(existing); if (record.ownerId !== client.ownerId) throw new CloudClientError("account_changed");
        if (blob) {
          const description = await describe(blob, record.asset.kind, combined);
          if ((Object.keys(description) as (keyof typeof description)[]).some(key => description[key] !== record.asset[key])) throw new CloudClientError("file_mismatch");
        }
        if (record.state === "prepared") {
          // Exact reservation replay resolves an interrupted create without new IDs.
          const reservation = await checked(client.reserve(record.projectId, record.asset, combined), combined);
          record = await save({ ...record, reservedUntil: reservation.reservedUntil }, "reserved", combined);
        }
        let status = await checked(client.status(record.id, combined), combined);
        if (blob && status.assetStatus === "reserved" && ["prepared", "reserved", "uploading"].includes(existing.state) && !["failed", "complete"].includes(status.status)) {
          const grant = await checked(client.mintUpload(record.projectId, record.id, combined), combined);
          record = await save(record, "uploading", combined);
          await checked(client.upload(record.projectId, record.asset, blob, grant, combined), combined);
          record = await save(record, "uploaded", combined);
        }
        if (status.status === "not_queued" && status.assetStatus === "reserved") {
          if (!blob && !["uploaded", "uploading", "finalising"].includes(existing.state)) throw new CloudClientError("file_required");
          status = await checked(client.finalise(record.id, combined), combined);
        }
        for (let poll = 0; poll < 6; poll++) {
          if (status.status === "complete" && status.assetStatus === "ready") { record = await save(record, "ready", combined); return { state: "ready", record, status }; }
          if (status.status === "failed" || ["deleted", "expired"].includes(status.assetStatus)) { record = await save(record, "failed", combined); return { state: "failed", record, status }; }
          record = await save(record, record.state === "uploading" ? "uploading" : "finalising", combined);
          if (poll === 5) break;
          await checked((options.sleep ?? sleep)(2000, combined), combined);
          status = await checked(client.status(record.id, combined), combined);
        }
        return { state: "pending", record, status };
      } finally { running = false; }
    },
    async list() { active(); return checked(journal.list()); },
    async forget(id: string) { active(); if (running || preparing) throw new CloudClientError("busy"); await checked(journal.remove(cloudUuid(id))); },
    close() { lifetime.abort(); journal.close(); },
  };
}
export type CloudUploadManager = ReturnType<typeof createCloudUploadManager>;
