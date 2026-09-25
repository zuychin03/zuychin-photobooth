import { createEventGuestClient, EventClientError, type EventGuestIdentity } from "./client";
import type { EventGuestRuntimeOptions, EventGuestSession } from "./guest-runtime";
import type { EventSession } from "./contract";

export type PostcardGuestSession = Pick<EventGuestSession, "client" | "context" | "session">;
// Existing postcard withdrawal must not depend on device storage being available.
export function createPostcardGuestRuntime(options: EventGuestRuntimeOptions) {
  let identity: EventGuestIdentity | null = null, closed = false;
  const clients = new Set<ReturnType<typeof createEventGuestClient>>();
  const make = () => { const client = createEventGuestClient({ ...options, identity: () => closed ? null : identity }); clients.add(client); return client; };
  const entry = make();
  const active = (signal?: AbortSignal) => { if (closed || signal?.aborted) throw new EventClientError("cancelled"); };
  async function adopt(session: EventSession, signal?: AbortSignal): Promise<PostcardGuestSession> {
    active(signal); if (identity || session.eventId !== options.eventId || session.kind !== "contribute" || !session.guestId) throw new EventClientError("identity_changed");
    identity = { eventId: options.eventId, guestId: session.guestId, epoch: 1 }; entry.close(); const client = make();
    try { const context = await client.context(signal); active(signal); return { client, context, session }; } catch (failure) { client.close(); throw failure; }
  }
  return {
    async inspect(signal?: AbortSignal) { active(signal); let existing: EventSession | null = null; try { existing = await entry.session(signal); } catch (failure) { if (!(failure instanceof EventClientError) || !["access_denied", "expired"].includes(failure.code)) throw failure; } active(signal); return { existing }; },
    async resume(session: EventSession, signal?: AbortSignal) { const current = await entry.session(signal); if (current.guestId !== session.guestId) throw new EventClientError("identity_changed"); return adopt(current, signal); },
    async join(token: string, nonce: string, signal?: AbortSignal) { return adopt(await entry.redeem(token, nonce, signal), signal); },
    close() { closed = true; identity = null; for (const client of clients) client.close(); clients.clear(); },
  };
}
export type PostcardGuestRuntime = ReturnType<typeof createPostcardGuestRuntime>;
