# Ritual reminder delivery

Migration `010_v2_ritual_delivery.sql` and `lib/server/ritual-reminders.ts` extend the existing `/api/reminders` scheduler. They require 001 and 009, retain the legacy `active=true` path, and keep versioned dates `active=false`. The application additionally requires `PB_MEMORIES_ENABLED=true`, valid cron/service configuration and `deliveryVersion:1`. Migration 009 alone reports delivery version 0: schedule management remains available, while versioned delivery is skipped. No flags or hosted migrations were changed by this work.

## Claims and consent

The existing 900-second global reminder lease coordinates runs. Each occurrence has a separate 300-second lease, renewed at dispatch, with its own token, date revision, cycle, UTC instant and frozen recipient targets. Claims, dispatch, acknowledgement and completion lock the original couple, date and occurrence in that order. Every dispatch and completion checks the current original membership, revision, enabled/unpaused state and recipient's channel consent. Recipient email addresses and push subscription capabilities are private worker data, never public status fields.

At most five occurrences are processed per pass, including terminalisation of an exhausted claim. When legacy dates are due, at most three ritual occurrences run first, leaving two legacy slots. An occurrence contains at most two individual email targets and 20 push subscriptions. Provider concurrency is two. A shared 45-second elapsed budget prevents starting another occurrence or target; already dispatched work is awaited and checkpointed. Production HTTP requests have ten-second abort signals, including response-body reads. SQL HTTP calls also have ten-second fetch bounds. These are request bounds plus a dispatch budget, not a hard total execution deadline. In-flight dispatch/finalisation RPCs and cleanup can finish after that budget.

Pause, deletion, recipient preference changes and explicit schedule edits increment revision and invalidate pending claims. A changed preference must not recreate an already-due occurrence under a new revision; that row stops with an uncertainty status and requires explicit resume/reconciliation. Resume calculates a future occurrence from fresh database time and the preserved civil anchor, without backlog. An elapsed one-off remains disabled. A provider request already in flight when consent changes cannot be recalled, and its acknowledgement cannot advance the revoked generation.

## Delivery and uncertainty

Before sending, SQL durably records a dispatch intent and payload hash. New email uses a deterministic key derived from date ID, revision, occurrence instant, recipient and channel. Each message contains one recipient. A successful provider response is followed by a recipient-specific checkpoint; completion is permitted only after every frozen target is delivered or safely gone. A missing database acknowledgement never advances the schedule.

Resend documents a 24-hour idempotency window and rejects a reused key with a different payload. This worker permits an identical email retry only within 23 hours of the first durable dispatch intent, allowing a conservative timing margin. A changed payload, an older ambiguous attempt or an ambiguous fifth attempt becomes terminal `uncertain`. Earlier preflight/provider failures retry after one minute, with no more than five occurrence claims. [Resend idempotency contract](https://resend.com/changelog/idempotency-keys), [implementation details](https://resend.com/blog/engineering-idempotency-keys).

Push collapse topics do not prove exactly-once delivery. An interrupted or unacknowledged push dispatch becomes uncertain and is not automatically resent, including when its subscription has since disappeared. Provider 404/410 responses mark that exact subscription gone and remove it only if its stored ownership and keys still match. Other push failures remain conservative. Push destinations are restricted to supported HTTPS browser push hosts, without credentials, nonstandard ports or redirects. Invalid/oversized target metadata consumes bounded attempts rather than enabling an unbounded claim loop.

Terminal failure disables the date and preserves the old occurrence cursor. Explicit resume/edit starts only a future schedule revision; it cannot re-open the old delivery. Public rows expose only `delivery: {status, attempts}`, where status is `idle`, `pending`, `retrying`, `failed` or `uncertain`. Schedule management accepts delivery versions 0 and 1 independently of worker availability.

## Retention and compatibility

The existing checkpoint table receives additive occurrence/revision/recipient columns and separate legacy/versioned unique indexes. A historical group-email checkpoint is never reused as a per-recipient ritual checkpoint. Versioned targets and occurrence detail are private. Each date retains at most 100 terminal occurrences; older terminal outcomes aggregate into 120 UTC month buckets and one older bucket. Uncertainty is an additional counter that can overlap failed or cancelled outcomes. Compaction removes only permanently ineligible generations or occurrences behind the authoritative cursor. The tests verify that compacted history cannot be claimed or acknowledged again.

Deleting the original couple removes dates and private target/occurrence state. Existing checkpoint evidence is not reassigned to a new couple. Logs and route errors contain no addresses, endpoint capabilities or reminder text. The old cron URLs still require header bearer authentication; query-string secrets remain unsupported.

## Local evidence and remaining gates

Focused injected-provider tests cover individual recipients, exact-key email retry, resolved provider errors, lost checkpoint/completion acknowledgements, pause before/after send, push uncertainty and 410, two-call concurrency, shared five-occurrence limits, elapsed-budget recovery, old capability compatibility and database-time recurrence. The disposable PostgreSQL suite exercises exclusive concurrent claims, stale tokens, real pause/dispatch races, five-attempt and exhausted-lease terminal handling, consent/unpair fences, checkpoint isolation, bounded compaction and populated reruns.

These checks send no email or push and do not validate hosted scheduler timing or real provider behaviour. Production migration/configuration, provider idempotency and timeout verification, consent/pause operational rehearsal and device notification checks remain activation evidence. Phone checks remain user-deferred.
