import { eventClientObject, eventClientConsent, parseEventReceipt } from "./client";
import type { EventConsent, EventReceipt } from "./contract";
export interface EventOwnConsent { version: 1; eventId: string; submissionId: string; revision: number; consent: EventConsent; receipt: EventReceipt }
export function parseEventOwnConsent(value: unknown, eventId: string, submissionId: string): EventOwnConsent {
  const b = eventClientObject(value, ["version", "eventId", "submissionId", "revision", "consent", "receipt"]), consent = eventClientConsent(b.consent);
  if (b.version !== 1 || b.eventId !== eventId || b.submissionId !== submissionId || !Number.isInteger(b.revision) || Number(b.revision) < 0 || Number(b.revision) > 2147483647 || !consent.submission) throw new Error("invalid_own_consent");
  return { version: 1, eventId, submissionId, revision: Number(b.revision), consent, receipt: parseEventReceipt(b.receipt, submissionId) };
}
export function prepareEventConsentChange(current: EventOwnConsent, gallery: boolean, wall: boolean) {
  if (typeof gallery !== "boolean" || typeof wall !== "boolean") throw new Error("invalid_consent");
  return Object.freeze({ expectedRevision: current.revision, gallery, wall });
}
