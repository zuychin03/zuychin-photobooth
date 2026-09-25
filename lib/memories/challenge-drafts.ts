import { validateStoryPlan, type StoryPlan } from "../stories/model";
import { cloudTimestamp, cloudUuid } from "../projects/cloud-contract";
import type { CloudIdentity } from "../projects/cloud-client";
import { openCloudJournalScope, type CloudJournalOptions } from "../projects/cloud-journal-db";
import { challengeObject, validateChallengeCreate, type ChallengeCreate } from "./challenge-contract";
import { challengeDesign, challengeLayouts } from "./challenge-ui";

export const CHALLENGE_DRAFT_LIMITS = Object.freeze({ records: 32, recordBytes: 70 * 1024, totalBytes: 2 * 1024 * 1024 });
export interface ChallengeCreationForm { story?: StoryPlan | null; selected: string[]; layoutId: string; policy: "all_submitted" | "immediate"; expiresAt: string }
export interface ChallengePartialForm { contributors: string[] }
interface Base { version: 1 | 2; id: string; ownerId: string; projectId: string; revision: number; createdAt: string; updatedAt: string; state: "draft" | "pending" }
export type ChallengeDraft = Base & (
  { kind: "create"; challengeId: null; form: ChallengeCreationForm; request: ChallengeCreate | null }
  | { kind: "partial"; challengeId: string; form: ChallengePartialForm; request: { id: string; contributors: string[] } | null }
);
export type ChallengeDraftInput = Pick<Base, "id" | "projectId"> & (
  { kind: "create"; challengeId: null; form: ChallengeCreationForm }
  | { kind: "partial"; challengeId: string; form: ChallengePartialForm }
);
export type ChallengeDraftEntry = ChallengeDraft | { id: string; readOnly: true };
export class ChallengeDraftError extends Error {
  constructor(readonly code: "conflict" | "capacity" | "readonly" | "invalid" | "missing" | "pending") { super(`challenge_draft_${code}`); }
}
const fail = (code: ChallengeDraftError["code"]): never => { throw new ChallengeDraftError(code); };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function ids(value: unknown, minimum: number) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 4) return fail("invalid");
  const result = value.map(cloudUuid); if (new Set(result).size !== result.length) return fail("invalid"); return result;
}
export function validateChallengeDraft(value: unknown): ChallengeDraft {
  try {
    const v = challengeObject(value, ["version", "id", "ownerId", "projectId", "challengeId", "revision", "createdAt", "updatedAt", "state", "kind", "form", "request"]);
    if (v.version !== 1 && v.version !== 2) return fail("readonly");
    if (!Number.isSafeInteger(v.revision) || (v.revision as number) < 0 || (v.revision as number) >= Number.MAX_SAFE_INTEGER || !["draft", "pending"].includes(v.state as string)) return fail("invalid");
    const base: Base = { version: v.version, id: cloudUuid(v.id), ownerId: cloudUuid(v.ownerId), projectId: cloudUuid(v.projectId), revision: v.revision as number, createdAt: cloudTimestamp(v.createdAt), updatedAt: cloudTimestamp(v.updatedAt), state: v.state as Base["state"] };
    if (Date.parse(base.updatedAt) < Date.parse(base.createdAt)) return fail("invalid");
    let result: ChallengeDraft;
    if (v.kind === "create") {
      const f = challengeObject(v.form, ["selected", "layoutId", "policy", "expiresAt", ...(v.version === 2 ? ["story"] : [])]), selected = ids(f.selected, 1);
      if (v.challengeId !== null || selected[0] !== base.ownerId || typeof f.layoutId !== "string" || ![2, 3, 4].flatMap(challengeLayouts).some(layout => layout.id === f.layoutId) || !["immediate", "all_submitted"].includes(f.policy as string)) return fail("invalid");
      const form: ChallengeCreationForm = { selected, layoutId: f.layoutId, policy: f.policy as ChallengeCreationForm["policy"], expiresAt: cloudTimestamp(f.expiresAt), ...(v.version === 2 ? { story: f.story === null ? null : validateStoryPlan(f.story) } : {}) };
      const request = v.request === null ? null : validateChallengeCreate(v.request);
      if (request && !same(request, validateChallengeCreate({ id: base.id, ...challengeDesign(form.layoutId, selected), policy: form.policy, expiresAt: form.expiresAt, ...(form.story ? { story: form.story } : {}) }))) return fail("invalid");
      result = { ...base, kind: "create", challengeId: null, form, request };
    } else if (v.kind === "partial") {
      if (v.version !== 1) return fail("readonly");
      const f = challengeObject(v.form, ["contributors"]), contributors = ids(f.contributors, 0).sort();
      let request: { id: string; contributors: string[] } | null = null;
      if (v.request !== null) { const r = challengeObject(v.request, ["id", "contributors"]); request = { id: cloudUuid(r.id), contributors: ids(r.contributors, 1).sort() }; if (request.id !== base.id || !same(request.contributors, contributors)) return fail("invalid"); }
      result = { ...base, kind: "partial", challengeId: cloudUuid(v.challengeId), form: { contributors }, request };
    } else return fail("invalid");
    if ((result.state === "pending") !== (result.request !== null) || bytes(result) > CHALLENGE_DRAFT_LIMITS.recordBytes) return fail("invalid");
    return result;
  } catch (error) { if (error instanceof ChallengeDraftError) throw error; return fail("invalid"); }
}
export interface ChallengeDraftJournal {
  readonly ownerId: string;
  list(): Promise<ChallengeDraftEntry[]>;
  get(id: string): Promise<ChallengeDraft | null>;
  saveDraft(input: ChallengeDraftInput, expectedRevision: number | null): Promise<ChallengeDraft>;
  freezeRequest(id: string, expectedRevision: number): Promise<ChallengeDraft>;
  rejectedRequest(id: string, expectedRevision: number): Promise<ChallengeDraft>;
  forget(id: string, expectedRevision: number): Promise<void>;
  close(): void;
}
export async function openChallengeDraftJournal(ownerId: string, options: CloudJournalOptions & { identity(): CloudIdentity | null }): Promise<ChallengeDraftJournal> {
  const scope = await openCloudJournalScope(ownerId, "challengeRequests", options);
  const read = (value: unknown): ChallengeDraft => { const row = validateChallengeDraft(value); if (row.ownerId !== ownerId) return fail("invalid"); return row; };
  const all = (store: IDBObjectStore, receive: (rows: unknown[]) => void, reject: (error: unknown) => void) => {
    const request = store.index("owner").getAll(ownerId, CHALLENGE_DRAFT_LIMITS.records + 1);
    request.onsuccess = () => { try { if (request.result.length > CHALLENGE_DRAFT_LIMITS.records || bytes(request.result) > CHALLENGE_DRAFT_LIMITS.totalBytes) fail("capacity"); receive(request.result); } catch (error) { reject(error); } };
  };
  function write(id: string, expected: number | null, update: (prior: ChallengeDraft | null) => ChallengeDraft | null) {
    cloudUuid(id);
    return scope.transaction<ChallengeDraft | null>("readwrite", (store, done, reject) => all(store, values => {
      try {
        const raw = values.find(value => (value as { id: string }).id === id), prior = raw ? read(raw) : null;
        if ((prior?.revision ?? null) !== expected) fail("conflict");
        const next = update(prior);
        if (!next) { store.delete([ownerId, id]); done(null); return; }
        const records = values.filter(value => (value as { id: string }).id !== id);
        for (const candidate of records) {
          const other = read(candidate);
          if (other.kind === next.kind && other.projectId === next.projectId && other.challengeId === next.challengeId) fail("conflict");
        }
        if (records.length >= CHALLENGE_DRAFT_LIMITS.records || bytes([...records, next]) > CHALLENGE_DRAFT_LIMITS.totalBytes) fail("capacity");
        store.put(next); done(next);
      } catch (error) { reject(error); }
    }, reject));
  }
  return {
    ownerId, close: scope.close,
    list: () => scope.transaction("readonly", (store, done, reject) => all(store, values => done(values.map(value => { try { return read(value); } catch { const id = cloudUuid((value as { id: unknown }).id); return { id, readOnly: true as const }; } })), reject)),
    get: id => { cloudUuid(id); return scope.transaction("readonly", (store, done, reject) => { const request = store.get([ownerId, id]); request.onsuccess = () => { try { done(request.result ? read(request.result) : null); } catch (error) { reject(error); } }; }); },
    saveDraft: async (input, expected) => {
      const timestamp = new Date().toISOString();
      return (await write(input.id, expected, prior => {
        if (prior?.state === "pending") fail("pending");
        if (prior && (prior.kind !== input.kind || prior.projectId !== input.projectId || prior.challengeId !== input.challengeId)) fail("conflict");
        const version = input.kind === "create" && (prior?.version === 2 || input.form.story != null) ? 2 : 1;
        const normalised = input.kind === "create" ? { ...input, form: { selected: input.form.selected, layoutId: input.form.layoutId, policy: input.form.policy, expiresAt: input.form.expiresAt, ...(version === 2 ? { story: input.form.story ?? null } : {}) } } : input;
        return validateChallengeDraft({ ...normalised, version, ownerId, revision: (prior?.revision ?? -1) + 1, createdAt: prior?.createdAt ?? timestamp, updatedAt: timestamp, state: "draft", request: null });
      }))!;
    },
    freezeRequest: async (id, expected) => (await write(id, expected, prior => {
      if (!prior) return fail("missing"); if (prior.state === "pending") return prior;
      const request = prior.kind === "create" ? { id, ...challengeDesign(prior.form.layoutId, prior.form.selected), policy: prior.form.policy, expiresAt: prior.form.expiresAt, ...(prior.form.story ? { story: prior.form.story } : {}) } : { id, contributors: prior.form.contributors };
      return validateChallengeDraft({ ...prior, revision: prior.revision + 1, updatedAt: new Date().toISOString(), state: "pending", request });
    }))!,
    rejectedRequest: async (id, expected) => (await write(id, expected, prior => {
      if (!prior || prior.state !== "pending") return fail("conflict");
      return validateChallengeDraft({ ...prior, state: "draft", request: null, revision: prior.revision + 1, updatedAt: new Date().toISOString() });
    }))!,
    forget: async (id, expected) => { await write(id, expected, () => null); },
  };
}
export function challengeDraftMessage(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "conflict") return "This draft changed in another tab. Reopen its saved version before continuing.";
  if (code === "capacity") return "Local challenge recovery is full. Review or dismiss old drafts in Cloud projects before continuing.";
  if (code === "readonly" || code === "journal_readonly") return "This recovery data needs a newer app. It has not been overwritten.";
  if (code === "account_changed") return "Your account changed. Reopen your own cloud library to recover this draft.";
  return "This draft could not be saved on this device. Your choices remain here. Retry saving before sending the request.";
}
