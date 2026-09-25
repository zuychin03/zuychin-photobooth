import { openCloudJournalScope, type CloudJournalOptions } from "./cloud-journal-db";
import { cloudTimestamp, cloudUuid, validateCloudAsset, type CloudAssetInput } from "./cloud-contract";
import { CloudClientError, type CloudIdentity } from "./cloud-client";

export interface CloudUploadRecord {
  id: string; ownerId: string; projectId: string; asset: CloudAssetInput;
  state: "prepared" | "reserved" | "uploading" | "uploaded" | "finalising" | "ready" | "failed";
  createdAt: string; updatedAt: string; reservedUntil: string | null;
}
export interface CloudUploadJournal {
  readonly ownerId: string;
  get(id: string): Promise<CloudUploadRecord | null>;
  list(): Promise<CloudUploadRecord[]>;
  put(record: CloudUploadRecord): Promise<void>;
  remove(id: string): Promise<void>;
  close(): void;
}
export { removeCloudJournalForOwner as removeCloudUploadJournalForOwner } from "./cloud-journal-db";
export function validateCloudUploadRecord(value: CloudUploadRecord): CloudUploadRecord {
  const asset = validateCloudAsset(value.asset);
  if (value.id !== asset.id || !["prepared", "reserved", "uploading", "uploaded", "finalising", "ready", "failed"].includes(value.state)) throw new CloudClientError("journal_invalid");
  return { id: cloudUuid(value.id), ownerId: cloudUuid(value.ownerId), projectId: cloudUuid(value.projectId), asset, state: value.state, createdAt: cloudTimestamp(value.createdAt), updatedAt: cloudTimestamp(value.updatedAt), reservedUntil: value.reservedUntil === null ? null : cloudTimestamp(value.reservedUntil) };
}
export async function openCloudUploadJournal(ownerId: string, options: CloudJournalOptions & { identity(): CloudIdentity | null }): Promise<CloudUploadJournal> {
  const { active, transaction, close } = await openCloudJournalScope(ownerId, "uploads", options);
  return {
    ownerId,
    get(id) { cloudUuid(id); return transaction("readonly", (store, done) => { const req = store.get([ownerId, id]); req.onsuccess = () => { try { done(req.result ? validateCloudUploadRecord(req.result) : null); } catch { req.transaction!.abort(); } }; }); },
    list() { return transaction("readonly", (store, done) => { const req = store.index("owner").getAll(ownerId, 65); req.onsuccess = () => { try { if (req.result.length > 64) throw new Error(); done(req.result.map(validateCloudUploadRecord)); } catch { req.transaction!.abort(); } }; }); },
    put(input) {
      const record = validateCloudUploadRecord(input); if (record.ownerId !== ownerId) throw new CloudClientError("account_changed");
      return transaction("readwrite", (store, done) => {
        const req = store.get([ownerId, record.id]); req.onsuccess = () => {
          try {
            active(); const prior = req.result ? validateCloudUploadRecord(req.result) : null;
            if (prior && (prior.projectId !== record.projectId || prior.createdAt !== record.createdAt || JSON.stringify(prior.asset) !== JSON.stringify(record.asset))) throw new Error();
            const all = store.index("owner").getAll(ownerId, 65); all.onsuccess = () => {
              try {
                active(); let count = all.result.length;
                if (!prior && count >= 64) for (const candidate of all.result) { if (candidate.state === "ready") { store.delete([ownerId, candidate.id]); count--; } }
                if (!prior && count >= 64) throw new Error(); store.put(record); done(undefined);
              } catch { req.transaction!.abort(); }
            };
          } catch { req.transaction!.abort(); }
        };
      });
    },
    remove(id) { cloudUuid(id); return transaction("readwrite", (store, done) => { store.delete([ownerId, id]); done(undefined); }); },
    close,
  };
}
