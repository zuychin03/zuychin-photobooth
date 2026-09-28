import assert from "node:assert/strict";
import test from "node:test";
import { checkTurn } from "../lib/rtc/turn-probe";
test("missing TURN never constructs peers", async () => {
  const result = await checkTurn([{ urls: "stun:example.test" }], new AbortController().signal, () => { throw new Error("must not construct"); });
  assert.equal(result.category, "not_configured");
});
test("constructor failure closes the first peer and never exposes credentials", async () => {
  let calls = 0, closed = 0;
  const result = await checkTurn([{ urls: "turn:private.test", credential: "secret" }], new AbortController().signal, () => {
    if (++calls === 2) throw new Error("secret private.test");
    return { close() { closed++; } } as RTCPeerConnection;
  });
  assert.equal(result.failureOrigin, "setup"); assert.equal(closed, 1); assert.equal(result.category, "connection_failed");
  assert(!JSON.stringify(result).includes("secret")); assert(!JSON.stringify(result).includes("private.test"));
});
test("pre-cancelled probe constructs nothing", async () => {
  const abort = new AbortController(); abort.abort();
  const result = await checkTurn([{ urls: "turn:example.test" }], abort.signal, () => { throw new Error("must not construct"); });
  assert.equal(result.category, "cancelled");
});

function peers(candidateType = "relay") {
  const instances: RTCPeerConnection[] = []; let closed = 0;
  const remoteChannel = { onmessage: null, onerror: null, onopen: null, close() {}, send(data: string) { queueMicrotask(() => (channel.onmessage as ((event: { data: string }) => void) | null)?.({ data })); } };
  const channel = { onmessage: null, onopen: null, onerror: null, close() {}, send(data: string) { queueMicrotask(() => (remoteChannel.onmessage as ((event: { data: string }) => void) | null)?.({ data })); } };
  const create = (config: RTCConfiguration) => {
    assert.equal(config.iceTransportPolicy, "relay");
    const peer = {
      remoteDescription: null as RTCSessionDescriptionInit | null,
      close() { closed++; }, createDataChannel: () => channel,
      createOffer: async () => ({ type: "offer", sdp: "private-sdp" }),
      createAnswer: async () => ({ type: "answer", sdp: "private-sdp" }),
      setLocalDescription: async () => {}, addIceCandidate: async () => {},
      setRemoteDescription: async (description: RTCSessionDescriptionInit) => { peer.remoteDescription = description; if (description.type === "answer") { instances[1].ondatachannel?.({ channel: remoteChannel } as unknown as RTCDataChannelEvent); queueMicrotask(() => (channel.onopen as (() => void) | null)?.()); } },
      getStats: async () => new Map([
        ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
        ["pair", { localCandidateId: "local", remoteCandidateId: "remote" }],
        ["local", { candidateType, relayProtocol: "udp", address: "private-ip" }],
        ["remote", { candidateType: "relay" }],
      ]),
    };
    instances.push(peer as unknown as RTCPeerConnection); return peer as unknown as RTCPeerConnection;
  };
  return { create, instances, get closed() { return closed; } };
}
test("verified echo requires relay stats and returns only safe fields", async () => {
  const f = peers(); const result = await checkTurn([{ urls: "turn:private.test" }], new AbortController().signal, f.create);
  assert.equal(result.category, "success"); assert.equal(result.transport, "udp"); assert.equal(result.bytes, 48); assert.equal(f.closed, 2);
  assert.deepEqual(Object.keys(result).sort(), ["bytes", "category", "configured", "durationMs", "failureOrigin", "iceErrorCodes", "peerStates", "phase", "relayCandidates", "transport"]);
});
test("an echo without relay candidate proof is refused", async () => {
  const f = peers("host"); const result = await checkTurn([{ urls: "turn:private.test" }], new AbortController().signal, f.create);
  assert.equal(result.category, "relay_unverified"); assert.equal(result.bytes, 0); assert.equal(f.closed, 2);
});
test("cancellation closes both peers even while offer creation never settles", async () => {
  const f = peers(), abort = new AbortController();
  const result = checkTurn([{ urls: "turn:private.test" }], abort.signal, config => {
    const peer = f.create(config); peer.createOffer = () => new Promise<never>(() => {}); return peer;
  });
  abort.abort(); assert.equal((await result).category, "cancelled"); assert.equal(f.closed, 2);
});


