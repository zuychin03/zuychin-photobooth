# P7 event discovery and settings foundation

Migration `017_v2_event_host_settings.sql` extends the event model without changing the creation request, its fingerprint, guest capability issuance, or publication permissions. Apply it only through the normal operator migration process. This work does not apply hosted SQL or enable feature flags.

## Contract

`lib/events/host-contract.ts` defines the bounded public projections. `createEventHostStore` shares the existing authenticated actor proof from `event-store.ts`; a plain user ID object cannot authorise a request.

- `capabilities()` returns `version: 1`, `listLimit: 25`, `settingsReceipts: 64`, `captionCharacters: 160`.
- `list(actor, after?, limit?)` returns `{ version: 1, events, nextCursor }`. UUID order is ascending and the cursor is the last returned ID only when more rows exist. Each summary contains event ID, title, timezone, start/contribution-close/expiry timestamps, status, the caller's role and membership. Active owners and active or invited moderators can discover their events. Revoked and unrelated memberships cannot. Expired and deleted events remain listed for honest cleanup status; this does not grant media access.
- `settings(actor, eventId)` returns `{ version: 1, eventId, revision, locked, event, look }` to active owners/moderators. Invited moderators receive only discovery metadata until they accept through the existing action.
- `saveSettings(actor, eventId, requestId, expectedRevision, { event, look })` is owner-only. `event` is the unchanged `EventCreateInput`. Reuse the exact request ID, expected revision and payload after uncertain delivery. Reusing an ID with different input conflicts.

The returned settings acknowledge a recorded request and show the current settings, including any later successful edit. They are not the original request's historical snapshot. Revisions are opaque monotonic values. A save changing both core settings and look can advance twice because each database update participates in the same revision trigger. Clients must use the returned revision, not increment locally. A successful no-op still records its retry identity but need not change the revision.

The new RPCs are service-only. The existing HTTP handler authenticates and rate-limits through the event transport, validates exact request fields, passes its abort signal to the RPC client, and revalidates the response projections. No tokens, owner IDs, raw database records or creation fingerprints belong in discovery/settings responses.

HTTP shapes are root `POST { operation: "list", after?, limit? }`, host `POST { operation: "settings" }` and host `POST { operation: "saveSettings", requestId, expectedRevision, settings: { event, look } }`. Discovery/settings use read rate limits; saving uses write limits. Capabilities adds `hostVersion: 0 | 1` separately from the existing transport version. Missing or incompatible host RPCs advertise zero while preserving the base event capability response. The optional host-store port keeps older fixture adapters compatible. New host operations still fail closed if their store or schema is unavailable.

## Look and caption boundaries

The look is `{ version: 1, frameId, filterId, sceneId, caption, showDate }`. Its default is film white, original filter, no scene, empty caption and no date. It permits the existing seven frame IDs, six filter IDs and only the six curated event scene IDs in asset pack 2.0.0. There are no arbitrary URLs, decorations, local blobs, source-photo references, inherited couple captions or token fields. Hosts may enter up to 160 Unicode characters; control characters are rejected. The model stores a safe rendering recipe only. Applying that recipe to guest compositions is a separate UI integration responsibility.

Look and caption changes stop at `first_accepted_at`, which migration 005 sets when the first contribution reservation is accepted. Settings changes and contribution reservation lock the same event row, so an edit cannot slip past that boundary. Existing schedule/expiry/capacity restrictions remain enforced by `pb_event_manage('update')`. The look's `locked` flag also covers deleted/expired events. It does not mean every core field is immutable: existing title/capacity/window rules still apply.

Legacy core updates also advance the settings revision. Original creation retries keep their original identity and return current event state. At most 64 distinct successful settings request receipts are retained per event. Receipts store a hash, not caption text or payload copies. Filling this limit does not block existing privacy deletion or cleanup operations.

## Verification

Run `node --import tsx --test tests/event-host-store.test.ts tests/event-store.test.ts` for strict projections, forged actors, cursor bounds, catalogue parity and unchanged base adapter behaviour.

Run `node --import tsx --test tests/event-host-requests.test.ts tests/event-requests.test.ts` for real-handler/adapter integration, separate capability fallback, verified identity, read/write rate buckets, immutable retry input, malformed projection refusal and cancellation without late settings disclosure.

Run `node database/tests/run-event-host.mjs` against the task-owned local PostgreSQL test container. It creates and removes a unique database, applies the migration twice, and checks discovery isolation, invitations/revocation, keyset pagination, safe settings validation, exact retries, stale/concurrent CAS, legacy create/update behaviour, first-contribution races, receipt limits and deletion/expiry visibility. These are local database checks, not hosted deployment or browser evidence.
