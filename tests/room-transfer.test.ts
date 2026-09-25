import assert from "node:assert/strict";
import test from "node:test";
import { PeerTransfers, retainOutgoing, type TransferWire } from "../lib/rtc/transfer";
import { encodeChunk, type TransferManifest } from "../lib/rtc/protocol";
import { transferHash } from "../lib/rtc/transfer-store";
import { CAPTURE_ID, MEMBER_A, MEMBER_B, ROOM_ID, SESSION_ID, memoryJournal } from "./helpers/room-fixture";
const info = { mime: "image/png" as const, width: 640, height: 480 };
async function fixture(length = 32769) {
  const bytes = new Uint8Array(length).fill(42), blob = new Blob([bytes], { type: "image/png" });
  const manifest: TransferManifest = { id: CAPTURE_ID, roomId: ROOM_ID, sessionId: SESSION_ID, captureId: CAPTURE_ID, shotId: "one", memberId: MEMBER_A, role: "A", ...info, bytes: length, sha256: await transferHash(bytes), chunkSize: 16384, chunks: Math.ceil(length / 16384), expiresAt: Date.now() + 60000 };
  return { bytes, blob, manifest };
}
test("receiver requests only missing durable chunks and acknowledges only after verified project commit", async () => {
  const { journal } = memoryJournal(), { bytes, manifest } = await fixture();
  await journal.reserve(manifest, "receive"); await journal.putChunk(manifest.id, 0, bytes.subarray(0, 16384));
  const controls: { type: string; payload: unknown }[] = [], order: string[] = [];
  let release!: () => void; const saved = new Promise<void>(resolve => { release = resolve; });
  const peer = new PeerTransfers({ peerId: MEMBER_A, journal, wire: { control: (type, payload) => { controls.push({ type, payload }); if (type === "transfer-ack") order.push("ack"); }, binary() {}, writable: async () => {} },
    authorise: async () => {}, inspect: async () => { order.push("decode"); return info; }, commit: async () => { order.push("commit-start"); await saved; order.push("commit-done"); }, onProgress() {}, onIncomplete() {} });
  try {
    await peer.receiveOffer(manifest); assert.deepEqual(controls[0], { type: "transfer-missing", payload: { id: manifest.id, missing: [1, 2] } });
    await peer.receiveChunk(encodeChunk(manifest.id, 1, bytes.subarray(16384, 32768)));
    const finish = peer.receiveChunk(encodeChunk(manifest.id, 2, bytes.subarray(32768)));
    await new Promise(resolve => setTimeout(resolve, 0)); assert(!controls.some(value => value.type === "transfer-ack"));
    release(); await finish; assert.deepEqual(order, ["decode", "commit-start", "commit-done", "ack"]); assert.equal((await journal.get(manifest.id))?.committed, true);
  } finally { peer.close(); }
});
test("checksum mismatch and project-save failure retain chunks without success acknowledgement", async () => {
  for (const corrupt of [true, false]) {
    const { journal } = memoryJournal(), { manifest, bytes } = await fixture(10); let ack = false, commits = 0;
    const peer = new PeerTransfers({ peerId: MEMBER_A, journal, wire: { control: type => { if (type === "transfer-ack") ack = true; }, binary() {}, writable: async () => {} }, authorise: async () => {}, inspect: async () => info,
      commit: async () => { commits++; throw new Error("quota_failed"); }, onProgress() {}, onIncomplete() {} });
    try { await peer.receiveOffer(manifest); await assert.rejects(peer.receiveChunk(encodeChunk(manifest.id, 0, corrupt ? new Uint8Array(10).fill(7) : bytes)), corrupt ? /checksum/ : /quota_failed/); assert.equal(ack, false); assert.equal(commits, corrupt ? 0 : 1); assert((await journal.get(manifest.id))?.chunks[0]); } finally { peer.close(); }
  }
});
test("a chunk window stays at four and outgoing sends wait for backpressure before each chunk", async () => {
  const { journal } = memoryJournal(), { manifest, blob } = await fixture(100000), sent: string[] = [];
  await retainOutgoing(journal, manifest, blob);
  const wire: TransferWire = { control() {}, writable: async () => { sent.push("ready"); }, binary: () => { sent.push("chunk"); } };
  const peer = new PeerTransfers({ peerId: MEMBER_B, journal, wire, authorise: async () => {}, commit: async () => {}, onProgress() {}, onIncomplete() {} });
  try { await peer.receiveMissing({ id: manifest.id, missing: [0, 2, 4, 6] }); assert.deepEqual(sent, ["ready", "chunk", "ready", "chunk", "ready", "chunk", "ready", "chunk"]); await assert.rejects(peer.receiveMissing({ id: manifest.id, missing: [0, 1, 2, 3, 4] }), /invalid_missing/); } finally { peer.close(); }
});
test("a removed peer and a wrong-sender offer cannot reach the project commit boundary", async () => {
  const { journal } = memoryJournal(), { manifest } = await fixture(10); let commits = 0;
  const peer = new PeerTransfers({ peerId: MEMBER_B, journal, wire: { control() {}, binary() {}, writable: async () => {} }, authorise: async () => { throw new Error("removed"); }, commit: async () => { commits++; }, onProgress() {}, onIncomplete() {} });
  try { await assert.rejects(peer.receiveOffer(manifest), /identity/); await assert.rejects(peer.receiveOffer({ ...manifest, memberId: MEMBER_B }), /removed/); assert.equal(commits, 0); } finally { peer.close(); }
});
test("an interrupted outgoing stage retries the same immutable slot and only fills missing chunks", async () => {
  const { journal, entries } = memoryJournal(), { manifest, blob } = await fixture();
  const put = journal.putChunk, writes: number[] = []; let fail = true;
  journal.putChunk = async (id, index, bytes) => { writes.push(index); if (index === 1 && fail) throw new Error("quota_interrupted"); await put(id, index, bytes); };
  await assert.rejects(retainOutgoing(journal, manifest, blob), /quota_interrupted/);
  const first = await journal.get(manifest.id); assert(first?.chunks[0]); assert.equal(first?.chunks[1], null);
  fail = false; writes.length = 0;
  const saved = await retainOutgoing(journal, { ...manifest, id: crypto.randomUUID() }, blob);
  assert.equal(saved.manifest.id, manifest.id); assert.equal(entries.size, 1); assert.deepEqual(writes, [1, 2]); assert(saved.chunks.every(Boolean));
  const joined = new Blob(saved.chunks.map(chunk => chunk!.blob)); assert.equal(await transferHash(new Uint8Array(await joined.arrayBuffer())), manifest.sha256);
  writes.length = 0; await journal.markCommitted(manifest.id);
  assert.equal((await retainOutgoing(journal, { ...manifest, id: crypto.randomUUID() }, blob)).committed, true); assert.deepEqual(writes, []);
});
test("an outgoing slot retry rejects changed bytes, identity metadata and extended expiry", async () => {
  const { journal, entries } = memoryJournal(), { manifest, blob } = await fixture(); await retainOutgoing(journal, manifest, blob);
  for (const change of [{ width: 320 }, { expiresAt: manifest.expiresAt + 1000 }, { role: "B" as const }]) await assert.rejects(retainOutgoing(journal, { ...manifest, ...change, id: crypto.randomUUID() }, blob), /slot_conflict/);
  const changed = new Blob([new Uint8Array(blob.size).fill(7)], { type: blob.type });
  await assert.rejects(retainOutgoing(journal, { ...manifest, id: crypto.randomUUID(), sha256: await transferHash(new Uint8Array(await changed.arrayBuffer())) }, changed), /slot_conflict/);
  assert.equal(entries.size, 1); assert.equal((await journal.get(manifest.id))?.manifest.sha256, manifest.sha256);
});
