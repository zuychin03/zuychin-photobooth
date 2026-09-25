# Cloud design save recovery

This is a source-ready P6 save coordinator and account-scoped recovery journal. It does not enable hosted cloud storage or prove provider/device behaviour. The canonical design contract remains migration 012, including retirementVersion 1 and its 100 immutable save-receipt limit.

## Public contract

`AccountCloudRuntime.designs` exposes `prepare`, `run`, `list`, `adoptOpen`, `forget`, and `close`. `prepare({ projectId, project, expectedRevision, participants, bindings?, canonicalIdentity? })` takes a saved project from the exact signed-in account repository. Device-only projects must first be deliberately copied into that account scope. The expected cloud revision is independent of the local project revision.

`prepare` validates the complete portable snapshot, writes a local `preparing` record with preallocated save/upload UUIDs, then checks every original sequentially using the existing native image inspector, exact inventory dimensions/size/MIME and SHA-256. It records immutable upload descriptors and bindings before returning `prepared`. There are no network mutations during preparation. A failed preparation remains visible and can be resumed with `run(recordId)`; another prepare for that local/cloud pair is rejected until the existing attempt is completed or explicitly dismissed.

`run(recordId, signal?)` checks current cloud ownership, accepted participant owners and source descriptors/read grants. It uploads only new originals through the existing bounded upload manager, sequentially, and requires verified ready status for every source. It persists `saving` before the canonical request. A lost response or failed local receipt write leaves that exact request intact; retry asks for its immutable receipt before attempting the same request again. A pending original returns `{ kind: 'pending', record, assetId }`. Success returns `{ kind: 'complete', record, receipt }`.

The coordinator retains frozen upload descriptors even when confirmed-ready upload tracking is pruned. It can reconstruct that tracking with the same asset and request IDs. Changed local bytes cannot replace an original. Reused bindings require a fresh exact hash, metadata, owner and current read grant. The server remains authoritative for challenge protection, lifetime binding identity and CAS.

`adoptOpen(openedResult)` accepts the complete successful result from `openCloudDesignCopy`. Call it before navigating to the new local copy. It durably associates the local copy with its cloud project, receipt, bindings, participant ownership and canonical identity. Subsequent saves preserve canonical ID, creation time and capture timezone. A previously null capture timestamp may become the first validated capture time; an already fixed capture time is preserved. Opening a previous checkpoint does not grant permission to overwrite a newer cloud head; the caller must obtain the explicit current head and choose its expected revision.

`forget(id, expectedJournalRevision)` removes local tracking under CAS only. It neither deletes remote originals nor releases cloud quota. Dismissing an uncertain request also discards its automatic exact-request recovery. `close` aborts local coordination and closes the owned design journal; it does not claim remote cancellation.

## Bounds and cleanup

The existing cloud journal upgrades additively from version 3 to version 4. It contains uploads, challenge requests, design saves and voice drafts, all keyed by exact account and ID. Version 3 clients receive IndexedDB VersionError rather than performing an incomplete cleanup. Unknown future databases remain untouched and report incomplete cleanup.

Design saves have a limit of 32 records per account, 128 KiB per record and 4 MiB total JSON. There is no automatic eviction of uncertain saves. Completed associations occupy a record until explicitly dismissed; another save of that same local/cloud pair reuses the record with a fresh request and journal revision. Media is retained only in the existing bounded project repository, never duplicated into this journal. No signed URL, token, camera ID or Blob is persisted in design records.

Each coordinator admits one operation at a time. Original inspection and upload are sequential; the existing 24-file, 64 MiB project inventory and per-kind media limits remain unchanged. The image inspector closes late native decode results but cannot synchronously abort browser decoder allocation. Underlying HTTP calls and upload polling retain their existing finite deadlines. The coordinator does not start background retries or accumulate queued operations.

Runtime account invalidation closes the client, upload manager and journals, including late-opening design connections. Explicit remove-local-copies cleanup atomically clears all four journal stores for the selected account and advances its persistent generation. Pending transactions are aborted; other accounts are preserved. The runtime's default Blob port reads only the exact account project repository, checks identity before and after each await, then closes that connection.

