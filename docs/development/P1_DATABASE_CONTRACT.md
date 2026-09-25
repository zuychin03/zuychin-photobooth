# P1 database contract and local evidence

Recorded 23/09/2026. The additive contract is [migration 001](../../database/migrations/001_v2_lifecycle.sql), also embedded exactly between the `PB_LIFECYCLE_V1` markers in [the complete setup](../../supabase-setup.sql). Existing installations may apply the migration alone. No hosted database write has been made. This implements P1 lifecycle/quota foundations, not the future project, room or event schemas.

## Compatibility and activation

Existing `pb_strips` columns and the owner/current-partner SELECT policy remain available to Gallery. The migration adds `media_bytes`, `archive_verified_at` and `lifecycle_legacy`. New tables are `pb_`-prefixed with RLS enabled, no public/guest table policies and explicit function grants. Existing reader scope is preserved, not widened.

Legacy direct strip INSERTs still pass through the same quota trigger as new clients. Authenticated strip UPDATE is narrowed to `caption`; identity, capture timestamp, layout classification and lifecycle fields are not client-editable. New clients use operation RPCs for keep/release/delete. Direct legacy row DELETE records durable cleanup provenance first, so an ignored Storage error does not erase the only cleanup reference. Stale clients attempting the old lifecycle writes must reload or export locally. Deploy the adapter release with this contract.

The sibling Gallery reader was inspected without edits: `app/photobooth/page.tsx` selects `id,owner,caption,cloudinary_public_id,created_at`, filters non-null public IDs and signs Cloudinary delivery with `type: authenticated`. Its field projection and owner/partner read scope are retained and covered by the local REST fixture. That source/REST check does not establish hosted Gallery playback or validate historical Cloudinary references.

P1 server mutations require the service-role key and canonical HTTPS `PB_PUBLIC_ORIGIN`; cron routes additionally require `CRON_SECRET` in the Bearer header. Query-string secrets are rejected. `/api/media/maintenance` and its `/api/retention` alias discover and process bounded durable work. Later-track flags `PB_EVENTS_ENABLED`, `PB_CLOUD_PROJECTS_ENABLED` and `PB_ROOM_V2_ENABLED` remain false. Installing P1 does not activate those tracks.

`pb_lifecycle_capabilities()` returns version 1, `ready`, `retention_timezone`, the database-computed `week_start` instant, `object_byte_limit`, `weekly_byte_limit`, `strip_limit`, `recap_limit` and `legacy_retention_not_before`. Compatibility aliases also expose the original spike names. The function is available to anonymous/authenticated/service callers but reveals no user rows or credentials. Missing schema, an unexpected version or `ready=false` disables dependent operations.

Timezone starts unset. An authorised operator must reconcile the former deployment's runtime timezone with the intended ISO-week policy, then call service-only `pb_configure_lifecycle(p_timezone text)` with that reviewed IANA name. The local fixture uses `Australia/Sydney`; this is not a production configuration decision. A later timezone change is rejected until a separate reconciliation migration is reviewed. There is no implicit UTC/Sydney fallback for destructive work.

Existing timestamps are preserved. Legacy rows receive a retention floor eight days after migration, beyond the next ordinary weekly reset, so activation does not immediately shorten their retention. `pb_discover_retention` honours that floor and the configured timezone. New rows use the database acceptance timestamp and the configured weekly boundary. Historical rows are backfilled without deletion; unknowable consumption from already-deleted pre-migration rows cannot be reconstructed. Existing unverified object sizes are charged conservatively during backfill. An over-cap historical week remains readable but rejects further saves until legitimate capacity is available.

## Quota and replacement behaviour

The configured ceilings are ten ordinary strips plus one recap per ISO week and quota scope, with each object at most 16 MiB and their combined charge at most 176 MiB. These are bounded P1 choices, not a claim about provider allowances. A client-selected `layout_id='recap'` consumes the separate single recap allowance; it does not bypass all quotas.

For a completed couple, an insert must identify the owner's actual current couple. Pending/unpaired users use the owner scope. Per-owner locks plus the couple-scope lock serialise competing inserts. Current members' existing charges are included when pairing changes, preventing null/foreign couple IDs or repeated couple creation from providing fresh capacity. Storage paths must be exactly `<owner>/<strip-id>.png`; size comes from the corresponding `storage.objects.metadata.size`, never a submitted byte claim. Invalid/missing/oversized metadata rejects insertion. Metadata/path changes or replacement of an already-consumed strip object are rejected.

`pb_strip_quota_ledger` keeps a UUID tombstone, original acceptance instant, week, owner/scope, category, verified charge and path. Direct row deletion, changing UI state or failed cleanup does not release its count or bytes. Only a completed delete job with confirmed Storage removal, Cloudinary removal/absence and row deletion sets `quota_released_at`, under the quota locks. This preserves the existing discard-and-replace workflow while preventing a failed cleanup from pretending to free space. The released UUID cannot be reused. Retries release capacity once.

