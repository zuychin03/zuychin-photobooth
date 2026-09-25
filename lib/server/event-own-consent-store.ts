import { EventStoreError, type EventRpcClient } from "./event-store";
import { parseEventOwnConsent } from "../events/own-consent";
export function createEventOwnConsentStore(client: EventRpcClient) {
  const rpc = async (name: string, args: Record<string, unknown>) => { const result = await client.rpc(name, args); if (result.error) { const message = result.error.message ?? ""; throw new EventStoreError(message.includes("CONFLICT") ? "conflict" : message.includes("DENIED") ? "access_denied" : message.includes("CAPACITY") ? "capacity" : message.includes("INVALID") ? "invalid_request" : message.includes("EXPIRED") ? "expired" : "unavailable", message.includes("DENIED") ? 403 : message.includes("INVALID") ? 400 : message.includes("EXPIRED") ? 410 : message.includes("CONFLICT") || message.includes("CAPACITY") ? 409 : 503); } return result.data; };
  return {
    async capabilities() { const data = await rpc("pb_event_own_consent_capabilities", {}); if (!data || typeof data !== "object" || (data as { version?: unknown }).version !== 1 || Object.keys(data).length !== 1) throw new EventStoreError("unavailable", 503); return { version: 1 as const }; },
    async read(eventId: string, hash: string, guestId: string, submissionId: string, update?: { expectedRevision: number; gallery: boolean; wall: boolean }) { const data = await rpc("pb_event_own_consent", { p_event: eventId, p_hash: hash, p_guest: guestId, p_submission: submissionId, p_revision: update?.expectedRevision ?? null, p_gallery: update?.gallery ?? null, p_wall: update?.wall ?? null }); try { return parseEventOwnConsent(data, eventId, submissionId); } catch { throw new EventStoreError("unavailable", 503); } },
  };
}
