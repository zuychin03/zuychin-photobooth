# P1 local storage and operations evidence

Updated 23/09/2026. P1 implements the secure cloud-operation foundation of [V2](../../V2_PLAN.md). It does not activate hosted changes or certify provider behaviour.

## Result

Cron authentication now fails closed before privileged work. User mutations require the configured origin, authenticated ownership and the lifecycle schema. Uploads register exact paths before transferring bytes. Archive, release, deletion, relay cleanup and abandoned-upload cleanup use durable jobs with exclusive source leases, checkpoints, bounded attempts and operator retry. A strip is purged only after its archive reference is persisted and the provider confirms the matching asset. Releasing an archive refuses to remove the last usable copy.

The additive migration enforces the existing weekly ten-strip allowance and one recap on the server, including legacy direct inserts. A direct row deletion does not reclaim capacity; confirmed storage/archive/row cleanup does. Keepsakes are excluded from the editor's discard choices. Pending operations return pending UI states rather than a completed result.

The combined [setup](../../supabase-setup.sql) and [migration](../../database/migrations/001_v2_lifecycle.sql) are artefacts for review and operator application. No hosted SQL, scheduler, credentials, real media, sibling repository or deployment was changed.

## Automated and database evidence

- Application checks cover cron configuration/authentication, zero work on denial, reminder retries, upload-intent reconciliation and generation identity, archive verification failures, deletion checkpoints, expired leases, last-copy protection and truthful pending responses. Final check counts are recorded in [V2 status](V2_STATUS.md).
- The local PostgreSQL 16 fixture exercises actual grants, RLS, triggers, transactions and concurrent connections. Twenty-four concurrent legacy saves admitted ten; eight job claimers obtained one source lease; confirmed deletion admitted exactly one of fourteen replacement saves. Empty/populated migration reruns, trusted object-size accounting, 56-row legacy backfill and 25/25/6 retention discovery, keep/retention races, forged archive fields and stale-generation writes were also checked.
- The isolated PostgREST 14.16 harness exercises real HTTP JWT roles and database transactions. Twenty-four simultaneous inserts admitted ten. Foreign reads and privileged RPCs were denied, timestamp mutation was denied, eight claimers obtained one lease, a false lease token was rejected, and the Gallery field projection remained readable.
- Database and REST harnesses use synthetic users and Storage metadata fixtures. They do not implement Supabase Storage's external byte-write transaction. They are separate from the injected application/provider tests.

The REST runner creates task-owned containers with no host mounts, a temporary bridge and one explicitly verified loopback port. Its ephemeral credentials are neither printed nor written to files. Its containers, volumes and network are removed in `finally`. The SQL runner uses the separately managed `pb-v2-p1-postgres` fixture container.

## Compatibility and operational boundaries

Read-only inspection of the sibling Gallery's `app/photobooth/page.tsx` confirmed its projection: `id, owner, caption, cloudinary_public_id, created_at`, filtered by a non-null archive ID. It signs authenticated Cloudinary delivery. P1 preserves these fields and partner reads; no Gallery source was edited. This is source and fixture compatibility, not a live Gallery/CDN acceptance test.

Configure an explicitly selected quota timezone before cloud writes or retention are enabled. Supabase service URLs allow HTTPS or local loopback HTTP; public reminder links require the exact configured HTTPS origin. Maintenance claims one job at a time with a 120-second lease, at most five jobs per invocation, and stops starting new jobs after 45 seconds. Supabase requests have abort deadlines. Cloudinary's SDK timeout is a socket-inactivity timeout, so these limits are not a hard total execution deadline. Stale workers cannot mutate database state, but external provider completion and cancellation still require failure rehearsal before activation.

Reminder delivery checkpoints completed channels and retains failed occurrences. A provider acceptance followed by a lost checkpoint remains an at-least-once boundary. The five-oldest-due limit can leave later dates waiting behind repeated failures; operators must resolve failures and review scheduler capacity. See [cron contract](P1_CRON.md) and [database contract](P1_DATABASE_CONTRACT.md).

## Pending external acceptance

Hosted migration against a backed-up disposable copy; actual Storage metadata timing and late writes; Cloudinary upload/verification/removal and signing/CDN behaviour; deployed scheduler headers and provider delivery; authenticated user-interface smoke tests; production timezone and capacity; remote CI for an authorised commit. These remain unverified, and optional V2 cloud flags stay off. Android testing is explicitly deferred by Danny and remains a later device acceptance item.
