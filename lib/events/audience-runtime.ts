import { EventClientError } from "./client";
import { createEventAudienceClient, type EventAudienceClientOptions } from "./audience-client";
import type { EventAudienceSession } from "./publication-contract";

export function createEventAudienceRuntime(options: EventAudienceClientOptions) {
  let client = createEventAudienceClient(options), closed = false;
  const check = (signal?: AbortSignal) => { if (closed || signal?.aborted) throw new EventClientError("cancelled"); };
  return {
    async inspect(signal?: AbortSignal) { await client.capabilities(signal); check(signal); let existing: EventAudienceSession | null = null; try { existing = await client.session(signal); } catch (error) { if (!(error instanceof EventClientError) || !["access_denied", "expired"].includes(error.code)) throw error; } check(signal); return existing; },
    async resume(expected: EventAudienceSession, signal?: AbortSignal) { check(signal); const session = await client.session(signal); check(signal); if (session.sessionId !== expected.sessionId) throw new EventClientError("identity_changed"); return { client, session }; },
    async exchange(token: string, signal?: AbortSignal) { check(signal); client.close(); client = createEventAudienceClient(options); const session = await client.exchange(token, signal); check(signal); return { client, session }; },
    close() { closed = true; client.close(); },
  };
}
export type EventAudienceRuntime = ReturnType<typeof createEventAudienceRuntime>;
