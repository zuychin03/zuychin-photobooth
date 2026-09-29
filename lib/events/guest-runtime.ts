import { createEventGuestClient, EventClientError, type EventBrowserOptions, type EventGuestIdentity } from "./client";
import { openEventGuestJournal, type EventGuestJournalOptions } from "./guest-journal";
import type { EventSession } from "./contract";

export interface EventGuestRuntimeOptions extends EventBrowserOptions { eventId: string; storageOrigin?: string; databaseName?: string; indexedDB?: IDBFactory }
export function createEventGuestRuntime(options: EventGuestRuntimeOptions) {
  let identity: EventGuestIdentity | null = null, epoch = 0, closed = false;
  const clients = new Set<ReturnType<typeof createEventGuestClient>>(), journals = new Set<Awaited<ReturnType<typeof openEventGuestJournal>>>();
  const make = () => { const client = createEventGuestClient({ ...options, identity: () => closed ? null : identity }); clients.add(client); return client; };
  let entry = make();
  const check = (signal?: AbortSignal) => { if (closed || signal?.aborted) throw new EventClientError("cancelled"); };
  async function adopt(session: EventSession, signal?: AbortSignal) {
    check(signal); if (identity || session.eventId !== options.eventId || session.kind !== "contribute" || !session.guestId) throw new EventClientError("identity_changed");
    identity = { eventId: options.eventId, guestId: session.guestId, epoch: ++epoch }; entry.close();
    const client = make(); let journal: Awaited<ReturnType<typeof openEventGuestJournal>> | undefined;
    try {
      const context = await client.context(signal); check(signal);
      journal = await openEventGuestJournal({ databaseName: options.databaseName, indexedDB: options.indexedDB, identity: () => closed ? null : identity } satisfies EventGuestJournalOptions); journals.add(journal); check(signal);
      return { client, journal, context, session };
    } catch (error) { journal?.close(); client.close(); identity = null; if (!closed) entry = make(); throw error; }
  }
  return {
    get entry() { return entry; },
    async inspect(signal?: AbortSignal) { const capabilities = await entry.capabilities(signal); let existing: EventSession | null = null; try { existing = await entry.session(signal); } catch (error) { if (!(error instanceof EventClientError) || !["access_denied", "expired"].includes(error.code)) throw error; } check(signal); return { capabilities, existing }; },
    async resume(session: EventSession, signal?: AbortSignal) { const current = await entry.session(signal); if (current.guestId !== session.guestId) throw new EventClientError("identity_changed"); return adopt(current, signal); },
    async join(invite: string, nonce: string, signal?: AbortSignal) { return adopt(await entry.redeem(invite, nonce, signal), signal); },
    close() { closed = true; identity = null; epoch++; for (const client of clients) client.close(); for (const journal of journals) journal.close(); clients.clear(); journals.clear(); },
  };
}
export type EventGuestRuntime = ReturnType<typeof createEventGuestRuntime>;
export type EventGuestSession = Awaited<ReturnType<EventGuestRuntime["join"]>>;
export function eventGuestEntryReady(capabilities: { hostVersion: number; uploadsAvailable: boolean; downloadsAvailable: boolean }, existingGuest: boolean): boolean {
  return capabilities.hostVersion === 1 && capabilities.downloadsAvailable && (existingGuest || capabilities.uploadsAvailable);
}
export function invalidateEventGuestSession(error: unknown, session: Pick<EventGuestSession, "client" | "journal">): boolean {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code !== "access_denied" && code !== "identity_changed") return false;
  session.client.close(); session.journal.close();
  return true;
}
export function takeEventFragment(kind: "invite" | "receipt", locationValue: Pick<Location, "hash" | "pathname" | "search">, replace: (path: string) => void): { token: string | null; eventId: string | null } {
  const hash = locationValue.hash, parts = new URLSearchParams(hash.slice(1)), query = new URLSearchParams(locationValue.search), keys = [...parts.keys()], token = parts.get(kind === "invite" ? "invite" : "token"), candidate = query.get("event") ?? parts.get("event"), eventId = kind === "receipt" && candidate && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(candidate) ? candidate : null;
  replace(`${locationValue.pathname}${eventId ? `?event=${eventId}` : ""}`);
  if (hash.length > 200 || kind === "invite" && locationValue.search || kind === "receipt" && ([...query.keys()].some(key => key !== "event") || query.getAll("event").length > 1 || query.has("event") && parts.has("event") && query.get("event") !== parts.get("event"))) return { token: null, eventId: null };
  if (!hash && kind === "receipt") return { token: null, eventId };
  if (keys.length !== (kind === "invite" ? 1 : parts.has("event") ? 2 : 1) || !keys.every(key => kind === "invite" ? key === "invite" : ["event", "token"].includes(key)) || !token || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(token) || kind === "receipt" && !eventId) return { token: null, eventId: null };
  return { token, eventId };
}
export function eventGuestError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : "";
  const messages: Record<string, string> = {
    unavailable: "Couldn't reach the event. Keep your photo and try again later.", not_ready: "Event uploads aren't open here yet. Your photo stays on this device.",
    access_denied: "This invitation doesn't work any more. Ask the host for help. Your photo stays on this device.", expired: "Uploads for this event have closed. You can still download your photo.",
    capacity: "This event is full. Download your photo and ask the host for help.", identity_changed: "Something changed in this browser. Refresh the page to continue.",
    conflict: "This changed in another tab. Refresh, then try again.", rate_limited: "Too many requests. Wait a minute, then try again.",
    queue_capacity: "This device has too many unsent photos. Download them before you remove any.", journal_unavailable: "This browser couldn't save your progress, so nothing was sent. Download your photo or allow storage, then try again.", journal_blocked: "Another tab is using this event. Close it, then try again.",
    upload_uncertain: "We couldn't confirm the upload. Try again with the same photo.", original_required: "Choose the same finished photo you saved earlier.", image_mismatch: "That's a different file. Choose the same finished photo you saved earlier.", queue_expired: "This upload has expired. Ask the host if you can still add a photo.",
  };
  return typeof code === "string" && messages[code] || "Something went wrong. Keep your photo, then try again or refresh.";
}
