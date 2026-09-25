import { cloudTimestamp, cloudUuid } from "./cloud-contract";
import { parsePhotoProject, validatePhotoProject, type PhotoProject } from "./model";

export const CLOUD_DESIGN_LIMITS = Object.freeze({ version: 1, snapshotBytes: 80 * 1024, requestBytes: 84 * 1024, bindings: 24, checkpoints: 2, receipts: 100 });
export interface CloudDesignBinding { mediaId: string; assetId: string; ownerId: string; sha256: string }
export interface CloudDesignParticipant { participantId: string; ownerId: string }
export interface CloudDesignSnapshot { version: 1; project: PhotoProject; bindings: CloudDesignBinding[]; participants: CloudDesignParticipant[] }
export interface CloudDesignReceipt { version: 1; projectId: string; requestId: string; revision: number; contentHash: string; savedAt: string }
export type CloudDesignRecord = CloudDesignReceipt & ({ unsupported: false; snapshot: CloudDesignSnapshot } | { unsupported: true; rawSnapshot: string; schemaVersion: number });
export function designObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("invalid_request");
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key) || !("value" in Object.getOwnPropertyDescriptor(value, key)!))) throw new Error("invalid_request");
  return value as Record<string, unknown>;
}
export function designRevision(value: unknown): number | null {
  if (value !== null && (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 99)) throw new Error("invalid_request");
  return value as number | null;
}
const hash = (value: unknown): string => { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid_request"); return value; };
export function validateCloudDesign(value: unknown): CloudDesignSnapshot {
  try {
    const s = designObject(value, ["version", "project", "bindings", "participants"]);
    if (s.version !== 1) throw new Error();
    const project = validatePhotoProject(s.project);
    if (project.scope.kind !== "device" || project.capture.cameraId !== null || !Array.isArray(s.bindings) || s.bindings.length !== project.media.length || s.bindings.length > 24 || !Array.isArray(s.participants) || s.participants.length !== project.participants.length) throw new Error();
    const participants = s.participants.map(value => {
      const p = designObject(value, ["participantId", "ownerId"]);
      if (typeof p.participantId !== "string" || !project.participants.some(person => person.id === p.participantId)) throw new Error();
      return { participantId: p.participantId, ownerId: cloudUuid(p.ownerId) };
    });
    if (new Set(participants.map(p => p.participantId)).size !== participants.length) throw new Error();
    const bindings = s.bindings.map(value => {
      const b = designObject(value, ["mediaId", "assetId", "ownerId", "sha256"]), media = project.media.find(m => m.id === b.mediaId);
      const ownerId = cloudUuid(b.ownerId);
      if (!media || (media.participantId !== null && participants.find(p => p.participantId === media.participantId)?.ownerId !== ownerId)) throw new Error();
      return { mediaId: media.id, assetId: cloudUuid(b.assetId), ownerId, sha256: hash(b.sha256) };
    });
    if (new Set(bindings.map(b => b.mediaId)).size !== bindings.length || new Set(bindings.map(b => b.assetId)).size !== bindings.length) throw new Error();
    const result: CloudDesignSnapshot = { version: 1, project, bindings: bindings.sort((a, b) => a.mediaId.localeCompare(b.mediaId, "en")), participants: participants.sort((a, b) => a.participantId.localeCompare(b.participantId, "en")) };
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > CLOUD_DESIGN_LIMITS.snapshotBytes) throw new Error();
    return result;
  } catch { throw new Error("invalid_request"); }
}
export function parseCloudDesignReceipt(value: unknown, projectId: string, requestId?: string): CloudDesignReceipt {
  const r = designObject(value, ["version", "projectId", "requestId", "revision", "contentHash", "savedAt"]);
  if (r.version !== 1 || cloudUuid(r.projectId) !== projectId || (requestId !== undefined && r.requestId !== requestId) || designRevision(r.revision) === null) throw new Error("invalid_response");
  return { version: 1, projectId, requestId: cloudUuid(r.requestId), revision: r.revision as number, contentHash: hash(r.contentHash), savedAt: cloudTimestamp(r.savedAt) };
}
export function parseCloudDesignHead(value: unknown, projectId: string): CloudDesignReceipt | null {
  try { const result = designObject(value, ["receipt"]); return result.receipt === null ? null : parseCloudDesignReceipt(result.receipt, projectId); }
  catch { throw new Error("invalid_response"); }
}
export function parseCloudDesignRecord(value: unknown, projectId: string): CloudDesignRecord | null {
  const r = designObject(value, ["record"]);
  if (r.record === null) return null;
  const record = designObject(r.record, ["receipt", "snapshot"]), receipt = parseCloudDesignReceipt(record.receipt, projectId);
  const s = designObject(record.snapshot, ["version", "project", "bindings", "participants"]);
  if (s.version !== 1) throw new Error("invalid_response");
  const rawSnapshot = JSON.stringify(s);
  if (new TextEncoder().encode(rawSnapshot).byteLength > CLOUD_DESIGN_LIMITS.snapshotBytes) throw new Error("invalid_response");
  const parsed = parsePhotoProject(JSON.stringify(s.project));
  if (parsed.kind === "unsupported") return { ...receipt, unsupported: true, rawSnapshot, schemaVersion: parsed.schemaVersion };
  return { ...receipt, unsupported: false, snapshot: validateCloudDesign(s) };
}
export function parseCloudDesignView(value: unknown, projectId: string): CloudDesignRecord | null {
  const v = designObject(value, ["design"]);
  if (v.design === null) return null;
  const raw = v.design as Record<string, unknown>, unsupported = raw?.unsupported;
  if (typeof unsupported !== "boolean") throw new Error("invalid_response");
  const r = designObject(raw, ["version", "projectId", "requestId", "revision", "contentHash", "savedAt", "unsupported", ...(unsupported ? ["rawSnapshot", "schemaVersion"] : ["snapshot"])]);
  const { unsupported: ignored, snapshot, rawSnapshot, schemaVersion, ...receipt } = r;
  void ignored;
  if (unsupported && (typeof rawSnapshot !== "string" || rawSnapshot.length > CLOUD_DESIGN_LIMITS.snapshotBytes)) throw new Error("invalid_response");
  const result = parseCloudDesignRecord({ record: { receipt, snapshot: unsupported ? JSON.parse(rawSnapshot as string) : snapshot } }, projectId);
  if (!result || result.unsupported !== unsupported || (result.unsupported && result.schemaVersion !== schemaVersion)) throw new Error("invalid_response");
  return result;
}
