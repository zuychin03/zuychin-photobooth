import { EventClientError, eventClientObject, eventClientUuid } from "./client";
import { parseEventReminder } from "./reminder-contract";
export function createEventReminderClient(options: { appOrigin: string; identity(): { ownerId: string; epoch: number } | null; accessToken(): Promise<string | null>; fetch?: typeof fetch; timeoutMs?: number }) {
  const owner = options.identity(), lifetime = new AbortController(), origin = new URL(options.appOrigin);
  if (!owner || origin.origin !== options.appOrigin || origin.username || origin.password || origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw new EventClientError("unavailable", 503);
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new EventClientError("unavailable", 503);
  const ownerId = eventClientUuid(owner.ownerId), epoch = owner.epoch;
  const assertActive = (signal?: AbortSignal) => { const current = options.identity(); if (!current || current.ownerId !== ownerId || current.epoch !== epoch) { lifetime.abort(); throw new EventClientError("identity_changed"); } if (lifetime.signal.aborted || signal?.aborted) throw new EventClientError("cancelled"); };
  async function request(eventId: string, save?: { expectedRevision: number; email: boolean; push: boolean }, signal?: AbortSignal) {
    assertActive(signal); const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), timeoutMs), active = AbortSignal.any([lifetime.signal, deadline.signal, ...(signal ? [signal] : [])]);
    let abort = () => {};
    const cancelled = new Promise<never>((_, reject) => { abort = () => { const current = options.identity(); reject(new EventClientError(!current || current.ownerId !== ownerId || current.epoch !== epoch ? "identity_changed" : "cancelled")); }; active.addEventListener("abort", abort, { once: true }); if (active.aborted) abort(); });
    const work = async () => {
    const token = await options.accessToken(); assertActive(active); if (!token) throw new EventClientError("access_denied", 403);
    const response = await (options.fetch ?? fetch)(`${options.appOrigin}/api/events/${eventClientUuid(eventId)}/reminder`, { method: "POST", credentials: "omit", redirect: "error", cache: "no-store", signal: active, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(save ? { operation: "save", ...save } : { operation: "read" }) });
    if (active.aborted) { void response.body?.cancel().catch(() => {}); assertActive(active); }
    assertActive(active); const reader = response.body?.getReader(); if (!reader) throw new EventClientError("unavailable", 503);
    const chunks: Uint8Array[] = []; let size = 0;
    const cancelReader = () => { void reader.cancel().catch(() => {}); }; active.addEventListener("abort", cancelReader, { once: true });
    try { while (true) { const next = await reader.read(); assertActive(active); if (next.done) break; size += next.value.length; if (size > 8192 || chunks.length >= 64) throw new EventClientError("unavailable", 503); chunks.push(next.value); } } finally { active.removeEventListener("abort", cancelReader); void reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const raw = JSON.parse(new TextDecoder().decode(bytes));
    if (!response.ok) { const b = eventClientObject(raw, ["error"]); throw new EventClientError(["unavailable", "access_denied", "conflict", "expired", "invalid_request", "rate_limited"].includes(String(b.error)) ? String(b.error) : "unavailable", response.status); }
    const b = eventClientObject(raw, ["settings", "configured"]), configured = eventClientObject(b.configured, ["email", "push"]);
    if (typeof configured.email !== "boolean" || typeof configured.push !== "boolean") throw new EventClientError("unavailable", 503);
    return { settings: parseEventReminder(b.settings, eventId), configured: { email: configured.email, push: configured.push } };
    };
    try { return await Promise.race([work(), cancelled]); } finally { clearTimeout(timer); active.removeEventListener("abort", abort); deadline.abort(); }
  }
  return { ownerId, assertActive, close() { lifetime.abort(); }, read: (eventId: string, signal?: AbortSignal) => request(eventId, undefined, signal), save: (eventId: string, value: { expectedRevision: number; email: boolean; push: boolean }, signal?: AbortSignal) => request(eventId, value, signal) };
}
export type EventReminderClient = ReturnType<typeof createEventReminderClient>;
