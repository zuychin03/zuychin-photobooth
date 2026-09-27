import test from "node:test";
import assert from "node:assert/strict";
import { copyPostcardReceipt } from "../lib/events/postcard-receipt";
import { EventClientError } from "../lib/events/client";
import type { PostcardView } from "../lib/events/postcard-contract";
import type { PostcardDraft } from "../lib/events/postcard-journal";
import { validateTemplateDesign } from "../lib/templates/model";

function fixture() {
  const id = () => crypto.randomUUID(), eventId = id(), guestId = id(), postcardId = id(), submissionId = id();
  const design = validateTemplateDesign({ canvas: { width: 536, height: 1600 }, requiredSources: { A: 1 }, slots: [{ id: "photo", role: "A", sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, crop: { zoom: 1, offsetX: 0, offsetY: 0, rotation: 0, mirror: false } }], layers: [], decorations: [], look: { frameId: "film", filterId: "none", patternId: "none", themeId: null, sceneId: null, materialId: null }, defaults: { caption: "", showDate: false } });
  const expiresAt = new Date(Date.now() + 3600000).toISOString(), principalId = id();
  const view: PostcardView = { version: 1, eventId, postcardId, submissionId, revision: 5, state: "ready", source: { kind: "challenge", id: id() }, design, designHash: "a".repeat(64), expiresAt, logicalExpiresAt: null, selfPrincipalId: principalId, canSubmit: true, selfConsent: { submission: true, gallery: false, wall: false }, participants: [{ principalId, role: "A", bound: true, consent: true, approved: true }], candidate: null };
  const receipt = { submissionId, state: "ready" as const, logicalExpiresAt: expiresAt, eventExpiresAt: expiresAt, gallery: "private" as const, wall: "private" as const };
  const draft: PostcardDraft = { version: 1, eventId, guestId, proposal: { postcardId, submissionId, source: view.source, design }, revision: 2, ticketRequestId: id(), reserveRequestId: id(), expiresAt, image: null, receipt, consentIntent: null };
  const calls: string[][] = [], copied: string[] = [], controller = new AbortController();
  const result = { receipt, receiptToken: "a".repeat(42) + "A", fragmentOnly: true as const };
  const client = { eventId, guestId, assertActive() {}, async view() { return structuredClone(view); }, async reserve(...args: [string, string, string, AbortSignal?]) { calls.push(args.slice(0, 3) as string[]); return result; } };
  const run = () => copyPostcardReceipt(client, draft, "http://127.0.0.1:3010", async link => { copied.push(link); }, controller.signal);
  return { view, draft, result, client, calls, copied, controller, run };
}

test("receipt recovery reuses frozen reservation identity without persisting credentials", async () => {
  const f = fixture(), before = JSON.stringify(f.draft);
  await f.run(); await f.run();
  assert.deepEqual(f.calls, Array(2).fill([f.view.postcardId, f.view.submissionId, f.draft.reserveRequestId]));
  assert.equal(f.copied[0], f.copied[1]);
  const url = new URL(f.copied[0]);
  assert.equal(url.pathname, `/receipt/${f.view.submissionId}`);
  assert.equal(url.searchParams.get("event"), f.view.eventId);
  assert.equal(url.searchParams.has("token"), false);
  assert.equal(new URLSearchParams(url.hash.slice(1)).get("token"), f.result.receiptToken);
  assert.equal(JSON.stringify(f.draft), before);
  assert.equal(before.includes(f.result.receiptToken), false);
});

test("unapproved, expired, non-submitting or unrecoverable postcards cannot retrieve a receipt", async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.view.state = "candidate"; }, (f: ReturnType<typeof fixture>) => { f.view.canSubmit = false; }, (f: ReturnType<typeof fixture>) => { f.view.expiresAt = "2020-01-01T00:00:00.000Z"; }, (f: ReturnType<typeof fixture>) => { f.draft.receipt = null; }, (f: ReturnType<typeof fixture>) => { f.client.guestId = crypto.randomUUID(); }]) {
    const f = fixture(); change(f); await assert.rejects(f.run()); assert.equal(f.calls.length, 0); assert.equal(f.copied.length, 0);
  }
});

test("withdrawal or changed source during receipt recovery prevents credential disclosure", async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.view.state = "revoked"; }, (f: ReturnType<typeof fixture>) => { f.view.source.id = crypto.randomUUID(); }, (f: ReturnType<typeof fixture>) => { f.view.canSubmit = false; }]) {
    const f = fixture(); f.draft = structuredClone(f.draft);
    const original = f.client.reserve; f.client.reserve = async (...args) => { const value = await original(...args); change(f); return value; };
    // Keep the original proposal independent of the mutable server response.
    f.view.source = { ...f.view.source };
    await assert.rejects(f.run()); assert.equal(f.copied.length, 0);
  }
});

test("late cancellation, lost identity and malformed receipts never reach clipboard", async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.controller.abort(); }, (f: ReturnType<typeof fixture>) => { f.client.assertActive = () => { throw new EventClientError("identity_changed"); }; }, (f: ReturnType<typeof fixture>) => { f.result.receiptToken = "invalid"; }]) {
    const f = fixture(), original = f.client.reserve;
    f.client.reserve = async (...args) => { const value = await original(...args); change(f); return value; };
    await assert.rejects(f.run()); assert.equal(f.copied.length, 0);
  }
});
