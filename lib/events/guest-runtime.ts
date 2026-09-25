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
    unavailable: "This event connection is unavailable. Keep your photo and try again later.", not_ready: "Event uploads are not available here yet. Your photo stays on this device.",
    access_denied: "This invitation or guest session is no longer available. Ask the host for help; keep your local photo.", expired: "This invitation or upload window has ended. You can still download your local photo.",
    capacity: "This event has reached its current capacity. Download your local photo and ask the host for help.", identity_changed: "The guest session changed. Refresh this page before continuing.",
    conflict: "This saved request changed in another tab. Refresh its status before retrying.", rate_limited: "Too many requests were made. Wait a minute, then try again.",
    queue_capacity: "This device's temporary queue is full. Review and export pending photos before removing them.", journal_unavailable: "This browser could not save the recovery request. Nothing new was uploaded. Download your photo or allow device storage, then retry.", journal_blocked: "Another tab is blocking device storage. Close it, then try again.",
    upload_uncertain: "The upload was not confirmed. Keep this request and retry with the same photo.", original_required: "Choose the exact finished photo saved for this request.", image_mismatch: "That file does not match. Choose the exact finished photo saved for this request.", queue_expired: "This temporary device request has expired. Ask the host whether a new contribution is still possible.",
  };
  return typeof code === "string" && messages[code] || "This action could not finish. Keep your photo and retry the same request, or refresh its status.";
}