test("ICE diagnostics retain only bounded numeric codes and relay counts", async () => {
  const f = peers();
  const result = await checkTurn([{ urls: "turn:private.test", credential: "secret" }], new AbortController().signal, config => {
    const peer = f.create(config);
    peer.createOffer = async () => {
      for (const errorCode of [701, 701, 401, 900, NaN]) peer.onicecandidateerror?.({ errorCode, errorText: "secret", url: "turn:private.test", address: "private-ip" } as RTCPeerConnectionIceErrorEvent);
      throw new Error("private-ip secret");
    };
    return peer;
  });
  assert.equal(result.failureOrigin, "signalling"); assert.deepEqual(result.iceErrorCodes, [401, 701]); assert.equal(result.phase, "offer");
  assert.deepEqual(result.relayCandidates, [0, 0]);
  assert(!/secret|private/.test(JSON.stringify(result)));
});

test("buffered candidate rejection reports candidate failure rather than signalling", async () => {
  const f = peers();
  const result = await checkTurn([{ urls: "turn:private.test" }], new AbortController().signal, config => {
    const peer = f.create(config), offer = peer.createOffer.bind(peer);
    peer.createOffer = (() => {
      peer.onicecandidate?.({ candidate: { type: "relay", toJSON: () => ({ candidate: "private-candidate" }) } } as unknown as RTCPeerConnectionIceEvent);
      return offer();
    }) as typeof peer.createOffer;
    peer.addIceCandidate = () => Promise.reject(new Error("private-candidate secret"));
    return peer;
  });
  assert.equal(result.failureOrigin, "add_ice_candidate"); assert.equal(f.closed, 2);
  assert.deepEqual(result.relayCandidates, [1, 0]); assert(!/private|secret/.test(JSON.stringify(result)));
});

for (const [name, ice, dtls] of [["ICE failure", "failed", "new"], ["DTLS failure after ICE connects", "connected", "failed"]] as const) {
  test(`${name} is captured before peer cleanup changes the states`, async () => {
    const f = peers();
    const states: { ice: string; connection: string; dtls: string; sctp: string }[] = [];
    const result = await checkTurn([{ urls: "turn:private.test" }], new AbortController().signal, config => {
      const peer = f.create(config), state = { ice, connection: "failed", dtls, sctp: "connecting" };
      states.push(state);
      Object.defineProperties(peer, {
        iceConnectionState: { get: () => state.ice }, connectionState: { get: () => state.connection },
        sctp: { get: () => ({ state: state.sctp, transport: { state: state.dtls } }) },
      });
      const close = peer.close.bind(peer);
      peer.close = () => { Object.assign(state, { ice: "closed", connection: "closed", dtls: "closed", sctp: "closed" }); close(); };
      peer.createOffer = () => { queueMicrotask(() => peer.onconnectionstatechange?.(new Event("connectionstatechange"))); return new Promise<never>(() => {}); };
      return peer;
    });
    assert.equal(result.failureOrigin, "peer_connection");
    assert.deepEqual(result.peerStates, Array.from({ length: 2 }, () => ({ iceConnectionState: ice, connectionState: "failed", dtlsState: dtls, sctpState: "connecting" })));
    assert(states.every(state => Object.values(state).every(value => value === "closed")));
    assert.equal(f.closed, 2);
  });
}

test("state snapshots omit unknown values and tolerate unavailable transport getters", async () => {
  const f = peers();
  const result = await checkTurn([{ urls: "turn:private.test" }], new AbortController().signal, config => {
    const peer = f.create(config);
    Object.defineProperties(peer, {
      iceConnectionState: { get: () => "private-secret" }, connectionState: { get: () => "private-secret" },
      sctp: { get: () => { throw new Error("private-secret"); } },
    });
    peer.createOffer = async () => { throw new Error("private-secret"); };
    return peer;
  });
  assert.deepEqual(result.peerStates, Array.from({ length: 2 }, () => ({ iceConnectionState: null, connectionState: null, dtlsState: null, sctpState: null })));
  assert(!/private|secret/.test(JSON.stringify(result))); assert.equal(f.closed, 2);
});
