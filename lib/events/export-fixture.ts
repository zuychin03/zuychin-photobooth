import { inspectImageHeader } from "../projects/images";
import type { EventExportEntry, EventExportPage, EventExportSummary, EventExportUpdate } from "./export-contract";

export async function createEventExportFixture(options: { appOrigin: string; storageOrigin: string; eventId: string; ownerId: string; image: Blob }) {
  const bytes = new Uint8Array(await options.image.arrayBuffer()), info = inspectImageHeader(bytes);
  if (info.mime !== "image/jpeg" || bytes.length > 2000000) throw new Error("Fixture requires bounded JPEG");
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(v => v.toString(16).padStart(2, "0")).join("");
  const slots = new Map<string, { generation: number; retired: boolean; summary: EventExportSummary; entries: EventExportEntry[] }>();
  const calls: string[] = []; let expired = false, stopped = false, revoked = false, lostCreate = false, lostCheckpoint = false, corrupt = false, epoch = 1, currentOwner: string | null = options.ownerId, downloads = 0;
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  const entries = (): EventExportEntry[] => Array.from({ length: 12 }, (_, index) => {
    const submissionId = `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, available = index !== 2;
    return { index, submissionId, createdAt: "2026-09-23T00:00:00.000Z", expiresAt, state: available ? "ready" : "failed", caption: null, captionStatus: "not_collected", media: available ? { bucket: "photobooth-events-v2", path: `${options.eventId}/${submissionId}/image`, bytes: bytes.length, mime: "image/jpeg", width: info.width, height: info.height, sha256 } : null, unavailable: available ? null : "failed", progress: available ? { status: "pending", error: null } : { status: "failed", error: "unavailable" } };
  });
  const fetcher: typeof fetch = async (input, init) => {
    if (stopped) throw new TypeError("Fixture stopped");
    const url = new URL(String(input)), reply = (body: unknown, status = 200) => Object.defineProperty(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }), "url", { value: url.href });
    if (expired) return reply({ error: "expired" }, 410);
    if (url.origin === options.storageOrigin) {
      downloads++; if (revoked) return reply({ error: "access_denied" }, 403);
      const payload = new Uint8Array(bytes); if (corrupt) payload[payload.length - 1] ^= 1;
      return Object.defineProperty(new Response(payload, { headers: { "content-type": "image/jpeg", "content-length": String(payload.length) } }), "url", { value: url.href });
    }
    if (url.href !== `${options.appOrigin}/api/events/${options.eventId}/exports` || init?.method !== "POST" || new Headers(init.headers).get("authorization") !== "Bearer synthetic-event-export") return reply({ error: "access_denied" }, 403);
    const b = JSON.parse(String(init.body)); calls.push(b.operation);
    if (revoked || currentOwner !== options.ownerId) return reply({ error: "access_denied" }, 403);
    if (b.operation === "list") return reply({ version: 1, exports: [...slots.values()].filter(x => !x.retired).map(x => x.summary), retired: [...slots.values()].filter(x => x.retired).map(x => ({ exportId: x.summary.exportId, generation: x.generation })) });
    let slot = slots.get(b.exportId);
    if (b.operation === "create") {
      if (slot && (slot.generation !== b.generation || !slot.retired && slot.summary.afterSubmissionId !== (b.afterSubmissionId ?? null))) return reply({ error: "conflict" }, 409);
      if (!slot && (slots.size >= 8 || b.generation !== 0)) return reply({ error: "capacity" }, 409);
      if (!slot || slot.retired) {
        const summary: EventExportSummary = { version: 1, exportId: b.exportId, eventId: options.eventId, generation: b.generation, revision: 0, createdAt: new Date().toISOString(), expiresAt, total: 12, afterSubmissionId: b.afterSubmissionId ?? null, nextSubmissionCursor: null };
        slot = { generation: b.generation, retired: false, summary, entries: entries() }; slots.set(b.exportId, slot);
      }
      if (lostCreate) { lostCreate = false; throw new TypeError("Synthetic lost acknowledgement"); } return reply(slot.summary);
    }
    if (!slot) return reply({ error: "access_denied" }, 403);
    if (b.operation === "retire" && slot.retired && slot.generation === b.generation + 1) return reply({ exportId: b.exportId, generation: slot.generation });
    if (slot.retired || slot.generation !== b.generation) return reply({ error: "conflict" }, 409);
    if (b.operation === "retire") { if (slot.summary.revision !== b.revision) return reply({ error: "conflict" }, 409); slot.retired = true; slot.generation++; slot.entries = []; return reply({ exportId: b.exportId, generation: slot.generation }); }
    if (b.operation === "page") {
      const after = b.after ?? -1, limit = b.limit ?? 10, items = slot.entries.slice(after + 1, after + 1 + limit);
      const result: EventExportPage = { summary: slot.summary, entries: items, nextCursor: after + items.length + 1 < slot.entries.length ? after + items.length : null }; return reply(result);
    }
    if (b.operation === "access" || b.operation === "media") {
      const entry = slot.entries[b.index]; if (!entry?.media) return reply({ error: "access_denied" }, 403);
      const descriptor = { ...entry.media, submissionId: entry.submissionId, expiresAt, maxAgeSeconds: 300 };
      if (b.operation === "access") return reply(descriptor);
      const { maxAgeSeconds: ignored, ...fields } = descriptor; void ignored;
      return reply({ ...fields, retainedUntil: expiresAt, expiresAt: new Date(Date.now() + 290000).toISOString(), signedUrl: `${options.storageOrigin}/storage/v1/object/sign/${entry.media.bucket}/${entry.media.path}?token=synthetic` });
    }
    if (b.operation === "checkpoint") {
      const updates = b.updates as EventExportUpdate[], same = updates.every(update => JSON.stringify(slot!.entries[update.index].progress) === JSON.stringify({ status: update.status, error: update.error }));
      if (!same) {
        if (slot.summary.revision !== b.revision) return reply({ error: "conflict" }, 409);
        for (const update of updates) slot.entries[update.index].progress = { status: update.status, error: update.error }; slot.summary.revision++;
      }
      if (lostCheckpoint) { lostCheckpoint = false; throw new TypeError("Synthetic lost acknowledgement"); } return reply(slot.summary);
    }
    return reply({ error: "invalid_request" }, 400);
  };
  return { fetch: fetcher, identity: () => currentOwner ? { ownerId: currentOwner, epoch } : null, accessToken: async () => "synthetic-event-export", calls,
    expire() { expired = true; }, close() { stopped = true; revoked = true; currentOwner = null; epoch++; slots.clear(); calls.length = 0; bytes.fill(0); },
    revoke() { revoked = true; }, restore() { revoked = false; }, corrupt(value: boolean) { corrupt = value; }, loseCreate() { lostCreate = true; }, loseCheckpoint() { lostCheckpoint = true; }, switchAccount() { currentOwner = null; epoch++; }, downloads: () => downloads,
  };
}