## Validation

On 23/09/2026, 18 focused coordinator/runtime tests passed. They cover failure before network mutation, stable identities after local preparation failure, lost acknowledgement, local receipt-write failure, pruned upload tracking, pending finalisation, changed bytes, foreign descriptors, adopted canonical identity, first capture timestamp, wrong scope, account loss and late IndexedDB opens. Whole TypeScript and scoped ESLint passed for this source tranche.

`runCloudDesignSaveProbe()` is a development-only, isolated native IndexedDB probe. It exercises version 3 to 4 preservation, old-client refusal, competing CAS writers, close/reopen, frozen request protection, transaction rollback, future-record read-only handling, the 32-record cap and all-four-store account cleanup with foreign-account survival. It deletes only its uniquely named synthetic databases. The probe is source-ready; native execution has not yet been claimed here. Hosted Storage, actual provider grants and physical-device acceptance remain separate gates.

## Development design rehearsal

The existing `/v2-lab/cloud` rehearsal now supplies `runtime.designs` to the actual save/open panels. Explicit Start creates one bounded synthetic PNG project for each synthetic account in a uniquely named P2 database. Save coordination and editable-copy opening use only that injected repository, never the normal account database. Stop closes the sessions/repositories and deletes both the unique project database and shared recovery journal.

The fake `/api/projects/design` transport supports capabilities, owner head/status, current and previous snapshots, exact-request receipts, compare-and-swap, lifetime binding identity and fresh source access checks. Its response hashes are deterministic fixture JSON hashes, not evidence of PostgreSQL JSONB canonicalisation. Original upload and download use the existing synthetic transport with real image inspection, hash checks and the actual upload manager.

Project-level controls can lose the next successful design-save response, advance the head as another synthetic device, or revoke a bound original. Opening an editable copy calls `adoptOpen`, reports the new isolated local ID and stays in the rehearsal. The normal panels can then prepare another save from that linked copy. Unmount/remount retains the fixture databases; switching synthetic accounts fences old work and shows only the new account's projects. Reload resets the fake server and is not a hosted-durability test.

Source validation on 23/09/2026: six real-client fixture tests and nine coordinator tests passed (15 total), covering current/previous views, lost acknowledgements, exact retries, CAS races, revoked originals, owner/viewer boundaries and retirement. Whole TypeScript and scoped ESLint passed. Native UI execution is a separate parent-owned check; no hosted API, Storage, authentication or production navigation was used in this tranche.

## Native rehearsal, 23/09/2026

All 15 native design-journal checks passed at 10:06:19 UTC in Chromium 153 on Windows. This includes additive v3 migration, refusal by old clients, one CAS winner, close/reopen, frozen identities, rollback, unknown records, capacity, exact-account cleanup across all four stores, stale-writer fencing and preservation of the other account. The probe removed its isolated databases.

The actual panels then prepared a saved P2 project containing one 1.1 KiB synthetic PNG. A deliberately lost save response left a pending request. Workspace unmount/remount recovered it; Continue reconciled version 1 without a duplicate save. Opening made a separate account-scoped P2 copy and durably adopted its cloud identity. Preparing that copy saved version 2; the previous checkpoint still exposed version 1. Advancing the simulated head refused a stale save and refused opening a replaced checkpoint. Revoking a bound original denied design access. Switching accounts removed Alex's projects and offered only Bao's saved design.

Review corrected dismissal action locking and focus restoration, duplicate-name labels with save times, and singular original/file wording. The safe Keep action received focus and restored the dismissal trigger. Narrow dark (390 x 844) and desktop light (1280 x 720) recovery screens were rendered without observed horizontal overflow. Stop and clear rehearsal removed the temporary projects and journals. This proves local UI, image and IndexedDB behaviour with synthetic transport; hosted provider durability and normal editor navigation remain separate checks.
