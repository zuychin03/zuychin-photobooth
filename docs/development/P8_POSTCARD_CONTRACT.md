# Remote postcards, local backend contract

Migration `025_v2_event_postcards.sql` is an unapplied source artefact. This tranche bridges an authorised room capture or revealed challenge result into an event. It does not grant an event host access to the source room, project, challenge inputs or private originals.

## Authority and frozen identity

The source principal is verified independently of the event guest. Room attachment uses the existing room-specific HttpOnly capability cookie. Challenge and partial-result attachment uses a server-verified account token. A five-minute event ticket binds one current contribution guest to one postcard. The source endpoint then binds only its authenticated principal to that guest. One guest cannot stand in for two source principals.

The immutable proposal contains postcard and submission UUIDs, a source descriptor and a validated `TemplateDesign`. Server-derived proof freezes the source capture/reveal hash, included roles, principals and challenge source asset identities. Sparse and repeated template sources are resolved by role and source index. Concealed challenge inputs, excluded partial contributors, changed source identity and unavailable decoration references are denied. Source-authenticated proposal discovery returns the same immutable proposal and public event ID without guest identifiers or capabilities.

Every included principal must explicitly consent to event submission before reservation or staging. Gallery and wall consent remain separate and default false. The ordinary reservation RPC rejects postcard-owned submission IDs; its previous implementation is private and invoked only after postcard checks. This also prevents the mission wrapper or an older service caller from bypassing the extra consent gate.

## Candidate and publication lifecycle

The first accepted reservation starts the existing ten-minute logical deadline. Upload, provider transformation, candidate review and unanimous approval must fit that same deadline. Event close uses the existing grace rule. The worker decodes and re-encodes the source through the normal bounded Sharp path, verifies both stored derivatives, then records the final JPEG digest, byte count and dimensions. Its completion becomes `candidate`, while the ordinary receipt remains `finalising` and all publication surfaces remain private.

Each bound participant downloads the candidate through a fresh private authorisation and approves its exact verified SHA-256. The server rechecks all source and participant authority before candidate reads, storage writes, checkpoints, approval and transition to ready. The last matching approval makes the submission ready. Unanimous destination consent then permits `awaiting_approval`; host or moderator approval is still independently required for gallery or wall publication.

After ready, each bound participant can read the same verified JPEG until event retention ends, subject to fresh source and unanimous submission-grant checks. This does not extend the candidate approval deadline.

`canSubmit` is a required server-derived boolean identifying the original submitting guest. Other bound participants can consent, review, approve and withdraw, but cannot stage this postcard.

Postcard revision is an opaque monotonic value. `selfConsent` is the participant's actual current submission/gallery/wall choice. The grant-change bridge synchronises it with ordinary consent operations, including migration 026, and fences stale restoration. Submission withdrawal bypasses stale revision and capacity checks, revokes the whole postcard and queues existing cleanup. Host removal and event expiry also deny future reads. Already downloaded local files cannot be revoked.

Ordinary room completion or room-row expiry does not revoke an already accepted postcard. Frozen bindings have no source-row foreign key cascade. Explicit member removal, source capture changes, challenge withdrawal, project membership loss or source deletion revoke the dependent event derivative. Bindings remain through event retention, then bounded housekeeping removes them. A participant's event session remains necessary for event-side withdrawal after anonymous room expiry. Recovery after losing or replacing that session is not implemented by this backend and must not be presented as a cross-browser recovery link.

## HTTP and browser integration

All operations are POST, same-origin, private/no-store and no-referrer. There are no mutation GETs. Event operations use the contribution cookie plus `expectedGuestId`; source operations use their separate authority. HTTP applies durable IP and principal rates, strict operation fields, finite chunks, a 20-second logical deadline and bounded provider requests. Source JSON is capped at 80,000 bytes; event JSON at 8,192 bytes.

`POST /api/events/{eventId}/postcards`:

