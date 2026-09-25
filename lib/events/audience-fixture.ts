import { EVENT_PUBLICATION_LIMITS, type EventAudienceEntry, type EventDestination } from "./publication-contract";
import { inspectImageHeader } from "../projects/images";
export const AUDIENCE_FIXTURE_EVENT = "72000000-0000-4000-8000-000000000001";
export const AUDIENCE_FIXTURE_TOKENS = { gallery: `${"A".repeat(42)}A`, wall: `${"B".repeat(42)}A` };
const id = (n: number) => `72000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export async function createEventAudienceFixture(options: { appOrigin: string; storageOrigin?: string; image?: Blob }) {
  if (process.env.NODE_ENV !== "development") throw new Error("Development audience fixture unavailable");
  let blob = options.image;
  if (!blob) { const canvas = document.createElement("canvas"); canvas.width = 240; canvas.height = 320; try { const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Canvas unavailable"); ctx.fillStyle = "#ead4ca"; ctx.fillRect(0, 0, 240, 320); ctx.fillStyle = "#a65d77"; ctx.fillRect(24, 28, 192, 216); ctx.fillStyle = "#fff8ef"; ctx.font = "22px sans-serif"; ctx.fillText("Event rehearsal", 28, 285); blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("JPEG unavailable")), "image/jpeg", .8)); } finally { canvas.width = canvas.height = 0; } }
  const source = new Uint8Array(await blob.arrayBuffer()), info = inspectImageHeader(source); if (info.mime !== "image/jpeg" || source.length > 100000 || info.width > 400 || info.height > 400) throw new Error("Fixture requires bounded JPEG");
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", source))].map(x => x.toString(16).padStart(2, "0")).join(""), storageOrigin = options.storageOrigin ?? options.appOrigin;
  let stopped = false, unavailable = false, expired = false, galleryWithdrawn = false, wallHidden = false, revoked = false;
  const sessions = new Map<EventDestination, string>(), reports = new Map<string, { fingerprint: string; reportId: string }>();
  const entries: (EventAudienceEntry & { gallery: boolean; wall: boolean })[] = Array.from({ length: 6 }, (_, index) => ({ submissionId: id(index + 10), revision: 0, createdAt: "2026-09-23T00:00:00.000Z", gallery: index === 1 || index >= 3, wall: index >= 2 }));
  const freshness = () => ({ checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() });
  const allowed = (destination: EventDestination) => revoked ? [] : entries.filter(entry => entry[destination] && !(destination === "gallery" && galleryWithdrawn) && !(destination === "wall" && wallHidden && entry.submissionId === id(12)));
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
  const fetcher: typeof fetch = async (input, init) => {
    if (stopped) throw new Error("Fixture stopped"); if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError"); if (unavailable) return json({ error: "unavailable" }, 503);
    const url = new URL(String(input));
    if (url.origin === storageOrigin && url.pathname.startsWith(`/storage/v1/object/sign/photobooth-events-v2/${AUDIENCE_FIXTURE_EVENT}/`)) {
      const parts = url.pathname.split("/"); if (!entries.some(entry => entry.submissionId === parts[7]) || !["image", "thumbnail"].includes(parts[8]) || url.searchParams.get("token") !== "synthetic-audience") return json({ error: "access_denied" }, 403);
      return new Response(source.slice(), { headers: { "content-type": "image/jpeg", "content-length": String(source.length) } });
    }
    const destination = url.pathname.split("/")[4] as EventDestination;
    if (url.origin !== options.appOrigin || !["gallery", "wall"].includes(destination) || url.pathname !== `/api/events/${AUDIENCE_FIXTURE_EVENT}/${destination}` || init?.method !== "POST") return json({ error: "access_denied" }, 403);
    const body = JSON.parse(String(init.body));
    if (body.operation === "capabilities") return json(EVENT_PUBLICATION_LIMITS);
    if (expired) return json({ error: "expired" }, 410); if (revoked) return json({ error: "access_denied" }, 403);
    const base = () => ({ version: 1, eventId: AUDIENCE_FIXTURE_EVENT, destination, ...freshness() });
    if (body.operation === "exchange") { if (body.token !== AUDIENCE_FIXTURE_TOKENS[destination]) return json({ error: "access_denied" }, 403); sessions.set(destination, sessions.get(destination) ?? crypto.randomUUID()); }
    if (!sessions.has(destination)) return json({ error: "access_denied" }, 403);
    if (["exchange", "session"].includes(body.operation)) return json({ ...base(), sessionId: sessions.get(destination), eventTitle: "An afternoon together" });
    if (body.expectedSessionId !== sessions.get(destination)) return json({ error: "identity_changed" }, 403);
    if (body.operation === "list") { const all = allowed(destination).filter(entry => !body.after || entry.submissionId > body.after), page = all.slice(0, body.limit); return json({ ...base(), eventTitle: "An afternoon together", entries: page.map(({ submissionId, revision, createdAt }) => ({ submissionId, revision, createdAt })), nextCursor: all.length > body.limit ? page.at(-1)!.submissionId : null }); }
    if (body.operation === "validate") return json({ ...base(), entries: allowed(destination).filter(entry => body.submissionIds.includes(entry.submissionId)).map(({ submissionId, revision }) => ({ submissionId, revision })) });
    const entry = allowed(destination).find(value => value.submissionId === body.submissionId); if (!entry) return json({ error: "access_denied" }, 403);
    if (body.operation === "media") { if (!["thumbnail", "image"].includes(body.variant) || destination === "wall" && body.variant === "image") return json({ error: "access_denied" }, 403); const path = `${AUDIENCE_FIXTURE_EVENT}/${entry.submissionId}/${body.variant}`; return json({ submissionId: entry.submissionId, revision: entry.revision, bucket: "photobooth-events-v2", path, variant: body.variant, bytes: source.length, mime: "image/jpeg", sha256: hash, width: info.width, height: info.height, retainedUntil: freshness().expiresAt, expiresAt: new Date(Date.now() + 290000).toISOString(), signedUrl: `${storageOrigin}/storage/v1/object/sign/photobooth-events-v2/${path}?token=synthetic-audience` }); }
    if (body.operation === "report") { const fingerprint = JSON.stringify([destination, body.submissionId, body.reason, body.detail]), previous = reports.get(body.requestId); if (previous && previous.fingerprint !== fingerprint) return json({ error: "conflict" }, 409); if (!previous && reports.size >= 100) return json({ error: "capacity" }, 409); const receipt = previous ?? { fingerprint, reportId: crypto.randomUUID() }; reports.set(body.requestId, receipt); return json({ version: 1, reportId: receipt.reportId, status: "open" }); }
    return json({ error: "invalid_request" }, 400);
  };
  return { fetch: fetcher, eventId: AUDIENCE_FIXTURE_EVENT, tokens: AUDIENCE_FIXTURE_TOKENS,
    failChecks(value: boolean) { unavailable = value; }, withdrawGallery(value: boolean) { galleryWithdrawn = value; }, hideFirstWall(value: boolean) { wallHidden = value; }, revoke(value: boolean) { revoked = value; }, expire(value: boolean) { expired = value; },
    replaceSession(destination: EventDestination) { sessions.set(destination, crypto.randomUUID()); },
    close() { stopped = true; sessions.clear(); reports.clear(); source.fill(0); },
  };
}
export type EventAudienceFixture = Awaited<ReturnType<typeof createEventAudienceFixture>>;
