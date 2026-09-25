import type { RoomRole } from "../server/room-contract";
import { validateRecipeCommit, validateRecipeProposal, type RecipeCommit, type RecipeProposal } from "./recipe-v2";

export const PROTOCOL_VERSION = 2;
export const TRANSFER_CHUNK_BYTES = 16384;
export const CONTROL_BYTES = 96 * 1024;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
export class RoomProtocolError extends Error { constructor(readonly code: string) { super(code); } }
export interface TransferManifest {
  id: string; roomId: string; sessionId: string; captureId: string; shotId: string; memberId: string;
  role: RoomRole; mime: "image/jpeg" | "image/png" | "image/webp"; width: number; height: number;
  bytes: number; sha256: string; chunkSize: 16384; chunks: number; expiresAt: number;
}
export type ControlPayloads = {
  hello: { peerEpoch: string };
  ping: { sentAt: number };
  pong: { sentAt: number; repliedAt: number };
  "capture-notice": { captureId: string };
  "capture-request": Record<string, never>;
  "recipe-proposal": RecipeProposal;
  "recipe-commit": RecipeCommit;
  "transfer-offer": TransferManifest;
  "transfer-missing": { id: string; missing: number[] };
  "transfer-ack": { id: string; sha256: string };
};
export type ControlType = keyof ControlPayloads;
export interface Envelope<T extends ControlType = ControlType> {
  v: 2; roomId: string; sessionId: string; memberId: string; connectionEpoch: string;
  rosterRevision: number; seq: number; type: T; payloadBytes: number; payload: ControlPayloads[T];
}
const fail = (): never => { throw new RoomProtocolError("invalid_message"); };
const record = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail();
  return input as Record<string, unknown>;
};
const keys = (input: Record<string, unknown>, names: string[]) => Object.keys(input).length === names.length && names.every(name => Object.hasOwn(input, name));
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const uuid = (value: unknown) => typeof value === "string" && UUID_PATTERN.test(value);
export const encodedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export function validateTransferManifest(value: unknown): TransferManifest {
  const item = record(value);
  if (!keys(item, ["id", "roomId", "sessionId", "captureId", "shotId", "memberId", "role", "mime", "width", "height", "bytes", "sha256", "chunkSize", "chunks", "expiresAt"])
    || ![item.id, item.roomId, item.sessionId, item.captureId, item.memberId].every(uuid)
    || typeof item.shotId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.shotId)
    || !["A", "B", "C", "D"].includes(item.role as string) || !["image/jpeg", "image/png", "image/webp"].includes(item.mime as string)
    || !integer(item.width, 1, 4096) || !integer(item.height, 1, 4096) || (item.width as number) * (item.height as number) > 12 * 1024 * 1024
    || !integer(item.bytes, 1, 10 * 1024 * 1024) || typeof item.sha256 !== "string" || !HASH.test(item.sha256)
    || item.chunkSize !== TRANSFER_CHUNK_BYTES || item.chunks !== Math.ceil((item.bytes as number) / TRANSFER_CHUNK_BYTES) || !integer(item.expiresAt, 1)) return fail();
  return Object.freeze({ ...item }) as unknown as TransferManifest;
}
function validatePayload(type: unknown, value: unknown): void {
  const p = record(value);
  if (type === "hello") { if (!keys(p, ["peerEpoch"]) || !uuid(p.peerEpoch)) fail(); }
  else if (type === "ping") { if (!keys(p, ["sentAt"]) || !integer(p.sentAt, 1)) fail(); }
  else if (type === "pong") { if (!keys(p, ["sentAt", "repliedAt"]) || !integer(p.sentAt, 1) || !integer(p.repliedAt, 1)) fail(); }
  else if (type === "capture-notice") { if (!keys(p, ["captureId"]) || !uuid(p.captureId)) fail(); }
  else if (type === "capture-request") { if (!keys(p, [])) fail(); }
  else if (type === "recipe-proposal" || type === "recipe-commit") {
    try { if (type === "recipe-proposal") validateRecipeProposal(p); else validateRecipeCommit(p); } catch { fail(); }
  }
  else if (type === "transfer-offer") validateTransferManifest(p);
  else if (type === "transfer-ack") { if (!keys(p, ["id", "sha256"]) || !uuid(p.id) || typeof p.sha256 !== "string" || !HASH.test(p.sha256)) fail(); }
  else if (type === "transfer-missing") {
    if (!keys(p, ["id", "missing"]) || !uuid(p.id) || !Array.isArray(p.missing) || p.missing.length > 640 || !p.missing.every(index => integer(index, 0, 639)) || new Set(p.missing).size !== p.missing.length) fail();
  } else fail();
}

