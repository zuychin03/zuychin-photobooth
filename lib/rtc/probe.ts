import { appendProjectMedia, createProject, type PhotoProject } from "../projects/model";
import { openProjectRepository, type ProjectRepository } from "../projects/storage";
import type { RoomCapture, RoomRole, RoomSignal, RoomState } from "../server/room-contract";
import { RoomEngineV2 } from "./engine-v2";
import type { RoomApi } from "./signaling-v2";
import { openTransferJournal, transferHash, type TransferJournal } from "./transfer-store";

export interface RoomMeshProbeResult { members: number; passed: string[]; elapsedMs: number }
const waitFor = async (predicate: () => boolean, description: string, timeout = 15000) => {
  const until = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= until) throw new Error(`Room probe timed out: ${description}`); await new Promise(resolve => setTimeout(resolve, 25)); }
};
const deleteFixture = (name: string) => new Promise<void>((resolve, reject) => {
  if (!name.startsWith("pb-room-mesh-probe-")) { reject(new Error("Not a fixture database")); return; }
  const request = indexedDB.deleteDatabase(name);
  request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error("Fixture database is still open"));
});

/** Uses native RTC and storage with a synthetic authority, never a camera or hosted room. */
export async function runRoomMeshProbe(count: 2 | 4 = 2): Promise<RoomMeshProbeResult> {
  if (count !== 2 && count !== 4) throw new Error("Probe supports two or four members");
  const started = Date.now(), roomId = crypto.randomUUID(), sessionId = crypto.randomUUID(), prefix = `pb-room-mesh-probe-${crypto.randomUUID()}`;
  const members: RoomState["members"] = Array.from({ length: count }, (_, i) => ({ id: crypto.randomUUID(), role: (["A", "B", "C", "D"] as const)[i], displayName: `Fixture ${i + 1}`, status: "admitted", connectionEpoch: crypto.randomUUID() }));
  const expiresAt = Date.now() + 120000, signals: RoomSignal[] = [], passed: string[] = [], errors: string[] = [];
  let capture: RoomCapture | null = null, cursor = 0;
  const canvases: HTMLCanvasElement[] = [], streams: MediaStream[] = [], engines: RoomEngineV2[] = [], repositories: ProjectRepository[] = [], journals: TransferJournal[] = [], names: string[] = [];
  const projects: PhotoProject[] = [], writes: Promise<void>[] = [], originals: Blob[] = [];
  const state = (index: number): RoomState => ({ roomId, sessionId, code: "ABC234", hostId: members[0].id, selfId: members[index].id, selfRole: members[index].role, connectionEpoch: members[index].connectionEpoch, status: "open", locked: false, rosterRevision: 1, expiresAt, serverNow: Date.now(), members: structuredClone(members), capture: structuredClone(capture) });
  const requireCapture = (id: string) => { if (!capture || capture.captureId !== id) throw new Error("Fixture capture missing"); return capture; };
  const api = (index: number): RoomApi => ({
    state: async () => state(index),
    signal: async input => { signals.push({ ...input, id: ++cursor, fromMemberId: members[index].id, createdAt: Date.now() }); return { cursor }; },
    poll: async after => { const page = signals.filter(signal => signal.id > after && signal.toMemberId === members[index].id).slice(0, 16); return { signals: structuredClone(page), cursor: page.at(-1)?.id ?? after, resetRequired: false, serverNow: Date.now() }; },
    prepare: async proposal => { if (index !== 0) throw new Error("Fixture host required"); capture = { ...structuredClone(proposal), memberIds: members.map(member => member.id), acks: [], state: "prepared" }; return structuredClone(capture); },
    ack: async input => { const value = requireCapture(input.captureId); if (!value.acks.includes(members[index].id)) value.acks.push(members[index].id); return structuredClone(value); },
    commit: async id => { const value = requireCapture(id); if (index !== 0 || value.acks.length !== count) throw new Error("Fixture not ready"); value.state = "committed"; return structuredClone(value); },
    abort: async id => { const value = requireCapture(id); value.state = "aborted"; return structuredClone(value); },
    capture: async id => structuredClone(requireCapture(id)),
    control: async () => { throw new Error("Fixture control unsupported"); },
  });
  const persist = (index: number, owner: number, blob: Blob) => {
    const result = writes[index].then(async () => {
      const previous = projects[index], role = members[owner].role as RoomRole, mediaId = `photo-${role}`;
      if (previous.media.some(media => media.id === mediaId)) return;
      const next = appendProjectMedia(previous, [{ id: mediaId, kind: "photo", mime: "image/png", bytes: blob.size, width: 256, height: 192, participantId: members[owner].id }], { ...previous.sourceOrder, [role]: [mediaId] }, new Date(capture!.fireAt).toISOString());
      projects[index] = await repositories[index].save(next, new Map([[mediaId, blob]]), previous.revision);
    });
    writes[index] = result; return result;
  };
  try {
    for (let index = 0; index < count; index++) {
      const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 192; canvases.push(canvas);
      const context = canvas.getContext("2d")!; const pixels = context.createImageData(256, 192);
      let seed = index + 7;
      for (let offset = 0; offset < pixels.data.length; offset += 4) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels.data[offset] = seed & 255; pixels.data[offset + 1] = (seed >>> 8) & 255; pixels.data[offset + 2] = (seed >>> 16) & 255; pixels.data[offset + 3] = 255; }
      context.putImageData(pixels, 0, 0);
      originals.push(await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Fixture PNG unavailable")), "image/png")));
      streams.push(canvas.captureStream(1));
      const projectDb = `${prefix}-project-${index}`, journalDb = `${prefix}-journal-${index}`; names.push(projectDb, journalDb);
      const repository = await openProjectRepository({ kind: "device" }, { databaseName: projectDb }); repositories.push(repository);
      projects.push(await repository.save(createProject({ name: "Disposable RTC probe", mode: count === 2 ? "duo" : "group", role: members[index].role!, participants: members.map(member => ({ id: member.id, role: member.role! })), capture: { requiredShots: 1 } }), new Map(), null));
      writes.push(Promise.resolve());
      const journal = await openTransferJournal({ scope: { kind: "device" }, roomId, sessionId, selfId: members[index].id }, { databaseName: journalDb }); journals.push(journal);
      engines.push(new RoomEngineV2({ initial: state(index), scope: { kind: "device" }, iceServers: [], api: api(index), journal,
        readiness: async () => true,
        captureShot: async () => { await persist(index, index, originals[index]); return originals[index]; },
        commitRemoteFrame: async ({ manifest, blob }) => { const owner = members.findIndex(member => member.id === manifest.memberId); if (owner < 0) throw new Error("Unknown fixture owner"); await persist(index, owner, blob); },
        onState() {}, onStatus() {}, onRemoteStream() {}, onError: code => { if (errors.length < 20) errors.push(code); },
      }));
    }
    await Promise.all(engines.map((engine, index) => engine.start(streams[index])));
    await waitFor(() => engines.every(engine => engine.peerReadiness.length === count - 1 && engine.peerReadiness.every(peer => peer.connected)), `native ${count}-peer mesh (${errors.join(", ")})`);
    passed.push(`${count} native peers complete identity-bound data-channel handshakes without STUN`);
    const proposal = await engines[0].prepareCapture({ captureId: crypto.randomUUID(), rosterRevision: 1, recipeHash: "a".repeat(64), shotIds: ["one"], fireAt: Date.now() + 4500, intervalMs: 1000, profile: { shotsPerMember: 1, maxPhotoBytes: 1024 * 1024, maxPhotoPixels: 256 * 192 } });
    await waitFor(() => capture?.acks.length === count, "all readiness acknowledgements", 2500);
    await engines[0].commitCapture(proposal.captureId);
    await waitFor(() => projects.every(project => project.media.length === count), `all originals committed (${errors.join(", ")})`, 20000);
    await Promise.all(writes);
    if (errors.length) throw new Error(`Unexpected transport errors: ${errors.join(", ")}`);
    passed.push("Future-time capture claims once and all originals commit through the project repository");
    for (let index = 0; index < count; index++) {
      const loaded = await repositories[index].load(projects[index].id);
      if (!loaded || loaded.kind !== "current" || loaded.media.size !== count) throw new Error("Project reload missing originals");
      for (let owner = 0; owner < count; owner++) {
        const blob = loaded.media.get(`photo-${members[owner].role}`)!;
        if (await transferHash(new Uint8Array(await blob.arrayBuffer())) !== await transferHash(new Uint8Array(await originals[owner].arrayBuffer()))) throw new Error("Reloaded original differs");
      }
    }
    passed.push("Every receiver reloads byte-identical multi-chunk PNG originals from IndexedDB");
    const receiptDeadline = Date.now() + 5000;
    while (!(await Promise.all(journals.map(journal => journal.list()))).every(items => items.length === count && items.every(item => item.committed))) {
      if (Date.now() > receiptDeadline) throw new Error("Durable transfer acknowledgements did not complete");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    passed.push("All frozen recipients acknowledge only after durable project commit, then temporary bytes are released");
    await waitFor(() => engines.every(engine => engine.peerReadiness.every(peer => peer.connected)), "mesh remains connected");
    return { members: count, passed, elapsedMs: Date.now() - started };
  } finally {
    engines.forEach(engine => engine.close()); streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    await Promise.allSettled(writes); journals.forEach(journal => journal.close()); repositories.forEach(repository => repository.close());
    canvases.forEach(canvas => { canvas.width = 0; canvas.height = 0; });
    await Promise.all(names.map(deleteFixture));
  }
}
