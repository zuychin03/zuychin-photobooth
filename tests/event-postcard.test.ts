import assert from "node:assert/strict";
import test from "node:test";
import { createEventPostcardStore, EventPostcardError } from "../lib/server/event-postcard-store";
import { createEventPostcardHandler, type EventPostcardRequestPorts } from "../lib/server/event-postcard-requests";
import { EVENT_POSTCARD_LIMITS, parsePostcardProposal, parsePostcardView, type PostcardView } from "../lib/events/postcard-contract";
import { verifyEventActor, type VerifiedEventActor } from "../lib/server/event-store";
import { validateTemplateDesign } from "../lib/templates/model";
const id = (n: number) => `80000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const design = validateTemplateDesign({ canvas: { width: 536, height: 1600 }, requiredSources: { A: 1 }, slots: [{ id: "photo", role: "A", sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, crop: { zoom: 1, offsetX: 0, offsetY: 0, rotation: 0, mirror: false } }], layers: [], decorations: [], look: { frameId: "film", filterId: "none", patternId: "none", themeId: null, sceneId: null, materialId: null }, defaults: { caption: "Synthetic", showDate: false } });
const proposal = { postcardId: id(2), submissionId: id(3), source: { kind: "room" as const, id: id(4), captureId: id(5) }, design };
const snapshot = (): PostcardView => ({ version: 1, eventId: id(1), postcardId: id(2), submissionId: id(3), revision: 0, state: "draft", source: proposal.source, design, designHash: "a".repeat(64), expiresAt: new Date(Date.now() + 3600000).toISOString(), logicalExpiresAt: null, selfPrincipalId: id(6), canSubmit: true, selfConsent: { submission: false, gallery: false, wall: false }, participants: [{ principalId: id(6), role: "A", bound: true, consent: false, approved: false }], candidate: null });
test("postcard parsers reject hidden authority, wrong scopes and unbound approvals", () => {
  assert.deepEqual(parsePostcardProposal(proposal), proposal);
  assert.throws(() => parsePostcardProposal({ ...proposal, actor: id(8) }));
  assert.throws(() => parsePostcardProposal({ ...proposal, source: { ...proposal.source, url: "https://foreign.invalid" } }));
  assert.throws(() => parsePostcardView(snapshot(), id(9), id(2)));
  assert.equal(parsePostcardView({ ...snapshot(), canSubmit: false }, id(1), id(2)).canSubmit, false);
  assert.throws(() => parsePostcardView({ ...snapshot(), canSubmit: undefined }, id(1), id(2)));
  assert.throws(() => parsePostcardView({ ...snapshot(), canSubmit: "true" }, id(1), id(2)));
  const current = snapshot(); current.participants[0].approved = true; assert.throws(() => parsePostcardView(current, id(1), id(2)));
});
test("postcard service refuses forged account authority and incompatible schema before mutation", async () => {
  const calls: string[] = [], store = createEventPostcardStore({ rpc: async name => { calls.push(name); return { data: { ...EVENT_POSTCARD_LIMITS, version: 2 }, error: null }; } });
  await assert.rejects(store.attach(id(1), "b".repeat(64), { ...proposal, source: { kind: "challenge", id: id(4) } }, { actor: { id: id(8) } as VerifiedEventActor }), /access_denied/);
  assert.equal(calls.length, 0);
  await assert.rejects(store.ticket(id(1), "b".repeat(64), id(7), id(2), id(8), "c".repeat(64)), /unavailable/);
  assert.deepEqual(calls, ["pb_event_postcard_capabilities"]);
});
function fixture() {
  const calls: string[] = [], view = snapshot(), token = "A".repeat(43);
  const methods = {
    capabilities: async () => { calls.push("capabilities"); return EVENT_POSTCARD_LIMITS; },
    ticket: async () => { calls.push("ticket"); return { postcardId: id(2), expiresAt: new Date(Date.now() + 300000).toISOString() }; },
    proposal: async () => { calls.push("proposal"); return { eventId: id(1), proposal }; },
    attach: async () => { calls.push("attach"); return view; }, view: async () => view,
    consent: async () => { calls.push("consent"); return view; }, reserve: async () => { throw new Error("Unused"); },
    approve: async () => { calls.push("approve"); return view; },
    candidate: async () => ({ revision: 1 as const, sha256: "d".repeat(64), bytes: 100, width: 40, height: 30, mime: "image/jpeg" as const, submissionId: id(3), bucket: "photobooth-events-v2" as const, path: `${id(1)}/${id(3)}/image`, expiresAt: new Date(Date.now() + 300000).toISOString(), maxAgeSeconds: 300 }),
  };
  const ports: EventPostcardRequestPorts = { open: () => ({ postcards: methods, events: { transportReady: async () => {}, rate: async () => ({ allowed: true, retryAfterSeconds: 0 }) }, objects: { signRead: async (_access, expiresAt) => { calls.push("sign"); return { signedUrl: "https://synthetic.invalid/private", expiresAt }; } } }), authenticate: () => verifyEventActor({ getUser: async () => ({ data: { user: { id: id(8) } }, error: null }) }) };
  const env = { NODE_ENV: "development", PB_EVENTS_ENABLED: "true", PB_ROOM_V2_ENABLED: "true", PB_CLOUD_PROJECTS_ENABLED: "true", PB_CHALLENGES_ENABLED: "true", PB_EVENT_TRANSPORT_SECRET: "synthetic-test-secret-never-deployed" };
  const request = (body: object, cookie = `pb-event-contribute=${token}`) => new Request("http://localhost/api/events/x/postcards", { method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
  return { calls, ports, env, request, methods, token };
}
test("postcard handlers deny disabled, forged principal fields and wrong cookie kind without mutations", async () => {
  const f = fixture(), value = { operation: "ticket", expectedGuestId: id(7), postcardId: id(2), requestId: id(8) };
  const disabled = createEventPostcardHandler("event", f.ports, () => ({ ...f.env, PB_EVENTS_ENABLED: "false" }));
  assert.equal((await disabled(f.request(value), id(1))).status, 503); assert.equal(f.calls.length, 0);
  const handle = createEventPostcardHandler("event", f.ports, () => f.env);
  assert.equal((await handle(f.request({ ...value, actor: id(9) }), id(1))).status, 400);
  assert.equal((await handle(f.request(value, `pb-event-receipt=${f.token}`), id(1))).status, 403);
  assert.equal((await handle(f.request(value, `pb-event-contribute=${f.token};pb-event-contribute=${f.token}`), id(1))).status, 403);
  assert.equal(f.calls.length, 0);
  const response = await handle(f.request(value), id(1)); assert.equal(response.status, 200); assert.match(response.headers.get("cache-control")!, /no-store/); assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const data = await response.json(); assert.equal(data.postcardId, id(2)); assert.match(data.ticket, /^[A-Za-z0-9_-]{43}$/);
});
test("source attachment requires its room-scoped cookie and exact source route", async () => {
  const f = fixture(), handle = createEventPostcardHandler("room", f.ports, () => f.env), body = { operation: "attach", eventId: id(1), ticket: f.token, proposal };
  assert.equal((await handle(f.request(body), id(4))).status, 403);
  assert.equal((await handle(f.request(body, `pb-room-${id(4)}=${f.token}`), id(9))).status, 400);
  assert.equal((await handle(f.request(body, `pb-room-${id(4)}=${f.token}`), id(4))).status, 200); assert.deepEqual(f.calls, ["attach"]);
});
test("proposal discovery authenticates the source rather than accepting an event guest cookie", async () => {
  const f = fixture(), handle = createEventPostcardHandler("room", f.ports, () => f.env), body = { operation: "proposal", postcardId: id(2), source: proposal.source };
  assert.equal((await handle(f.request(body), id(4))).status, 403);
  assert.equal((await handle(f.request({ ...body, actor: id(8) }, `pb-room-${id(4)}=${f.token}`), id(4))).status, 400);
  const response = await handle(f.request(body, `pb-room-${id(4)}=${f.token}`), id(4)); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { eventId: id(1), proposal }); assert.deepEqual(f.calls, ["proposal"]);
});
test("fragmented oversized input and aborted reads cannot reach postcard operations", async () => {
  const f = fixture(), handle = createEventPostcardHandler("event", f.ports, () => f.env);
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < 129; i++) controller.enqueue(new Uint8Array([32])); controller.close(); } });
  const request = new Request("http://localhost/api/events/x/postcards", { method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
  assert.equal((await handle(request, id(1))).status, 413);
  const abort = new AbortController(); abort.abort();
  const cancelled = new Request(f.request({ operation: "capabilities" }), { signal: abort.signal });
  assert.equal((await handle(cancelled, id(1))).status, 503); assert.equal(f.calls.length, 0);
});
test("candidate link is suppressed when withdrawal wins during provider signing", async () => {
  const f = fixture(), read = f.methods.candidate; let checks = 0;
  f.methods.candidate = async () => { if (++checks > 1) throw new EventPostcardError("access_denied", 403); return read(); };
  const response = await createEventPostcardHandler("event", f.ports, () => f.env)(f.request({ operation: "candidate", expectedGuestId: id(7), postcardId: id(2) }), id(1));
  assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: "access_denied" }); assert.deepEqual(f.calls, ["sign"]);
});

test("postcard RPC dates normalise for strict views, tickets, receipts and candidates", async () => {
 const expiry = "2099-01-01T00:00:00.000Z", offset = "2099-01-01T10:30:00+10:30", hash = "b".repeat(64);
 const expected = { ...snapshot(), expiresAt: expiry };
 let value: unknown = { ...expected, expiresAt: offset };
 const store = createEventPostcardStore({ rpc: async name => ({ data: name === "pb_event_postcard_capabilities" ? EVENT_POSTCARD_LIMITS : value, error: null }) });
 assert.deepEqual(parsePostcardView(await store.view(id(1),hash,id(7),id(2)),id(1),id(2)), expected);
 value = { postcardId: id(2), expiresAt: offset }; assert.equal((await store.ticket(id(1),hash,id(7),id(2),id(8),hash)).expiresAt,expiry);
 value = { submissionId:id(3),state:"reserved",logicalExpiresAt:offset,eventExpiresAt:offset,gallery:"private",wall:"private",stagingPath:id(1)+"/"+id(3)+"/source",stagingHeldBytes:2000000,derivativeHeldBytes:2100000 };
 assert.equal((await store.reserve(id(1),hash,id(7),id(2),id(8),hash)).logicalExpiresAt,expiry);
 value = { revision:1,sha256:"d".repeat(64),bytes:100,width:40,height:30,mime:"image/jpeg",submissionId:id(3),bucket:"photobooth-events-v2",path:id(1)+"/"+id(3)+"/image",expiresAt:offset,maxAgeSeconds:300 };
 assert.equal((await store.candidate(id(1),hash,id(7),id(2))).expiresAt,expiry);
 for(const bad of [{...expected,expiresAt:null},{...expected,logicalExpiresAt:7},{...expected,extra:true}]) {value=bad;await assert.rejects(store.view(id(1),hash,id(7),id(2)),/unavailable/);}
});
