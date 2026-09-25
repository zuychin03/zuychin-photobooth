import { test } from "node:test";
import assert from "node:assert/strict";
import { validateChallengeDraft, type ChallengeDraft, type ChallengeDraftInput } from "../lib/memories/challenge-drafts";
import { createChallengeDraftWriter } from "../lib/memories/challenge-draft-writer";
import { challengeDesign } from "../lib/memories/challenge-ui";

const owner = "10000000-0000-4000-8000-000000000001", other = "10000000-0000-4000-8000-000000000002", project = "10000000-0000-4000-8000-000000000003", id = "10000000-0000-4000-8000-000000000004";
function draft(): Extract<ChallengeDraft, { kind: "create" }> {
  return { version: 1, id, ownerId: owner, projectId: project, challengeId: null, kind: "create", revision: 0, createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z", state: "draft", form: { selected: [owner, other], layoutId: "duo-alternate", policy: "all_submitted", expiresAt: "2026-09-30T00:00:00Z" }, request: null };
}
function input(value = draft()): Extract<ChallengeDraftInput, { kind: "create" }> { return { kind: "create", id: value.id, projectId: value.projectId, challengeId: null, form: value.form }; }

test("creation drafts preserve exact private form data and freeze only its derived request", () => {
  const row = draft(), request = { id, ...challengeDesign(row.form.layoutId, row.form.selected), policy: row.form.policy, expiresAt: row.form.expiresAt };
  const pending = validateChallengeDraft({ ...row, state: "pending", request });
  assert.equal(pending.request?.id, id);
  assert.throws(() => validateChallengeDraft({ ...row, state: "pending", request: { ...request, policy: "immediate" } }));
  assert.throws(() => validateChallengeDraft({ ...row, request }));
  assert.throws(() => validateChallengeDraft({ ...row, state: "pending" }));
});

test("partial drafts contain only the intended contributors and immutable proposal identity", () => {
  const row = { ...draft(), kind: "partial", challengeId: project, form: { contributors: [other, owner] }, state: "pending", request: { id, contributors: [owner, other] } };
  assert.equal(validateChallengeDraft(row).kind, "partial");
  for (const patch of [{ request: { id, contributors: [owner] } }, { form: { contributors: [owner], sourceId: id } }, { consent: true }, { signedUrl: "https://private.invalid" }, { token: "opaque" }]) assert.throws(() => validateChallengeDraft({ ...row, ...patch }));
});

test("foreign creator order, duplicate identities and future schema cannot masquerade as editable drafts", () => {
  assert.throws(() => validateChallengeDraft({ ...draft(), form: { ...draft().form, selected: [other, owner] } }));
  assert.throws(() => validateChallengeDraft({ ...draft(), form: { ...draft().form, selected: [owner, owner] } }));
  assert.throws(() => validateChallengeDraft({ ...draft(), version: 3 }), /readonly/);
  assert.throws(() => validateChallengeDraft({ ...draft(), revision: Number.MAX_SAFE_INTEGER }));
});

test("autosave bounds writes to one active operation and one latest replacement", async () => {
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  const calls: ChallengeDraftInput[] = [], revisions: (number | null)[] = [];
  let live = 0, maximum = 0;
  const journal = { async saveDraft(value: ChallengeDraftInput, expected: number | null) { calls.push(value); revisions.push(expected); maximum = Math.max(maximum, ++live); if (calls.length === 1) await blocked; live--; return validateChallengeDraft({ ...draft(), ...value, revision: expected! + 1 }); } };
  const writer = createChallengeDraftWriter(draft(), journal, () => {});
  writer.schedule(input()); await Promise.resolve();
  for (let n = 0; n < 100; n++) writer.schedule({ ...input(), form: { ...draft().form, expiresAt: new Date(Date.UTC(2027, 0, 1 + n)).toISOString() } });
  assert.equal(calls.length, 1); release(); const saved = await writer.flush();
  assert.equal(calls.length, 2); assert.equal(maximum, 1); assert.deepEqual(revisions, [0, 1]);
  assert.equal(saved.kind === "create" && saved.form.expiresAt, new Date(Date.UTC(2027, 0, 100)).toISOString()); writer.close();
});

test("failed local writes retain choices and retry the same CAS without claiming saved", async () => {
  let fails = true; const revisions: (number | null)[] = [], ids: string[] = [], reports: unknown[] = [];
  const journal = { async saveDraft(value: ChallengeDraftInput, expected: number | null) { revisions.push(expected); ids.push(value.id); if (fails) throw new DOMException("full", "QuotaExceededError"); return validateChallengeDraft({ ...draft(), ...value, revision: expected! + 1 }); } };
  const writer = createChallengeDraftWriter(draft(), journal, state => reports.push(state)); writer.schedule(input());
  await assert.rejects(writer.flush(), { name: "QuotaExceededError" }); assert.equal((reports.at(-1) as { saving: boolean }).saving, false); fails = false;
  assert.equal((await writer.flush()).revision, 1); assert.deepEqual(revisions, [0, 0]); assert.deepEqual(ids, [id, id]); assert.ok(reports.length > 0); writer.close();
});

test("close suppresses late callbacks and cancels queued successors without replacing a pending request", async () => {
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; }); let calls = 0, reports = 0;
  const journal = { async saveDraft(value: ChallengeDraftInput) { calls++; await blocked; return validateChallengeDraft({ ...draft(), ...value, revision: 1 }); } };
  const writer = createChallengeDraftWriter(draft(), journal, () => { reports++; }); writer.schedule(input()); await Promise.resolve(); writer.schedule(input());
  const waiting = writer.flush(); writer.close(); const before = reports; release(); await assert.rejects(waiting, /closed/);
  assert.equal(calls, 1); assert.equal(reports, before);
});
