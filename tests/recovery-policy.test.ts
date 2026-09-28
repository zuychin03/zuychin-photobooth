import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac } from "node:crypto";
import { recoveryOperationAllowed } from "../lib/recovery-policy";
import { createProjectHandler, type ProjectRequestPorts } from "../lib/server/project-requests";
import { createProjectDesignHandler } from "../lib/server/project-design-requests";
import { createEventHandler, type EventRequestPorts, type EventRoute } from "../lib/server/event-requests";
import { createEventExportHandler, type EventExportRequestPorts } from "../lib/server/event-export-requests";
import { createEventKioskHandler, type EventKioskRequestPorts } from "../lib/server/event-kiosk-requests";
import { EventStoreError, type EventStore } from "../lib/server/event-store";
import type { ProjectStore } from "../lib/server/project-store";
import type { ProjectDesignStore } from "../lib/server/project-design-store";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const env = { NODE_ENV: "production", PB_RELEASE_MODE: "recovery", PB_CLOUD_PROJECTS_ENABLED: "true", PB_EVENTS_ENABLED: "true", PB_PUBLIC_ORIGIN: "https://app.test", PB_EVENT_TRANSPORT_SECRET: "synthetic-recovery-test-secret-000000", PB_EVENT_TRUSTED_IP_HEADER: "x-test-ip" };
const request = (path: string, body: unknown, headers: Record<string, string> = {}) => new Request(`https://app.test${path}`, { method: "POST", headers: { origin: env.PB_PUBLIC_ORIGIN, authorization: "Bearer test-access", "content-type": "application/json", "x-test-ip": "192.0.2.1", ...headers }, body: JSON.stringify(body) });
async function refused(response: Response) { assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "feature_recovery" }); assert.equal(response.headers.get("cache-control"), "private, no-store"); }

test("recovery policy denies unknown operations and new authority while retaining narrow privacy reductions", () => {
  for (const [surface, operations] of Object.entries({ project: ["create", "reserve", "upload"], "project-design": ["save"], "event-root": ["create"], "event-host": ["issue", "saveSettings", "saveMissions"], "event-guest": ["redeem", "upload", "saveGuestbook"], "event-kiosk": ["create", "begin", "reserve", "upload"], optional: ["read", "create", "capabilities"] })) for (const operation of operations) assert.equal(recoveryOperationAllowed(surface, operation), false, `${surface}:${operation}`);
  for (const surface of ["project", "event-export", "unknown", "constructor", "__proto__"]) assert.equal(recoveryOperationAllowed(surface, "unknown"), false);
  assert.equal(recoveryOperationAllowed("project", "member", { action: "revoke" }), true);
  assert.equal(recoveryOperationAllowed("project", "member", { action: "accept" }), false);
  assert.equal(recoveryOperationAllowed("event-host", "manage", { action: "pause" }), true);
  assert.equal(recoveryOperationAllowed("event-host", "manage", { action: "open" }), false);
  assert.equal(recoveryOperationAllowed("event-guest", "consent", { consent: { submission: false, gallery: false, wall: false } }), true);
  assert.equal(recoveryOperationAllowed("event-guest", "consent", { consent: { submission: true, gallery: false, wall: false } }), false);
  assert.equal(recoveryOperationAllowed("event-guest", "saveOwnConsent", { gallery: false, wall: false }), true);
  assert.equal(recoveryOperationAllowed("event-guest", "saveOwnConsent", { gallery: false, wall: true }), false);
  for (const operation of ["list", "create", "page", "access", "media", "guestbook", "checkpoint", "retire"]) assert.equal(recoveryOperationAllowed("event-export", operation), true);
});

test("recovery project allocations, invitations and minting never open auth or provider ports", async () => {
  let opened = 0; const deny = (): never => { opened++; throw new Error("Unexpected port"); };
  const handler = createProjectHandler({ store: deny, objects: deny }, () => env);
  for (const body of [{ operation: "create", id: id(1), kind: "personal", title: "Test", maxBytes: 10485760 }, { operation: "upload", projectId: id(1), assetId: id(2) }, { operation: "member", projectId: id(1), userId: id(2), action: "invite" }, { operation: "member", projectId: id(1), userId: id(2), action: "accept" }]) await refused(await handler(request("/api/projects", body)));
  assert.equal(opened, 0);
  assert.equal((await handler(request("/api/projects", { operation: "list" }, { origin: "https://other.test" }))).status, 403);
  assert.equal((await handler(request("/api/projects", { operation: "list" }, { authorization: "" }))).status, 401);
  assert.equal(opened, 0);
});

