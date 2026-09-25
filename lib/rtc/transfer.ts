import { inspectProjectImage, type ProjectImageInfo } from "../projects/images";
import { decodeChunk, encodeChunk, TRANSFER_CHUNK_BYTES, validateTransferManifest, type ControlPayloads, type TransferManifest } from "./protocol";
import { transferHash, type TransferJournal, type JournalTransfer } from "./transfer-store";

export interface TransferWire {
  control<T extends "transfer-offer" | "transfer-missing" | "transfer-ack">(type: T, payload: ControlPayloads[T]): void;
  binary(bytes: ArrayBuffer): void;
  writable(signal: AbortSignal): Promise<void>;
}
export class PeerTransfers {
  private readonly controller = new AbortController();
  private incoming = new Map<string, { attempts: number; requested: number[]; timer: ReturnType<typeof setTimeout> | null }>();
  private finalising = new Set<string>();
  private sending = new Set<string>();
  constructor(private readonly options: {
    peerId: string; journal: TransferJournal; wire: TransferWire;
    authorise(manifest: TransferManifest, phase: "offer" | "commit" | "send" | "ack"): Promise<void>;
    commit(manifest: TransferManifest, blob: Blob): Promise<void>;
    onProgress(id: string, received: number, total: number): void;
    onIncomplete(id: string, reason: string): void;
    onAcknowledged?(manifest: TransferManifest, memberIds: string[]): Promise<void>;
    inspect?: (blob: Blob) => Promise<ProjectImageInfo>;
    retryMs?: number;
  }) {}
  close() {
    this.controller.abort();
    for (const item of this.incoming.values()) if (item.timer) clearTimeout(item.timer);
    this.incoming.clear();
  }
  private live() { if (this.controller.signal.aborted) throw new Error("transfer_closed"); }
  async offerStored(): Promise<void> {
    for (const item of await this.options.journal.list()) {
      this.live();
      if (item.direction === "send" && !item.committed && !item.acknowledgedBy.includes(this.options.peerId) && item.chunks.every(Boolean)) { await this.options.authorise(item.manifest, "offer"); this.live(); this.options.wire.control("transfer-offer", item.manifest); }
    }
  }
  async receiveOffer(value: TransferManifest): Promise<void> {
    this.live(); const manifest = validateTransferManifest(value);
    if (manifest.memberId !== this.options.peerId || manifest.expiresAt <= Date.now()) throw new Error("transfer_identity");
    await this.options.authorise(manifest, "offer"); this.live();
    const item = await this.options.journal.reserve(manifest, "receive"); this.live();
    if (item.committed) { this.options.wire.control("transfer-ack", { id: manifest.id, sha256: manifest.sha256 }); return; }
    if (!this.incoming.has(manifest.id)) {
      if (this.incoming.size >= 4) throw new Error("transfer_capacity");
      this.incoming.set(manifest.id, { attempts: 0, requested: [], timer: null });
    }
    await this.requestMissing(item);
  }
  private async requestMissing(item: JournalTransfer): Promise<void> {
    this.live();
    const pending = this.incoming.get(item.manifest.id); if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    const missing = item.chunks.flatMap((chunk, index) => chunk ? [] : [index]);
    if (!missing.length) { await this.finish(item); return; }
    if (pending.attempts >= 8) { this.options.onIncomplete(item.manifest.id, "transfer_retry_exhausted"); return; }
    pending.attempts++;
    pending.requested = missing.slice(0, 4);
    this.options.wire.control("transfer-missing", { id: item.manifest.id, missing: pending.requested });
    pending.timer = setTimeout(() => {
      void this.options.journal.get(item.manifest.id).then(current => current && this.requestMissing(current)).catch(() => {
        if (!this.controller.signal.aborted) this.options.onIncomplete(item.manifest.id, "transfer_storage_failed");
      });
    }, this.options.retryMs ?? 2000);
  }
  async receiveChunk(wire: ArrayBuffer): Promise<void> {
    this.live(); const chunk = decodeChunk(wire);
    const item = await this.options.journal.get(chunk.id); this.live();
    if (!item || item.direction !== "receive" || item.manifest.memberId !== this.options.peerId) throw new Error("transfer_identity");
    if (!this.incoming.has(chunk.id) && !item.committed) throw new Error("unexpected_chunk");
    await this.options.journal.putChunk(chunk.id, chunk.index, chunk.bytes); this.live();
    if (item.committed) { this.options.wire.control("transfer-ack", { id: chunk.id, sha256: item.manifest.sha256 }); return; }
    const current = await this.options.journal.get(chunk.id); this.live();
    if (!current) throw new Error("transfer_missing");
    const received = current.chunks.reduce((sum, part) => sum + (part?.blob.size ?? 0), 0);
    this.options.onProgress(chunk.id, received, current.manifest.bytes);
    const pending = this.incoming.get(chunk.id);
    if (pending) { pending.requested = pending.requested.filter(index => index !== chunk.index); if (!item.chunks[chunk.index]) pending.attempts = 0; }
    if (current.chunks.every(Boolean)) await this.finish(current);
    else if (pending && !pending.requested.length) await this.requestMissing(current);
  }
  private async finish(item: JournalTransfer): Promise<void> {
    const id = item.manifest.id;
    if (this.finalising.has(id)) return;
    this.finalising.add(id);
    const pending = this.incoming.get(id); if (pending?.timer) clearTimeout(pending.timer);
    try {
      const blob = new Blob(item.chunks.map(chunk => { if (!chunk) throw new Error("transfer_incomplete"); return chunk.blob; }), { type: item.manifest.mime });
      if (blob.size !== item.manifest.bytes || await transferHash(new Uint8Array(await blob.arrayBuffer())) !== item.manifest.sha256) throw new Error("transfer_checksum");
      const info = await (this.options.inspect ?? inspectProjectImage)(blob); this.live();
      if (info.mime !== item.manifest.mime || info.width !== item.manifest.width || info.height !== item.manifest.height) throw new Error("transfer_image_mismatch");
      await this.options.authorise(item.manifest, "commit"); this.live();
      await this.options.commit(item.manifest, blob); this.live();
      await this.options.journal.markCommitted(id); this.live();
      this.incoming.delete(id);
      this.options.wire.control("transfer-ack", { id, sha256: item.manifest.sha256 });
    } catch (error) {
      if (!this.controller.signal.aborted) this.options.onIncomplete(id, error instanceof Error ? error.message : "transfer_failed");
      throw error;
    } finally { this.finalising.delete(id); }
  }
  async receiveMissing(payload: ControlPayloads["transfer-missing"]): Promise<void> {
    this.live();
    if (this.sending.has(payload.id)) return;
    if (this.sending.size >= 1) throw new Error("transfer_send_busy");
    this.sending.add(payload.id);
    try {
      const item = await this.options.journal.get(payload.id); this.live();
      if (!item || item.direction !== "send" || item.committed || payload.missing.length > 4 || payload.missing.some(index => index >= item.manifest.chunks) || !item.chunks.every(Boolean)) throw new Error("invalid_missing_chunks");
      await this.options.authorise(item.manifest, "send"); this.live();
      for (const index of payload.missing) {
        await this.options.wire.writable(this.controller.signal); this.live();
        const chunk = item.chunks[index]!;
        this.options.wire.binary(encodeChunk(item.manifest.id, index, new Uint8Array(await chunk.blob.arrayBuffer())));
      }
    } finally { this.sending.delete(payload.id); }
  }
  async receiveAck(payload: ControlPayloads["transfer-ack"]): Promise<void> {
    this.live(); const item = await this.options.journal.get(payload.id); this.live();
    if (!item || item.direction !== "send" || item.manifest.sha256 !== payload.sha256) throw new Error("invalid_transfer_ack");
    await this.options.authorise(item.manifest, "ack"); this.live();
    await this.options.journal.acknowledge(payload.id, this.options.peerId);
    const updated = await this.options.journal.get(payload.id);
    if (updated) await this.options.onAcknowledged?.(updated.manifest, updated.acknowledgedBy);
    this.options.onProgress(payload.id, item.manifest.bytes, item.manifest.bytes);
  }
}