export function encodeEnvelope<T extends ControlType>(identity: Omit<Envelope<T>, "v" | "type" | "payload" | "payloadBytes">, type: T, payload: ControlPayloads[T]): string {
  const value: Envelope<T> = { v: 2, ...identity, type, payloadBytes: encodedBytes(payload), payload };
  const wire = JSON.stringify(value); parseEnvelope(wire); return wire;
}
export function parseEnvelope(wire: string): Envelope {
  if (typeof wire !== "string" || wire.length > CONTROL_BYTES || new TextEncoder().encode(wire).length > CONTROL_BYTES) return fail();
  let value: unknown; try { value = JSON.parse(wire); } catch { return fail(); }
  const item = record(value);
  if (item.v !== 2) throw new RoomProtocolError("protocol_update_required");
  if (!keys(item, ["v", "roomId", "sessionId", "memberId", "connectionEpoch", "rosterRevision", "seq", "type", "payloadBytes", "payload"])
    || ![item.roomId, item.sessionId, item.memberId, item.connectionEpoch].every(uuid) || !integer(item.rosterRevision, 1) || !integer(item.seq, 1)
    || !integer(item.payloadBytes, 1, CONTROL_BYTES) || item.payloadBytes !== encodedBytes(item.payload)) return fail();
  validatePayload(item.type, item.payload);
  return item as unknown as Envelope;
}
export class PeerEnvelopeGuard {
  private seq = 0;
  constructor(private readonly identity: Pick<Envelope, "roomId" | "sessionId" | "memberId" | "connectionEpoch" | "rosterRevision">) {}
  accept(wire: string): Envelope | null {
    const value = parseEnvelope(wire);
    for (const key of ["roomId", "sessionId", "memberId", "connectionEpoch", "rosterRevision"] as const) if (value[key] !== this.identity[key]) throw new RoomProtocolError("peer_identity_changed");
    if (value.seq <= this.seq) return null;
    if (value.seq !== this.seq + 1) throw new RoomProtocolError("sequence_gap");
    this.seq = value.seq; return value;
  }
}

export function encodeChunk(id: string, index: number, bytes: Uint8Array): ArrayBuffer {
  if (!UUID_PATTERN.test(id) || !integer(index, 0, 639) || bytes.byteLength < 1 || bytes.byteLength > TRANSFER_CHUNK_BYTES) return fail();
  const result = new ArrayBuffer(28 + bytes.length), view = new DataView(result), output = new Uint8Array(result);
  output.set([80, 66, 67, 50]); output.set(Uint8Array.from(id.replaceAll("-", "").match(/../g)!.map(part => parseInt(part, 16))), 4);
  view.setUint32(20, index); view.setUint32(24, bytes.length); output.set(bytes, 28); return result;
}
export function decodeChunk(wire: ArrayBuffer): { id: string; index: number; bytes: Uint8Array } {
  if (!(wire instanceof ArrayBuffer) || wire.byteLength < 29 || wire.byteLength > 28 + TRANSFER_CHUNK_BYTES) return fail();
  const bytes = new Uint8Array(wire), view = new DataView(wire);
  if (bytes[0] !== 80 || bytes[1] !== 66 || bytes[2] !== 67 || bytes[3] !== 50 || view.getUint32(24) !== bytes.length - 28 || view.getUint32(20) > 639) return fail();
  const hex = [...bytes.subarray(4, 20)].map(value => value.toString(16).padStart(2, "0")).join("");
  return { id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`, index: view.getUint32(20), bytes: bytes.subarray(28) };
}