test("recovery project list, finalise and deletion keep normal actor and rate checks", async () => {
  const calls: string[] = [];
  const store = { rate: async (scope: string) => { calls.push(scope); }, list: async () => ({ projects: [], nextCursor: null }), enqueueFinalisation: async (assetId: string) => ({ assetId, status: "queued" }), delete: async () => ({ pending: true }), member: async () => ({ status: "revoked" }) } as unknown as ProjectStore;
  const ports: ProjectRequestPorts = { store: async token => { assert.equal(token, "test-access"); calls.push("verified-actor"); return store; }, objects: () => { throw new Error("Unexpected provider"); } };
  const handler = createProjectHandler(ports, () => env);
  for (const [body, status] of [[{ operation: "list" }, 200], [{ operation: "finalise", assetId: id(2) }, 202], [{ operation: "delete", projectId: id(1) }, 202], [{ operation: "member", projectId: id(1), userId: id(2), action: "revoke" }, 200]] as const) assert.equal((await handler(request("/api/projects", body))).status, status);
  assert.deepEqual(calls, ["verified-actor", "read", "verified-actor", "write", "verified-actor", "write", "verified-actor", "write"]);
});

test("recovery design save is denied before store creation while head/status still authenticate", async () => {
  let opened = 0;
  const store = { rate: async () => {}, head: async () => null, status: async () => null } as unknown as ProjectDesignStore;
  const handler = createProjectDesignHandler(async token => { assert.equal(token, "test-access"); opened++; return store; }, () => env);
  await refused(await handler(request("/api/projects/design", { operation: "save", projectId: id(1), requestId: id(2), expectedRevision: null, snapshot: {} })));
  assert.equal(opened, 0);
  assert.equal((await handler(request("/api/projects/design", { operation: "head", projectId: id(1) }))).status, 200);
  assert.equal((await handler(request("/api/projects/design", { operation: "status", projectId: id(1), requestId: id(2) }))).status, 200);
  assert.equal(opened, 2);
});

test("recovery event reservation, mint and authority creation fail before all service ports", async () => {
  let opened = 0; const deny = (): never => { opened++; throw new Error("Unexpected service port"); };
  const ports: EventRequestPorts = { store: deny, authenticate: deny, objects: deny, hostStore: deny, readiness: deny, ownConsent: deny, guestbook: deny };
  const cases: [EventRoute, Record<string, unknown>][] = [["root", { operation: "create" }], ["host", { operation: "issue" }], ["host", { operation: "manage", action: "open", body: {} }], ["guest", { operation: "redeem" }], ["guest", { operation: "upload" }], ["guest", { operation: "consent", consent: { submission: true, gallery: false, wall: false } }], ["guest", { operation: "saveOwnConsent", gallery: true, wall: true }]];
  for (const [route, body] of cases) await refused(await createEventHandler(route, ports, () => env)(request(`/api/events/${id(1)}`, body), id(1), id(2)));
  assert.equal(opened, 0);
  const badOrigin = await createEventHandler("guest", ports, () => env)(request(`/api/events/${id(1)}/guest`, { operation: "finalise" }, { origin: "https://other.test" }), id(1));
  assert.equal(badOrigin.status, 403); assert.equal(opened, 0);
});

test("recovery event finalisation and receipt reads still reach existing capability/session security", async () => {
  let opened = 0;
  const ports: EventRequestPorts = { authenticate: async () => { throw new EventStoreError("access_denied", 401); }, store: () => { opened++; throw new EventStoreError("access_denied", 403); } };
  for (const [route, operation] of [["guest", "finalise"], ["receipt", "read"], ["host", "dashboard"]] as const) {
    const response = await createEventHandler(route, ports, () => env)(request(`/api/events/${id(1)}`, { operation }), id(1), id(2));
    assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: "access_denied" });
  }
  assert.equal(opened, 3);
});

