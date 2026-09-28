export interface TurnPeerState {
  iceConnectionState: RTCIceConnectionState | null;
  connectionState: RTCPeerConnectionState | null;
  dtlsState: RTCDtlsTransportState | null;
  sctpState: RTCSctpTransportState | null;
}
export interface TurnProbeResult {
  peerStates: [TurnPeerState | null, TurnPeerState | null];
  failureOrigin: "setup" | "signalling" | "add_ice_candidate" | "peer_connection" | "data_channel" | "payload_mismatch" | "stats" | null;
  configured: boolean;
  phase: "setup" | "offer" | "answer" | "ice" | "data" | "stats";
  iceErrorCodes: number[];
  relayCandidates: [number, number];
  category: "success" | "not_configured" | "cancelled" | "timeout" | "connection_failed" | "relay_unverified";
  transport: "udp" | "tcp" | "mixed" | "unknown";
  durationMs: number;
  bytes: number;
}
const payload = "photobooth-turn-probe-v1";
function stateEnum<T extends string>(read: () => unknown, allowed: readonly T[]): T | null {
  try { const value = read(); return typeof value === "string" && allowed.includes(value as T) ? value as T : null; }
  catch { return null; }
}
function peerState(peer?: RTCPeerConnection): TurnPeerState | null {
  if (!peer) return null;
  return {
    iceConnectionState: stateEnum(() => peer.iceConnectionState, ["new", "checking", "connected", "completed", "failed", "disconnected", "closed"] as const),
    connectionState: stateEnum(() => peer.connectionState, ["new", "connecting", "connected", "disconnected", "failed", "closed"] as const),
    dtlsState: stateEnum(() => peer.sctp?.transport.state, ["new", "connecting", "connected", "closed", "failed"] as const),
    sctpState: stateEnum(() => peer.sctp?.state, ["connecting", "connected", "closed"] as const),
  };
}
export async function checkTurn(servers: RTCIceServer[], signal: AbortSignal, create: (config: RTCConfiguration) => RTCPeerConnection = config => new RTCPeerConnection(config)): Promise<TurnProbeResult> {
  const started = performance.now();
  const peers: RTCPeerConnection[] = [], channels: RTCDataChannel[] = [];
  let failureOrigin: TurnProbeResult["failureOrigin"] = null;
  let phase: TurnProbeResult["phase"] = "setup";
  const iceErrorCodes = new Set<number>(), relayCandidates: [number, number] = [0, 0];
  const configured = servers.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => /^turns?:/i.test(url)));
  const result = (category: TurnProbeResult["category"], transport: TurnProbeResult["transport"] = "unknown", bytes = 0): TurnProbeResult => ({ configured, failureOrigin, category, transport, bytes, phase, peerStates: [peerState(peers[0]), peerState(peers[1])], iceErrorCodes: [...iceErrorCodes].sort((a, b) => a - b), relayCandidates: [...relayCandidates], durationMs: Math.round(performance.now() - started) });
  if (signal.aborted) return result("cancelled");
  if (!configured) return result("not_configured");
  let stopped = false;
  let settle!: (value: TurnProbeResult) => void;
  const completion = new Promise<TurnProbeResult>(resolve => { settle = resolve; });
  const finish = (category: TurnProbeResult["category"], transport?: TurnProbeResult["transport"], bytes?: number) => {
    if (stopped) return; stopped = true; settle(result(category, transport, bytes));
  };
  const fail = (origin: NonNullable<TurnProbeResult["failureOrigin"]>) => { if (!stopped) { failureOrigin = origin; finish("connection_failed"); } };
  const cancel = () => finish("cancelled");
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => finish("timeout"), 24_000);
  const waitingForIce = () => { if (phase === "answer") phase = "ice"; };
  const live = () => { if (stopped) throw new Error("stopped"); };
  try {
    const config: RTCConfiguration = { iceServers: servers, iceTransportPolicy: "relay" };
    const a = create(config); peers.push(a);
    const b = create(config); peers.push(b);
    const buffered = new Map<RTCPeerConnection, RTCIceCandidateInit[]>([[a, []], [b, []]]);
    const candidate = (target: RTCPeerConnection, value: RTCIceCandidate | null) => {
      if (stopped || !value) return;
      if (value.type === "relay") relayCandidates[target === b ? 0 : 1]++;
      if (!target.remoteDescription) buffered.get(target)!.push(value.toJSON());
      else void target.addIceCandidate(value).catch(() => fail("add_ice_candidate"));
    };
    a.onicecandidate = event => candidate(b, event.candidate);
    b.onicecandidate = event => candidate(a, event.candidate);
    for (const peer of peers) peer.onicecandidateerror = event => { if (!stopped && Number.isInteger(event.errorCode) && event.errorCode >= 100 && event.errorCode <= 799) iceErrorCodes.add(event.errorCode); };
    for (const peer of peers) peer.onconnectionstatechange = () => { if (peer.connectionState === "failed") fail("peer_connection"); };
    const relay = async (peer: RTCPeerConnection) => {
      phase = "stats";
      const stats = await peer.getStats(); live();
      let pair: { localCandidateId?: string; remoteCandidateId?: string } | undefined;
      stats.forEach(value => { if (value.type === "transport" && value.selectedCandidatePairId) pair = stats.get(value.selectedCandidatePairId); });
      if (!pair) stats.forEach(value => { if (value.type === "candidate-pair" && value.state === "succeeded" && value.nominated) pair = value; });
      const local = pair && stats.get(pair.localCandidateId!), remote = pair && stats.get(pair.remoteCandidateId!);
      if (local?.candidateType !== "relay" || remote?.candidateType !== "relay") return null;
      return local.relayProtocol === "udp" || local.relayProtocol === "tcp" ? local.relayProtocol as "udp" | "tcp" : "unknown";
    };
    b.ondatachannel = event => {
      if (stopped) { event.channel.close(); return; }
      channels.push(event.channel);
      event.channel.onmessage = message => { if (!stopped && message.data === payload) { try { event.channel.send(payload); } catch { fail("data_channel"); } } else fail("payload_mismatch"); };
      event.channel.onerror = () => fail("data_channel");
    };
    const channel = a.createDataChannel("turn-probe"); channels.push(channel);
    channel.onopen = () => { phase = "data"; if (!stopped) { try { channel.send(payload); } catch { fail("data_channel"); } } };
    channel.onerror = () => fail("data_channel");
    channel.onmessage = message => {
      if (message.data !== payload) { fail("payload_mismatch"); return; }
      void Promise.all([relay(a), relay(b)]).then(([first, second]) => {
        if (!first || !second) { if (!stopped) failureOrigin = "stats"; finish("relay_unverified"); }
        else finish("success", first === second ? first : "mixed", new TextEncoder().encode(payload).length * 2);
      }).catch(() => fail("stats"));
    };
    const remote = async (peer: RTCPeerConnection, description: RTCSessionDescriptionInit) => {
      await peer.setRemoteDescription(description); live();
      for (const item of buffered.get(peer)!.splice(0)) { try { await peer.addIceCandidate(item); } catch { fail("add_ice_candidate"); throw new Error("candidate_failed"); } live(); }
    };
    void (async () => {
      phase = "offer";
      const offer = await a.createOffer(); live(); await a.setLocalDescription(offer); live();
      await remote(b, offer);
      phase = "answer";
      const answer = await b.createAnswer(); live(); await b.setLocalDescription(answer); live();
      await remote(a, answer); waitingForIce();
    })().catch(() => fail("signalling"));
    return await completion;
  } catch { fail("setup"); return await completion; }
  finally {
    stopped = true; clearTimeout(timer); signal.removeEventListener("abort", cancel);
    for (const channel of channels) { channel.onopen = null; channel.onmessage = null; channel.onerror = null; try { channel.close(); } catch {} }
    for (const peer of peers) { peer.onicecandidate = null; peer.onicecandidateerror = null; peer.ondatachannel = null; peer.onconnectionstatechange = null; try { peer.close(); } catch {} }
  }
}
