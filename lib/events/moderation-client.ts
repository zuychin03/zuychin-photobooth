import { EventClientError, eventClientObject, eventClientUuid, type EventHostClientOptions } from "./client";
import { EVENT_PUBLICATION_LIMITS, parseEventModerationEntry, parseEventModerationPage, parseEventReportPage, parseEventReportReceipt, publicationDestination, publicationRevision, type EventDestination, type EventReportReason } from "./publication-contract";

export type EventModerationDecision = { submissionId: string; destination: EventDestination; expectedRevision: number } & ({ state: "approved"; requestId: string } | { state: "hidden" | "rejected" });
export type EventModerationReport = { submissionId: string; destination: EventDestination; requestId: string; reason: EventReportReason; detail: string };

export function createEventModerationClient(options: EventHostClientOptions) {
  const origin = new URL(options.appOrigin), initial = options.identity(), lifetime = new AbortController(), timeoutMs = options.timeoutMs ?? 10000;
  if (origin.origin !== options.appOrigin || origin.username || origin.password || origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) || !initial || !Number.isSafeInteger(initial.epoch) || initial.epoch < 0 || typeof location !== "undefined" && location.origin !== origin.origin || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new EventClientError("invalid_configuration");
  const ownerId = eventClientUuid(initial.ownerId), identity = JSON.stringify(initial);
  const assertActive = (signal?: AbortSignal) => { if (JSON.stringify(options.identity()) !== identity) { lifetime.abort(); throw new EventClientError("identity_changed"); } if (lifetime.signal.aborted || signal?.aborted) throw new EventClientError("cancelled"); };
  async function request(eventId: string, operation: string, input: object, signal?: AbortSignal): Promise<unknown> {
    assertActive(signal); eventClientUuid(eventId);
    const body = JSON.stringify({ operation, ...input }); if (new TextEncoder().encode(body).length > 4096) throw new EventClientError("invalid_request");
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), timeoutMs), active = AbortSignal.any([lifetime.signal, deadline.signal, ...(signal ? [signal] : [])]);
    let rejectAbort = () => {};
    const interrupted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new EventClientError(deadline.signal.aborted ? "timeout" : "cancelled")); active.addEventListener("abort", rejectAbort, { once: true }); });
    const work = async () => {
      const token = await options.accessToken(); assertActive(active); if (!token || token.length > 16384 || /[\s,]/.test(token)) throw new EventClientError("access_denied");
      const endpoint = `${origin.origin}/api/events/${eventId}/moderation`, response = await (options.fetch ?? fetch)(endpoint, { method: "POST", credentials: "omit", cache: "no-store", redirect: "error", signal: active, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body });
      if (active.aborted || response.redirected || response.url && response.url !== endpoint || !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) { void response.body?.cancel(); assertActive(active); throw new EventClientError("invalid_response"); }
      const length = response.headers.get("content-length"); if (length !== null && (!/^\d+$/.test(length) || Number(length) > 32768)) { void response.body?.cancel(); throw new EventClientError("response_too_large"); }
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
      const cancel = () => { void reader?.cancel().catch(() => undefined); }; active.addEventListener("abort", cancel, { once: true });
      try { if (reader) while (true) { assertActive(active); const part = await reader.read(); assertActive(active); if (part.done) break; size += part.value.length; if (size > 32768 || chunks.length >= 64) throw new EventClientError("response_too_large"); chunks.push(part.value); } }
      finally { active.removeEventListener("abort", cancel); if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); } }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); assertActive(active);
      if (!response.ok) { const b = eventClientObject(value, ["error"]), code = String(b.error); throw new EventClientError(["access_denied", "expired", "conflict", "capacity", "not_ready", "invalid_request", "rate_limited", "origin_denied", "unavailable", "update_required"].includes(code) ? code : "unavailable", response.status); }
      return value;
    };
    try { const value = await Promise.race([work(), interrupted]); assertActive(signal); return value; }
    catch (error) { assertActive(signal); if (error instanceof EventClientError) throw error; throw new EventClientError("invalid_response"); }
    finally { clearTimeout(timer); active.removeEventListener("abort", rejectAbort); deadline.abort(); }
  }
  const cursor = (after?: string, limit = 12) => { if (!Number.isInteger(limit) || limit < 1 || limit > 12) throw new EventClientError("invalid_request"); return { limit, ...(after === undefined ? {} : { after: eventClientUuid(after) }) }; };
  return { ownerId, assertActive, close() { lifetime.abort(); },
    async capabilities(eventId: string, signal?: AbortSignal) { const b = eventClientObject(await request(eventId, "capabilities", {}, signal), Object.keys(EVENT_PUBLICATION_LIMITS)); if (Object.entries(EVENT_PUBLICATION_LIMITS).some(([key, value]) => b[key] !== value)) throw new EventClientError("update_required"); return EVENT_PUBLICATION_LIMITS; },
    async list(eventId: string, after?: string, limit = 12, signal?: AbortSignal) { return parseEventModerationPage(await request(eventId, "list", cursor(after, limit), signal), eventId, after, limit); },
    async decide(eventId: string, decision: EventModerationDecision, signal?: AbortSignal) {
      eventClientObject(decision, ["submissionId", "destination", "expectedRevision", "state"], decision.state === "approved" ? ["requestId"] : []);
      eventClientUuid(decision.submissionId); publicationDestination(decision.destination); publicationRevision(decision.expectedRevision);
      if (!["approved", "hidden", "rejected"].includes(decision.state)) throw new EventClientError("invalid_request"); if (decision.state === "approved") eventClientUuid(decision.requestId);
      const result = parseEventModerationEntry(await request(eventId, "decide", decision, signal));
      if (result.submissionId !== decision.submissionId || result.revision < decision.expectedRevision) throw new EventClientError("invalid_response"); return result;
    },
    async remove(eventId: string, submissionId: string, expectedRevision: number, signal?: AbortSignal) { const result = parseEventModerationEntry(await request(eventId, "remove", { submissionId: eventClientUuid(submissionId), expectedRevision: publicationRevision(expectedRevision) }, signal)); if (result.submissionId !== submissionId || result.state !== "deleted" || result.revision < expectedRevision) throw new EventClientError("invalid_response"); return result; },
    async reports(eventId: string, after?: string, limit = 12, signal?: AbortSignal) { return parseEventReportPage(await request(eventId, "reports", cursor(after, limit), signal), eventId, after, limit); },
    async report(eventId: string, input: EventModerationReport, signal?: AbortSignal) { eventClientObject(input, ["submissionId", "destination", "requestId", "reason", "detail"]); eventClientUuid(input.submissionId); eventClientUuid(input.requestId); publicationDestination(input.destination); if (!["privacy", "inappropriate", "other"].includes(input.reason) || typeof input.detail !== "string" || [...input.detail].length > 500 || /[\u0000-\u001f\u007f]/.test(input.detail)) throw new EventClientError("invalid_request"); return parseEventReportReceipt(await request(eventId, "report", input, signal)); },
    async resolve(eventId: string, reportId: string, signal?: AbortSignal) { const result = parseEventReportReceipt(await request(eventId, "resolve", { reportId: eventClientUuid(reportId) }, signal)); if (result.reportId !== reportId || result.status !== "resolved") throw new EventClientError("invalid_response"); return result; },
  };
}
export type EventModerationClient = ReturnType<typeof createEventModerationClient>;
