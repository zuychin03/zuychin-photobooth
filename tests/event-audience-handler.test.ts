import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { createEventAudienceClient } from "../lib/events/audience-client";
import { createEventPublicationHandler, type EventPublicationPorts } from "../lib/server/event-publication-requests";
import { createEventPublicationStore } from "../lib/server/event-publication-store";
import { EVENT_PUBLICATION_LIMITS } from "../lib/events/publication-contract";
import { EVENT_LIMITS } from "../lib/events/contract";

test("real audience client exchanges separate cookies and reads exact media through the production handler/store", async () => {
  const eventId = crypto.randomUUID(), submissionId = crypto.randomUUID(), sessionId = crypto.randomUUID(), appOrigin = "https://booth.example", storageOrigin = "https://storage.example", token = Buffer.alloc(32, 9).toString("base64url");
  const jpeg = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#bd7790" } }).jpeg().toBuffer(), sha256 = createHash("sha256").update(jpeg).digest("hex"), expiresAt = new Date(Date.now() + 86400000).toISOString();
  const env = { PB_EVENTS_ENABLED: "true", PB_PUBLIC_ORIGIN: appOrigin, PB_EVENT_TRANSPORT_SECRET: "test-publication-transport-secret-only", NEXT_PUBLIC_SUPABASE_URL: storageOrigin, SUPABASE_SERVICE_ROLE_KEY: "test-key", PB_EVENT_TRUSTED_IP_HEADER: "x-real-ip" };
  let allowed = true, expectedSession = sessionId, signed = 0, reports = 0;
  const store = createEventPublicationStore(env, { rpc: async (name, args) => {
    const ok = (data: unknown) => ({ data, error: null });
    if (name === "pb_event_publication_capabilities") return ok(EVENT_PUBLICATION_LIMITS);
    if (name === "pb_event_capabilities") return ok({ version: 1, ready: true, deploymentBytes: 250000000, allocatedBytes: 0, limits: EVENT_LIMITS });
    if (!allowed || args.p_hash !== createHash("sha256").update(token).digest("hex")) return { data: null, error: { message: "PB_EVENT_DENIED" } };
    if (args.p_session && args.p_session !== expectedSession) return { data: null, error: { message: "PB_EVENT_IDENTITY_CHANGED" } };
    const base = { version: 1, eventId, destination: args.p_destination, checkedAt: new Date().toISOString(), expiresAt };
    if (name === "pb_event_audience_session") return ok({ ...base, sessionId: expectedSession, eventTitle: "Private fixture" });
    if (name === "pb_event_audience_list") return ok({ ...base, eventTitle: "Private fixture", entries: [{ submissionId, revision: 2, createdAt: new Date().toISOString() }], nextCursor: null });
    if (name === "pb_event_audience_validate") return ok({ ...base, entries: [{ submissionId, revision: 2 }] });
    if (name === "pb_event_audience_access") return ok({ submissionId, revision: 2, bucket: "photobooth-events-v2", path: `${eventId}/${submissionId}/${args.p_variant}`, variant: args.p_variant, bytes: jpeg.length, mime: "image/jpeg", sha256, width: 12, height: 8, expiresAt, maxAgeSeconds: 300 });
    if (name === "pb_event_audience_report") { reports++; return ok({ version: 1, reportId: args.p_request, status: "open" }); }
    throw new Error(`Unexpected fixture RPC ${name}`);
  } });
  const ports: EventPublicationPorts = { authenticate: async () => { throw new Error("Audience must not authenticate an account"); }, stores: () => ({ publication: store, base: { transportReady: async () => {}, rate: async () => ({ allowed: true, retryAfterSeconds: 0 }) }, objects: { signRead: async descriptor => { signed++; return { signedUrl: `${storageOrigin}/storage/v1/object/sign/${descriptor.bucket}/${descriptor.path}?token=synthetic`, expiresAt: new Date(Date.now() + 290000).toISOString() }; } } }) };
  const handlers = { gallery: createEventPublicationHandler("gallery", ports, () => env), wall: createEventPublicationHandler("wall", ports, () => env) }, cookies = new Map<string, string>();
  const transport: typeof fetch = async (url, init) => {
    if (String(url).startsWith(storageOrigin)) return new Response(jpeg, { headers: { "content-type": "image/jpeg" } });
    const destination = new URL(String(url)).pathname.split("/")[4] as "gallery" | "wall", headers = new Headers(init?.headers); assert.equal(headers.has("authorization"), false); headers.set("origin", appOrigin); headers.set("x-real-ip", "127.0.0.1"); headers.set("cookie", [...cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    const response = await handlers[destination](new Request(String(url), { ...init, headers }), eventId), cookie = response.headers.get("set-cookie"); if (cookie) { const [key, value] = cookie.split(";")[0].split("="); cookies.set(key, value); } return response;
  };
  const gallery = createEventAudienceClient({ appOrigin, storageOrigin, eventId, destination: "gallery", fetch: transport, decode: async () => ({ width: 12, height: 8, close() {} }) }), wall = createEventAudienceClient({ appOrigin, storageOrigin, eventId, destination: "wall", fetch: transport });
  try {
    await gallery.capabilities(); await gallery.exchange(token); assert(cookies.has("__Host-pb-event-gallery")); await assert.rejects(wall.session(), /access_denied/);
    await wall.exchange(token); assert(cookies.has("__Host-pb-event-display"));
    const entry = (await gallery.list()).entries[0]; assert.equal((await gallery.download(entry, "thumbnail")).size, jpeg.length); assert.equal(signed, 1);
    await gallery.report({ requestId: crypto.randomUUID(), submissionId, reason: "privacy", detail: "Please check." }); assert.equal(reports, 1);
    expectedSession = crypto.randomUUID(); await assert.rejects(gallery.list(), /identity_changed/);
    allowed = false; await assert.rejects(wall.list(), /access_denied/);
  } finally { gallery.close(); wall.close(); }
});
