# Event worker readiness and scheduler runbook

Source-only correction, 23/09/2026. No scheduler, hosted migration, event flag or provider configuration was activated. The hosting provider is still an activation decision in V2_PLAN. Do not infer scheduling support from this repository or enable uploads merely because a provider adapter exists.

## Authority and admission

Migration `019_v2_event_worker_readiness.sql` follows 005/016/017 (and 018 when exports are installed). Apply the reviewed numbered chain in order through the authorised operator workflow; the consolidated P1 setup alone is insufficient. Do not replay 005 alone after later migrations, because it replaces functions and resets grants. Rerun the full reviewed dependent chain. 019 preserves its verified heartbeat on populated rerun, adds no public table access, and denies direct calls to the pre-gate reservation/authorisation functions even to `service_role`.

`pb_event_worker_status()` exposes a service-only versioned readiness projection. A heartbeat is fresh for 150 seconds. The application calls `pb_event_worker_verified()` only after a successful bounded sweep and an acknowledged idle, finalisation or cleanup result. An uncertain sweep, provider failure, lost completion acknowledgement, cancellation or timeout does not renew it. The marker is a trusted service boundary, not a caller-supplied browser assertion or proof of provider performance. A stale marker never stops the worker from running to bootstrap/recover.

New reservations are serialised through one deployment-wide admission lock and limited to **two pending submissions** across `reserved`, `uploading` and `finalising`. This is a deliberately conservative provisional admission setting, not a measured capacity or a reduction of each event's 25-guest/100-contribution totals. Saturation returns `not_ready`, not `capacity`; the latter continues to mean the event's own quota. Expired pending rows remain conservative holds until the bounded sweep changes their state. Upgrades with more existing pending rows admit no new work until the backlog drains. Bytes remain charged independently until confirmed cleanup.

Absent/stale readiness blocks new reservations and new upload-token authorisations. Exact accepted reservation replays still reach the original immutable-ID/consent validator. Already uploaded accepted originals may still enqueue finalisation, and receipt reads, owner exports, withdrawal and cleanup remain available. Existing guests can explicitly enter recovery while new uploads are unavailable. Context reports `serviceAvailable:false` separately from event `capacityAvailable`; the UI does not call a busy service a full event. Old/missing 019 schema cannot advertise `uploadsAvailable:true` or mint through the new HTTP implementation. Guest entry also requires 017 host/context capability.

The SQL logical deadline remains the earliest of reservation time plus ten minutes, ordinary closure time plus ten minutes and event expiry. Authorisation, enqueue, each worker checkpoint and completion still enforce it. Provider upload tokens can outlive that logical deadline; staging retains its original token lifetime plus cleanup margin. Nothing here extends reservations, weakens consent checks or releases quota early.

## Runner and invocation contract

The existing 15-minute `/api/media/maintenance` schedule does **not** process event jobs and cannot meet their ten-minute deadline. Events have a separate authenticated `GET /api/events/maintenance` worker. Each pass claims one job with its existing 120-second token lease and a 90-second application deadline. Finalisation claims take priority over cleanup; all existing same-source lease exclusion, retry ceilings and checkpoint fences remain.

Local commands, using environment supplied by the operator's secret manager:

```powershell
node --import tsx scripts/run-event-worker.ts --help
node --import tsx scripts/run-event-worker.ts
node --import tsx scripts/run-event-worker.ts --apply --max-passes=3 --deadline-ms=300000
```

The first two commands make **zero network requests**. `--apply` explicitly authorises the runner invocation; this document does not authorise executing it against a hosted service. Required process variables are `PB_PUBLIC_ORIGIN`, `CRON_SECRET` and `PB_EVENTS_ENABLED=true`. The runner never loads env files, prints credentials, accepts a query secret or follows redirects. Origin must be canonical HTTPS; loopback HTTP is allowed only with `NODE_ENV=development`. It prints only bounded counts and a stop code. Existing server service credentials stay on the server, not in the runner.

