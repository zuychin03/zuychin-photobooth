# Bounded retained-memory backfill

The local runner fills the operational gap between applying the reviewed memory migrations and enabling the memory library. It calls the existing service-only `pb_memory_backfill`, never arbitrary SQL or a media provider. No automatic backfill is added to page loads, schema installation or the scheduler.

## Preparation and dry-run

Use the matching reviewed migration chain, including later protection/retention replacements. The consolidated setup still has its documented P1 boundary; this runner neither applies migrations nor makes an older migration safe to replay over newer functions. Keep feature activation separate. A deployment operator must authorise the target and any hosted writes.

Provide `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the process environment through the existing secure operator workflow. Do not paste credentials into command arguments, logs or this document. The runner does not load `.env` files. HTTPS is mandatory except for literal loopback origins; credentials, paths, queries and fragments in the URL are rejected. Credentials and remote error bodies are never printed.

```powershell
node --import tsx scripts/backfill-memory-activity.ts
```

Default dry-run validates local options/configuration and prints only the public target origin, mode and zero counts. It makes **no network request**, so it does not estimate missing rows, validate the credential or claim that the schema is installed. `--help` works without configuration. The runner does not require `PB_MEMORIES_ENABLED`, allowing authorised preparation before users can open the feature.

## Explicit bounded application

After the operator separately authorises the target writes:

```powershell
node --import tsx scripts/backfill-memory-activity.ts --apply --batch-size=25 --max-batches=10 --deadline-ms=60000
```

The first request checks the existing memory capability and expected limits. Only then can the runner call `pb_memory_backfill`. Defaults permit at most ten sequential batches of 25 rows. Hard limits are 100 rows per batch, 20 batches and 120 seconds per invocation; each request/body has a ten-second timeout shortened by the remaining run budget. Response bodies are capped at 4 KiB/128 chunks. Redirects are refused. No concurrency, automatic retry, schema mutation, photo read or media deletion is performed.

The client deadline stops further dispatch, not a claim that PostgreSQL rolls back an already-issued RPC. An interrupted or unacknowledged mutation returns `uncertain` and stops. A server statement may still commit. Do not kill unrelated database sessions or infer rollback from a network timeout.

## Checkpoint and completion

The authoritative durable checkpoint already exists on each source: immutable `activity_recorded_at`. Every RPC selects only unrecorded eligible strips and ready photo assets, ordered by UUID, with row locks and `SKIP LOCKED`; recording and marking happen in the same transaction. A rerun skips committed sources, including a batch whose acknowledgement was lost. It cannot recreate compacted activity or increment its counter again. A separate local cursor file would be weaker than these server markers and could skip locked work, so none is created.

Output includes only acknowledged batch/row counts. Lost acknowledgements can therefore undercount the work done. Stop states:

- `dry_run`: no remote work attempted; exit 0.
- `no_unlocked_work`: a batch returned zero; exit 0. This is **not** proof that every source is complete because another transaction may hold eligible rows.
- `batch_limit` or `deadline`: bounded work stopped; exit 2. Rerun deliberately for another batch window.
- `interrupted`: stopped before another mutation; exit 2.
- `uncertain`: a dispatched mutation lacks a validated acknowledgement; exit 2. Wait for outstanding database work to settle, then rerun the same bounded command.
- `unavailable`: capability/configuration/transport was not accepted before a mutation; exit 2. Invalid local arguments/configuration exit 1.

During activation, run serially in finite windows, inspect each receipt, and repeat after ordinary source transactions have settled until a fresh invocation reports no unlocked work. This establishes the observed drain only; retain the ability to run another window if concurrent old rows were locked. Backfill discovers existing sources with verifiable saved/created timestamps. It does not recover deleted photos, invent capture dates or guarantee unlimited detailed history. Activity compaction and current source permissions remain in force.

## Local verification

Injected transport tests cover zero-network dry-run, strict options/origins, capability failure, exact service-only requests, bounded sequential batches, elapsed limits, ambiguous commit/restart through server markers, malformed/oversized responses and cancellation with a late provider response. Existing disposable activity and voice SQL harnesses exercise the real marker/compaction RPCs; this runner does not replace their database evidence. No hosted invocation or actual provider acceptance is claimed.

On 23/09/2026, all eight focused runner tests, whole-project TypeScript and scoped ESLint passed. The actual CLI `--help` entrypoint exited successfully without network/configuration access. Its first sandboxed smoke attempt hit Windows subprocess `EPERM`; the same zero-network command passed with the required subprocess permission. The CLI was never invoked with `--apply` against any service.