test("recovery owner export operations retain authentication instead of being blanket-disabled", async () => {
  let authenticated = 0, opened = 0;
  const ports: EventExportRequestPorts = { authenticate: async () => { authenticated++; throw new EventStoreError("access_denied", 401); }, stores: () => { opened++; throw new Error("Unexpected stores"); } };
  const handler = createEventExportHandler(ports, () => env);
  for (const body of [{ operation: "list" }, { operation: "create", exportId: id(2), generation: 0 }, { operation: "media", exportId: id(2), generation: 0, index: 0 }]) assert.equal((await handler(request(`/api/events/${id(1)}/exports`, body), id(1))).status, 401);
  assert.equal(authenticated, 3); assert.equal(opened, 0);
});

test("recovery kiosk rejects new guests/allocations even when lock middleware bypasses other routing", async () => {
  let opened = 0; const deny = (): never => { opened++; throw new Error("Unexpected kiosk port"); };
  const ports: EventKioskRequestPorts = { kiosk: deny, core: deny, host: deny, objects: deny, authenticate: deny };
  const handler = createEventKioskHandler(ports, () => env);
  for (const operation of ["create", "begin", "reserve", "upload"]) await refused(await handler(request(`/api/events/${id(1)}/kiosk`, { operation }), id(1)));
  assert.equal(opened, 0);
});


test("recovery reservation replay reads only existing receipt authority and never allocates", async () => {
  const token = Buffer.alloc(32, 7).toString("base64url"), eventId = id(1), submissionId = id(2), requestId = id(3), guestId = id(4);
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const receiptToken = createHmac("sha256", env.PB_EVENT_TRANSPORT_SECRET).update(JSON.stringify(["receipt", eventId, token, submissionId, requestId])).digest("base64url");
  const expiry = "2099-01-01T00:00:00.000Z";
  let allocations = 0, reads = 0;
  const receipt = { submissionId, state: "ready", logicalExpiresAt: expiry, eventExpiresAt: expiry, gallery: "private", wall: "private" };
  const mutation = async (): Promise<never> => { allocations++; throw new Error("Unexpected allocation"); };
  const store = {
    transportReady: async () => {}, rate: async () => ({ allowed: true, retryAfterSeconds: 0 }), capabilities: async () => ({ ready: true }),
    session: async (event: string, tokenHash: string, kind: string, requestedId?: string) => {
      if (event !== eventId || (kind === "contribute" ? tokenHash !== hash(token) : tokenHash !== hash(receiptToken) || requestedId !== submissionId)) throw new EventStoreError("access_denied", 403);
      return { eventId, kind, guestId, submissionId: requestedId ?? null, expiresAt: expiry };
    },
    receipt: async (event: string, tokenHash: string, requestedId: string) => { assert.equal(event, eventId); assert.equal(tokenHash, hash(receiptToken)); assert.equal(requestedId, submissionId); reads++; return receipt; },
    reserve: mutation,
  } as unknown as EventStore;
  const ports: EventRequestPorts = { store: () => store, authenticate: mutation, readiness: () => { throw new Error("Recovery reads must not need worker admission"); }, guestbook: () => { throw new Error("No mission reservation port"); }, objects: () => { throw new Error("No mint port"); } };
  const handler = createEventHandler("guest", ports, () => env);
  for (const operation of ["reserve", "reserveMission"]) {
    const body = { operation, submissionId, requestId, expectedGuestId: guestId, consent: { submission: true, gallery: false, wall: false }, ...(operation === "reserveMission" ? { missionId: null } : {}) };
    const run = (overrides: Record<string, unknown> = {}, cookie = token) => handler(request(`/api/events/${eventId}/guest`, { ...body, ...overrides }, { cookie: `__Host-pb-event-contribute=${cookie}` }), eventId);
    const response = await run(); assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { receipt, receiptToken, replacesBrowserReceipt: true, fragmentOnly: true });
    assert(response.headers.get("set-cookie")?.includes(receiptToken));
    for (const overrides of [{ submissionId: id(7) }, { requestId: id(8) }, { expectedGuestId: id(9) }]) assert.equal((await run(overrides)).status, 403);
    assert.equal((await run({}, Buffer.alloc(32, 8).toString("base64url"))).status, 403);
    assert.equal((await run({ extra: true })).status, 400);
    if (operation === "reserveMission") assert.equal((await run({ missionId: "unknown" })).status, 400);
    // Changed publication input is ignored: recovery only reads the existing private result.
    assert.equal((await run({ consent: { submission: true, gallery: true, wall: true } })).status, 201);
  }
  assert.equal(allocations, 0); assert.equal(reads, 4);
});
