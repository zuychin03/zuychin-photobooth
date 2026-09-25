import type { LegacyRoomRehearsal } from "../../components/rooms/LegacyRoom";
import { createProject, appendProjectMedia, type PhotoProject } from "../projects/model";
import { openProjectRepository } from "../projects/storage";
import { inspectProjectImage } from "../projects/images";
import { projectBlobHash } from "../projects/bundle";
import { relayFrameOriginal } from "../relay-recovery";
import type { Role } from "../layouts";
import type { RoomEngine } from "./engine";
import { newRoomCode } from "../room-code";

export async function createLegacyRoomFixture() {
  if (process.env.NODE_ENV !== "development") throw new Error("Development only");
  const suffix = crypto.randomUUID(), code = newRoomCode();
  const diagnostics: string[] = [], people: { name: string; props: LegacyRoomRehearsal; databaseName: string; stop(): Promise<void>; inspect(): Promise<string> }[] = [];
  const log = (line: string) => { diagnostics.push(line); if (diagnostics.length > 40) diagnostics.shift(); };
  let failHost = false;
  try {
    for (let index = 0; index < 2; index++) {
      const name = index === 0 ? "Host" : "Guest", databaseName = `pb-legacy-room-${suffix}-${index}`;
      let active = true, engine: RoomEngine | null = null, project: PhotoProject | null = null, queue: Promise<unknown> = Promise.resolve();
      const check = () => { if (!active) throw new Error("Synthetic room stopped"); };
      const expectedHashes = new Map<string, string>();
      const repository = await openProjectRepository({ kind: "device" }, { databaseName, assertActive: check });
      const enqueue = <T,>(operation: () => Promise<T>): Promise<T> => { const work = queue.catch(() => {}).then(() => { check(); return operation(); }); queue = work; return work; };
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 480;
      let tick = 0; const paint = () => { const ctx = canvas.getContext("2d")!; ctx.fillStyle = index ? "#3557b8" : "#af3858"; ctx.fillRect(0, 0, 640, 480); ctx.fillStyle = "#fff"; ctx.font = "32px sans-serif"; ctx.fillText(`${name} · synthetic ${++tick}`, 30, 80); };
      paint(); const animation = setInterval(paint, 100), stream = canvas.captureStream(10);
      const videoRef = { current: null as HTMLVideoElement | null };
      const save = (role: Role, shot: number, original: Blob, local: boolean) => enqueue(async () => {
        if (!project) throw new Error("The synthetic round has not started");
        if (local && index === 0 && failHost) { failHost = false; log("Host original save refused once; use Retry unsaved photos in the actual room."); throw new Error("Synthetic local storage refusal. Retry the retained original."); }
        const info = await inspectProjectImage(original); check();
        const id = crypto.randomUUID(), sources = [...project.sourceOrder[role]]; while (sources.length <= shot) sources.push(null); sources[shot] = id;
        const next = appendProjectMedia(project, [{ ...info, id, kind: "photo", participantId: `synthetic-${role}`, bytes: original.size }], { ...project.sourceOrder, [role]: sources }, new Date().toISOString());
        const hash = await projectBlobHash(original); check(); await repository.save(next, new Map([[id, original]]), project.revision); check(); project = next; expectedHashes.set(id, hash);
        log(`${name}: saved ${role} photo ${shot + 1}; ${project.media.length} originals in isolated IDB.`);
      });
      const props: LegacyRoomRehearsal = {
        code, isHost: index === 0,
        camera: { videoRef, stream: { current: stream }, ready: true, error: null, facing: "user", cameras: [], canFlip: false, attachVideo(element) { videoRef.current = element; if (element) { element.srcObject = stream; void element.play().catch(() => {}); } }, toggleFacing() {}, retry() { void videoRef.current?.play().catch(() => {}); } },
        session: { hydrating: false, update: patch => enqueue(async () => {
          if (project) throw new Error("Stop this rehearsal before starting a new round");
          const next = createProject({ name: `${name} legacy room rehearsal`, mode: patch.mode, role: patch.role, participants: (patch.members ?? ["A", "B"]).map(role => ({ id: `synthetic-${role}`, role })), editor: { layoutId: patch.layoutId, filterId: patch.filterId, sceneId: patch.sceneId } });
          await repository.save(next, new Map(), null); check(); project = next; log(`${name}: round project saved before capture.`);
        }), async setShot(role, shot, frame) { const blob = await relayFrameOriginal(frame); check(); await save(role, shot, blob, true); }, async importShot(role, shot, blob) { await save(role, shot, blob, false); } },
        navigation: { push(path) { log(`${name}: actual room requested ${path}. Saved project remains in fixture for inspection.`); }, replace(path) { log(`${name}: actual room requested replacement ${path}.`); } },
        onEngine(value) { engine = value; },
      };
      people.push({ name, props, databaseName,
        async inspect() { await queue.catch(() => {}); check(); if (!project) return `${name}: no round saved yet.`; const reopened = await openProjectRepository({ kind: "device" }, { databaseName, assertActive: check }); let loaded; try { loaded = await reopened.load(project.id); } finally { reopened.close(); } if (loaded?.kind !== "current") throw new Error("Saved project could not reopen"); for (const blob of loaded.media.values()) await inspectProjectImage(blob); const hashes = await Promise.all([...loaded.media].map(async ([id, blob]) => { const hash = await projectBlobHash(blob); if (hash !== expectedHashes.get(id)) throw new Error("Stored original differs from received bytes"); return hash; })); return `${name}: reopened ${loaded.media.size} originals, ${hashes.length} SHA-256 hashes verified; role A=${loaded.project.sourceOrder.A.filter(Boolean).length}, role B=${loaded.project.sourceOrder.B.filter(Boolean).length}.`; },
        async stop() { if (!active) return; active = false; engine?.close(); clearInterval(animation); stream.getTracks().forEach(track => track.stop()); if (videoRef.current) videoRef.current.srcObject = null; canvas.width = canvas.height = 0; await queue.catch(() => {}); repository.close(); await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(databaseName); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error("Synthetic database cleanup blocked")); }); },
      });
    }
  } catch (error) { await Promise.allSettled(people.map(person => person.stop())); throw error; }
  return { people, diagnostics, failNextHostSave() { failHost = true; log("Next local host original save will be refused once."); }, async inspect() { for (const person of people) log(await person.inspect()); }, disconnectGuest() { return people[1].stop().then(() => log("Guest disconnected and its isolated database removed; host originals remain.")); }, async stop() { await Promise.all(people.map(person => person.stop())); log("Both synthetic streams, engines and isolated databases cleared."); } };
}
export type LegacyRoomFixture = Awaited<ReturnType<typeof createLegacyRoomFixture>>;
