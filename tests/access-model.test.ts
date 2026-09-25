import assert from "node:assert/strict";
import test from "node:test";
import { AccessDenied, Capabilities, EventAccess, MINUTE, RoomSignalling, type ContributorGrant } from "../lib/feasibility/access-model";

function fixture() {
  let time = 1_000;
  const now = () => time;
  const caps = new Capabilities(now);
  const events = new EventAccess(caps, now);
  const rooms = new RoomSignalling(caps, now);
  const token = (scope: "event" | "room", resource: string, subject: string, role: Parameters<Capabilities["issue"]>[0]["role"], duration = 1_000 * MINUTE) =>
    caps.issue({ scope, resource, subject, role, expiresAt: now() + duration });
  const config = { maxCount: 100, maxBytes: 250_000_000, stagingBytes: 2_000_000, derivativeBytes: 2_100_000, expiresAt: now() + 2_000 * MINUTE };
  events.create("party", config);
  events.create("other", config);
  const contribute = token("event", "party", "alice", "contribute");
  const receipts = new Map<string, string>();
  const receipt = (object: string): string => {
    if (!receipts.has(object)) receipts.set(object, caps.issue({ scope: "event", resource: "party", subject: "alice", role: "receipt", expiresAt: now() + 1_000 * MINUTE, object }));
    return receipts.get(object)!;
  };
  const gallery = token("event", "party", "viewer", "gallery");
  const wall = token("event", "party", "display", "wall");
  const grant = (subject = "alice", gallery = false, wall = false): ContributorGrant => ({ subject, submission: true, gallery, wall });
  const consent = (credential: string, value: ContributorGrant) => {
    const { subject: _subject, ...choices } = value;
    void _subject;
    events.consent(credential, "party", choices);
  };
  consent(contribute, grant());
  return { caps, events, rooms, token, config, now, advance: (ms: number) => { time += ms; }, contribute, receipt, gallery, wall, grant, consent };
}
const denied = (fn: () => unknown) => assert.throws(fn, AccessDenied);