This bounds accepted active strips within each week, not total lifetime Cloudinary storage, every relay frame or arbitrary pre-existing upload. Shared-provider capacity, orphan storage and archive growth need separate accounting/activation measurements. Uploading an object before a legacy direct INSERT can still consume temporary bytes even when the insert is refused; the new adapter registers provenance first so that path is recoverable.

## Durable jobs and worker RPCs

`pb_media_jobs` records `id`, `kind`, `source_type`, `source_id`, `owner`, owner-scoped `idempotency_key`, trusted `snapshot`, `checkpoint`, `stage`, `status`, `attempts`, `max_attempts`, lease owner/token/expiry, retry time and a bounded error code. Kinds are `archive`, `retention_archive`, `release`, `delete`, `relay_cleanup` and `upload_cleanup`. Status is queued/running/retry/complete/failed. Source snapshots survive source-row deletion. Any prior archive attempt also preserves the deterministic archive identifier for later cleanup when persistence or configuration fails.

| RPC | Caller and result |
| --- | --- |
| `pb_enqueue_strip_operation(p_strip_id, p_operation, p_request_id)` | Authenticated owner only; archive/release/delete; returns the durable job. Archive intent atomically sets kept. Repeating a completed request returns its old job without repeating its state change. At most 32 active user-requested jobs per owner. |
| `pb_enqueue_media_job(p_kind, p_source_type, p_source_id, p_idempotency_key, p_payload)` | Service only; snapshots existing strip/relay records instead of trusting a caller's row snapshot. Tracked upload cleanup normally comes from the upload-intent resolver. |
| `pb_discover_retention(p_limit=25)` | Service only; returns number queued. Uses authoritative week/grace, row locks and current keep/recap state. Excludes previously recorded matching jobs so a failed oldest batch does not starve later rows. |
| `pb_claim_media_jobs(p_worker_id, p_limit=10, p_lease_seconds=60, p_job_id=null)` | Service only; up to 25 jobs, leases up to 900 seconds. Optional exact-job claim supports bounded inline work. Returns job rows with fresh fencing tokens. |
| `pb_checkpoint_media_job(p_job_id, p_lease_token, p_stage, p_checkpoint={})` | Service only; verifies the active token and stage/evidence, merges a bounded checkpoint and renews the lease for 120 seconds. |
| `pb_update_media_strip(p_job_id, p_lease_token, p_fields)` | Service only; lease-fenced mutation of the permitted lifecycle fields. Used instead of an unfenced raw UPDATE. |
| `pb_delete_media_strip(p_job_id, p_lease_token)` | Service only; requires deletion confirmations and the current lease before idempotent row deletion. |
| `pb_finish_media_job(p_job_id, p_lease_token, p_outcome, p_error=null, p_retry_after_seconds=60)` | Service only; complete/retry/failed. Completion validates the operation's final evidence and atomically sets stage complete. |
| `pb_retry_media_job(p_job_id)` | Operator service action for a failed job; adds four attempts up to an absolute ceiling of 20, retaining prior stage/checkpoint. No public retry/admin UI is added. |
| `pb_media_cleanup_paths(p_job_id, p_lease_token)` | Service only; returns exact authorised cleanup paths after current lease, provenance, generation and durable-reference checks. |

Claims use `FOR UPDATE SKIP LOCKED`, source-scoped transaction locks and active-lease checks, including within one batch. Jobs for a source execute in order. A newer explicit user action supersedes an older retention decision; an in-flight retention delete rejects a racing keep with `PB_SOURCE_BUSY`. The worker must surface this honestly instead of claiming the keep succeeded. Every checkpoint and fenced row mutation rechecks retention eligibility. A network/provider side effect still requires an idempotent provider operation and a fresh fence before retry; a database cannot retract an already-issued external request.

Archive stages are pending -> uploaded -> reference_verified. Uploaded checkpoints carry `cloudinary_public_id` and `cloudinary_url`. Reference verification requires `archive_verified=true` and matching persisted strip fields with `archive_verified_at`; an already-existing verified archive may go straight to that stage. Retention archive adds `storage_removed=true` and a persisted purged flag. A delete requires storage_removed -> cloudinary_removed -> row_deleted, each with its matching true confirmation and actual row absence. Release requires Cloudinary confirmation and cleared persisted archive fields. Cleanup requires confirmed Storage removal. Completion accepts the appropriate final stage and records complete atomically; it cannot bypass missing evidence.

## Upload and relay provenance

`pb_register_upload(p_request_id, p_source_id, p_source_type, p_paths)` is authenticated and owner-bound. It returns an upload-intent row with `id`, owner/source, exact paths, status, expiry, creation time and generation. The fixed bucket is `photobooth-strips`. A strip has one exact PNG path; a relay role has one to four distinct exact A/B frame paths. B registration requires an existing pending relay and actual partner membership. A matching completed request is returned before the pending-only check, so completion-response retries work. At most 32 registered intents per owner are accepted; their default lifetime is two hours.

