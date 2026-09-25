import { openChallengeDraftJournal, type ChallengeDraftJournal } from "./challenge-drafts";
import { cloudFixturePeople } from "../projects/cloud-fixture-people";

export async function runPartialDraftsProbe(): Promise<{ checks: string[] }> {
  if (process.env.NODE_ENV !== "development") throw new Error("Development probe unavailable");
  const databaseName = `pb-partial-drafts-probe-${crypto.randomUUID()}`, people = cloudFixturePeople(4), handles: ChallengeDraftJournal[] = [], checks: string[] = [];
  const open = async (index: number) => {
    const ownerId = people[index].ownerId, journal = await openChallengeDraftJournal(ownerId, { databaseName, identity: () => ({ ownerId, epoch: 1 }) });
    handles.push(journal); return journal;
  };
  const check = (value: boolean, message: string) => { if (!value) throw new Error(message); checks.push(message); };
  try {
    const first = await open(1), id = crypto.randomUUID(), projectId = crypto.randomUUID(), challengeId = crypto.randomUUID();
    const contributors = [people[0].ownerId, people[2].ownerId];
    const draft = await first.saveDraft({ id, projectId, challengeId, kind: "partial", form: { contributors } }, null);
    first.close();
    const reopened = await open(1), recovered = await reopened.get(id);
    check(recovered?.kind === "partial" && JSON.stringify(recovered.form.contributors) === JSON.stringify(contributors), "Unmount and reopen preserves an excluded proposer's two contributor choices");
    const pending = await reopened.freezeRequest(id, draft.revision); reopened.close();
    const retry = await open(1), frozen = await retry.get(id);
    check(frozen?.state === "pending" && JSON.stringify(frozen.request) === JSON.stringify(pending.request), "Pending partial reopens with the exact proposal UUID and contributor set");
    for (const index of [0, 2, 3]) check((await (await open(index)).list()).length === 0, `${people[index].name}'s account cannot see Bao's pending proposal`);
    let rejected = false;
    try { await retry.saveDraft({ id, projectId, challengeId, kind: "partial", form: { contributors: [people[0].ownerId] } }, pending.revision); } catch { rejected = true; }
    check(rejected && JSON.stringify((await retry.get(id))?.request) === JSON.stringify(pending.request), "A pending retry cannot silently change its contributors");
    await retry.forget(id, pending.revision);
    check(await retry.get(id) === null, "Explicit local dismissal removes only the saved retry record");
    return { checks };
  } finally {
    handles.forEach(handle => handle.close());
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Partial probe cleanup blocked"));
    });
  }
}
