import { EVENT_MISSIONS, type EventMissionSettings, type EventGuestbookNote } from "./guestbook-contract";
import { prepareEventMissionEdit } from "./mission-edit";
import { createEventReminderClient } from "./reminder-client";
import { createEventReviewClient, type EventReviewClientOptions } from "./review-client";
import { createEventReviewFixture } from "./review-fixture";
import { createEventHostClient, type EventHostIdentity, type EventPublicEvent } from "./client";
import { EVENT_LIMITS, type EventReceipt } from "./contract";
import { DEFAULT_EVENT_LOOK, validateEventLook, type EventSettingsInput } from "./host-contract";
import { createEventModerationClient } from "./moderation-client";
import { EVENT_PUBLICATION_LIMITS, type EventModerationEntry, type EventReportEntry } from "./publication-contract";

const id = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const EVENT_FIXTURE_PEOPLE = [{ id: id(1), name: "Alex" }, { id: id(2), name: "Bao" }, { id: id(3), name: "Casey" }] as const;
interface Entry { event: EventPublicEvent; ownerId: string; moderators: Map<string, "active" | "invited" | "revoked">; look: EventSettingsInput["look"]; revision: number; locked: boolean; creation: string; receipts: Map<string, string>; invites: Map<string, { token: string; expiresAt: string; fingerprint: string; revoked: boolean }>; submissions: EventReceipt[] }
export function createEventHostUIFixture(appOrigin: string, options: { decode?: EventReviewClientOptions["decode"] } = {}) {
  if (process.env.NODE_ENV !== "development") throw new Error("Development fixture unavailable");
  const missions = new Map<string, EventMissionSettings>(), guestbook = new Map<string, EventGuestbookNote>();
  const reminderPrefs = new Map<string, { revision: number; email: boolean; push: boolean }>();
  let reminderClient: ReturnType<typeof createEventReminderClient> | undefined;
  let reviewClient: ReturnType<typeof createEventReviewClient> | undefined;
  let moderationClient: ReturnType<typeof createEventModerationClient> | undefined;
  const publications = new Map<string, EventModerationEntry>(), approvals = new Map<string, { actor: string; fingerprint: string }>(), reports = new Map<string, EventReportEntry & { actor: string; requestId: string; fingerprint: string }>();
  let channelsAvailable = true;
  const events = new Map<string, Entry>(), logs: string[] = [];
  let identity: EventHostIdentity | null = null, epoch = 0, current: ReturnType<typeof createEventHostClient> | null = null, loseNext = false, compatible = true, stopped = false;
  const review = createEventReviewFixture({ appOrigin, identity: () => identity, lookup: (eventId, actorId) => { const entry = events.get(eventId); return entry ? { event: entry.event, submissions: entry.submissions, authorised: entry.ownerId === actorId || entry.moderators.get(actorId) === "active" } : null; } });
  const seed = (ownerId: string, eventId: string, title: string) => {
    const now = Date.now(), event: EventPublicEvent = { eventId, title, status: "draft", timezone: "Australia/Sydney", startsAt: new Date(now - 3600000).toISOString(), closesAt: new Date(now + 86400000).toISOString(), expiresAt: new Date(now + 7 * 86400000).toISOString(), maxGuests: 25, maxContributions: 100, maxBytes: 250000000 };
    const { eventId: _id, status: _status, ...input } = event; void _id; void _status;
    events.set(eventId, { event, ownerId, moderators: new Map(), look: { ...DEFAULT_EVENT_LOOK }, revision: 0, locked: false, creation: JSON.stringify(input), receipts: new Map(), invites: new Map(), submissions: [] });
  };
  seed(EVENT_FIXTURE_PEOPLE[0].id, id(10), "Graduation afternoon"); seed(EVENT_FIXTURE_PEOPLE[2].id, id(20), "Casey’s private gathering");
  events.get(id(10))!.moderators.set(EVENT_FIXTURE_PEOPLE[1].id, "invited");
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  const denied = () => json({ error: "access_denied" }, 403);
  const config = (entry: Entry) => { const { eventId, status: _status, ...event } = entry.event; void _status; return { version: 1, eventId, revision: entry.revision, locked: entry.locked || entry.event.status === "deleted" || Date.parse(entry.event.expiresAt) <= Date.now(), event, look: entry.look }; };
  const transport: typeof fetch = async (url, init) => {
    if (stopped || !identity || init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const actor = identity.ownerId, capture = identity.epoch, path = new URL(String(url));
    if (path.pathname.endsWith("/review") || path.pathname.startsWith("/storage/v1/object/sign/photobooth-events-v2/")) return compatible ? review.fetch(url, init) : json({ error: "unavailable" }, 503);
    if (path.origin !== appOrigin || !/^\/api\/events(?:\/[0-9a-f-]{36}(?:\/(?:reminder|moderation))?)?$/.test(path.pathname)) return denied();
    await new Promise(resolve => setTimeout(resolve, 100));
    if (stopped || identity?.epoch !== capture || init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const b = JSON.parse(String(init?.body)), operation = String(b.operation), eventId = path.pathname.split("/")[3];
    logs.push(`Synthetic ${operation}`); if (logs.length > 20) logs.shift();
    const ack = (value: unknown) => { if (loseNext) { loseNext = false; return json({ error: "unavailable" }, 503); } return json(value); };
    if (path.pathname.endsWith("/moderation")) {
      const entry = events.get(eventId);
      if (!compatible) return json({ error: "unavailable" }, 503);
      if (!entry || entry.ownerId !== actor && entry.moderators.get(actor) !== "active" || entry.event.status === "deleted" || Date.parse(entry.event.expiresAt) <= Date.now()) return denied();
      if (operation === "capabilities") return json(EVENT_PUBLICATION_LIMITS);
      const entries = () => entry.submissions.flatMap(s => { const value = publications.get(s.submissionId); return value ? [{ ...value, state: s.state, gallery: s.gallery, wall: s.wall, thumbnailAvailable: s.state === "ready" }] : []; });
      const page = <T extends { submissionId: string }>(items: T[]) => items.filter(s => !b.after || s.submissionId > b.after).sort((a, z) => a.submissionId.localeCompare(z.submissionId));
      if (operation === "list") { const all = page(entries()), rows = all.slice(0, b.limit ?? 12); return json({ version: 1, eventId, entries: rows, nextCursor: all.length > rows.length ? rows.at(-1)!.submissionId : null }); }
      if (operation === "reports") { const all = [...reports.values()].filter(r => entry.submissions.some(s => s.submissionId === r.submissionId) && (!b.after || r.reportId > b.after)).sort((a, z) => a.reportId.localeCompare(z.reportId)), rows = all.slice(0, b.limit ?? 12).map(({ actor: _actor, requestId: _request, fingerprint: _fingerprint, ...r }) => { void _actor; void _request; void _fingerprint; return r; }); return json({ version: 1, eventId, entries: rows, nextCursor: all.length > rows.length ? rows.at(-1)!.reportId : null }); }
      if (operation === "resolve") { const report = reports.get(b.reportId); if (!report || !entry.submissions.some(s => s.submissionId === report.submissionId)) return denied(); report.status = "resolved"; return ack({ version: 1, reportId: report.reportId, status: report.status }); }
      const value = publications.get(b.submissionId), submission = entry.submissions.find(s => s.submissionId === b.submissionId); if (!value || !submission) return denied();
      if (operation === "report") {
        const fingerprint = JSON.stringify([b.submissionId, b.destination, b.reason, b.detail]), prior = [...reports.values()].find(r => r.actor === actor && r.requestId === b.requestId);
        if (prior) return prior.fingerprint === fingerprint ? ack({ version: 1, reportId: prior.reportId, status: prior.status }) : json({ error: "conflict" }, 409);
        if (submission.state !== "ready") return denied();
        if (reports.size >= 100) return json({ error: "capacity" }, 409);
        if ([...reports.values()].some(r => r.actor === actor && r.submissionId === b.submissionId && r.destination === b.destination)) return json({ error: "conflict" }, 409);
        const reportId = crypto.randomUUID(); reports.set(reportId, { version: 1, reportId, status: "open", submissionId: b.submissionId, destination: b.destination, reason: b.reason, detail: b.detail, createdAt: new Date().toISOString(), actor, requestId: b.requestId, fingerprint }); return ack({ version: 1, reportId, status: "open" });
      }
      if (operation === "decide") {
        const fingerprint = JSON.stringify([b.submissionId, b.destination, b.expectedRevision, b.state]), prior = approvals.get(b.requestId);
        if (prior) return prior.actor === actor && prior.fingerprint === fingerprint ? ack(entries().find(s => s.submissionId === b.submissionId)) : json({ error: "conflict" }, 409);
        if (b.expectedRevision !== value.revision) return json({ error: "conflict" }, 409);
        if (b.state === "approved" && (submission.state !== "ready" || !(b.destination === "gallery" ? value.galleryConsent : value.wallConsent))) return denied();
        if (b.state === "approved") approvals.set(b.requestId, { actor, fingerprint });
        if (b.destination === "gallery") { submission.gallery = b.state; value.gallery = b.state; } else { submission.wall = b.state; value.wall = b.state; }
        value.revision++; return ack(entries().find(s => s.submissionId === b.submissionId));
      }
      if (operation === "remove") { if (submission.state !== "deleted" && value.revision !== b.expectedRevision) return json({ error: "conflict" }, 409); if (submission.state !== "deleted") { submission.state = "deleted"; value.revision++; } return ack(entries().find(s => s.submissionId === b.submissionId)); }
      return json({ error: "invalid_request" }, 400);
    }
    if (operation === "capabilities") return json({ enabled: true, version: 1, transportVersion: 1, hostVersion: compatible ? 1 : 0, guestbookVersion: compatible ? 1 : 0, limits: EVENT_LIMITS, uploadsAvailable: false, downloadsAvailable: false });
    if (!compatible) return json({ error: "unavailable" }, 503);
    if (operation === "list") {
      const matches = [...events.values()].filter(e => (e.ownerId === actor || ["active", "invited"].includes(e.moderators.get(actor) ?? "")) && (!b.after || e.event.eventId > b.after)).sort((a, z) => a.event.eventId.localeCompare(z.event.eventId)), limit = Math.min(25, b.limit ?? 25), page = matches.slice(0, limit);
      return json({ version: 1, events: page.map(e => { const { maxBytes: _b, maxGuests: _g, maxContributions: _c, ...event } = e.event; void _b; void _g; void _c; return { ...event, role: e.ownerId === actor ? "owner" : "moderator", membership: e.ownerId === actor ? "active" : e.moderators.get(actor) }; }), nextCursor: matches.length > limit ? page.at(-1)!.event.eventId : null });
    }
    if (operation === "create") {
      const old = events.get(b.eventId);
      if (old) return old.ownerId === actor && old.creation === JSON.stringify(b.event) ? ack(old.event) : json({ error: "conflict" }, 409);
      if (events.size >= 20) return json({ error: "capacity" }, 409);
      seed(actor, b.eventId, b.event.title); const entry = events.get(b.eventId)!; entry.event = { ...b.event, eventId: b.eventId, status: "draft" }; entry.creation = JSON.stringify(b.event); return ack(entry.event);
    }
    const entry = events.get(eventId); if (!entry) return denied();
    if (path.pathname.endsWith("/reminder")) {
      if (entry.ownerId !== actor) return denied();
      const prefs = reminderPrefs.get(eventId) ?? { revision: 0, email: false, push: false };
      if (operation === "save") {
        if (entry.event.status === "deleted" || Date.parse(entry.event.expiresAt) <= Date.now()) return json({ error: "expired" }, 410);
        if (prefs.revision !== b.expectedRevision && !(prefs.revision === b.expectedRevision + 1 && prefs.email === b.email && prefs.push === b.push)) return json({ error: "conflict" }, 409);
        if (prefs.email !== b.email || prefs.push !== b.push) { prefs.revision++; prefs.email = b.email; prefs.push = b.push; }
        reminderPrefs.set(eventId, prefs);
      } else if (operation !== "read") return json({ error: "invalid_request" }, 400);
      const result = { settings: { version: 1, eventId, ...prefs, expiresAt: entry.event.expiresAt, scheduledAt: new Date(Date.parse(entry.event.expiresAt) - 86400000).toISOString(), status: "idle", emailAvailable: channelsAvailable, pushAvailable: channelsAvailable }, configured: { email: true, push: true } };
      return operation === "save" ? ack(result) : json(result);
    }
    if (operation === "manage" && b.action === "accept_moderator") { if (entry.moderators.get(actor) !== "invited") return denied(); entry.moderators.set(actor, "active"); return ack({ accepted: true }); }
    if (entry.ownerId !== actor && entry.moderators.get(actor) !== "active") return denied();
    if (["missions", "saveMissions", "guestbook"].includes(operation)) {
      if (entry.event.status === "deleted" || Date.parse(entry.event.expiresAt) <= Date.now()) return denied();
      const settings = missions.get(eventId) ?? { version: 1 as const, eventId, revision: 0, missionIds: [], endsAt: entry.event.closesAt, locked: entry.locked };
      settings.locked = entry.locked;
      if (operation === "missions") return json(settings);
      if (operation === "saveMissions") {
        if (entry.ownerId !== actor) return denied();
        const same = JSON.stringify(settings.missionIds) === JSON.stringify(b.missionIds) && settings.endsAt === b.endsAt;
        if (!same) { if (entry.locked || settings.revision !== b.expectedRevision) return json({ error: "conflict" }, 409); try { prepareEventMissionEdit(settings, b.missionIds, b.endsAt, entry.event); } catch { return json({ error: "invalid_request" }, 400); } settings.missionIds = [...b.missionIds]; settings.endsAt = b.endsAt; settings.revision++; }
        else if (![b.expectedRevision, b.expectedRevision + 1].includes(settings.revision)) return json({ error: "conflict" }, 409);
        missions.set(eventId, settings); return ack(settings);
      }
      const all = entry.submissions.filter(item => !b.after || item.submissionId > b.after).sort((a, z) => a.submissionId.localeCompare(z.submissionId)), rows = all.slice(0, b.limit ?? 25).map(item => { const unavailable = ["deleted", "expired", "failed"].includes(item.state), note = guestbook.get(item.submissionId) ?? { version: 1, eventId, submissionId: item.submissionId, revision: 0, message: "", signature: "", withdrawn: false, mission: null, missionCompleted: false }; return { submissionId: item.submissionId, unavailable, note: unavailable ? null : note }; });
      return json({ version: 1, entries: rows, nextCursor: all.length > rows.length ? rows.at(-1)!.submissionId : null });
    }
    if (operation === "settings") return json(config(entry));
    if (operation === "dashboard") { const items = entry.submissions.filter(item => !b.after || item.submissionId > b.after).slice(0, b.limit ?? 25); return json({ event: entry.event, submissions: items, usage: { guests: entry.submissions.length, count: entry.submissions.length, bytes: entry.submissions.length * 4100000, stagingBytes: entry.submissions.length * 2000000, derivativeBytes: entry.submissions.length * 2100000 } }); }
    if (entry.ownerId !== actor) return denied();
    if (operation === "saveSettings") {
      const fingerprint = JSON.stringify([b.expectedRevision, b.settings]), prior = entry.receipts.get(b.requestId);
      if (prior) return prior === fingerprint ? ack(config(entry)) : json({ error: "conflict" }, 409);
      if (entry.revision !== b.expectedRevision || entry.locked && JSON.stringify(entry.look) !== JSON.stringify(b.settings.look)) return json({ error: "conflict" }, 409);
      if (entry.receipts.size >= 64) return json({ error: "capacity" }, 409);
      entry.look = validateEventLook(b.settings.look); entry.event = { ...entry.event, ...b.settings.event }; entry.revision++; entry.receipts.set(b.requestId, fingerprint); return ack(config(entry));
    }
    if (operation === "manage") {
      if (["open", "pause", "close", "delete"].includes(b.action)) entry.event.status = ({ open: "open", pause: "paused", close: "closed", delete: "deleted" } as const)[b.action as "open" | "pause" | "close" | "delete"];
      else if (["invite_moderator", "revoke_moderator"].includes(b.action)) entry.moderators.set(b.body.userId, b.action === "invite_moderator" ? entry.moderators.get(b.body.userId) === "active" ? "active" : "invited" : "revoked");
      else return json({ error: "invalid_request" }, 400);
      return ack(entry.event);
    }
    if (operation === "issue") {
      const fingerprint = JSON.stringify([b.kind, b.expiresAt, b.rotate]), previous = entry.invites.get(b.requestId);
      if (previous && previous.fingerprint !== fingerprint) return json({ error: "conflict" }, 409);
      if (!previous) {
        if (b.rotate) entry.invites.forEach(invite => { invite.revoked = true; });
        const bytes = crypto.getRandomValues(new Uint8Array(32)), token = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
        entry.invites.set(b.requestId, { token, fingerprint, expiresAt: b.expiresAt, revoked: false });
      }
      const invite = entry.invites.get(b.requestId)!; return ack({ kind: b.kind, token: invite.token, expiresAt: invite.expiresAt, fragmentOnly: true });
    }
    if (operation === "revokeToken") { for (const invite of entry.invites.values()) if (invite.token === b.token) invite.revoked = true; return ack(entry.event); }
    return json({ error: "invalid_request" }, 400);
  };
  return {
    people: EVENT_FIXTURE_PEOPLE, logs,
    mount(index: number) { current?.close(); reminderClient?.close(); reviewClient?.close(); moderationClient?.close(); const person = EVENT_FIXTURE_PEOPLE[index]; if (!person || stopped) throw new Error("Synthetic account unavailable"); identity = { ownerId: person.id, epoch: ++epoch }; current = createEventHostClient({ appOrigin, identity: () => identity, accessToken: async () => "synthetic-not-a-credential", fetch: transport }); reminderClient = createEventReminderClient({ appOrigin, identity: () => identity, accessToken: async () => "synthetic-not-a-credential", fetch: transport }); reviewClient = createEventReviewClient({ appOrigin, storageOrigin: appOrigin, identity: () => identity, accessToken: async () => "synthetic-not-a-credential", fetch: transport, decode: options.decode }); moderationClient = createEventModerationClient({ appOrigin, identity: () => identity, accessToken: async () => "synthetic-not-a-credential", fetch: transport }); return current; },
    get reminderClient() { return reminderClient; },
    get reviewClient() { return reviewClient; },
    get moderationClient() { return moderationClient; },
    reminderTargets(value: boolean) { channelsAvailable = value; },
    loseNextAcknowledgement() { loseNext = true; },
    editElsewhere() { const entry = events.get(id(10))!; entry.event.title = "Graduation afternoon, updated elsewhere"; entry.revision++; },
    acceptContribution() { const entry = events.get(id(10))!; entry.locked = true; if (!entry.submissions.length) entry.submissions.push({ submissionId: id(100), state: "failed", logicalExpiresAt: entry.event.closesAt, eventExpiresAt: entry.event.expiresAt, gallery: "private", wall: "private" }); },
    async seedReadyContribution(blob?: Blob) { const entry = events.get(id(10))!; await review.seed(id(101), blob); if (stopped) throw new Error("Fixture closed"); entry.locked = true; const value: EventReceipt = { submissionId: id(101), state: "ready", logicalExpiresAt: entry.event.closesAt, eventExpiresAt: entry.event.expiresAt, gallery: "private", wall: "private" }, old = entry.submissions.findIndex(s => s.submissionId === id(101)); if (old === -1) entry.submissions.push(value); else entry.submissions[old] = value; },
    withdrawReadyContribution() { const item = events.get(id(10))?.submissions.find(s => s.submissionId === id(101)); if (item) item.state = "deleted"; },
    async seedPublicationChoices(blob?: Blob) {
      const entry = events.get(id(10))!;
      for (let n = 0; n < 4; n++) {
        const submissionId = id(110 + n); await review.seed(submissionId, blob); if (stopped) throw new Error("Fixture closed");
        const galleryConsent = Boolean(n & 1), wallConsent = Boolean(n & 2);
        if (publications.has(submissionId)) continue;
        const value: EventModerationEntry = { submissionId, revision: 0, createdAt: entry.event.startsAt, state: "ready", gallery: galleryConsent ? "awaiting_approval" : "private", wall: wallConsent ? "awaiting_approval" : "private", galleryConsent, wallConsent, thumbnailAvailable: true };
        publications.set(submissionId, value); entry.submissions.push({ submissionId, state: "ready", logicalExpiresAt: entry.event.closesAt, eventExpiresAt: entry.event.expiresAt, gallery: value.gallery, wall: value.wall }); entry.locked = true;
      }
    },
    changePublicationConsent(allowed: boolean) { const value = publications.get(id(113)), submission = events.get(id(10))?.submissions.find(s => s.submissionId === id(113)); if (!value || !submission) return; value.galleryConsent = allowed; value.gallery = allowed ? "awaiting_approval" : "private"; submission.gallery = value.gallery; value.revision++; },
    seedGuestbook() { const entry = events.get(id(10))!; entry.locked = true; for (let n = 0; n < 26; n++) { const submissionId = id(200 + n); if (!entry.submissions.some(item => item.submissionId === submissionId)) entry.submissions.push({ submissionId, state: "ready", logicalExpiresAt: entry.event.closesAt, eventExpiresAt: entry.event.expiresAt, gallery: "private", wall: "private" }); guestbook.set(submissionId, { version: 1, eventId: id(10), submissionId, revision: 1, message: n === 0 ? "A lovely gathering. Thank you for having us!" : `Private note ${n + 1}`, signature: `Synthetic guest ${n + 1}`, withdrawn: false, mission: n === 0 ? EVENT_MISSIONS[0] : null, missionCompleted: n === 0 }); } },
    withdrawGuestbook() { const note = guestbook.get(id(200)); if (note) { note.message = note.signature = ""; note.withdrawn = true; note.revision++; } },
    expireSeededEvent() { events.get(id(10))!.event.expiresAt = new Date(Date.now() - 1000).toISOString(); },
    oldServer(value: boolean) { compatible = !value; },
    revokeAccess() { identity = null; current?.close(); reminderClient?.close(); reviewClient?.close(); moderationClient?.close(); },
    close() { stopped = true; identity = null; current?.close(); reminderClient?.close(); reviewClient?.close(); moderationClient?.close(); review.close(); reminderPrefs.clear(); missions.clear(); guestbook.clear(); publications.clear(); approvals.clear(); reports.clear(); events.clear(); logs.length = 0; },
  };
}
