import assert from "node:assert/strict";
import test from "node:test";
import { RoomEngineV2, type RoomEngineV2Options, type RoomV2Status } from "../lib/rtc/engine-v2";
import type { RoomState } from "../lib/server/room-contract";
import type { RoomApi } from "../lib/rtc/signaling-v2";
import { EPOCH, MEMBER_A, MEMBER_B, ROOM_ID, SESSION_ID, captureFixture, memoryJournal } from "./helpers/room-fixture";
const snapshot = (pending = false): RoomState => ({ roomId: ROOM_ID, code: "ABC234", sessionId: SESSION_ID, hostId: pending ? MEMBER_B : MEMBER_A, selfId: MEMBER_A, selfRole: pending ? null : "A", connectionEpoch: EPOCH, status: "open", locked: false, rosterRevision: 1, expiresAt: Date.now() + 60000, serverNow: Date.now(), members: [{ id: MEMBER_A, role: pending ? null : "A", displayName: "Fixture", status: pending ? "pending" : "admitted", connectionEpoch: EPOCH }], capture: null });
const api = (state: (renew?: boolean) => Promise<RoomState>): RoomApi => ({ state, signal: async () => ({ cursor: 0 }), poll: async () => ({ signals: [], cursor: 0, serverNow: Date.now(), resetRequired: false }), prepare: async () => { throw new Error("unused"); }, ack: async capture => capture, commit: async () => { throw new Error("unused"); }, abort: async () => { throw new Error("unused"); }, capture: async () => { throw new Error("unused"); }, control: async () => ({ ended: true }) });
const options = (initial: RoomState, transport: RoomApi, status: RoomV2Status[]): RoomEngineV2Options => ({ initial, scope: { kind: "device" }, iceServers: [], journal: memoryJournal().journal, api: transport, readiness: async () => false, captureShot: async () => { throw new Error("unused"); }, commitRemoteFrame: async () => {}, onState() {}, onStatus: value => status.push(value), onRemoteStream() {}, onError() {}, createPeer: () => { throw new Error("must not create a peer"); } });
test("pending admission polls without renewing a privileged connection epoch or creating peers", async () => {
  const state = snapshot(true), renewals: (boolean | undefined)[] = [], statuses: RoomV2Status[] = [];
  const engine = new RoomEngineV2(options(state, api(async renew => { renewals.push(renew); return state; }), statuses));
  try { await engine.start({} as MediaStream); assert.deepEqual(renewals, [false]); assert(statuses.some(status => status.kind === "waiting-admission")); } finally { engine.close(); }
});
test("the current state getter cannot mutate authoritative engine identity", () => {
  const state = snapshot(), engine = new RoomEngineV2(options(state, api(async () => state), []));
  const copy = engine.state; copy.selfId = MEMBER_B; copy.members[0].role = "D";
  assert.equal(engine.state.selfId, MEMBER_A); assert.equal(engine.state.members[0].role, "A"); engine.close();
});

test("peer readiness never treats an admitted but unconnected member as ready", () => {
  const state = snapshot(); state.members.push({ id: MEMBER_B, role: "B", displayName: "Guest", status: "admitted", connectionEpoch: EPOCH });
  const engine = new RoomEngineV2(options(state, api(async () => state), []));
  const peers = engine.peerReadiness;
  assert.equal(peers.length, 1); assert.equal(peers[0].connected, false);
  peers[0].member.id = MEMBER_A;
  assert.equal(engine.peerReadiness[0].member.id, MEMBER_B); engine.close();
  assert.equal(engine.peerReadiness[0].connected, false);
});
test("a late room state after close cannot restart peers or schedule capture", async () => {
  const state = snapshot(), statuses: RoomV2Status[] = []; let resolve!: (value: RoomState) => void;
  const pending = new Promise<RoomState>(done => { resolve = done; });
  const engine = new RoomEngineV2(options(state, api(async () => pending), statuses));
  const start = engine.start({} as MediaStream); engine.close(); resolve(state);
  await assert.rejects(start, /generation_changed/); assert.equal(statuses.at(-1)?.kind, "closed");
});


test("repeated committed state polls cannot restart a finished or incomplete capture UI", async () => {
  const state = snapshot(), statuses: RoomV2Status[] = [];
  state.capture = captureFixture();
  const transport = api(async () => state); transport.capture = async () => state.capture!;
  const engine = new RoomEngineV2(options(state, transport, statuses));
  try {
    await engine.start({ getVideoTracks: () => [] } as unknown as MediaStream);
    await new Promise(resolve => setImmediate(resolve)); await engine.refresh(); await engine.refresh();
    assert.equal(statuses.filter(status => status.kind === "capture-committed").length, 1);
    assert.equal(statuses.filter(status => status.kind === "capture-incomplete").length, 1);
  } finally { engine.close(); }
});

test("an explicit reconnect waits out the obsolete state response then requests a fresh connection epoch", async () => {
  const state = snapshot(), renewals: (boolean | undefined)[] = [];
  let waiting = false, resolve!: (state: RoomState) => void;
  const obsolete = new Promise<RoomState>(done => { resolve = done; });
  const engine = new RoomEngineV2(options(state, api(async renew => { renewals.push(renew); return waiting && !renew ? obsolete : state; }), []));
  try {
    await engine.start({ getVideoTracks: () => [] } as unknown as MediaStream); waiting = true;
    const old = engine.refresh(), rejected = assert.rejects(old, /room_generation_changed/);
    const reconnect = engine.reconnect(); resolve(state); await Promise.all([rejected, reconnect]);
    assert.deepEqual(renewals, [true, false, true]);
  } finally { engine.close(); }
});
