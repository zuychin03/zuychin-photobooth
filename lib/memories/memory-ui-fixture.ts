import { createActivityClient } from "./activity-client";
import { createRetainedStripClient } from "./retained-strip-client";
import { createCloudProjectClient, type CloudIdentity } from "../projects/cloud-client";
import { CLOUD_PROJECT_LIMITS } from "../projects/cloud-contract";
import { inspectRetainedPngHeader } from "../projects/images";
import { RETAINED_STRIP_LIMITS } from "./retained-strip-contract";
import { memoryAfter, memoryInstantMicros, memoryYearBounds, validateMemoryBrowse } from "./activity-browse";
import { validateActivityAnnotation, validateChapterInput, type ActivityAvailability, type MemoryActivity, type MemoryChapter } from "./activity-contract";
import type { MemoryRuntime } from "./memory-runtime";

const uuid = (n: number) => `80000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const memoryFixturePeople = [uuid(1), uuid(2)] as const;
export const memoryFixtureCouple = uuid(3);
interface Stored { ownerId: string; item: MemoryActivity }
export interface MemoryFixtureSession { runtime: MemoryRuntime; ownerId: string; name: string; key: string; close(): void }
export async function createMemoryUIFixture(appOrigin: string, image: { png: Blob; width: number; height: number }) {
  if (image.png.size > 128 * 1024 || image.png.type !== "image/png") throw new Error("Invalid rehearsal PNG");
  const bytes = new Uint8Array(await image.png.arrayBuffer()), header = inspectRetainedPngHeader(bytes);
  if (header.width !== image.width || header.height !== image.height || image.width > 384 || image.height > 384) throw new Error("Invalid rehearsal image dimensions");
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
  const rows: Stored[] = [], chapters = new Map<string, { ownerId: string; chapter: MemoryChapter }>(), revoked = new Set<string>(), sessions = new Set<MemoryFixtureSession>();
  let paired = true, closed = false, epoch = 0, failure: "before" | "after" | null = null;
  const statuses: ActivityAvailability[] = ["available", "archived", "archive_pending", "expired", "deleted", "unknown", "access_lost"];
  for (let person = 0; person < 2; person++) {
    const ownerId = memoryFixturePeople[person], chapterId = uuid(10 + person);
    chapters.set(chapterId, { ownerId, chapter: { id: chapterId, title: person ? "Bao's private chapter" : "Alex's quiet weekends", revision: 0, createdAt: "2026-01-02T00:00:00Z" } });
    for (let n = 0; n < 38; n++) {
      const mine = true, availability = statuses[n % statuses.length], shared = n % 3 === 0;
      const occurredAt = n === 36 ? "2025-12-31T20:30:00Z" : n === 37 ? "2026-12-31T20:30:00Z" : new Date(Date.UTC(2026, n % 12, 4 + Math.floor(n / 12), 12)).toISOString();
      rows.push({ ownerId, item: { id: uuid(100 + person * 100 + n), mine, occurredAt, provenance: "saved_at", availability,
        source: availability === "access_lost" ? null : { kind: "strip", id: uuid(1000 + person * 100 + n), scopeKind: shared ? "couple" : "personal", scopeId: shared ? memoryFixtureCouple : null },
        annotation: { revision: 0, chapterId: n % 7 === 0 ? chapterId : null, occasion: n % 7 === 0 ? person ? "Bao's private occasion" : "A slow Sunday" : null } } });
    }
  }
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  const denied = () => response({ error: "access_denied" }, 403), conflict = () => response({ error: "conflict" }, 409);
  function projection(stored: Stored, ownerId: string): MemoryActivity | null {
    const mine = stored.ownerId === ownerId, source = stored.item.source;
    if (!mine && (!paired || source?.scopeKind !== "couple" || revoked.has(source.id))) return null;
    const lost = source && (revoked.has(source.id) || source.scopeKind === "couple" && !paired);
    return structuredClone({ ...stored.item, mine, ...(lost ? { availability: "access_lost" as const, source: null } : {}), annotation: mine ? stored.item.annotation : null });
  }
  function mount(person: 0 | 1): MemoryFixtureSession {
    if (closed) throw new Error("Rehearsal closed");
    const ownerId = memoryFixturePeople[person]; let identity: CloudIdentity | null = { ownerId, epoch: ++epoch };
    const ownRows = () => rows.map(row => projection(row, ownerId)).filter((row): row is MemoryActivity => row !== null);
    // Real clients parse this in-memory transport; it is not SQL or provider evidence.
    const transport: typeof fetch = async (input, init) => {
      if (closed || !identity || init?.signal?.aborted) throw new Error("Rehearsal cancelled");
      const url = new URL(String(input));
      if (url.origin !== appOrigin || init?.method !== "POST" || new Headers(init.headers).get("authorization") !== "Bearer synthetic-memory-fixture") return denied();
      if (failure === "before") { failure = null; throw new Error("Synthetic offline"); }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const mutation = ["putChapter", "annotate", "deleteChapter"].includes(String(body.operation));
      let result: Response;
      try {
        if (url.pathname === "/api/memories") {
          if (body.operation === "browse") {
            const query = validateMemoryBrowse(body.query), bounds = memoryYearBounds(query.year, query.timeZone);
            if (query.chapterId && chapters.get(query.chapterId)?.ownerId !== ownerId) return denied();
            const all = ownRows().filter(row => memoryInstantMicros(row.occurredAt) >= memoryInstantMicros(bounds.start) && memoryInstantMicros(row.occurredAt) < memoryInstantMicros(bounds.end) && (!query.chapterId || row.mine && row.annotation?.chapterId === query.chapterId) && (!query.after || memoryAfter(row, query.after))).sort((a, b) => memoryAfter(a, b) ? 1 : -1);
            const items = all.slice(0, query.limit), last = items.at(-1);
            result = response({ version: 1, year: query.year, timeZone: query.timeZone, chapterId: query.chapterId, items, nextCursor: all.length > query.limit && last ? { id: last.id, occurredAt: last.occurredAt } : null });
          } else if (body.operation === "list") {
            const all = ownRows().filter(row => !body.after || row.id > String(body.after)).sort((a, b) => a.id.localeCompare(b.id)), items = all.slice(0, Number(body.limit ?? 20));
            result = response({ items, nextCursor: all.length > items.length ? items.at(-1)?.id ?? null : null });
          } else if (body.operation === "summary") {
            const year = Number(body.year), own = rows.filter(row => row.ownerId === ownerId && new Date(row.item.occurredAt).getUTCFullYear() === year);
            result = response({ year, timezone: "UTC", basis: "own_source_records", months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, total: own.filter(row => new Date(row.item.occurredAt).getUTCMonth() === i).length })), outsideCalendar: 0 });
          } else if (body.operation === "chapters") result = response({ chapters: [...chapters.values()].filter(value => value.ownerId === ownerId).map(value => value.chapter) });
          else if (body.operation === "putChapter") {
            const value = validateChapterInput(body.chapter), prior = chapters.get(value.id);
            if (prior && prior.ownerId !== ownerId) return denied();
            if ((prior?.chapter.revision ?? -1) !== value.expectedRevision) return conflict();
            if (!prior && [...chapters.values()].filter(value => value.ownerId === ownerId).length >= 100) return response({ error: "capacity" }, 409);
            const chapter = { id: value.id, title: value.title, revision: value.expectedRevision + 1, createdAt: prior?.chapter.createdAt ?? new Date().toISOString() }; chapters.set(value.id, { ownerId, chapter }); result = response(chapter);
          } else if (body.operation === "annotate") {
            const value = validateActivityAnnotation(body.annotation), stored = rows.find(row => row.item.id === value.id && row.ownerId === ownerId);
            if (!stored || value.chapterId && chapters.get(value.chapterId)?.ownerId !== ownerId) return denied();
            if (stored.item.annotation?.revision !== value.expectedRevision) return conflict();
            stored.item.annotation = { revision: value.expectedRevision + 1, chapterId: value.chapterId, occasion: value.occasion }; result = response(projection(stored, ownerId));
          } else if (body.operation === "deleteChapter") {
            const prior = chapters.get(String(body.id)); if (!prior || prior.ownerId !== ownerId) return denied();
            if (prior.chapter.revision !== body.expectedRevision) return conflict();
            if (rows.some(row => row.item.annotation?.chapterId === body.id)) return response({ error: "chapter_not_empty" }, 409);
            chapters.delete(String(body.id)); result = response({ deleted: true });
          } else return response({ error: "invalid_request" }, 400);
        } else if (/^\/api\/media\/strips\/[a-f0-9-]{36}\/read$/.test(url.pathname)) {
          const sourceId = url.pathname.split("/")[4], item = ownRows().find(row => row.source?.id === sourceId);
          if (!item) return denied();
          if (!["available", "archive_pending", "archived"].includes(item.availability)) return response({ error: "source_unavailable" }, 409);
          if (body.operation === "resolve") result = response({ version: 1, id: sourceId, availability: item.availability, bytesLimit: RETAINED_STRIP_LIMITS.bytes });
          else if (body.operation === "download") result = new Response(bytes.slice(), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", "Content-Length": String(bytes.length), "X-Strip-Version": "1", "X-Strip-Id": sourceId, "X-Strip-Availability": item.availability, "X-Strip-Width": String(image.width), "X-Strip-Height": String(image.height), "X-Strip-Sha256": sha256 } });
          else return response({ error: "invalid_request" }, 400);
        } else if (url.pathname === "/api/projects" && body.operation === "list") result = response({ projects: [], nextCursor: null });
        else if (url.pathname === "/api/projects" && body.operation === "capabilities") result = response({ enabled: true, version: 1, limits: CLOUD_PROJECT_LIMITS });
        else return denied();
      } catch { return response({ error: "invalid_request" }, 400); }
      if (mutation && result.ok && failure === "after") { failure = null; throw new Error("Synthetic acknowledgement lost"); }
      return result;
    };
    const options = { appOrigin, identity: () => identity, accessToken: async () => "synthetic-memory-fixture", fetch: transport };
    const runtime: MemoryRuntime = { activity: createActivityClient(options), retained: createRetainedStripClient(options), projects: createCloudProjectClient({ ...options, storageOrigin: "https://memory-fixture.invalid" }) };
    const session: MemoryFixtureSession = { ownerId, name: person ? "Bao" : "Alex", key: `${ownerId}:${epoch}`, runtime, close() { identity = null; runtime.activity.close(); runtime.retained.close(); runtime.projects.close(); sessions.delete(session); } }; sessions.add(session); return session;
  }
  return { mount, failNext(mode: "before" | "after") { failure = mode; },
    revokeAvailable() { for (const row of rows) if (row.item.source && ["available", "archive_pending", "archived"].includes(row.item.availability)) revoked.add(row.item.source.id); },
    unpair() { paired = false; }, close() { closed = true; for (const session of [...sessions]) session.close(); rows.length = 0; chapters.clear(); revoked.clear(); } };
}
