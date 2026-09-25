import type { TransferJournal, JournalTransfer } from "../../lib/rtc/transfer-store";
import type { RoomCapture } from "../../lib/server/room-contract";
export const ROOM_ID = "11111111-1111-4111-8111-111111111111", SESSION_ID = "22222222-2222-4222-8222-222222222222", MEMBER_A = "33333333-3333-4333-8333-333333333333", MEMBER_B = "44444444-4444-4444-8444-444444444444", EPOCH = "55555555-5555-4555-8555-555555555555", CAPTURE_ID = "66666666-6666-4666-8666-666666666666";
export const captureFixture = (): RoomCapture => ({ captureId: CAPTURE_ID, rosterRevision: 1, recipeHash: "a".repeat(64), shotIds: ["first", "second"], fireAt: 10000, intervalMs: 1000, profile: { maxPhotoBytes: 1048576, maxPhotoPixels: 1048576, shotsPerMember: 2 }, memberIds: [MEMBER_A, MEMBER_B], acks: [MEMBER_A, MEMBER_B], state: "committed" });
export function memoryJournal() {
  const entries = new Map<string, JournalTransfer>(), markers = new Set<string>();
  const journal: TransferJournal = {
    reserve: async (manifest, direction) => { const old = entries.get(manifest.id); if (old) return old; const item: JournalTransfer = { manifest, direction, chunks: Array.from({ length: manifest.chunks }, () => null), committed: false, acknowledgedBy: [] }; entries.set(manifest.id, item); return item; },
    get: async id => { const item = entries.get(id); return item ? { ...item, chunks: [...item.chunks], acknowledgedBy: [...item.acknowledgedBy] } : null; },
    list: async () => [...entries.values()],
    putChunk: async (id, index, bytes) => { const item = entries.get(id); if (!item || index >= item.manifest.chunks || bytes.length !== Math.min(16384, item.manifest.bytes - index * 16384)) throw new Error("invalid_chunk"); item.chunks[index] = { blob: new Blob([new Uint8Array(bytes)]), hash: "fixture" }; },
    markCommitted: async id => { const item = entries.get(id); if (!item) throw new Error("missing"); item.committed = true; },
    acknowledge: async (id, member) => { entries.get(id)!.acknowledgedBy.push(member); },
    remove: async id => { entries.delete(id); },
    claimShot: async (capture, shot) => { const key = `${capture}/${shot}`; if (markers.has(key)) return false; markers.add(key); return true; },
    finishShot: async () => {}, cleanup: async () => {}, close() {},
  };
  return { journal, entries, markers };
}