`pb_finish_upload(p_request_id, p_success, p_generation)` requires the exact generation. It checks the durable strip or completed relay-role reference under the intent lock even when the client reports failure. A committed write with a lost response becomes complete, not an orphan. Failure without a reference queues exact stored paths. `pb_enqueue_expired_uploads(p_limit=25)` performs the same bounded reconciliation for expired registered intents, independently of legacy retention grace.

Strip/relay commit triggers and tracked Storage-object writes lock the same intent row. A failed or expired intent rejects a late reference or metadata commit. Once every cleanup job for that generation is complete and no lease remains, the same exact failed intent can rearm for another two hours with an incremented generation, up to eight generations. Delayed finish calls from earlier generations are rejected. A different request ID cannot bypass the unique owner/source binding. A consumed strip UUID cannot be rearmed for reuse.

Relay writes validate real couple membership and immutable identity/role fields. Relay row deletion snapshots cleanup provenance. Historical relay partner ownership is not assumed: unverified legacy partner cleanup is flagged and held for operator review rather than deleting another person's paths speculatively. The initiating owner's known paths remain available to the cleanup contract. Untracked historical orphans are likewise not deleted merely because a listing appears unreferenced.

Supabase Storage's actual object-upload transaction and external object bytes are not emulated by the local schema. Hosted/disposable Storage tests must verify metadata timing, late writes, trigger compatibility and cleanup errors before activation. SQL failure cannot by itself prove that a provider left no transient external object.

## Reminder coordination

Service-only `pb_acquire_job_lease(p_job,p_token,p_seconds)` returns true for an available lease or renewal by the same token; another active token is denied. `pb_release_job_lease(p_job,p_token)` only releases the matching token. `pb_record_reminder_delivery(p_date_id,p_scheduled_at,p_channel)` records an idempotent checkpoint for `email` or `push:<subscription UUID>`. Records survive schedule changes/deletion. A provider send followed by a failed checkpoint remains an at-least-once boundary; provider idempotency and timeout handling belong to the reminder adapter.

## Local validation

Run `node database/tests/run-local.mjs` against the task-owned local PostgreSQL 16 container named `pb-v2-p1-postgres` (override `PB_TEST_CONTAINER` only with another `pb-v2-*` test container). The runner creates unique `pb_v2_lifecycle_*` databases. It never connects to a hosted URL, publishes a port, mounts host data or destroys an existing database. Container lifecycle is managed separately.

The fixture uses real PostgreSQL grants, RLS, triggers, advisory locks and concurrent connections, with minimal mock `auth` and `storage` schemas. Results:

- Empty-schema migration and rerun; populated rerun preserves rows/charges/jobs.
- Authenticated/foreign/service boundaries, preserved partner SELECT, immutable identity, verified size accounting, bounded recap, durable row-deletion provenance and generation-safe upload recovery.
- Twenty-four concurrent direct-style inserts: ten accepted and fourteen quota errors, charging 160 MiB; one recap reaches the 176 MiB ceiling.
- Eight competing claimers: one active job for the same strip source.
- Direct deletion retains quota; confirmed cleanup releases one slot; fourteen concurrent replacements admit exactly one; UUID reuse remains rejected.
- Fifty-six pre-migration rows are preserved/backfilled. Legacy grace blocks early discovery. Discovery progresses 25/25/6 despite a failed first batch.
- Newer keep intent supersedes retention deletion; active deletion blocks a racing keep; expired leases cannot mutate strip rows.

Run `node database/tests/run-rest.mjs` for the separate local PostgreSQL 16 + PostgREST 14.16 fixture. It creates a private Docker network and disposable containers, publishes only an automatically selected loopback HTTP port, then removes those containers/network. It verifies the consolidated setup contains the exact migration, applies the complete setup, and reruns the migration. No hosted URL or real user credentials are used.

Actual HTTP requests through PostgREST established:

- Twenty-four concurrent legacy INSERT requests admit exactly ten rows; supplied historical timestamps cannot move their quota week.
- Foreign row reads return no rows; authenticated callers cannot read job tables or claim service jobs, and cannot enqueue another owner's deletion.
- Direct timestamp/purged PATCH and forged Cloudinary-reference/verification PATCH return HTTP 403; the archive reference remains unchanged.
- Eight concurrent service claims obtain one active lease; an incorrect lease token cannot checkpoint it.
- The Gallery reader field projection remains available to the owner/current partner.

PostgREST HTTP handling, role selection and RPC response shapes were exercised against real PostgreSQL. The `auth` schema and Storage metadata are fixtures; no Supabase Storage upload API or external object bytes were exercised. Hosted Storage transaction/trigger compatibility, Cloudinary verification/removal, production migration data, deployed permissions and Gallery playback still require activation evidence. These local results are not hosted Supabase acceptance.
