import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { createEventGuestClient } from "../lib/events/client";
import { createEventPostcardClient, createPostcardSourceClient, type PostcardReviewedImage } from "../lib/events/postcard-client";
import { parsePostcardDraft, updatePostcardDraft } from "../lib/events/postcard-journal";
import { parsePostcardInvitation, parsePostcardReference, postcardReferenceUrl } from "../lib/events/postcard-links";
import { validateTemplateDesign } from "../lib/templates/model";
import type { PostcardView } from "../lib/events/postcard-contract";
const id = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const design = validateTemplateDesign({ canvas: { width: 536, height: 1600 }, requiredSources: { A: 1 }, slots: [{ id: "photo", role: "A", sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, crop: { zoom: 1, offsetX: 0, offsetY: 0, rotation: 0, mirror: false } }], layers: [], decorations: [], look: { frameId: "film", filterId: "none", patternId: "none", themeId: null, sceneId: null, materialId: null }, defaults: { caption: "Synthetic", showDate: false } });
const source = { kind: "room" as const, id: id(4), captureId: id(5) }, proposal = { postcardId: id(2), submissionId: id(3), source, design };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
async function fixture() {
  const jpeg = await sharp(await readFile("tests/fixtures/projects/b.png")).jpeg().toBuffer(), metadata = await sharp(jpeg).metadata();
  const candidate = { revision: 1 as const, sha256: createHash("sha256").update(jpeg).digest("hex"), bytes: jpeg.length, width: metadata.width, height: metadata.height, mime: "image/jpeg" as const };
  let epoch = 1, reads = 0, closes = 0, approvalCalls = 0;
  const snapshot = (): PostcardView => ({ version: 1, eventId: id(1), postcardId: id(2), submissionId: id(3), revision: 5, state: "candidate", source, design, designHash: "a".repeat(64), expiresAt: new Date(Date.now() + 3600000).toISOString(), logicalExpiresAt: new Date(Date.now() + 600000).toISOString(), selfPrincipalId: id(6), canSubmit: true, selfConsent: { submission: true, gallery: false, wall: false }, participants: [{ principalId: id(6), role: "A", bound: true, consent: true, approved: false }], candidate });
  let view = snapshot(), corrupt = false, deniedAfterDecode = false, foreignUrl = false;
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).startsWith("https://storage.example")) { assert.equal(init?.credentials, "omit"); assert.equal(init?.cache, "no-store"); const copy = new Uint8Array(jpeg); if (corrupt) copy[copy.length - 3] ^= 1; return new Response(copy, { headers: { "content-type": "image/jpeg" } }); }
    const body = JSON.parse(String(init?.body)); assert.equal(init?.credentials, "same-origin"); assert.equal(body.expectedGuestId, id(7));
    if (body.operation === "view") { reads++; if (deniedAfterDecode && closes === 0 && reads > 1) return json({ error: "access_denied" }, 403); return json(view); }
    if (body.operation === "candidate") return json({ ...candidate, submissionId: id(3), bucket: "photobooth-events-v2", path: `${id(1)}/${id(3)}/image`, retainedUntil: view.expiresAt, expiresAt: new Date(Date.now() + 290000).toISOString(), signedUrl: `${foreignUrl ? "https://foreign.invalid" : "https://storage.example"}/storage/v1/object/sign/photobooth-events-v2/${id(1)}/${id(3)}/image?token=synthetic` });
    if (body.operation === "approveCandidate") { approvalCalls++; assert.equal(body.sha256, candidate.sha256); return json({ ...view, participants: view.participants.map(p => ({ ...p, approved: true })) }); }
    throw new Error("Unexpected operation");
  };
  const guest = createEventGuestClient({ appOrigin: "https://app.example", eventId: id(1), identity: () => ({ eventId: id(1), guestId: id(7), epoch }), fetch: fetcher });
  const client = createEventPostcardClient({ appOrigin: "https://app.example", storageOrigin: "https://storage.example", guest, fetch: fetcher, decode: async blob => { const m = await sharp(Buffer.from(await blob.arrayBuffer())).metadata(); return { width: m.width, height: m.height, close() { closes++; } }; } });
  return { client, guest, candidate, snapshot, get reads() { return reads; }, get closes() { return closes; }, get approvals() { return approvalCalls; }, replace: () => { epoch++; }, corrupt: () => { corrupt = true; }, revokeDuringDecode: () => { deniedAfterDecode = true; }, foreign: () => { foreignUrl = true; }, change: (next: PostcardView) => { view = next; } };
}
test("candidate approval requires this client's verified JPEG and fresh matching server view", async () => {
  const f = await fixture(); await assert.rejects(f.client.approveCandidate({ candidate: f.candidate, postcardId: id(2), submissionId: id(3), blob: new Blob() } as PostcardReviewedImage), /image_review_required/);
  const image = await f.client.download(id(2)); assert.equal(f.reads, 2); assert.equal(f.closes, 1); assert(image.blob.size > 0);
  await f.client.approveCandidate(image); assert.equal(f.approvals, 1);
  f.change({ ...f.snapshot(), candidate: { ...f.candidate, sha256: "f".repeat(64) } }); await assert.rejects(f.client.approveCandidate(image), /conflict/); assert.equal(f.approvals, 1);
});
test("equal-size corrupted bytes never reach review or approval", async () => { const f = await fixture(); f.corrupt(); await assert.rejects(f.client.download(id(2)), /invalid_image/); assert.equal(f.closes, 0); assert.equal(f.approvals, 0); });
test("late permission withdrawal clears decoded candidate before handing bytes to the UI", async () => { const f = await fixture(); f.revokeDuringDecode(); await assert.rejects(f.client.download(id(2)), /access_denied/); assert.equal(f.closes, 1); });
test("foreign signed destinations and replaced guest epochs fail closed", async () => { const f = await fixture(); f.foreign(); await assert.rejects(f.client.download(id(2)), /invalid_response/); f.replace(); await assert.rejects(f.client.view(id(2)), /identity_changed/); });
test("room proposal discovery uses only same-origin room credentials and exact source", async () => {
  let active = true, calls = 0; const client = createPostcardSourceClient({ appOrigin: "https://app.example", source, assertAuthority() { if (!active) throw new Error("source_lost"); }, fetch: async (_url, init) => { calls++; assert.equal(init?.credentials, "same-origin"); assert.equal(new Headers(init?.headers).get("Authorization"), null); assert.deepEqual(JSON.parse(String(init?.body)), { operation: "proposal", postcardId: id(2), source }); return json({ eventId: id(1), proposal }); } });
  assert.deepEqual(await client.proposal(id(2)), { eventId: id(1), proposal }); active = false; await assert.rejects(client.proposal(id(2)), /source_lost/); assert.equal(calls, 1);
});
test("challenge source auth is fresh and never sends event cookies", async () => {
  const challenge = { kind: "challenge" as const, id: id(4) }; let tokenCalls = 0;
  const client = createPostcardSourceClient({ appOrigin: "https://app.example", source: challenge, assertAuthority() {}, accessToken: async () => `token${++tokenCalls}`, fetch: async (_url, init) => { assert.equal(init?.credentials, "omit"); assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer token${tokenCalls}`); return json({ eventId: id(1), proposal: { ...proposal, source: challenge } }); } });
  await client.proposal(id(2)); await client.proposal(id(2)); assert.equal(tokenCalls, 2);
});
test("deadline releases caller even when a fetch ignores cancellation, with bounded unresolved work", async () => {
  let calls = 0; const guest = createEventGuestClient({ appOrigin: "https://app.example", eventId: id(1), identity: () => ({ eventId: id(1), guestId: id(7), epoch: 1 }) });
  const client = createEventPostcardClient({ appOrigin: "https://app.example", storageOrigin: "https://storage.example", guest, timeoutMs: 10, fetch: async () => { calls++; return new Promise<Response>(() => {}); } });
  await assert.rejects(client.view(id(2)), /timeout/); await assert.rejects(client.view(id(2)), /timeout/); await assert.rejects(client.view(id(2)), /busy/); assert.equal(calls, 2); client.close();
});
test("postcard journal snapshots reject credentials, image replacement and stale intent changes", async () => {
  const f = await fixture(), draft = parsePostcardDraft({ version: 1, eventId: id(1), guestId: id(7), proposal, revision: 0, ticketRequestId: id(8), reserveRequestId: id(9), expiresAt: new Date(Date.now() + 3600000).toISOString(), image: null, receipt: null, consentIntent: null });
  assert.throws(() => parsePostcardDraft({ ...draft, ticket: "secret" }));
  const image = updatePostcardDraft(draft, { image: f.candidate }); assert.throws(() => updatePostcardDraft(image, { image: { ...f.candidate, sha256: "f".repeat(64) } }), /conflict/);
  const pending = updatePostcardDraft(image, { consentIntent: { expectedRevision: 5, consent: { submission: true, gallery: false, wall: true } } });
  assert.throws(() => updatePostcardDraft(pending, { consentIntent: { expectedRevision: 6, consent: { submission: true, gallery: true, wall: true } } }), /conflict/);
  assert.equal(updatePostcardDraft(pending, { consentIntent: null }).reserveRequestId, draft.reserveRequestId);
});
test("share references contain metadata only; invitations are strict same-origin fragment credentials", () => {
  const link = postcardReferenceUrl("https://app.example", id(1), id(2), source); assert.deepEqual(parsePostcardReference(link, "https://app.example"), { eventId: id(1), postcardId: id(2), source }); assert(!link.includes("token"));
  for (const bad of [link + "&source=" + id(4), link + "#token=secret", link.replace("app.example", "foreign.example")]) assert.throws(() => parsePostcardReference(bad, "https://app.example"));
  const invite = `https://app.example/events/${id(1)}/join#invite=${"A".repeat(43)}`; assert.equal(parsePostcardInvitation(invite, "https://app.example").eventId, id(1)); assert.throws(() => parsePostcardInvitation(invite.replace("#invite", "?invite"), "https://app.example"));
});
