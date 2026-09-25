import { cloudTimestamp, cloudUuid } from "./cloud-contract";
import type { CloudIdentity } from "./cloud-client";
import { openCloudJournalScope, type CloudJournalOptions } from "./cloud-journal-db";
import { designObject, designRevision, parseCloudDesignReceipt, validateCloudDesign, type CloudDesignBinding, type CloudDesignParticipant, type CloudDesignReceipt } from "./cloud-design";
import { validatePhotoProject, type PhotoProject } from "./model";
import { validateCloudUploadRecord, type CloudUploadRecord } from "./cloud-upload-journal";

export const DESIGN_SAVE_LIMITS = Object.freeze({ records: 32, recordBytes: 128 * 1024, totalBytes: 4 * 1024 * 1024 });
export interface DesignUploadPlan { mediaId: string; assetId: string; requestId: string; record: CloudUploadRecord | null }
export interface CloudDesignSaveRecord {
  version: 1; id: string; ownerId: string; localProjectId: string; cloudProjectId: string; revision: number;
  createdAt: string; updatedAt: string; phase: "preparing" | "prepared" | "uploading" | "saving" | "complete";
  requestId: string; expectedRevision: number | null; project: PhotoProject;
  participants: CloudDesignParticipant[]; bindings: CloudDesignBinding[]; uploads: DesignUploadPlan[]; receipt: CloudDesignReceipt | null;
}
export type CloudDesignSaveEntry = CloudDesignSaveRecord | { id: string; readOnly: true };
export class CloudDesignSaveError extends Error {
  constructor(readonly code: "conflict" | "capacity" | "readonly" | "invalid" | "pending" | "missing" | "file_mismatch" | "access_changed" | "upload_failed" | "busy") { super(`design_save_${code}`); }
}
const fail = (code: CloudDesignSaveError["code"]): never => { throw new CloudDesignSaveError(code); };
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const localId = (value: unknown): string => { if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) return fail("invalid"); return value; };
export function validateDesignSaveRecord(value: unknown): CloudDesignSaveRecord {
  try {
    const v = designObject(value, ["version", "id", "ownerId", "localProjectId", "cloudProjectId", "revision", "createdAt", "updatedAt", "phase", "requestId", "expectedRevision", "project", "participants", "bindings", "uploads", "receipt"]);
    if (v.version !== 1) return fail("readonly");
    if (!Number.isSafeInteger(v.revision) || (v.revision as number) < 0 || (v.revision as number) >= Number.MAX_SAFE_INTEGER || !["preparing", "prepared", "uploading", "saving", "complete"].includes(v.phase as string)) return fail("invalid");
    const project = validatePhotoProject(v.project), ownerId = cloudUuid(v.ownerId), cloudProjectId = cloudUuid(v.cloudProjectId);
    if (project.scope.kind !== "device" || project.capture.cameraId !== null || !Array.isArray(v.participants) || v.participants.length !== project.participants.length || !Array.isArray(v.bindings) || v.bindings.length > 24 || !Array.isArray(v.uploads) || v.uploads.length > 24) return fail("invalid");
    const participants = v.participants.map(value => { const p = designObject(value, ["participantId", "ownerId"]); return { participantId: localId(p.participantId), ownerId: cloudUuid(p.ownerId) }; });
    if (new Set(participants.map(p => p.participantId)).size !== participants.length || participants.some(p => !project.participants.some(person => person.id === p.participantId))) return fail("invalid");
    const bindings = v.bindings.map(value => { const b = designObject(value, ["mediaId", "assetId", "ownerId", "sha256"]); if (typeof b.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(b.sha256)) return fail("invalid"); return { mediaId: localId(b.mediaId), assetId: cloudUuid(b.assetId), ownerId: cloudUuid(b.ownerId), sha256: b.sha256 }; });
    if (new Set(bindings.map(b => b.mediaId)).size !== bindings.length || new Set(bindings.map(b => b.assetId)).size !== bindings.length) return fail("invalid");
    const uploads = v.uploads.map(value => {
      const p = designObject(value, ["mediaId", "assetId", "requestId", "record"]), mediaId = localId(p.mediaId), assetId = cloudUuid(p.assetId), requestId = cloudUuid(p.requestId);
      const record = p.record === null ? null : validateCloudUploadRecord(p.record as CloudUploadRecord);
      if (record && (record.id !== assetId || record.asset.requestId !== requestId || record.ownerId !== ownerId || record.projectId !== cloudProjectId || record.asset.protection.kind !== "none" || record.state !== "prepared")) return fail("invalid");
      return { mediaId, assetId, requestId, record };
    });
    if (new Set(uploads.map(p => p.mediaId)).size !== uploads.length || new Set(uploads.map(p => p.assetId)).size !== uploads.length || new Set(uploads.map(p => p.requestId)).size !== uploads.length) return fail("invalid");
    for (const binding of bindings) {
      const media = project.media.find(m => m.id === binding.mediaId);
      if (!media || media.participantId !== null && participants.find(p => p.participantId === media.participantId)?.ownerId !== binding.ownerId) return fail("invalid");
    }
    for (const plan of uploads) {
      const media = project.media.find(m => m.id === plan.mediaId), binding = bindings.find(b => b.mediaId === plan.mediaId);
      if (!media || media.participantId !== null && participants.find(p => p.participantId === media.participantId)?.ownerId !== ownerId || binding && (binding.assetId !== plan.assetId || binding.ownerId !== ownerId)) return fail("invalid");
      if (plan.record && (!binding || binding.sha256 !== plan.record.asset.sha256 || (["kind", "mime", "bytes", "width", "height"] as const).some(key => media[key] !== plan.record!.asset[key]))) return fail("invalid");
    }
    if (project.media.some(m => !bindings.some(b => b.mediaId === m.id) && !uploads.some(p => p.mediaId === m.id))) return fail("invalid");
    if (v.phase !== "preparing") { validateCloudDesign({ version: 1, project, participants, bindings }); if (uploads.some(p => !p.record)) return fail("invalid"); }
    const receipt = v.receipt === null ? null : parseCloudDesignReceipt(v.receipt, cloudProjectId, cloudUuid(v.requestId));
    if ((v.phase === "complete") !== (receipt !== null) || receipt && receipt.revision !== (v.expectedRevision === null ? 0 : Number(v.expectedRevision) + 1)) return fail("invalid");
    const result: CloudDesignSaveRecord = { version: 1, id: cloudUuid(v.id), ownerId, cloudProjectId, localProjectId: localId(v.localProjectId), revision: v.revision as number, createdAt: cloudTimestamp(v.createdAt), updatedAt: cloudTimestamp(v.updatedAt), phase: v.phase as CloudDesignSaveRecord["phase"], requestId: cloudUuid(v.requestId), expectedRevision: designRevision(v.expectedRevision), project, participants, bindings, uploads, receipt };
    if (Date.parse(result.updatedAt) < Date.parse(result.createdAt) || size(result) > DESIGN_SAVE_LIMITS.recordBytes) return fail("invalid");
    return result;
  } catch (error) { if (error instanceof CloudDesignSaveError) throw error; return fail("invalid"); }
}
export interface CloudDesignJournal {
  ownerId: string; list(): Promise<CloudDesignSaveEntry[]>; get(id: string): Promise<CloudDesignSaveRecord | null>;
  put(record: CloudDesignSaveRecord, expectedRevision: number | null): Promise<CloudDesignSaveRecord>;
  forget(id: string, expectedRevision: number): Promise<void>; close(): void;
}
export async function openCloudDesignJournal(ownerId: string, options: CloudJournalOptions & { identity(): CloudIdentity | null }): Promise<CloudDesignJournal> {
  const scope = await openCloudJournalScope(ownerId, "designSaves", options);
  const read = (value: unknown) => { const record = validateDesignSaveRecord(value); if (record.ownerId !== ownerId) return fail("invalid"); return record; };
  const all = (store: IDBObjectStore, next: (rows: unknown[]) => void, reject: (error: unknown) => void) => { const req = store.index("owner").getAll(ownerId, 33); req.onsuccess = () => { try { if (req.result.length > 32 || size(req.result) > DESIGN_SAVE_LIMITS.totalBytes) fail("capacity"); next(req.result); } catch (error) { reject(error); } }; };
  return {
    ownerId, close: scope.close,
    list: () => scope.transaction("readonly", (store, done, reject) => all(store, rows => done(rows.map(value => { try { return read(value); } catch { return { id: cloudUuid((value as { id: unknown }).id), readOnly: true as const }; } })), reject)),
    get(id) { cloudUuid(id); return scope.transaction("readonly", (store, done, reject) => { const req = store.get([ownerId, id]); req.onsuccess = () => { try { done(req.result ? read(req.result) : null); } catch (error) { reject(error); } }; }); },
    put(input, expected) {
      const next = read(input);
      return scope.transaction("readwrite", (store, done, reject) => all(store, values => {
        try {
          const rows = values.map(read), prior = rows.find(r => r.id === next.id);
          if ((prior?.revision ?? null) !== expected || next.revision !== (expected === null ? 0 : expected + 1)) fail("conflict");
          if (rows.some(r => r.id !== next.id && r.cloudProjectId === next.cloudProjectId && r.localProjectId === next.localProjectId)) fail("conflict");
          if (prior) {
            if (prior.ownerId !== next.ownerId || prior.cloudProjectId !== next.cloudProjectId || prior.localProjectId !== next.localProjectId || prior.createdAt !== next.createdAt) fail("conflict");
            if (prior.requestId !== next.requestId) { if (prior.phase !== "complete" || next.phase !== "preparing") fail("pending"); }
            else {
              if (!same(prior.project, next.project) || !same(prior.participants, next.participants) || prior.expectedRevision !== next.expectedRevision || prior.uploads.length !== next.uploads.length) fail("conflict");
              if (prior.bindings.some(b => !next.bindings.some(n => same(b, n))) || prior.uploads.some(p => !next.uploads.some(n => p.mediaId === n.mediaId && p.assetId === n.assetId && p.requestId === n.requestId && (p.record === null || same(p.record, n.record))))) fail("conflict");
              if (prior.phase !== "preparing" && !same(prior.bindings, next.bindings)) fail("conflict");
              if (prior.phase === "complete" && !same(prior.receipt, next.receipt)) fail("conflict");
            }
          }
          const kept = rows.filter(r => r.id !== next.id); if (kept.length >= 32 || size([...kept, next]) > DESIGN_SAVE_LIMITS.totalBytes) fail("capacity");
          store.put(next); done(next);
        } catch (error) { reject(error); }
      }, reject));
    },
    forget(id, expected) { cloudUuid(id); return scope.transaction("readwrite", (store, done, reject) => { const req = store.get([ownerId, id]); req.onsuccess = () => { try { if (!req.result || read(req.result).revision !== expected) fail("conflict"); store.delete([ownerId, id]); done(undefined); } catch (error) { reject(error); } }; }); },
  };
}
