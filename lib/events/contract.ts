export const EVENT_LIMITS = Object.freeze({ guests: 25, contributions: 100, eventBytes: 250_000_000, imageBytes: 2_000_000, thumbnailBytes: 100_000, derivativeBytes: 2_100_000, logicalSeconds: 600, uploadSeconds: 7200, cleanupMarginSeconds: 300, issueSeconds: 60, readSeconds: 300, jobBatch: 10, leaseSeconds: 120 });
export type EventStatus = "draft" | "open" | "paused" | "closed" | "deleted";
export type EventDeliveryState = "reserved" | "uploading" | "finalising" | "ready" | "failed" | "expired" | "deleted";
export type EventDestination = "gallery" | "wall";
export type EventPublicationState = "private" | "awaiting_approval" | "approved" | "hidden" | "rejected";
export type EventErrorCode = "unavailable" | "invalid_request" | "access_denied" | "capacity" | "conflict" | "expired" | "not_ready" | "lease_lost";
export interface EventCapabilities { version: 1; ready: boolean; deploymentBytes: number; allocatedBytes: number; limits: typeof EVENT_LIMITS }
export const EVENT_TRANSPORT_LIMITS = Object.freeze({ version: 1, rateKeys: 10000, readPerMinute: 120, writePerMinute: 60, redeemPerMinute: 30, issuancePerEvent: 64 });
export type EventTokenKind = "contribute" | "receipt" | "gallery" | "display";
export interface EventSession { eventId: string; kind: EventTokenKind; guestId: string | null; submissionId: string | null; expiresAt: string }
export interface EventCreateInput { title: string; timezone: string; startsAt: string; closesAt: string; expiresAt: string; maxGuests: number; maxContributions: number; maxBytes: number }
export interface EventConsent { submission: boolean; gallery: boolean; wall: boolean }
export interface EventReservation { submissionId: string; state: EventDeliveryState; logicalExpiresAt: string; eventExpiresAt: string; stagingHeldBytes: number; derivativeHeldBytes: number; stagingPath: string }
export interface EventReceipt { submissionId: string; state: EventDeliveryState; logicalExpiresAt: string; eventExpiresAt: string; gallery: EventPublicationState; wall: EventPublicationState }
export interface EventUploadAuthorisation { bucket: "photobooth-event-images-staging-v2"; path: string; generation: number; mintBefore: string; authorisationUntil: string; cleanupAfter: string; maxBytes: number; overwrite: false }
export type EventJobKind = "finalise" | "delete_delivery" | "delete_staging";
export interface EventJob { id: string; event_id: string; submission_id: string; kind: EventJobKind; status: "queued" | "running" | "retry" | "complete" | "failed"; attempts: number; lease_token: string | null; lease_until: string | null; checkpoint: Record<string, unknown> }
export interface EventObjectAccess { bucket: "photobooth-events-v2"; path: string; maxAgeSeconds: number }
export type EventManageAction = "update" | "open" | "pause" | "close" | "delete" | "invite" | "rotate_invite" | "revoke_guest" | "invite_moderator" | "accept_moderator" | "revoke_moderator" | "publication" | "remove_submission" | "issue_read_token" | "revoke_token";
export interface EventDashboard { event: Record<string, unknown>; submissions: EventReceipt[]; usage: { guests: number; count: number; bytes: number; stagingBytes: number; derivativeBytes: number } }
