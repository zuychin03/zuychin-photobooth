import { eventClientConsent, eventClientInstant, eventClientObject, eventClientUuid } from "./client";
import type { EventConsent } from "./contract";
import { validateTemplateDesign, type TemplateDesign } from "../templates/model";

export const EVENT_POSTCARD_LIMITS = Object.freeze({ version: 1, participants: 4, draftsPerEvent: 100, draftsPerSource: 100, ticketSeconds: 300, logicalSeconds: 600, candidateBytes: 2000000, journalEntries: 8 });
export type PostcardSource = { kind: "room"; id: string; captureId: string } | { kind: "challenge" | "partial"; id: string };
export interface PostcardProposal { postcardId: string; submissionId: string; source: PostcardSource; design: TemplateDesign }
export interface PostcardCandidate { revision: 1; sha256: string; bytes: number; width: number; height: number; mime: "image/jpeg" }
export interface PostcardView {
  version: 1; eventId: string; postcardId: string; submissionId: string; revision: number;
  state: "draft" | "reserved" | "candidate" | "ready" | "revoked" | "expired";
  source: PostcardSource; design: TemplateDesign; designHash: string; expiresAt: string; logicalExpiresAt: string | null;
  selfPrincipalId: string; participants: { principalId: string; role: "A" | "B" | "C" | "D"; bound: boolean; consent: boolean; approved: boolean }[];
  selfConsent: EventConsent; canSubmit: boolean;
  candidate: PostcardCandidate | null;
}
const invalid = (): never => { throw new Error("Invalid postcard response"); };
const integer = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max ? v as number : invalid();
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v) ? v : invalid();
export function parsePostcardSource(value: unknown): PostcardSource {
  const b = eventClientObject(value, ["kind", "id"], ["captureId"]), id = eventClientUuid(b.id);
  if (b.kind === "room") return { kind: "room", id, captureId: eventClientUuid(b.captureId) };
  if ((b.kind === "challenge" || b.kind === "partial") && b.captureId === undefined) return { kind: b.kind, id };
  return invalid();
}
export function parsePostcardProposal(value: unknown): PostcardProposal {
  const b = eventClientObject(value, ["postcardId", "submissionId", "source", "design"]);
  return { postcardId: eventClientUuid(b.postcardId), submissionId: eventClientUuid(b.submissionId), source: parsePostcardSource(b.source), design: validateTemplateDesign(b.design) };
}
export function parsePostcardCandidate(value: unknown): PostcardCandidate {
  const b = eventClientObject(value, ["revision", "sha256", "bytes", "width", "height", "mime"]);
  const width = integer(b.width, 1, 4096), height = integer(b.height, 1, 4096);
  if (b.revision !== 1 || b.mime !== "image/jpeg" || width * height > 12000000) invalid();
  return { revision: 1, sha256: hash(b.sha256), bytes: integer(b.bytes, 1, 2000000), width, height, mime: "image/jpeg" };
}
export function parsePostcardView(value: unknown, eventId: string, postcardId: string): PostcardView {
  const b = eventClientObject(value, ["version", "eventId", "postcardId", "submissionId", "revision", "state", "source", "design", "designHash", "expiresAt", "logicalExpiresAt", "selfPrincipalId", "participants", "candidate", "selfConsent", "canSubmit"]);
  if (typeof b.canSubmit !== "boolean" || b.version !== 1 || b.eventId !== eventClientUuid(eventId) || b.postcardId !== eventClientUuid(postcardId) || !["draft", "reserved", "candidate", "ready", "revoked", "expired"].includes(String(b.state)) || !Array.isArray(b.participants) || b.participants.length < 1 || b.participants.length > 4) invalid();
  const seen = new Set<string>(), roles = new Set<string>();
  const participants = (b.participants as unknown[]).map(value => { const p = eventClientObject(value, ["principalId", "role", "bound", "consent", "approved"]), principalId = eventClientUuid(p.principalId); if (seen.has(principalId) || roles.has(String(p.role)) || !["A", "B", "C", "D"].includes(String(p.role)) || [p.bound, p.consent, p.approved].some(v => typeof v !== "boolean") || p.approved && (!p.bound || !p.consent)) invalid(); seen.add(principalId); roles.add(String(p.role)); return { principalId, role: p.role as "A" | "B" | "C" | "D", bound: p.bound as boolean, consent: p.consent as boolean, approved: p.approved as boolean }; });
  const selfPrincipalId = eventClientUuid(b.selfPrincipalId); if (!seen.has(selfPrincipalId)) invalid();
  const design = validateTemplateDesign(b.design); if (Object.keys(design.requiredSources).some(role => !roles.has(role)) || roles.size !== Object.keys(design.requiredSources).length) invalid();
  return { version: 1, eventId, postcardId, submissionId: eventClientUuid(b.submissionId), revision: integer(b.revision, 0, Number.MAX_SAFE_INTEGER), state: b.state as PostcardView["state"], source: parsePostcardSource(b.source), design, designHash: hash(b.designHash), expiresAt: eventClientInstant(b.expiresAt), logicalExpiresAt: b.logicalExpiresAt === null ? null : eventClientInstant(b.logicalExpiresAt), selfPrincipalId, canSubmit: b.canSubmit as boolean, selfConsent: eventClientConsent(b.selfConsent), participants, candidate: b.candidate === null ? null : parsePostcardCandidate(b.candidate) };
}
