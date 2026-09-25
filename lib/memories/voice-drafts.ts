import type { CloudIdentity } from "../projects/cloud-client";
import { cloudUuid } from "../projects/cloud-contract";
import { openCloudJournalScope, type CloudJournalOptions } from "../projects/cloud-journal-db";
import { PCM_VOICE, inspectVoiceWav } from "./voice-wav";
import { VoiceError, voiceObject, voiceRevision, voiceText, voiceBlobBase64, type VoiceSave } from "./voice-contract";

export interface VoiceDraft {
  version: 1; id: string; ownerId: string; revision: number; remoteRevision: number;
  text: string; audio: "keep" | "remove" | "replace"; blob: Blob | null;
  requestId: string; state: "draft" | "pending"; kind: "save" | "delete";
}
export type VoiceDraftInput = Pick<VoiceDraft, "id" | "remoteRevision" | "text" | "audio" | "blob">;
export function parseVoiceDraft(value: unknown): VoiceDraft {
  const v = voiceObject(value, ["version", "id", "ownerId", "revision", "remoteRevision", "text", "audio", "blob", "requestId", "state", "kind"]);
  if (v.version !== 1) throw new VoiceError("journal_readonly");
  if (!["keep", "remove", "replace"].includes(v.audio as string) || !["draft", "pending"].includes(v.state as string) || !["save", "delete"].includes(v.kind as string) || v.kind === "delete" && (v.state !== "pending" || v.text !== "" || v.audio !== "remove" || v.blob !== null)) throw new VoiceError("invalid_draft");
  if (v.audio === "replace" ? !(v.blob instanceof Blob) || v.blob.type !== "audio/wav" || v.blob.size < 46 || v.blob.size > PCM_VOICE.bytes : v.blob !== null) throw new VoiceError("invalid_draft");
  return { version: 1, id: cloudUuid(v.id), ownerId: cloudUuid(v.ownerId), revision: voiceRevision(v.revision), remoteRevision: voiceRevision(v.remoteRevision), text: voiceText(v.text), audio: v.audio as VoiceDraft["audio"], blob: v.blob as Blob | null, requestId: cloudUuid(v.requestId), state: v.state as VoiceDraft["state"], kind: v.kind as VoiceDraft["kind"] };
}
export async function voiceDraftRequest(draft: VoiceDraft): Promise<VoiceSave> {
  const row = parseVoiceDraft(draft);
  if (row.state !== "pending" || row.kind !== "save") throw new VoiceError("invalid_draft");
  return { requestId: row.requestId, revision: row.remoteRevision, text: row.text, audio: row.audio === "replace" ? { operation: "replace", wav: await voiceBlobBase64(row.blob!) } : { operation: row.audio } };
}
export async function openVoiceDraftJournal(ownerId: string, options: CloudJournalOptions & { identity(): CloudIdentity | null }) {
  const scope = await openCloudJournalScope(ownerId, "voiceDrafts", options);
  const parse = (raw: unknown) => { const row = parseVoiceDraft(raw); if (row.ownerId !== ownerId) throw new VoiceError("invalid_draft"); return row; };
  async function mutate(id: string, expected: number | null, update: (prior: VoiceDraft | null) => VoiceDraft | null): Promise<VoiceDraft | null> {
    cloudUuid(id);
    return scope.transaction("readwrite", (store, done, reject) => {
      const request = store.index("owner").getAll(ownerId, 21);
      request.onsuccess = () => {
        try {
          if (request.result.length > 20) throw new VoiceError("capacity");
          const rows = request.result.map(parse), prior = rows.find(row => row.id === id) ?? null;
          if ((prior?.revision ?? null) !== expected) throw new VoiceError("conflict", 409);
          const next = update(prior);
          if (next) {
            const remaining = rows.filter(row => row.id !== id);
            if (remaining.length >= 20 || remaining.reduce((sum, row) => sum + (row.blob?.size ?? 0), next.blob?.size ?? 0) > PCM_VOICE.bytes * 20) throw new VoiceError("capacity", 409);
            store.put(parse(next));
          } else store.delete([ownerId, id]);
          done(next);
        } catch (error) { reject(error); }
      };
    });
  }
  return {
    ownerId, close: scope.close, assertActive: scope.active,
    get: async (id: string) => {
      cloudUuid(id);
      const row = await scope.transaction<VoiceDraft | null>("readonly", (store, done, reject) => { const request = store.get([ownerId, id]); request.onsuccess = () => { try { done(request.result ? parse(request.result) : null); } catch (error) { reject(error); } }; });
      if (row?.blob) inspectVoiceWav(new Uint8Array(await row.blob.arrayBuffer())); scope.active();
      return row;
    },
    save: async (input: VoiceDraftInput, expected: number | null) => {
      if (input.blob) inspectVoiceWav(new Uint8Array(await input.blob.arrayBuffer())); scope.active();
      return (await mutate(input.id, expected, prior => {
        if (prior?.state === "pending") throw new VoiceError("pending");
        return parse({ ...input, remoteRevision: prior?.remoteRevision ?? input.remoteRevision, version: 1, ownerId, revision: (prior?.revision ?? -1) + 1, requestId: crypto.randomUUID(), state: "draft", kind: "save" });
      }))!;
    },
    prepareDelete: async (id: string, remoteRevision: number) => (await mutate(id, null, () => parse({ version: 1, id, ownerId, revision: 0, remoteRevision, text: "", audio: "remove", blob: null, requestId: crypto.randomUUID(), state: "pending", kind: "delete" })))!,
    freeze: async (id: string, expected: number) => (await mutate(id, expected, prior => {
      if (!prior) throw new VoiceError("missing");
      return prior.state === "pending" ? prior : { ...prior, revision: prior.revision + 1, state: "pending" };
    }))!,
    forget: async (id: string, expected: number) => { await mutate(id, expected, () => null); },
  };
}
export type VoiceDraftJournal = Awaited<ReturnType<typeof openVoiceDraftJournal>>;