export async function retainOutgoing(journal: TransferJournal, manifest: TransferManifest, blob: Blob): Promise<JournalTransfer> {
  validateTransferManifest(manifest);
  if (blob.size !== manifest.bytes || blob.type !== manifest.mime || await transferHash(new Uint8Array(await blob.arrayBuffer())) !== manifest.sha256) throw new Error("outgoing_image_mismatch");
  const existing = (await journal.list()).find(item => item.manifest.roomId === manifest.roomId && item.manifest.sessionId === manifest.sessionId && item.manifest.captureId === manifest.captureId && item.manifest.memberId === manifest.memberId && item.manifest.shotId === manifest.shotId);
  if (existing && (existing.direction !== "send" || Object.keys(manifest).some(field => field !== "id" && manifest[field as keyof TransferManifest] !== existing.manifest[field as keyof TransferManifest]))) throw new Error("transfer_slot_conflict");
  const retained = await journal.reserve(existing?.manifest ?? manifest, "send");
  if (retained.committed) return retained;
  for (let index = 0; index < retained.manifest.chunks; index++) if (!retained.chunks[index]) await journal.putChunk(retained.manifest.id, index, new Uint8Array(await blob.slice(index * TRANSFER_CHUNK_BYTES, (index + 1) * TRANSFER_CHUNK_BYTES).arrayBuffer()));
  const staged = await journal.get(retained.manifest.id);
  if (!staged) throw new Error("transfer_missing");
  return staged;
}
