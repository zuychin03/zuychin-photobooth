import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_PUBLICATION_LIMITS, parseEventAudienceAccess, parseEventAudiencePage, parseEventAudienceSession, parseEventAudienceValidation, type EventAudienceAccess } from "../lib/events/publication-contract";
import { createEventPublicationStore, EventPublicationError } from "../lib/server/event-publication-store";
import { createEventPublicationHandler, type EventPublicationPorts } from "../lib/server/event-publication-requests";
import { verifyEventActor } from "../lib/server/event-store";
import { EVENT_LIMITS } from "../lib/events/contract";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`, eventId = id(1), submissionId = id(2), sessionId = id(3), ownerId = id(4);
const now = "2026-09-23T00:00:00.000Z", expiresAt = "2099-01-01T00:00:00.000Z", token = Buffer.alloc(32,1).toString("base64url");
const session = { version: 1 as const, eventId, destination: "gallery" as const, sessionId, eventTitle: "Synthetic event", checkedAt: now, expiresAt };
const entry = { submissionId, revision: 4, createdAt: now }, page = { version: 1 as const, eventId, destination: "gallery" as const, eventTitle: session.eventTitle, checkedAt: now, expiresAt, entries: [entry], nextCursor: null };
const access: EventAudienceAccess = { submissionId, revision: 4, bucket: "photobooth-events-v2", path: `${eventId}/${submissionId}/thumbnail`, variant: "thumbnail", bytes: 100, mime: "image/jpeg", sha256: null, width: null, height: null, expiresAt, maxAgeSeconds: 300 };
const env = { PB_EVENTS_ENABLED: "true", PB_PUBLIC_ORIGIN: "https://app.example", PB_EVENT_TRANSPORT_SECRET: "publication-synthetic-transport-secret", NEXT_PUBLIC_SUPABASE_URL: "https://storage.example", SUPABASE_SERVICE_ROLE_KEY: "synthetic", PB_EVENT_TRUSTED_IP_HEADER: "x-real-ip" };
const actor = () => verifyEventActor({ getUser: async () => ({ data: { user: { id: ownerId } }, error: null }) });
const request = (body: unknown, headers: Record<string,string> = {}) => new Request(`https://app.example/api/events/${eventId}/gallery`, { method: "POST", headers: { Origin: "https://app.example", "Content-Type": "application/json", "x-real-ip": "127.0.0.1", Cookie: `__Host-pb-event-gallery=${token}`, ...headers }, body: JSON.stringify(body) });
function fixture() {
  let allowed = true, rateAllowed = true, revision = 4, schema = true, count = 0;
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const store = createEventPublicationStore(env, { rpc: async (name, args) => {
    calls.push({ name, args });
    if (name === "pb_event_publication_capabilities") return { data: { ...EVENT_PUBLICATION_LIMITS, publicationVersion: schema ? 1 : 0 }, error: null };
    if (name === "pb_event_capabilities") return { data: { version: 1, ready: true, deploymentBytes: 250000000, allocatedBytes: 0, limits: EVENT_LIMITS }, error: null };
    if (!allowed) return { data: null, error: { message: "PB_EVENT_DENIED" } };
    if (args.p_session !== undefined && args.p_session !== sessionId) return { data: null, error: { message: "PB_EVENT_IDENTITY_CHANGED" } };
    if (name === "pb_event_audience_session") return { data: { ...session, destination: args.p_destination }, error: null };
    if (name === "pb_event_audience_access") return { data: { ...access, revision }, error: null };
    if (name === "pb_event_audience_list") return { data: page, error: null };
    if (name === "pb_event_audience_validate") return { data: { version: 1, eventId, destination: "gallery", checkedAt: now, expiresAt, entries: [{ submissionId, revision }] }, error: null };
    return { data: { version: 1, reportId: id(9), status: "open" }, error: null };
  } });
  const ports: EventPublicationPorts = { authenticate: actor, stores: () => ({ publication: store, base: { transportReady: async () => {}, rate: async () => { count++; return { allowed: rateAllowed, retryAfterSeconds: 7 }; } }, objects: { signRead: async () => ({ signedUrl: "https://storage.example/synthetic-private", expiresAt: new Date(Date.now()+100000).toISOString() }) } }) };
  return { store, ports, calls, deny: () => { allowed = false; }, limit: () => { rateAllowed = false; }, change: () => { revision++; }, oldSchema: () => { schema = false; }, get count() { return count; } };
}
test("audience parsers reject foreign context, overlarge batches, extra private fields and incomplete originals", () => {
  assert.deepEqual(parseEventAudienceSession(session,eventId,"gallery"),session); assert.deepEqual(parseEventAudiencePage(page,eventId,"gallery"),page); assert.deepEqual(parseEventAudienceAccess(access,eventId,submissionId,"thumbnail"),access);
  for(const bad of [{...page,eventId:id(8)},{...page,destination:"wall"},{...page,token},{...page,entries:[entry,entry]},{...page,nextCursor:submissionId}]) assert.throws(()=>parseEventAudiencePage(bad,eventId,"gallery"));
  assert.throws(()=>parseEventAudienceAccess({...access,path:`${eventId}/${submissionId}/image`},eventId,submissionId,"thumbnail"));
  assert.throws(()=>parseEventAudienceAccess({...access,path:`${eventId}/${submissionId}/image`,variant:"image"},eventId,submissionId,"image"));
  assert.throws(()=>parseEventAudienceValidation({version:1,eventId,destination:"gallery",checkedAt:now,expiresAt,entries:[{submissionId:id(8),revision:1}]},eventId,"gallery",[submissionId]));
});
test("publication store fails closed for missing marker, spoofed actors and replaced audience identity", async () => {
  const f=fixture(); assert.deepEqual(await f.store.session(eventId,"a".repeat(64),"gallery"),session);
  await assert.rejects(f.store.moderation({id:ownerId} as Awaited<ReturnType<typeof actor>>,eventId),/access_denied/);
  await assert.rejects(f.store.list(eventId,"a".repeat(64),"gallery",id(8)),/identity_changed/);
  f.oldSchema(); await assert.rejects(f.store.list(eventId,"a".repeat(64),"gallery",sessionId),/unavailable/);
  assert(!f.calls.some(c=>c.name.includes("worker")));
});
test("audience exchange sets bounded separate private cookies and never accepts contribution cookies", async () => {
  const f=fixture(), gallery=createEventPublicationHandler("gallery",f.ports,()=>env), wall=createEventPublicationHandler("wall",f.ports,()=>env);
  const response=await gallery(request({operation:"exchange",token},{Cookie:""}),eventId); assert.equal(response.status,200); assert.match(response.headers.get("set-cookie")!,/^__Host-pb-event-gallery=/); assert.match(response.headers.get("set-cookie")!,/HttpOnly; SameSite=Strict; Secure/); assert.match(response.headers.get("cache-control")!,/no-store/); assert.equal(response.headers.get("referrer-policy"),"no-referrer");
  const wallResponse=await wall(request({operation:"exchange",token},{Cookie:""}),eventId); assert.match(wallResponse.headers.get("set-cookie")!,/^__Host-pb-event-display=/);
  assert.equal((await gallery(request({operation:"session"},{Cookie:`__Host-pb-event-contribute=${token}`}),eventId)).status,403);
  assert.equal((await wall(request({operation:"session"}),eventId)).status,403);
  assert.equal((await gallery(request({operation:"session"},{Cookie:`__Host-pb-event-gallery=${token}; __Host-pb-event-gallery=${token}`}),eventId)).status,403);
});
test("audience HTTP denies forged origin, extra authority, missing identity and wall originals before mint", async () => {
  const f=fixture(), gallery=createEventPublicationHandler("gallery",f.ports,()=>env), wall=createEventPublicationHandler("wall",f.ports,()=>env);
  assert.equal((await gallery(request({operation:"list",expectedSessionId:sessionId},{Origin:"https://foreign.example"}),eventId)).status,403);
  assert.equal((await gallery(request({operation:"list",expectedSessionId:sessionId,actor:ownerId}),eventId)).status,400);
  assert.equal((await gallery(request({operation:"list"}),eventId)).status,400);
  assert.equal((await wall(request({operation:"media",expectedSessionId:sessionId,submissionId,variant:"image"},{Cookie:`__Host-pb-event-display=${token}`}),eventId)).status,400);
  assert.equal((await gallery(request({operation:"validate",expectedSessionId:sessionId,submissionIds:Array(13).fill(submissionId)}),eventId)).status,400);
  assert.equal((await gallery(request({operation:"list",expectedSessionId:sessionId}),eventId)).status,200);
});
test("revocation or revision change during signing never publishes a stale link", async () => {
  for(const change of ["deny","change"] as const) { const f=fixture(), original=f.ports.stores; f.ports.stores=(...args)=>{const p=original(...args);p.objects.signRead=async()=>{f[change]();return{signedUrl:"secret-link",expiresAt:new Date(Date.now()+100000).toISOString()};};return p;}; const handler=createEventPublicationHandler("gallery",f.ports,()=>env), response=await handler(request({operation:"media",expectedSessionId:sessionId,submissionId,variant:"thumbnail"}),eventId); assert.equal(response.status,403); assert(!JSON.stringify(await response.json()).includes("secret-link")); }
});
test("disabled and rate-limited requests perform no privileged audience operation", async () => {
  const f=fixture(); const disabled=createEventPublicationHandler("gallery",f.ports,()=>({})); assert.equal((await disabled(request({operation:"exchange",token}),eventId)).status,503); assert.equal(f.count,0);
  f.limit(); const limited=await createEventPublicationHandler("gallery",f.ports,()=>env)(request({operation:"list",expectedSessionId:sessionId}),eventId); assert.equal(limited.status,429); assert.equal(limited.headers.get("retry-after"),"7"); assert.equal(f.calls.length,0);
});
test("moderation requires authenticated authority and report payloads remain bounded", async () => {
  const f=fixture(), handler=createEventPublicationHandler("moderation",f.ports,()=>env);
  assert.equal((await handler(request({operation:"list"}),eventId)).status,401);
  assert.equal((await handler(request({operation:"report",submissionId,destination:"gallery",requestId:id(7),reason:"privacy",detail:"x".repeat(501)},{Authorization:"Bearer synthetic"}),eventId)).status,400);
  await assert.rejects(f.store.decide(await actor(),eventId,{submissionId,destination:"gallery",expectedRevision:4,state:"approved"}),/invalid_request/);
  const invalid={...access,bytes:2000001}; assert.throws(()=>parseEventAudienceAccess(invalid,eventId,submissionId,"thumbnail"));
  assert(new EventPublicationError("conflict",409) instanceof Error);
});

