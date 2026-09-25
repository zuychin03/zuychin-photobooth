import type { EventHostIdentity, EventPublicEvent } from "./client";
import type { EventReceipt } from "./contract";
import { EVENT_REVIEW_LIMITS } from "./review-contract";

export function createEventReviewFixture(options: { appOrigin: string; identity(): EventHostIdentity | null; lookup(eventId: string, actorId: string): { event: EventPublicEvent; submissions: EventReceipt[]; authorised: boolean } | null }) {
  if (process.env.NODE_ENV !== "development") throw new Error("Development review fixture unavailable");
  const photos = new Map<string, { blob: Blob; sha256: string }>(); let stopped = false, seeding = false;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
  const deny = () => json({ error: "access_denied" }, 403);
  const transport: typeof fetch = async (input, init) => {
    const identity = options.identity(), url = new URL(String(input)); if (stopped || !identity || init?.signal?.aborted || url.origin !== options.appOrigin) return deny();
    const binary = url.pathname.startsWith("/storage/v1/object/sign/photobooth-events-v2/"), eventId = url.pathname.split("/")[binary ? 6 : 3], entry = options.lookup(eventId, identity.ownerId);
    if (!entry?.authorised || entry.event.status === "deleted" || Date.parse(entry.event.expiresAt) <= Date.now()) return deny();
    const descriptor = (submissionId: string) => { const submission = entry.submissions.find(s => s.submissionId === submissionId), photo = photos.get(submissionId); if (!submission || submission.state !== "ready" || !photo || Date.parse(submission.eventExpiresAt) <= Date.now()) return null; return { submissionId, bucket: "photobooth-events-v2", path: `${eventId}/${submissionId}/thumbnail`, bytes: photo.blob.size, mime: "image/jpeg", sha256: photo.sha256, expiresAt: submission.eventExpiresAt, maxAgeSeconds: Math.min(300, Math.floor((Date.parse(submission.eventExpiresAt) - Date.now()) / 1000)) }; };
    if (binary) { const submissionId = url.pathname.split("/")[7], access = descriptor(submissionId); if (!access || url.pathname !== `/storage/v1/object/sign/${access.bucket}/${access.path}` || url.searchParams.get("token") !== `synthetic-${identity.epoch}`) return deny(); return new Response(photos.get(submissionId)!.blob, { headers: { "content-type": "image/jpeg", "cache-control": "private, no-store" } }); }
    if (url.pathname !== `/api/events/${eventId}/review` || init?.method !== "POST") return deny();
    const body = JSON.parse(String(init.body));
    if (body.operation === "capabilities") return json(EVENT_REVIEW_LIMITS);
    if (body.operation === "list") { const limit = Math.min(12, body.limit ?? 12), all = entry.submissions.filter(s => !body.after || s.submissionId > body.after).sort((a, b) => a.submissionId.localeCompare(b.submissionId)), rows = all.slice(0, limit); return json({ version: 1, eventId, entries: rows.map(s => ({ ...s, createdAt: entry.event.startsAt, thumbnailAvailable: descriptor(s.submissionId) !== null })), nextCursor: all.length > limit ? rows.at(-1)!.submissionId : null }); }
    const access = descriptor(body.submissionId); if (!access) return deny();
    if (body.operation === "access") return json(access);
    if (body.operation === "media") { const { maxAgeSeconds, ...fields } = access; return json({ ...fields, retainedUntil: fields.expiresAt, expiresAt: new Date(Date.now() + Math.min(200, maxAgeSeconds) * 1000).toISOString(), signedUrl: `${options.appOrigin}/storage/v1/object/sign/${access.bucket}/${access.path}?token=synthetic-${identity.epoch}` }); }
    return json({ error: "invalid_request" }, 400);
  };
  return { fetch: transport,
    async seed(submissionId: string, blob?: Blob) {
      if (stopped || seeding || photos.size >= 8 && !photos.has(submissionId)) throw new Error("Synthetic photo capacity");
      seeding = true;
      try {
      if (!blob) { const canvas = document.createElement("canvas"); canvas.width = 120; canvas.height = 160; try { const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Canvas unavailable"); ctx.fillStyle = "#efd5d9"; ctx.fillRect(0, 0, 120, 160); ctx.fillStyle = "#a45d70"; ctx.fillRect(20, 30, 80, 100); blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(v => v ? resolve(v) : reject(new Error("Synthetic JPEG unavailable")), "image/jpeg", .8)); } finally { canvas.width = canvas.height = 0; } }
      if (blob.type !== "image/jpeg" || blob.size > 100000 || !blob.size) throw new Error("Invalid synthetic JPEG"); const bytes = await blob.arrayBuffer(), sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(v => v.toString(16).padStart(2, "0")).join(""); if (stopped) throw new Error("Synthetic fixture closed"); photos.set(submissionId, { blob, sha256 });
      } finally { seeding = false; }
    },
    close() { stopped = true; photos.clear(); },
  };
}
