import { openVoiceDraftJournal, voiceDraftRequest, type VoiceDraftJournal } from "./voice-drafts";
import { removeCloudJournalForOwner } from "../projects/cloud-journal-db";
import { encodeVoiceWav } from "./voice-wav";

export async function runVoiceDraftProbe(): Promise<string[]> {
  const databaseName = `pb-voice-probe-${crypto.randomUUID()}`, ownerId = "11111111-1111-4111-8111-111111111119", otherId = "22222222-2222-4222-8222-222222222229";
  const handles: VoiceDraftJournal[] = [], checks: string[] = [];
  const open = async (owner: string) => { const journal = await openVoiceDraftJournal(owner, { databaseName, identity: () => ({ ownerId: owner, epoch: 1 }) }); handles.push(journal); return journal; };
  const check = (condition: unknown, description: string) => { if (!condition) throw new Error(description); checks.push(description); };
  const rejects = async (work: () => Promise<unknown>, description: string) => { let rejected = false; try { await work(); } catch { rejected = true; } check(rejected, description); };
  try {
    const first = await open(ownerId), second = await open(ownerId), other = await open(otherId), id = crypto.randomUUID();
    const blob = new Blob([encodeVoiceWav(new Int16Array([1, -1, 2, -2]))], { type: "audio/wav" });
    const draft = await first.save({ id, remoteRevision: 4, text: "Synthetic caption", audio: "replace", blob }, null);
    const recovered = await second.get(id);
    check(recovered?.text === draft.text && recovered.blob?.size === blob.size, "Native IndexedDB recovers text and actual WAV bytes across handles");
    await rejects(() => second.save({ id, remoteRevision: 4, text: "stale", audio: "keep", blob: null }, null), "Stale local revision cannot overwrite another handle's draft");
    const edited = await second.save({ id, remoteRevision: 99, text: "Edited recovered draft", audio: "replace", blob }, draft.revision);
    check(edited.remoteRevision === 4, "Editing a recovered draft preserves its original server revision instead of silently rebasing");
    const frozen = await first.freeze(id, edited.revision), again = await second.freeze(id, frozen.revision);
    check(frozen.requestId === again.requestId && JSON.stringify(await voiceDraftRequest(frozen)) === JSON.stringify(await voiceDraftRequest(again)), "Retry keeps the exact frozen request identity and payload");
    await rejects(() => first.save({ id, remoteRevision: 4, text: "changed", audio: "keep", blob: null }, frozen.revision), "Pending upload drafts cannot be edited");
    await first.forget(id, frozen.revision);
    const deletion = await first.prepareDelete(id, 5), recoveredDelete = await second.get(id);
    check(recoveredDelete?.kind === "delete" && recoveredDelete.requestId === deletion.requestId && recoveredDelete.state === "pending", "Deletion request identity survives native journal recovery");
    await other.save({ id, remoteRevision: 0, text: "Other synthetic owner", audio: "keep", blob: null }, null);
    await removeCloudJournalForOwner(ownerId, { databaseName });
    await rejects(() => first.get(id), "Exact-owner cleanup invalidates open journal handles");
    const reopened = await open(ownerId);
    check(await reopened.get(id) === null && (await other.get(id))?.text === "Other synthetic owner", "Cleanup removes only the selected owner's voice drafts");
    for (let i = 0; i < 20; i++) await reopened.save({ id: crypto.randomUUID(), remoteRevision: 0, text: "", audio: "keep", blob: null }, null);
    await rejects(() => reopened.save({ id: crypto.randomUUID(), remoteRevision: 0, text: "", audio: "keep", blob: null }, null), "The twenty-draft capacity is enforced transactionally");
    return checks;
  } finally {
    handles.forEach(handle => handle.close());
    await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(databaseName); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error("Probe database cleanup blocked")); });
  }
}