test("publication RPC offsets normalise freshness and nested creation dates", async () => {
 let value: unknown = { ...session, checkedAt: "2026-09-23T10:30:00+10:30", expiresAt: "2099-01-01T00:00:00+00:00" };
 const store = createEventPublicationStore(env, { rpc: async name => ({ data: name === "pb_event_publication_capabilities" ? EVENT_PUBLICATION_LIMITS : name === "pb_event_capabilities" ? { version: 1, ready: true, deploymentBytes: 250000000, allocatedBytes: 0, limits: EVENT_LIMITS } : value, error: null }) });
 const hash = "a".repeat(64);
 assert.deepEqual(parseEventAudienceSession(await store.session(eventId,hash,"gallery"),eventId,"gallery"),session);
 value = { ...page, checkedAt: "2026-09-23T00:00:00+00:00", expiresAt: "2099-01-01T00:00:00+00:00", entries: [{ ...entry, createdAt: "2026-09-23T10:30:00+10:30" }] };
 assert.deepEqual(parseEventAudiencePage(await store.list(eventId,hash,"gallery",sessionId),eventId,"gallery"),page);
 value = { ...access, expiresAt: "2099-01-01T10:30:00+10:30" }; assert.deepEqual(await store.access(eventId,hash,"gallery",sessionId,submissionId,"thumbnail"),access);
 for(const bad of [{ ...session, checkedAt: false },{ ...session, extra: true },{ ...session, expiresAt: "2099-02-30T00:00:00+00:00" }]) { value=bad; await assert.rejects(store.session(eventId,hash,"gallery"),/unavailable/); }
});