Each runner invocation executes at most three sequential passes and stops at idle, any failed/uncertain pass, cancellation or its 300-second total deadline. Individual HTTP waits are bounded to 95 seconds, allowing the worker's 90-second deadline to respond. Response bytes are capped at 4 KiB/64 chunks. There is no hidden retry or background loop. Exit zero means dry-run, verified idle, or the finite pass limit; it does not mean every queued job is complete. `retry`, `refused`, `deadline` and `cancelled` exit with code2; invalid configuration exits with code1.

An approved scheduler must start an invocation **at least every 60 seconds**, retain the secret in its header/environment facility and support the required duration. Because an invocation may last longer than its cadence, deployments must safely allow overlapping invocations: handler-local busy guards and SQL leases prevent duplicate claims, while the two-pending admission limit bounds finalisation demand. A scheduler that skips starts during a long active invocation does not satisfy this contract. If the selected hosting/scheduling product cannot meet it, keep event writes disabled and choose a compatible worker execution arrangement; do not increase the ten-minute deadline to conceal the mismatch.

The provisional queue calculation is one dispatch interval (60s) plus two 90s passes, approximately240s before the second initial pass completes. This is **not a throughput guarantee**: it excludes upload time, provider/network variance, retries/backoff, cold starts and a process that cannot settle native work. Slow uploads can still leave too little time before their existing ten-minute deadline. The heartbeat expires and new admission stops when verified work stops. Real load and failure measurements must demonstrate enough headroom before activation or any reviewed increase to the two-pending ceiling.

## Activation and recovery checklist

1. Apply the reviewed chain to a disposable environment, partition real provider headroom and verify private bucket/Storage metadata fences. Confirm the deployed code and migration versions match.
2. Verify canonical origin, actual scheduler cadence, request duration/overlap support, HTTPS cookies, secret header handling and redirect-free endpoint. Keep public invitations undistributed during bootstrap.
3. Run one authorised worker invocation. A verified idle pass creates the first heartbeat. Confirm capabilities become upload-ready only while the heartbeat is fresh and admission has room.
4. Rehearse no-account reserve/upload/finalise within the original deadline, concurrent two-slot admission, pause/close, stale-worker refusal, exact retry, expiry and physical cleanup. Measure cold/warm/provider failure behaviour, not just local codec speed.
5. Stop the scheduler deliberately. After150s, new reservations/mint must fail while receipt/export/recovery remain accessible. Restart it and confirm durable jobs recover without duplicate finalisation or early charge release.
6. Monitor runner stop codes and failed jobs. Restore the worker rather than manually forging the heartbeat. Terminal failed jobs/charged objects require the existing explicit operator reconciliation; do not reset leases or delete accounting records to force capacity.

For rollback, use the durable admission control below while keeping the compatible worker/receipt/export build available. Disabling `PB_EVENTS_ENABLED` also disables the worker and is therefore not a cleanup strategy. The app does not install, modify or remotely verify a scheduler.

## Admission-only pause and resume

Migration 027 adds a persisted pause and monotonic revision to the existing worker-health row. Only the service role can inspect or change it, through `pb_event_admission_control`. The operator CLI requires the exact current revision and validates an acknowledged versioned response. Missing migration 027, a missing health row, changed revision, unexpected response or uncertain network outcome cannot be reported as a successful pause. No browser or host-event control changes this deployment-wide setting.

Prepare process environment variables `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` through the operator's secret manager. The CLI never reads env files or prints the credentials. HTTPS is required except loopback with `NODE_ENV=development`. It has a ten-second logical deadline, a 4 KiB/64-chunk response cap, and refuses redirects. The commands below are examples, not authorisation to execute against a hosted service:

```powershell
node --import tsx scripts/control-event-admission.ts --help
node --import tsx scripts/control-event-admission.ts --action=status
node --import tsx scripts/control-event-admission.ts --action=pause --expected-revision=0
# After separate authorisation, inspect the current server revision.
node --import tsx scripts/control-event-admission.ts --action=status --apply
# Substitute that revision; zero is only the initial deployment value.
node --import tsx scripts/control-event-admission.ts --action=pause --expected-revision=0 --apply
node --import tsx scripts/control-event-admission.ts --action=status --apply
# Resume deliberately using the current paused revision, after recovery checks.
node --import tsx scripts/control-event-admission.ts --action=resume --expected-revision=1 --apply
```