test("capabilities are high-entropy opaque secrets with scope, resource, role, expiry and revocation checks", () => {
  const f = fixture();
  assert.match(f.contribute, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(f.contribute, f.token("event", "party", "alice", "contribute"));
  denied(() => f.caps.check("party", "event", "party", ["contribute"]));
  denied(() => f.caps.check(f.contribute, "room", "party", ["contribute"]));
  denied(() => f.caps.check(f.contribute, "event", "other", ["contribute"]));
  denied(() => f.caps.check(f.contribute, "event", "party", ["receipt"]));
  const short = f.token("event", "party", "alice", "receipt", MINUTE);
  f.advance(MINUTE);
  denied(() => f.caps.check(short, "event", "party", ["receipt"]));
  f.caps.revoke(f.contribute);
  denied(() => f.caps.check(f.contribute, "event", "party", ["contribute"]));
});

test("two rooms reject foreign, spoofed, removed and expired signalling identities", () => {
  const f = fixture();
  f.rooms.create("a", ["host", "guest"], f.now() + 10 * MINUTE);
  f.rooms.create("b", ["host", "guest"], f.now() + 10 * MINUTE);
  const a = f.token("room", "a", "host", "host");
  const guest = f.token("room", "a", "guest", "participant");
  const b = f.token("room", "b", "host", "host");
  const message = { sender: "host", recipient: "guest", kind: "sdp", payload: "offer" };
  f.rooms.send(a, "a", message);
  assert.deepEqual(f.rooms.poll(a, "a", 0).messages, []);
  assert.equal(f.rooms.poll(guest, "a", 0).messages[0].payload, "offer");
  assert.deepEqual(f.rooms.poll(b, "b", 0).messages, []);
  denied(() => f.rooms.send(b, "a", message));
  denied(() => f.rooms.poll(b, "a", 0));
  denied(() => f.rooms.send(guest, "a", message));
  f.rooms.remove("a", "guest");
  denied(() => f.rooms.poll(guest, "a", 0));
  denied(() => f.rooms.send(guest, "a", { ...message, sender: "guest", recipient: "host" }));
  assert.deepEqual(f.rooms.poll(a, "a", 0).messages, []);
  f.advance(10 * MINUTE);
  denied(() => f.rooms.poll(a, "a", 0));
});

test("signalling inbox enforces type, UTF-8 bytes, cursor, page, capacity and TTL bounds", () => {
  const f = fixture();
  f.rooms.create("a", ["host", "guest"], f.now() + 10 * MINUTE);
  const host = f.token("room", "a", "host", "host");
  const guest = f.token("room", "a", "guest", "participant");
  const message = { sender: "host", recipient: "guest", kind: "ice", payload: "candidate" };
  denied(() => f.rooms.send(host, "a", { ...message, kind: "capture" }));
  denied(() => f.rooms.send(host, "a", { ...message, payload: "é".repeat(2_049) }));
  denied(() => f.rooms.send(host, "a", { ...message, kind: "sdp", payload: "x".repeat(32_769) }));
  denied(() => f.rooms.poll(guest, "a", -1));
  for (let i = 0; i < 64; i++) f.rooms.send(host, "a", message);
  denied(() => f.rooms.send(host, "a", message));
  const first = f.rooms.poll(guest, "a", 0);
  assert.equal(first.messages.length, 16);
  assert.equal(first.cursor, 16);
  assert.equal(f.rooms.poll(guest, "a", first.cursor).messages[0].cursor, 17);
  denied(() => f.rooms.poll(guest, "a", 65));
  f.advance(MINUTE);
  assert.deepEqual(f.rooms.poll(guest, "a", 0), { messages: [], cursor: 64 });
  assert.equal(f.rooms.send(host, "a", message), 65);
});

test("contribute, personal receipt, gallery and wall are independent permissions", () => {
  for (const allowGallery of [false, true]) for (const allowWall of [false, true]) {
    const f = fixture();
    const grant = f.grant("alice", allowGallery, allowWall);
    f.consent(f.contribute, grant);
    const id = f.events.reserve(f.contribute, "party", "photo", [grant]);
    denied(() => f.events.read(f.receipt(id), "party", id, "receipt"));
    f.events.finalise(f.contribute, "party", id, 1_000);
    assert.match(f.events.read(f.receipt(id), "party", id, "receipt"), /^events\/party\/delivery\//);
    denied(() => f.events.read(f.contribute, "party", id, "receipt"));
    denied(() => f.events.reserve(f.receipt(id), "party", "denied", [grant]));
    denied(() => f.events.read(f.receipt(id), "other", id, "receipt"));
    denied(() => f.events.read(f.token("event", "party", "bob", "receipt"), "party", id, "receipt"));
    for (const destination of ["gallery", "wall"] as const) {
      const credential = f[destination];
      denied(() => f.events.read(credential, "party", id, destination));
      f.events.moderate("party", id, destination, true);
      if (grant[destination]) assert.ok(f.events.read(credential, "party", id, destination));
      else denied(() => f.events.read(credential, "party", id, destination));
    }
  }
});

test("every included contributor must grant a destination; hiding and withdrawal are destination-specific", () => {
  const f = fixture();
  const alice = f.grant("alice", true, true);
  const bob = f.grant("bob", true, false);
  f.consent(f.contribute, alice);
  denied(() => f.events.reserve(f.contribute, "party", "spoof-consent", [alice, bob]));
  f.consent(f.token("event", "party", "bob", "contribute"), bob);
  const id = f.events.reserve(f.contribute, "party", "duo", [alice, bob]);
  f.events.finalise(f.contribute, "party", id, 2_000_000);
  f.events.moderate("party", id, "gallery", true);
  f.events.moderate("party", id, "wall", true);
  assert.ok(f.events.read(f.gallery, "party", id, "gallery"));
  denied(() => f.events.read(f.wall, "party", id, "wall"));
  f.events.hide("party", id, "wall");
  assert.ok(f.events.read(f.gallery, "party", id, "gallery"));
  f.events.withdraw("party", id, "bob", "gallery");
  denied(() => f.events.read(f.gallery, "party", id, "gallery"));
  assert.ok(f.events.read(f.receipt(id), "party", id, "receipt"));
  f.events.withdraw("party", id, "bob", "submission");
  denied(() => f.events.read(f.receipt(id), "party", id, "receipt"));
});

test("reservations are idempotent and hold maximum staging bytes plus derivative headroom", () => {
  const f = fixture();
  const id = f.events.reserve(f.contribute, "party", "same", [f.grant()]);
  assert.equal(f.events.reserve(f.contribute, "party", "same", [f.grant()]), id);
  assert.deepEqual(f.events.usage("party"), { count: 1, bytes: 4_100_000 });
  denied(() => f.events.finalise(f.contribute, "party", id, 2_000_001));
  f.events.finalise(f.contribute, "party", id, 100);
  f.events.finalise(f.contribute, "party", id, 100);
  assert.deepEqual(f.events.usage("party"), { count: 1, bytes: 4_100_000 });
  for (let i = 1; i < 60; i++) f.events.reserve(f.contribute, "party", `key${i}`, [f.grant()]);
  assert.equal(f.events.usage("party").bytes, 246_000_000);
  denied(() => f.events.reserve(f.contribute, "party", "excess", [f.grant()]));
  denied(() => f.events.confirmStagingDeleted("party", id));
  f.advance(125 * MINUTE);
  assert.deepEqual(f.events.usage("party"), { count: 1, bytes: 122_100_000 });
  f.events.confirmStagingDeleted("party", id);
  f.events.confirmStagingDeleted("party", id);
  assert.equal(f.events.usage("party").bytes, 120_100_000);
});

test("count ceiling is independent of byte headroom and guest keys do not collide", () => {
  const f = fixture();
  f.events.create("tiny", { ...f.config, maxCount: 1 });
  const token = f.token("event", "tiny", "alice", "contribute");
  f.events.consent(token, "tiny", { submission: true, gallery: false, wall: false });
  f.events.reserve(token, "tiny", "one", [f.grant()]);
  denied(() => f.events.reserve(token, "tiny", "two", [f.grant()]));
  const bob = f.token("event", "party", "bob", "contribute");
  f.consent(bob, f.grant("bob"));
  assert.notEqual(f.events.reserve(f.contribute, "party", "same", [f.grant()]), f.events.reserve(bob, "party", "same", [f.grant("bob")]));
});

test("ordinary closure honours accepted reservation deadline; revocation and removal are immediate", () => {
  const f = fixture();
  const accepted = f.events.reserve(f.contribute, "party", "accepted", [f.grant()]);
  const late = f.events.reserve(f.contribute, "party", "late", [f.grant()]);
  f.advance(8 * MINUTE);
  f.events.close("party");
  denied(() => f.events.reserve(f.contribute, "party", "new", [f.grant()]));
  f.events.finalise(f.contribute, "party", accepted, 100);
  f.advance(2 * MINUTE);
  denied(() => f.events.finalise(f.contribute, "party", late, 100));
  assert.ok(f.events.read(f.receipt(accepted), "party", accepted, "receipt"));
  f.events.revokeGuest("party", "alice");
  denied(() => f.events.finalise(f.contribute, "party", accepted, 100));
  denied(() => f.events.read(f.receipt(accepted), "party", accepted, "receipt"));
  assert.equal(f.events.usage("party").bytes, 6_100_000);
  const other = fixture();
  const removed = other.events.reserve(other.contribute, "party", "remove", [other.grant()]);
  other.events.remove("party", removed);
  denied(() => other.events.finalise(other.contribute, "party", removed, 100));
  assert.deepEqual(other.events.usage("party"), { count: 0, bytes: 2_000_000 });
});

test("expired or deleted events and revoked capabilities deny access", () => {
  for (const invalidate of ["expiry", "delete", "token"] as const) {
    const f = fixture();
    const id = f.events.reserve(f.contribute, "party", "one", [f.grant()]);
    f.events.finalise(f.contribute, "party", id, 100);
    if (invalidate === "expiry") f.advance(2_000 * MINUTE);
    if (invalidate === "delete") f.events.deleteEvent("party");
    if (invalidate === "token") f.caps.revoke(f.receipt(id));
    denied(() => f.events.read(f.receipt(id), "party", id, "receipt"));
  }
});

test("contributor withdrawal or emergency revocation denies pending finalisation immediately", () => {
  for (const action of ["withdraw", "revoke", "delete"] as const) {
    const f = fixture();
    const bob = f.token("event", "party", "bob", "contribute");
    f.consent(bob, f.grant("bob"));
    const id = f.events.reserve(f.contribute, "party", "pending", [f.grant(), f.grant("bob")]);
    if (action === "withdraw") f.events.consent(bob, "party", { submission: false, gallery: false, wall: false });
    if (action === "revoke") f.events.revokeGuest("party", "bob");
    if (action === "delete") f.events.deleteEvent("party");
    denied(() => f.events.finalise(f.contribute, "party", id, 100));
  }
});

test("receipt capabilities bind exactly one session even for the same guest", () => {
  const f = fixture();
  const first = f.events.reserve(f.contribute, "party", "first", [f.grant()]);
  const second = f.events.reserve(f.contribute, "party", "second", [f.grant()]);
  for (const id of [first, second]) f.events.finalise(f.contribute, "party", id, 100);
  assert.ok(f.events.read(f.receipt(first), "party", first, "receipt"));
  denied(() => f.events.read(f.receipt(first), "party", second, "receipt"));
  denied(() => f.events.read(f.token("event", "party", "alice", "receipt"), "party", first, "receipt"));
});

test("removed delivery bytes remain charged until explicit deletion confirmation", () => {
  const f = fixture();
  const id = f.events.reserve(f.contribute, "party", "one", [f.grant()]);
  f.events.finalise(f.contribute, "party", id, 100);
  denied(() => f.events.confirmDeliveryDeleted("party", id));
  f.events.remove("party", id);
  f.events.remove("party", id);
  denied(() => f.events.read(f.receipt(id), "party", id, "receipt"));
  assert.deepEqual(f.events.usage("party"), { count: 0, bytes: 4_100_000 });
  f.events.confirmDeliveryDeleted("party", id);
  f.events.confirmDeliveryDeleted("party", id);
  assert.deepEqual(f.events.usage("party"), { count: 0, bytes: 2_000_000 });
  f.advance(125 * MINUTE);
  assert.equal(f.events.usage("party").bytes, 2_000_000);
  f.events.confirmStagingDeleted("party", id);
  assert.equal(f.events.usage("party").bytes, 0);
});
