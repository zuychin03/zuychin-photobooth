import { openEventGuestJournal, type EventGuestJournal } from "../lib/events/guest-journal";

export type EventJournalProbeRequest = { sequence: number; type: "open"; databaseName: string; eventId: string; guestId: string; otherGuest: string; otherSubmission: string } | { sequence: number; type: "check"; submissionId: string };
export type EventJournalProbeReply = { sequence: number; type: "opened" } | { sequence: number; type: "checked"; staleReadDenied: boolean; staleWriteDenied: boolean; otherRead: boolean; otherWrite: boolean } | { sequence: number; type: "error" };
const scope = self as unknown as { onmessage: ((event: MessageEvent<EventJournalProbeRequest>) => void) | null; postMessage(value: EventJournalProbeReply): void };
let own: EventGuestJournal | null = null, other: EventGuestJournal | null = null, otherSubmission: string | null = null, running = false;
const denied = (error: unknown) => error !== null && typeof error === "object" && "code" in error && error.code === "identity_changed";
scope.onmessage = event => {
  const message = event.data;
  if (process.env.NODE_ENV !== "development" || running) { scope.postMessage({ sequence: message.sequence, type: "error" }); return; }
  running = true;
  void (async () => {
    if (message.type === "open") {
      if (own || other || !/^pb-event-journal-probe-[a-f0-9-]{36}$/.test(message.databaseName) || message.guestId === message.otherGuest) throw new Error();
      own = await openEventGuestJournal({ databaseName: message.databaseName, identity: () => ({ eventId: message.eventId, guestId: message.guestId, epoch: 1 }) });
      other = await openEventGuestJournal({ databaseName: message.databaseName, identity: () => ({ eventId: message.eventId, guestId: message.otherGuest, epoch: 1 }) }); otherSubmission = message.otherSubmission;
      scope.postMessage({ sequence: message.sequence, type: "opened" });
    } else if (own && other && otherSubmission) {
      let staleReadDenied = false, staleWriteDenied = false; try { await own.list(); } catch (error) { staleReadDenied = denied(error); } try { await own.remove(message.submissionId); } catch (error) { staleWriteDenied = denied(error); }
      const current = await other.get(otherSubmission); if (!current) throw new Error(); await other.update(otherSubmission, current.revision, { stage: "reserving" });
      scope.postMessage({ sequence: message.sequence, type: "checked", staleReadDenied, staleWriteDenied, otherRead: !!current, otherWrite: (await other.get(otherSubmission))?.stage === "reserving" });
    } else throw new Error();
  })().catch(() => { own?.close(); other?.close(); scope.postMessage({ sequence: message.sequence, type: "error" }); }).finally(() => { running = false; });
};