- `capabilities {}` returns the exact independent postcard marker and limits.
- `ticket {expectedGuestId, postcardId, requestId}` returns `{postcardId, expiresAt, ticket}`.
- `view {expectedGuestId, postcardId}` returns `PostcardView`.
- `scopeConsent {expectedGuestId, postcardId, expectedRevision, consent}` returns the current view.
- `reserve {expectedGuestId, postcardId, requestId}` returns `{receipt, receiptToken, fragmentOnly:true}`. Exact retry returns the existing receipt even after the worker progresses.
- `candidate {expectedGuestId, postcardId}` returns final JPEG digest/bytes/dimensions, exact submission/bucket/path, an ephemeral signed URL and its expiry. Signing is followed by another authority check.
- `approveCandidate {expectedGuestId, postcardId, sha256}` returns the current view.

`POST /api/rooms/{roomId}/postcards` and `POST /api/challenges/{sourceId}/postcards`:

- `proposal {postcardId, source}` returns `{eventId, proposal}` only to a currently authorised source participant.
- `attach {eventId, ticket, proposal}` binds that principal and returns the view. A partial result uses its partial UUID as `sourceId` and `source.kind:'partial'`.

After specialised reservation, the existing guest upload and finalise operations remain the only staging transport. Ticket, receipt and signed URL values are credentials and must never enter persistent journals, reports or logs. The browser must persist immutable request/proposal IDs before network work, never silently replace an uncertain request, and verify actual candidate bytes before enabling exact-digest approval. This document does not claim that the browser journal or UI is complete.

## Bounds and accounting

There are at most four principals, 100 postcard records per event and 100 per source, checked under shared locks. Each guest has one current ticket row. A draft expires after at most 24 hours or event expiry. Accepted source and candidate bytes use the existing event reservation, provisional two-pending global admission ceiling, provider token lifetime and physical cleanup accounting. Candidate failure or withdrawal does not release held bytes early. No new bucket, scheduler or independent free capacity is assumed. The existing event maintenance runner recognises an acknowledged candidate as a successful worker pass, without claiming final delivery.

## Local evidence and remaining gates

On 23/09/2026, 26 focused transport, worker and readiness tests passed, including actual Sharp output, candidate outcome, preserved kiosk source approval, wrong authority/cookie fields, bounded chunk input, cancellation and withdrawal during candidate signing. The disposable PostgreSQL suite passed actual room principal binding, full challenge concealment, contributor-only partial binding, withdrawal racing final approval, exact-digest checks, private candidate reads, ordinary room expiry independence, 026 stale consent restoration denial, concurrent draft admission, retained charges, direct grant denial and populated migration rerun. The harness also exercises actual `EventPostcardStore` parsing against SQL projections.

Provider signing/storage behaviour, hosted migration order, actual scheduler throughput, multi-device participant review and browser recovery remain separate activation and native acceptance gates. All feature flags remain unchanged.

## Room integration source checkpoint

`RoomPostcard` connects the actual room workspace to `EventPostcardComposer` only after the capture's complete participant/source map is saved. `roomPostcardPlan` uses `templateFromProject`; render reads the scoped repository's full originals, not the downsampled room preview. It checks current capture, roster, source ownership, recipe and persisted project before and after composition. Shared room controls, capture and editable-copy navigation are blocked while postcard work is busy.

The native decode/encode slot remains occupied until late cancelled work settles and releases every canvas. Original input is bounded by the room's 48 MiB / 36-megapixel aggregate and capture profile, while output stays within 4096 pixels per side, 12 million pixels and two million JPEG bytes. Material and sticker assets must load before export. No segmentation or silent participant omission occurs: unsupported Together companion layouts ask the user to select a separate-photo or split layout before creating the proposal. Original-background fallback is explicitly labelled.

Four focused room tests passed for full-original mapping, incomplete/rebound/unsupported sources, recipe and authority changes, and late native cancellation/retry. Whole TypeScript, scoped ESLint and the narrow UI detector passed. Room postcard browser rendering and multi-participant native acceptance remain pending with the parent integration pass.
