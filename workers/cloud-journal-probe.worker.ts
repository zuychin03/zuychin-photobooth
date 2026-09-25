import { openCloudUploadJournal, type CloudUploadJournal, type CloudUploadRecord } from "../lib/projects/cloud-upload-journal";

export type CloudJournalProbeRequest =
  | { sequence: number; type: "open"; databaseName: string; owner: CloudUploadRecord; other: CloudUploadRecord }
  | { sequence: number; type: "check"; owner: CloudUploadRecord; other: CloudUploadRecord };
export type CloudJournalProbeReply =
  | { sequence: number; type: "opened" }
  | { sequence: number; type: "checked"; staleReadDenied: boolean; staleWriteDenied: boolean; otherRead: boolean; otherWrite: boolean }
  | { sequence: number; type: "error" };

const scope = self as unknown as { onmessage: ((event: MessageEvent<CloudJournalProbeRequest>) => void) | null; postMessage(value: CloudJournalProbeReply): void };
let owner: CloudUploadJournal | null = null, other: CloudUploadJournal | null = null, initialOther: string | null = null, running = false;
const generationDenied = (error: unknown) => error !== null && typeof error === "object" && "code" in error && error.code === "account_changed";

scope.onmessage = event => {
  const message = event.data;
  if (process.env.NODE_ENV !== "development" || running) { scope.postMessage({ sequence: message.sequence, type: "error" }); return; }
  running = true;
  void (async () => {
    if (message.type === "open") {
      if (owner || other || !/^pb-cloud-journal-probe-[a-f0-9-]{36}$/.test(message.databaseName) || message.owner.ownerId === message.other.ownerId) throw new Error();
      owner = await openCloudUploadJournal(message.owner.ownerId, { databaseName: message.databaseName, identity: () => ({ ownerId: message.owner.ownerId, epoch: 1 }) });
      other = await openCloudUploadJournal(message.other.ownerId, { databaseName: message.databaseName, identity: () => ({ ownerId: message.other.ownerId, epoch: 1 }) });
      await owner.put(message.owner); await other.put(message.other); initialOther = message.other.id;
      scope.postMessage({ sequence: message.sequence, type: "opened" });
    } else if (message.type === "check" && owner && other && initialOther) {
      let staleReadDenied = false, staleWriteDenied = false;
      try { await owner.list(); } catch (error) { staleReadDenied = generationDenied(error); }
      try { await owner.put(message.owner); } catch (error) { staleWriteDenied = generationDenied(error); }
      const otherRead = (await other.get(initialOther))?.ownerId === message.other.ownerId;
      await other.put(message.other);
      const otherWrite = (await other.get(message.other.id))?.ownerId === message.other.ownerId;
      scope.postMessage({ sequence: message.sequence, type: "checked", staleReadDenied, staleWriteDenied, otherRead, otherWrite });
    } else throw new Error();
  })().catch(() => { owner?.close(); other?.close(); scope.postMessage({ sequence: message.sequence, type: "error" }); }).finally(() => { running = false; });
};
