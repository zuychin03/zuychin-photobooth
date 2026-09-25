import type { RoomCapture, RoomSignal, RoomState } from "../server/room-contract";
import { openProjectRepository } from "../projects/storage";
import { openRoomWorkspaceStore } from "./workspace-store";
import { openTransferJournal } from "./transfer-store";
import { RoomEngineV2 } from "./engine-v2";
import { RoomWorkspaceController } from "./workspace-controller";
import type { RoomApi } from "./signaling-v2";

export interface RoomFixturePerson {
  name: string; controller: RoomWorkspaceController; stream: MediaStream; projectDatabaseName: string;
  readState(): Promise<RoomState>;
}
export interface RoomWorkspaceFixture {
  people: RoomFixturePerson[];
  diagnostics: string[];
  disconnectHost(): void;
  failNextHostSave(): void;
  stop(): Promise<void>;
}

export async function createRoomWorkspaceFixture(count: 2 | 4): Promise<RoomWorkspaceFixture> {
  if (process.env.NODE_ENV !== "development") throw new Error("Room fixture is development-only");
  const prefix = `pb-room-ui-fixture-${crypto.randomUUID()}`, roomId = crypto.randomUUID(), sessionId = crypto.randomUUID();
  const members: RoomState["members"] = Array.from({ length: count }, (_, index) => ({ id: crypto.randomUUID(), role: index === 0 ? "A" : null, displayName: ["Alex", "Bao", "Cleo", "Dara"][index], status: index === 0 ? "admitted" : "pending", connectionEpoch: crypto.randomUUID() }));
  let revision = 1, cursor = 0, signalFloor = 0, ended = false, locked = false, stopped = false, failHostSave = false;
  const expiresAt = Date.now() + 30 * 60 * 1000, signals: RoomSignal[] = [], captures = new Map<string, RoomCapture>();
  let capture: RoomCapture | null = null;
  const timers: ReturnType<typeof setInterval>[] = [], canvases: HTMLCanvasElement[] = [], people: RoomFixturePerson[] = [], names: string[] = [], diagnostics: string[] = [];
  const state = (index: number): RoomState => ({ roomId, sessionId, code: "V2TEST", hostId: members[0].id, selfId: members[index].id, selfRole: members[index].status === "admitted" ? members[index].role : null, connectionEpoch: members[index].connectionEpoch, status: ended ? "ended" : "open", locked, rosterRevision: revision, expiresAt, serverNow: Date.now(), members: structuredClone(members), capture: structuredClone(capture) });
  const requireCapture = (id: string) => { const value = captures.get(id); if (!value) throw new Error("state_conflict"); return value; };
  const apiFor = (index: number): RoomApi => ({
    state: async renew => { if (renew) { members[index].connectionEpoch = crypto.randomUUID(); signalFloor = cursor; for (let item = signals.length - 1; item >= 0; item--) if ([signals[item].fromMemberId, signals[item].toMemberId].includes(members[index].id)) signals.splice(item, 1); if (capture?.state === "prepared") capture.state = "aborted"; } return state(index); },
    signal: async input => { signals.push({ ...input, id: ++cursor, fromMemberId: members[index].id, createdAt: Date.now() }); if (signals.length > 128) signals.shift(); return { cursor }; },
    poll: async after => { const page = signals.filter(signal => signal.id > after && signal.toMemberId === members[index].id).slice(0, 16); return { signals: structuredClone(page), cursor: page.at(-1)?.id ?? cursor, resetRequired: after < signalFloor, serverNow: Date.now() }; },
    prepare: async proposal => { if (index !== 0) throw new Error("access_denied"); capture = { ...structuredClone(proposal), memberIds: members.filter(member => member.status === "admitted").map(member => member.id), acks: [], state: "prepared" }; captures.set(capture.captureId, capture); return structuredClone(capture); },
    ack: async input => { const value = requireCapture(input.captureId); if (!value.memberIds.includes(members[index].id) || input.recipeHash !== value.recipeHash) throw new Error("not_ready"); if (!value.acks.includes(members[index].id)) value.acks.push(members[index].id); return structuredClone(value); },
    commit: async id => { const value = requireCapture(id); if (index !== 0 || value.acks.length !== value.memberIds.length || Date.now() > value.fireAt - 1000) throw new Error("not_ready"); value.state = "committed"; return structuredClone(value); },
    abort: async id => { const value = requireCapture(id); if (index !== 0) throw new Error("access_denied"); value.state = "aborted"; return structuredClone(value); },
    capture: async (id, peerId) => { const value = requireCapture(id); if (![members[index].id, ...(peerId ? [peerId] : [])].every(person => value.memberIds.includes(person) && members.some(member => member.id === person && member.status === "admitted"))) throw new Error("access_denied"); return structuredClone(value); },
    control: async (action, body) => {
      if (index !== 0) throw new Error("access_denied");
      if (action === "end") { ended = true; return { ended: true }; }
      if (action === "lock") locked = body.locked === true;
      else {
        const member = members.find(item => item.id === body.memberId);
        if (!member || member.id === members[0].id) throw new Error("invalid_request");
        if (action === "admit") { const role = (["B", "C", "D"] as const).find(value => !members.some(item => item.status === "admitted" && item.role === value)); if (!role) throw new Error("room_full"); member.status = "admitted"; member.role = role; }
        else member.status = "removed";
        revision++; if (capture?.state === "prepared") capture.state = "aborted";
      }
      return state(index);
    },
  });
  for (let index = 0; index < count; index++) {
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 480; canvases.push(canvas);
    const context = canvas.getContext("2d")!; let tick = 0;
    const paint = () => { context.fillStyle = ["#ec718e", "#25a69b", "#9581d9", "#dcb760"][index]; context.fillRect(0, 0, 640, 480); context.fillStyle = "#faf7f2"; context.beginPath(); context.ellipse(320, 170, 65, 75, 0, 0, Math.PI * 2); context.fill(); context.fillRect(210, 260, 220, 220); context.fillStyle = "#272321"; context.font = "bold 25px sans-serif"; context.fillText(`${members[index].displayName} · ${tick++}`, 24, 40); };
    paint(); timers.push(setInterval(paint, 250));
    const stream = canvas.captureStream(8), projectDatabaseName = `${prefix}-${index}-projects`, metadataName = `${prefix}-${index}-metadata`, journalName = `${prefix}-${index}-transfer`;
    names.push(projectDatabaseName, metadataName, journalName);
    const api = apiFor(index);
    const controller = new RoomWorkspaceController(state(index), { kind: "device" }, {
      api, iceServers: () => [],
      onError: error => { diagnostics.push(`${members[index].displayName}: ${error instanceof Error ? error.message : "fixture_error"}`); if (diagnostics.length > 20) diagnostics.shift(); },
      openStore: async binding => {
        const store = await openRoomWorkspaceStore(binding, { databaseName: metadataName, projectDatabaseName });
        return { ...store, saveFrame: async input => {
          if (index === 0 && input.role === "A" && failHostSave) { failHostSave = false; throw new DOMException("Synthetic save failure", "QuotaExceededError"); }
          return store.saveFrame(input);
        } };
      },
      openRepository: scope => openProjectRepository(scope, { databaseName: projectDatabaseName }),
      createEngine: options => new RoomEngineV2({ ...options, api, openJournal: () => openTransferJournal({ scope: { kind: "device" }, roomId, sessionId, selfId: members[index].id }, { databaseName: journalName }) }),
    });
    people.push({ name: members[index].displayName, controller, stream, projectDatabaseName, readState: async () => { if (stopped) throw new Error("Fixture stopped"); return state(index); } });
    await controller.start();
  }
  return {
    people, diagnostics,
    disconnectHost() { people[0].controller.disconnect(); },
    failNextHostSave() { failHostSave = true; },
    async stop() {
      if (stopped) return; stopped = true;
      for (const timer of timers) clearInterval(timer);
      for (const person of people) person.stream.getTracks().forEach(track => track.stop());
      await Promise.all(people.map(person => person.controller.close()));
      for (const canvas of canvases) canvas.width = canvas.height = 0;
      await Promise.all(names.map(name => new Promise<void>((resolve, reject) => {
        if (!name.startsWith(`${prefix}-`)) { reject(new Error("Invalid fixture database")); return; }
        const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error("A fixture database is still closing. Reload the lab before retrying."));
      })));
    },
  };
}
