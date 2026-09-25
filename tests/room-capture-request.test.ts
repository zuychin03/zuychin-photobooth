import assert from "node:assert/strict";
import test from "node:test";
import { RoomEngineV2 } from "../lib/rtc/engine-v2";
import { encodeEnvelope, parseEnvelope } from "../lib/rtc/protocol";
import type { RoomApi } from "../lib/rtc/signaling-v2";
import type { RoomState } from "../lib/server/room-contract";
import { EPOCH, MEMBER_A, MEMBER_B, ROOM_ID, SESSION_ID, memoryJournal } from "./helpers/room-fixture";

class Channel {
  label = "photobooth-v2"; ordered = true; readyState = "open"; bufferedAmount = 0;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null; onclose: (() => void) | null = null;
  sent: string[] = [];
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = "closed"; this.onclose?.(); }
}
class Peer {
  channel = new Channel();
  ondatachannel: ((event: { channel: RTCDataChannel }) => void) | null = null;
  createDataChannel() { return this.channel as unknown as RTCDataChannel; }
  async createOffer() { return { type: "offer", sdp: "fixture" }; }
  async setLocalDescription() {}
  close() {}
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function setup(guest = false) {
  const members: RoomState["members"] = [{ id: MEMBER_A, role: "A", displayName: "Host", status: "admitted", connectionEpoch: EPOCH }, { id: MEMBER_B, role: "B", displayName: "Guest", status: "admitted", connectionEpoch: EPOCH }];
  const state: RoomState = { roomId: ROOM_ID, sessionId: SESSION_ID, code: "ABC234", hostId: MEMBER_A, selfId: guest ? MEMBER_B : MEMBER_A, selfRole: guest ? "B" : "A", connectionEpoch: EPOCH, status: "open", locked: false, rosterRevision: 1, expiresAt: Date.now() + 60000, serverNow: Date.now(), members, capture: null };
  let prepares = 0; const requests: string[] = [], errors: string[] = [], peer = new Peer();
  const unused = async (): Promise<never> => { throw new Error("unexpected capture operation"); };
  const api: RoomApi = { state: async () => state, signal: async () => ({ cursor: 0 }), poll: async () => ({ cursor: 0, signals: [], serverNow: Date.now(), resetRequired: false }), prepare: async () => { prepares++; return unused(); }, capture: unused, ack: unused, commit: unused, abort: unused, control: async () => ({ ended: true }) };
  const engine = new RoomEngineV2({ initial: state, scope: { kind: "device" }, iceServers: [], api, journal: memoryJournal().journal, createPeer: () => peer as unknown as RTCPeerConnection, readiness: async () => false, captureShot: unused, commitRemoteFrame: async () => {}, onState() {}, onStatus() {}, onRemoteStream() {}, onError: error => errors.push(error), onCaptureRequest: async sender => { requests.push(sender.id); sender.displayName = "Mutated callback copy"; } });
  await engine.start({ getVideoTracks: () => [] } as unknown as MediaStream);
  if (guest) peer.ondatachannel?.({ channel: peer.channel as unknown as RTCDataChannel });
  peer.channel.onopen?.();
  const identity = { roomId: ROOM_ID, sessionId: SESSION_ID, memberId: guest ? MEMBER_A : MEMBER_B, connectionEpoch: EPOCH, rosterRevision: 1 };
  peer.channel.onmessage?.({ data: encodeEnvelope({ ...identity, seq: 1 }, "hello", { peerEpoch: EPOCH }) });
  await tick();
  return { engine, peer, identity, requests, errors, prepares: () => prepares };
}
test("capture requests carry no preparation authority or arbitrary payload", () => {
  const identity = { roomId: ROOM_ID, sessionId: SESSION_ID, memberId: MEMBER_B, connectionEpoch: EPOCH, rosterRevision: 1, seq: 1 };
  assert.equal(parseEnvelope(encodeEnvelope(identity, "capture-request", {})).type, "capture-request");
  const wire = JSON.parse(encodeEnvelope(identity, "capture-request", {}));
  wire.payload = { fireAt: 1 }; wire.payloadBytes = JSON.stringify(wire.payload).length;
  assert.throws(() => parseEnvelope(JSON.stringify(wire)), /invalid_message/);
});
test("authenticated guests can notify the host once per interval without preparing or capturing", async () => {
  const host = await setup();
  try {
    host.peer.channel.onmessage?.({ data: encodeEnvelope({ ...host.identity, seq: 2 }, "capture-request", {}) });
    host.peer.channel.onmessage?.({ data: encodeEnvelope({ ...host.identity, seq: 3 }, "capture-request", {}) });
    await tick();
    assert.deepEqual(host.requests, [MEMBER_B]); assert.equal(host.prepares(), 0); assert.deepEqual(host.errors, []);
    assert.equal(host.engine.state.members[1].displayName, "Guest");
    assert.throws(() => host.engine.requestCapture(), /host_prepares_capture/);
  } finally { host.engine.close(); }
  const guest = await setup(true);
  try {
    guest.engine.requestCapture();
    const sent = guest.peer.channel.sent.map(parseEnvelope);
    assert.equal(sent.at(-1)?.type, "capture-request"); assert.deepEqual(sent.at(-1)?.payload, {});
    assert.throws(() => guest.engine.requestCapture(), /rate_limited/); assert.equal(guest.prepares(), 0);
  } finally { guest.engine.close(); }
});
test("a capture request sent to a non-host or with a forged identity never reaches the callback", async () => {
  const guest = await setup(true);
  try {
    guest.peer.channel.onmessage?.({ data: encodeEnvelope({ ...guest.identity, seq: 2 }, "capture-request", {}) });
    await tick(); assert.deepEqual(guest.requests, []); assert(guest.errors.includes("host_required"));
  } finally { guest.engine.close(); }
  const host = await setup();
  try {
    host.peer.channel.onmessage?.({ data: encodeEnvelope({ ...host.identity, memberId: MEMBER_A, seq: 2 }, "capture-request", {}) });
    await tick(); assert.deepEqual(host.requests, []); assert(host.errors.some(error => error.includes("identity")));
    host.engine.close(); assert.throws(() => host.engine.requestCapture());
  } finally { host.engine.close(); }
});
