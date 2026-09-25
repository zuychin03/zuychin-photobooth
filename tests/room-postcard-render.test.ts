import assert from "node:assert/strict";
import test from "node:test";
import { appendProjectMedia, createProject, type ProjectMedia } from "../lib/projects/model";
import { initialRecipeCommit } from "../lib/rtc/recipe-v2";
import { roomPostcardPlan, renderRoomPostcard, type RoomPostcardRenderPorts } from "../lib/rtc/postcard-render";
import type { WorkspaceSnapshot } from "../lib/rtc/workspace-controller";
import { CAPTURE_ID, EPOCH, MEMBER_A, MEMBER_B, ROOM_ID, SESSION_ID, captureFixture } from "./helpers/room-fixture";

async function fixture() {
  const people = [{ id: MEMBER_A, role: "A" as const }, { id: MEMBER_B, role: "B" as const }];
  const base = createProject({ id: CAPTURE_ID, mode: "duo", role: "A", participants: people });
  const declarations: ProjectMedia[] = people.flatMap(person => Array.from({ length: 4 }, (_, index) => ({ id: `source-${person.role}-${index}`, kind: "photo" as const, participantId: person.id, mime: "image/jpeg" as const, bytes: 10, width: 1600, height: 1200 })));
  const project = appendProjectMedia(base, declarations, { A: declarations.slice(0, 4).map(item => item.id), B: declarations.slice(4).map(item => item.id), C: [], D: [] }, base.createdAt);
  const recipe = await initialRecipeCommit({ project, hostId: MEMBER_A, members: people, availableMediaIds: new Set(project.media.map(item => item.id)) });
  let snapshot: WorkspaceSnapshot = { room: { roomId: ROOM_ID, sessionId: SESSION_ID, code: "ABC234", hostId: MEMBER_A, selfId: MEMBER_A, selfRole: "A", connectionEpoch: EPOCH, status: "open", locked: false, rosterRevision: 1, expiresAt: Date.now() + 60000, serverNow: Date.now(), members: people.map(person => ({ ...person, status: "admitted", displayName: person.role, connectionEpoch: EPOCH })), capture: { ...captureFixture(), shotIds: ["one", "two", "three", "four"], profile: { maxPhotoBytes: 1048576, maxPhotoPixels: 2097152, shotsPerMember: 4 }, recipeHash: recipe.recipeHash } }, draft: project, recipe, round: project, peers: [], status: "", error: null, busy: false, cameraConnected: true, capturing: false, pendingProposal: false, recoveryRecipe: null, captureRequest: null, savedShots: 8, pendingLocalFrames: [], remoteStreamRevision: 0 };
  const originals = new Map(declarations.map(media => [media.id, new Blob([media.id.padEnd(10, "x")], { type: "image/jpeg" })])), images: HTMLCanvasElement[] = [], seen: Blob[] = [];
  let closed = 0, released = 0, renders = 0, authority = 0;
  const ports: RoomPostcardRenderPorts = {
    open: async () => ({ load: async () => ({ kind: "current", readOnly: false, id: project.id, revision: project.revision, project, media: originals, checkpoint: null }), close: () => { closed++; } }),
    state: async () => { authority++; return snapshot.room; },
    decode: async (blob, media) => { seen.push(blob); const canvas = { width: media.width, height: media.height } as HTMLCanvasElement; images.push(canvas); return canvas; },
    prepare: async () => ({ resources: new Map(), release: () => { released++; } }),
    render: async input => { renders++; assert.equal(input.template?.slots.length, 4); assert.equal(input.shots.A?.[0]?.width, 1600); assert.equal(input.shots.B?.[3]?.height, 1200); return new Blob(["jpeg"], { type: "image/jpeg" }); },
  };
  const initial = roomPostcardPlan(snapshot), signal = new AbortController();
  const options = { initial, current: () => snapshot, design: initial.design, signal: signal.signal, assertActive() {} };
  return { options, ports, signal, images, originals, seen, get snapshot() { return snapshot; }, set snapshot(value: WorkspaceSnapshot) { snapshot = value; }, counts: () => ({ closed, released, renders, authority }) };
}
test("room postcard renders exact complete originals and rechecks authority before publishing", async () => {
  const f = await fixture(), blob = await renderRoomPostcard(f.options, f.ports);
  assert.equal(blob.type, "image/jpeg"); assert.equal(f.seen.length, 8); assert.deepEqual(f.seen, [...f.originals.values()]);
  assert(f.images.every(image => image.width === 0 && image.height === 0)); assert.deepEqual(f.counts(), { closed: 1, released: 1, renders: 1, authority: 2 });
});
test("incomplete, rebound and unsupported Together maps fail before any export", async () => {
  const f = await fixture(), project = f.snapshot.round!;
  assert.throws(() => roomPostcardPlan({ ...f.snapshot, round: { ...project, sourceOrder: { ...project.sourceOrder, A: [null, ...project.sourceOrder.A.slice(1)] } } }), /shared capture/);
  assert.throws(() => roomPostcardPlan({ ...f.snapshot, room: { ...f.snapshot.room, members: f.snapshot.room.members.map(member => member.id === MEMBER_B ? { ...member, status: "removed" } : member) } }), /shared capture/);
  const editor = { ...project.editor, sceneId: "cream" };
  assert.throws(() => roomPostcardPlan({ ...f.snapshot, round: { ...project, editor }, recipe: { ...f.snapshot.recipe!, recipe: { ...f.snapshot.recipe!.recipe, editor } } }), /separate-photo|Unknown|scene/);
});
test("a changed recipe or revoked participant during rendering suppresses the JPEG", async () => {
  const f = await fixture(), original = f.ports.render;
  f.ports.render = async (input, signal) => { const result = await original(input, signal); f.snapshot = { ...f.snapshot, recipe: { ...f.snapshot.recipe!, recipeHash: "f".repeat(64) } }; return result; };
  await assert.rejects(renderRoomPostcard(f.options, f.ports), /shared capture/); assert(f.images.every(image => image.width === 0));
  const g = await fixture(); let requests = 0;
  g.ports.state = async () => ++requests === 1 ? g.snapshot.room : { ...g.snapshot.room, members: g.snapshot.room.members.map(member => member.id === MEMBER_B ? { ...member, status: "removed" } : member) };
  await assert.rejects(renderRoomPostcard(g.options, g.ports), /shared capture/); assert.equal(g.counts().released, 1);
});
test("cancelled native work holds the occupied slot until its late canvas can be released", async () => {
  const f = await fixture(); let resolve!: (canvas: HTMLCanvasElement) => void, started = false;
  f.ports.decode = async () => { started = true; return new Promise<HTMLCanvasElement>(done => { resolve = done; }); };
  const pending = renderRoomPostcard(f.options, f.ports);
  for (let i = 0; !started && i < 100; i++) await new Promise(done => setTimeout(done, 1)); assert(started);
  f.signal.abort(); await assert.rejects(pending, /cancelled/);
  const next = await fixture(); await assert.rejects(renderRoomPostcard(next.options, next.ports), /still being prepared/);
  const late = { width: 1600, height: 1200 } as HTMLCanvasElement; resolve(late);
  for (let i = 0; late.width && i < 100; i++) await new Promise(done => setTimeout(done, 1)); assert.equal(late.width, 0);
  assert.equal((await renderRoomPostcard(next.options, next.ports)).type, "image/jpeg");
});