Without `--apply`, every command makes zero network requests. `--apply` explicitly enables the bounded service RPC request; it does not bypass separate hosted-operation authorisation. On a timeout or lost acknowledgement, read status before choosing a retry. An exact immediately preceding transition can replay its acknowledgement; a stale opposite transition cannot undo a later operator decision. No-op requests keep the existing revision.

Pause and reservation/upload authorisation share the deployment admission lock. After pause commits, new ordinary, kiosk and postcard reservations fail `not_ready`. This is distinct from closing an individual event or blocking guest redemption: existing guests and newly redeemed guests may still enter private recovery, but cannot start a new submission. New upload URL authorisations also stop, including accepted reservations whose first reserve or URL acknowledgement was lost. Exact accepted reservation retries recover the same submission and receipt identity without consuming another slot, but cannot mint or increment an upload generation while paused. Keep the exact local finished photo. Deliberate resume can restore minting only within the original ten-minute logical deadline; otherwise let the reservation expire and clean up, without extending its deadline or silently replacing its request ID.

Already issued provider URLs remain bounded by their existing lifetime. An authorisation already accepted before pause may finish its bounded signing request; pause cannot retroactively revoke an external capability. Already uploaded accepted bytes can still enqueue, finish verification, obtain all postcard approvals and become ready. Receipt reads, exports, consent reductions, withdrawal and confirmed cleanup continue. This is an explicit pause of unfinished upload writes, not a promise that every accepted reservation can finish during rollback.

Keep the scheduler and `PB_EVENTS_ENABLED=true` for draining and cleanup. Successful worker passes still renew the heartbeat, but migration 027 status stays `ready:false, admissionPaused:true` until explicit resume. The worker HTTP response `workerReady:true` acknowledges a verified pass, not permission to admit submissions. The runner therefore continues bounded cleanup during pause without reopening writes. Apply/rerun the complete reviewed chain through 028 with application traffic stopped or isolated; intermediate older function definitions are not a supported live rollback state. Never down-migrate or delete retained data to roll back code.

## Local evidence

The disposable019 SQL suite passed empty/populated reruns, missing/stale health, six concurrent reservations across two events for two available slots, exact accepted replay and changed-payload refusal, accepted enqueue/receipt recovery, finalisation priority over older cleanup, concurrent same-source claim exclusion, wrong-lease denial, ordinary pause and unchanged hard expiry. Its temporary local database was removed.

Focused tests cover strict readiness parsing, zero-network dry-run, exact origin/header handling, finite sequential draining, rejected/oversized/redirected responses, ignored-abort timeout and no hidden retry. Worker tests prove heartbeat renewal follows only successful verified passes. HTTP/UI contract tests preserve reads while admission is unavailable and require the context version before entry. These are local tests, not hosted scheduler, load, Storage or device acceptance.

The full-chain harness `node database/tests/run-full-chain.mjs` uses only an existing local Docker PostgreSQL container and deletes its uniquely named test database in `finally`. It verifies baseline/001 equality and fresh plus populated 002-028 application, final capability markers, private buckets and internal-helper grants. Its populated fixtures cover retained challenge geometry, ordinary/kiosk ready originals, postcard candidate approval, accepted replay, lost reserve/mint acknowledgement boundaries, revision-fenced pause/resume, concurrent pause/admission, and no cleanup charge release until the recorded objects are absent. It caught and fixed 022's incompatible removal of the legacy optional manage argument during populated rerun. Local metadata fixtures do not prove real provider deletion, signed URL behaviour, hosted migration execution or scheduler cadence.

On 23/09/2026, the complete fresh/populated 001-028 harness passed, including an observed PostgreSQL reservation lock wait during pause and missing-health-row denial; its disposable database was removed. The 24 focused admission/readiness/worker tests, whole TypeScript check and scoped ESLint also passed. CLI help and default execution were checked without contacting a service. No hosted pause, migration or scheduler change was executed.
