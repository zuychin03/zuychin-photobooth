import assert from "node:assert/strict";
import test from "node:test";
import { RoomEngineV2, type RoomV2Status } from "../lib/rtc/engine-v2";
import { encodeEnvelope } from "../lib/rtc/protocol";
import type { RoomApi } from "../lib/rtc/signaling-v2";
import type { RoomSignal, RoomSignalInput, RoomState } from "../lib/server/room-contract";
import { EPOCH, MEMBER_A, MEMBER_B, ROOM_ID, SESSION_ID, memoryJournal } from "./helpers/room-fixture";
const THIRD = "77777777-7777-4777-8777-777777777777", FOURTH = "88888888-8888-4888-8888-888888888888";
async function until(ready: () => boolean) { for (let i = 0; i < 1000 && !ready(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert(ready()); }
class Channel { label = "photobooth-v2"; ordered = true; readyState = "open"; bufferedAmount = 0; onmessage: ((event: { data: string }) => void) | null = null; close() {} send() {} }
class Peer {
  signalingState = "stable"; remoteDescription: RTCSessionDescriptionInit | null = null;
  descriptions: RTCSessionDescriptionInit[] = []; candidates: RTCIceCandidateInit[] = []; closed = false;
  remoteGate?: Promise<void>; channel = new Channel();
  createDataChannel() { return this.channel as unknown as RTCDataChannel; }
  async createOffer() { return { type: "offer" as const, sdp: "fixture-offer" }; }
  async createAnswer() { return { type: "answer" as const, sdp: "fixture-answer" }; }
  async setLocalDescription(value: RTCSessionDescriptionInit) { this.signalingState = value.type === "offer" ? "have-local-offer" : "stable"; }
  async setRemoteDescription(value: RTCSessionDescriptionInit) {
    if (value.type === "answer" && this.signalingState !== "have-local-offer") throw new Error("duplicate_answer_in_stable");
    this.descriptions.push(value); await this.remoteGate; this.remoteDescription = value; this.signalingState = value.type === "offer" ? "have-remote-offer" : "stable";
  }
  async addIceCandidate(value: RTCIceCandidateInit) { this.candidates.push(value); }
  close() { this.closed = true; }
}
function setup(guest = false) {
  let state: RoomState = { roomId: ROOM_ID, sessionId: SESSION_ID, code: "ABC234", hostId: MEMBER_A, selfId: guest ? MEMBER_B : MEMBER_A, selfRole: guest ? "B" : "A", connectionEpoch: EPOCH, status: "open", locked: false, rosterRevision: 1, expiresAt: Date.now() + 60000, serverNow: Date.now(), capture: null, members: [{ id: MEMBER_A, role: "A", displayName: "Host", status: "admitted", connectionEpoch: EPOCH }, { id: MEMBER_B, role: "B", displayName: "Guest", status: "admitted", connectionEpoch: EPOCH }] };
  const peers: Peer[] = [], messages: RoomSignal[] = [], sent: RoomSignalInput[] = [], errors: string[] = []; let polls = 0, opened = 0, floor = 0, stateReads = 0, pageSize = 16; const statuses: RoomV2Status[] = [];
  const unused = async (): Promise<never> => { throw new Error("unused"); };
  const api: RoomApi = { state: async () => { stateReads++; return state; }, signal: async value => { sent.push(value); return { cursor: 0 }; }, poll: async cursor => { polls++; const signals = messages.filter(item => item.id > cursor).slice(0, pageSize); return { signals, cursor: signals.at(-1)?.id ?? Math.max(messages.at(-1)?.id ?? 0, floor), serverNow: Date.now(), resetRequired: cursor < floor }; }, capture: unused, prepare: unused, ack: unused, commit: unused, abort: unused, control: unused };
  let gate: Promise<void> | undefined;
  const engine = new RoomEngineV2({ initial: state, scope: { kind: "device" }, iceServers: [], api, openJournal: async () => { opened++; return memoryJournal().journal; }, createPeer: () => { const peer = new Peer(); peer.remoteGate = gate; peers.push(peer); return peer as unknown as RTCPeerConnection; }, readiness: async () => false, captureShot: unused, commitRemoteFrame: async () => {}, onState() {}, onStatus(value) { statuses.push(value); }, onRemoteStream() {}, onError: error => errors.push(error) });
  const signal = (payload: object, from = guest ? MEMBER_A : MEMBER_B, kind: "sdp" | "ice" = "sdp", messageId = crypto.randomUUID()) => {
    const value: RoomSignal = { id: messages.length + 1, messageId, fromMemberId: from, toMemberId: state.selfId, connectionEpoch: EPOCH, kind, createdAt: Date.now(), payload: JSON.stringify(payload) }; messages.push(value); return value;
  };
  return { engine, peers, messages, sent, errors, signal, statuses, pageSize(value: number) { pageSize = value; }, get polls() { return polls; }, get stateReads() { return stateReads; }, floor(value: number) { floor = value; }, get opened() { return opened; }, get state() { return state; }, setState(value: RoomState) { state = value; }, gate(value: Promise<void>) { gate = value; } };
}
const stream = { getVideoTracks: () => [] } as unknown as MediaStream;
test("duplicate SDP answers are idempotent, a bad row does not discard later ICE, and journal factory opens lazily", async () => {
  const f = setup(); assert.equal(f.opened, 0);
  const payload = { type: "answer", sdp: "answer-1", rosterRevision: 1, toConnectionEpoch: EPOCH };
  f.signal(payload); f.signal(payload); f.signal({ ...payload, sdp: "changed-without-new-epoch" });
  f.signal({ candidate: "fixture-candidate", rosterRevision: 1, toConnectionEpoch: EPOCH }, MEMBER_B, "ice");
  try {
    await f.engine.start(stream); await until(() => f.peers[0]?.candidates.length === 1);
    assert.equal(f.opened, 1); assert.equal(f.peers[0].descriptions.length, 1); assert.deepEqual(f.errors, ["unexpected_renegotiation"]);
    assert.equal(JSON.parse(f.sent[0].payload).rosterRevision, 1); assert.equal(JSON.parse(f.sent[0].payload).toConnectionEpoch, EPOCH);
  } finally { f.engine.close(); }
});
test("admission from two to three to four peers ignores retained SDP and ICE from older roster revisions", async () => {
  const f = setup();
  f.signal({ type: "answer", sdp: "old-answer", rosterRevision: 1, toConnectionEpoch: EPOCH });
  try {
    await f.engine.start(stream); await until(() => f.peers[0]?.descriptions.length === 1);
    for (const [id, role] of [[THIRD, "C"], [FOURTH, "D"]] as const) {
      const revision = f.state.rosterRevision + 1, previousCount = f.peers.length;
      f.setState({ ...f.state, rosterRevision: revision, members: [...f.state.members, { id, role, displayName: role, status: "admitted", connectionEpoch: EPOCH }] });
      f.signal({ candidate: "stale-ice", rosterRevision: revision - 1, toConnectionEpoch: EPOCH }, MEMBER_B, "ice");
      f.signal({ type: "answer", sdp: "wrong-recipient-epoch", rosterRevision: revision, toConnectionEpoch: FOURTH });
      for (const member of f.state.members.slice(1)) f.signal({ type: "answer", sdp: `fresh-${revision}-${member.role}`, rosterRevision: revision, toConnectionEpoch: EPOCH }, member.id);
      await f.engine.refresh(); await until(() => f.peers.slice(previousCount).every(peer => peer.descriptions.length === 1));
      for (const peer of f.peers.slice(previousCount)) { assert.match(peer.descriptions[0].sdp!, new RegExp(`^fresh-${revision}`)); assert.equal(peer.candidates.length, 0); }
    }
    assert.deepEqual(f.errors, []);
  } finally { f.engine.close(); }
});
test("closing during remote SDP application cannot emit a late answer", async () => {
  const f = setup(true); let resolve!: () => void; f.gate(new Promise<void>(done => { resolve = done; }));
  f.signal({ type: "offer", sdp: "offer", rosterRevision: 1, toConnectionEpoch: EPOCH });
  await f.engine.start(stream); await until(() => f.peers[0]?.descriptions.length === 1);
  f.engine.close(); resolve(); await new Promise(done => setTimeout(done, 10)); assert.equal(f.sent.length, 0); assert.deepEqual(f.errors, []);
});

test("ended or removed projections close peers before any controller persistence callback can drain", async () => {
  for (const removed of [false, true]) {
    const f = setup(); await f.engine.start(stream);
    f.setState(removed ? { ...f.state, selfRole: null, members: f.state.members.map(member => member.id === MEMBER_A ? { ...member, status: "removed", role: null } : member) } : { ...f.state, status: "ended" });
    await f.engine.refresh(); assert(f.peers.every(peer => peer.closed)); assert(f.engine.peerReadiness.every(peer => !peer.connected)); f.engine.close();
  }
});
test("a new peer epoch rewinds an offer polled before the corresponding state update", async () => {
  const f = setup(true);
  const offer = f.signal({ type: "offer", sdp: "renewed-offer", rosterRevision: 1, toConnectionEpoch: EPOCH }); offer.connectionEpoch = THIRD;
  try {
    await f.engine.start(stream); await until(() => f.polls >= 1); assert.equal(f.peers[0].descriptions.length, 0);
    f.setState({ ...f.state, members: f.state.members.map(member => member.id === MEMBER_A ? { ...member, connectionEpoch: THIRD } : member) });
    await f.engine.refresh(); await until(() => f.peers[1]?.descriptions.length === 1);
    assert.equal(f.peers[1].descriptions[0].sdp, "renewed-offer"); assert(f.peers[0].closed);
    assert.equal(JSON.parse(f.sent.at(-1)!.payload).toConnectionEpoch, THIRD); assert.deepEqual(f.errors, []);
  } finally { f.engine.close(); }
});


test("SQL-shaped reset floor revalidates authority and still processes current SDP and ICE in that page", async () => {
  const f = setup(); f.floor(1);
  f.signal({ type: "answer", sdp: "expired-recipient", rosterRevision: 1, toConnectionEpoch: THIRD });
  f.signal({ type: "answer", sdp: "current-answer", rosterRevision: 1, toConnectionEpoch: EPOCH });
  f.signal({ candidate: "current-ice", rosterRevision: 1, toConnectionEpoch: EPOCH }, MEMBER_B, "ice");
  try {
    await f.engine.start(stream); await until(() => f.peers[0]?.candidates.length === 1);
    assert(f.stateReads >= 2); assert.deepEqual(f.peers[0].descriptions.map(value => value.sdp), ["current-answer"]);
    assert.deepEqual(f.errors, []);
  } finally { f.engine.close(); }
});


test("an expected epoch reset remains expected across every paginated floor page", async () => {
  const f = setup(); f.pageSize(1); f.floor(2);
  f.setState({ ...f.state, connectionEpoch: THIRD, members: f.state.members.map(member => member.id === MEMBER_A ? { ...member, connectionEpoch: THIRD } : member) });
  f.signal({ type: "answer", sdp: "new-answer", rosterRevision: 1, toConnectionEpoch: THIRD });
  f.signal({ candidate: "new-ice", rosterRevision: 1, toConnectionEpoch: THIRD }, MEMBER_B, "ice");
  try {
    await f.engine.start(stream); await until(() => f.peers[0]?.candidates.length === 1);
    assert(f.polls >= 2); assert(!f.statuses.some(status => status.kind === "recovery-required" && status.reason === "signalling_expired"));
  } finally { f.engine.close(); }
});
test("a room-wide floor hint cannot declare an already authenticated connected peer expired", async () => {
  const f = setup(); f.floor(1);
  try {
    await f.engine.start(stream);
    f.peers[0].channel.onmessage?.({ data: encodeEnvelope({ roomId: ROOM_ID, sessionId: SESSION_ID, memberId: MEMBER_B, connectionEpoch: EPOCH, rosterRevision: 1, seq: 1 }, "hello", { peerEpoch: EPOCH }) });
    await until(() => f.polls >= 1);
    assert(f.engine.peerReadiness.every(peer => peer.connected));
    assert(!f.statuses.some(status => status.kind === "recovery-required" && status.reason === "signalling_expired"));
  } finally { f.engine.close(); }
});
