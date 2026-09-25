import type { ChallengeDraft, ChallengeDraftInput, ChallengeDraftJournal } from "./challenge-drafts";

export function createChallengeDraftWriter(initial: ChallengeDraft, journal: Pick<ChallengeDraftJournal, "saveDraft">, changed: (state: { draft: ChallengeDraft; saving: boolean; error: unknown }) => void) {
  let draft = initial, latest: ChallengeDraftInput | null = null, task: Promise<void> | null = null, failure: unknown = null, closed = false;
  const report = () => { if (!closed) changed({ draft, saving: task !== null || latest !== null && !failure, error: failure }); };
  const pump = () => {
    if (closed || task || !latest) return;
    task = Promise.resolve().then(async () => {
      while (!closed && latest) {
        const input = latest; latest = null;
        try { draft = await journal.saveDraft(input, draft.revision); failure = null; }
        catch (error) { latest ??= input; failure = error; break; }
      }
    }).finally(() => { task = null; report(); });
    report();
  };
  return {
    schedule(input: ChallengeDraftInput) { if (closed || draft.state !== "draft") throw new Error("Draft closed"); latest = structuredClone(input); failure = null; pump(); },
    async flush() { if (closed) throw new Error("Draft closed"); failure = null; pump(); if (task) await task; if (closed) throw new Error("Draft closed"); if (failure) throw failure; return draft; },
    close() { closed = true; latest = null; },
  };
}
