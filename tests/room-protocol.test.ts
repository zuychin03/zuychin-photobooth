import assert from "node:assert/strict";
import test from "node:test";
import { decodeChunk, encodeChunk, encodeEnvelope, parseEnvelope, PeerEnvelopeGuard, TRANSFER_CHUNK_BYTES, validateTransferManifest } from "../lib/rtc/protocol";
import { validateRoomCapture, validateRoomState, createRoomApi } from "../lib/rtc/signaling-v2";
import { CAPTURE_ID, EPOCH, MEMBER_A, MEMBER_B, ROOM_ID, SESSION_ID, captureFixture } from "./helpers/room-fixture";
import { createProject } from "../lib/projects/model";
const identity = { roomId: ROOM_ID, sessionId: SESSION_ID, memberId: MEMBER_A, connectionEpoch: EPOCH, rosterRevision: 1 };
test("v2 control envelopes reject forged identities, obsolete epochs, changed lengths and unsupported clients", () => {
  const wire = encodeEnvelope({ ...identity, seq: 1 }, "hello", { peerEpoch: EPOCH });
  assert.equal(parseEnvelope(wire).type, "hello");
  for (const [key, value] of [["roomId", MEMBER_B], ["sessionId", MEMBER_B], ["memberId", MEMBER_B], ["connectionEpoch", MEMBER_B], ["rosterRevision", 2]] as const) assert.throws(() => new PeerEnvelopeGuard(identity).accept(JSON.stringify({ ...JSON.parse(wire), [key]: value })), /identity/);
  assert.throws(() => parseEnvelope(JSON.stringify({ ...JSON.parse(wire), payloadBytes: 1 })), /invalid/);
  assert.throws(() => parseEnvelope(JSON.stringify({ ...JSON.parse(wire), v: 1 })), /update/);
  assert.throws(() => parseEnvelope("{"));
});
test("ordered control sequence ignores duplicates and refuses a gap without accepting it", () => {
  const guard = new PeerEnvelopeGuard(identity), make = (seq: number) => encodeEnvelope({ ...identity, seq }, "ping", { sentAt: 100 });
  assert.equal(guard.accept(make(1))?.seq, 1); assert.equal(guard.accept(make(1)), null);
  assert.throws(() => guard.accept(make(3)), /gap/); assert.equal(guard.accept(make(2))?.seq, 2);
});

test("recipe proposals and commits cross only the strict bounded v2 envelope", () => {
  const proposal = { schemaVersion: 1 as const, id: CAPTURE_ID, baseRevision: 0, edit: { kind: "shared" as const, patch: { caption: "Together" } } };
  assert.equal(parseEnvelope(encodeEnvelope({ ...identity, seq: 1 }, "recipe-proposal", proposal)).type, "recipe-proposal");
  assert.throws(() => encodeEnvelope({ ...identity, seq: 1 }, "recipe-proposal", { ...proposal, edit: { ...proposal.edit, patch: { caption: "x".repeat(20000) } } }));
  const commit = { schemaVersion: 1 as const, revision: 1, proposalId: CAPTURE_ID, authorId: MEMBER_A, recipeHash: "b".repeat(64), recipe: { editor: createProject().editor, owners: { A: MEMBER_A }, stickerOwners: {} } };
  assert.equal(parseEnvelope(encodeEnvelope({ ...identity, seq: 2 }, "recipe-commit", commit)).type, "recipe-commit");
  assert.throws(() => encodeEnvelope({ ...identity, seq: 2 }, "recipe-commit", { ...commit, authorId: "foreign" }));
});
test("binary chunk framing bounds allocation and carries its own transfer/index/length identity", () => {
  const bytes = new Uint8Array(TRANSFER_CHUNK_BYTES).fill(17), wire = encodeChunk(CAPTURE_ID, 639, bytes), parsed = decodeChunk(wire);
  assert.equal(parsed.id, CAPTURE_ID); assert.equal(parsed.index, 639); assert.deepEqual(parsed.bytes, bytes);
  assert.throws(() => encodeChunk(CAPTURE_ID, 640, bytes)); assert.throws(() => encodeChunk(CAPTURE_ID, 1, new Uint8Array(16385)));
  new DataView(wire).setUint32(24, 8); assert.throws(() => decodeChunk(wire));
  assert.throws(() => decodeChunk(new ArrayBuffer(1000000)));
});
test("transfer declarations cannot exceed original image or chunk inventory bounds", () => {
  const manifest = { id: CAPTURE_ID, roomId: ROOM_ID, sessionId: SESSION_ID, captureId: CAPTURE_ID, shotId: "one", memberId: MEMBER_A, role: "A", mime: "image/png", width: 640, height: 480, bytes: 16385, sha256: "a".repeat(64), chunkSize: 16384, chunks: 2, expiresAt: Date.now() + 1000 };
  assert.equal(validateTransferManifest(manifest).chunks, 2);
  for (const patch of [{ chunks: 1 }, { bytes: 10485761 }, { width: 4097 }, { mime: "image/svg+xml" }, { token: "not allowed" }]) assert.throws(() => validateTransferManifest({ ...manifest, ...patch }));
});
test("server projections are validated before a client can allocate peers or capture work", () => {
  assert.equal(validateRoomCapture(captureFixture()).state, "committed");
  assert.throws(() => validateRoomCapture({ ...captureFixture(), acks: ["foreign"] }));
  assert.throws(() => validateRoomCapture({ ...captureFixture(), profile: { ...captureFixture().profile, maxPhotoPixels: 12582912 } }));
  assert.throws(() => validateRoomState({ roomId: ROOM_ID, members: new Array(10000) }));
});
test("signalling uses same-origin HttpOnly credentials and refuses oversized response streams", async () => {
  let options: RequestInit | undefined;
  const api = createRoomApi(ROOM_ID, { fetch: async (_url, init) => { options = init; return new Response(JSON.stringify({ error: "access_denied" }), { status: 403 }); } });
  await assert.rejects(api.state(), /access_denied/); assert.equal(options?.credentials, "same-origin"); assert.equal(options?.cache, "no-store"); assert(!JSON.stringify(options?.headers).includes("Bearer"));
  const large = createRoomApi(ROOM_ID, { fetch: async () => new Response("x".repeat(640 * 1024 + 1)) });
  await assert.rejects(large.state(), /invalid_response/);
});
