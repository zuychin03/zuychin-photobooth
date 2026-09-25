import assert from "node:assert/strict";
import test from "node:test";
import { parseEventOwnConsent, prepareEventConsentChange } from "../lib/events/own-consent";
const eventId = "10000000-0000-4000-8000-000000000001", submissionId = "20000000-0000-4000-8000-000000000001";
const value = { version: 1, eventId, submissionId, revision: 9, consent: { submission: true, gallery: true, wall: false }, receipt: { submissionId, state: "ready", logicalExpiresAt: "2099-01-01T00:00:00.000Z", eventExpiresAt: "2099-01-01T00:00:00.000Z", gallery: "private", wall: "rejected" } };
test("own consent reads actual grants independently of moderation states and freezes the revision", () => {
  const current = parseEventOwnConsent(value, eventId, submissionId); assert.equal(current.consent.gallery, true); assert.equal(current.receipt.gallery, "private"); const request = prepareEventConsentChange(current, false, false); current.revision = 12; assert.deepEqual(request, { expectedRevision: 9, gallery: false, wall: false }); assert(Object.isFrozen(request));
  assert.throws(() => parseEventOwnConsent({ ...value, revision: -1 }, eventId, submissionId)); assert.throws(() => parseEventOwnConsent(value, eventId, eventId)); assert.throws(() => parseEventOwnConsent({ ...value, consent: { ...value.consent, submission: false } }, eventId, submissionId));
});
