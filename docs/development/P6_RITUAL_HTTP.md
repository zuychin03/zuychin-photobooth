# Ritual HTTP and browser client

This tranche connects the existing ritual service contract to `POST /api/memories`. It is source-ready and locally tested. It does not activate hosted storage, reminder delivery or a ritual UI. `PB_MEMORIES_ENABLED` remains false by default. Migration 009 and its independent ritual capability are required; activity capabilities alone never enable rituals. Delivery capability evolution is owned by the separate worker tranche, and missing delivery support must not prevent schedule management.

## Public calls

`createRitualClient({ appOrigin, identity, accessToken, fetch?, timeoutMs? })` exports `RitualClient`. Identity is the existing `{ ownerId, epoch }` account identity. Each call obtains a fresh token. Call `close()` synchronously when that identity changes or its owning UI unmounts. No shared cache, credentials or schedule state is persisted by this client.

| Client method | Wire operation | Additional body fields |
| --- | --- | --- |
| `list(coupleId, after?, limit?, signal?)` | `ritualList` | Optional UUID keyset `after`, limit 1–20 |
| `create(coupleId, input, signal?)` | `ritualCreate` | Public `{ id, title, schedule }` input |
| `upgrade(coupleId, id, expectedScheduledAt, input, signal?)` | `ritualUpgrade` | Exact legacy scheduled instant and public `{ title, schedule }` |
| `edit(coupleId, id, revision, input, signal?)` | `ritualEdit` | Current revision and public `{ title, schedule }` |
| `pause(coupleId, id, revision, signal?)` | `ritualPause` | Current revision |
| `resume(coupleId, id, revision, signal?)` | `ritualResume` | Current revision |
| `delete(coupleId, id, revision, signal?)` | `ritualDelete` | Current revision |
| `setChannels(coupleId, id, revision, channels, signal?)` | `ritualSetChannels` | Current revision and `{ email, push }` for the caller |

Every body includes the explicit original `coupleId`. The client never replaces it with the current couple, and the existing service/database membership gate rejects access lost through unpairing or re-pairing. The browser cannot submit an actor, recipient identity, database-time proof or derived recurrence cursor. `after` is only the bounded UUID listing keyset. Fixed anchor, IANA zone, gap/fold/date policy and a one-off instant remain public schedule fields; recurrence proof is computed from database time by the service.

List returns the existing `RitualPage`. Mutations return the existing strictly validated `RitualRow`, except deletion which returns `{ id, deleted: true, revision }`. Legacy rows remain explicit with no inferred schedule. Upgrade requires an intentional public definition and the exact expected legacy instant. Mutation acknowledgements bind the requested couple, ritual ID and incremented revision; edit/upgrade additionally bind title and normalised definition. Create preserves the service's exact-ID retry behaviour and can return its existing current row.

## Request and lifetime boundaries

The combined handler checks the memories feature flag, POST, HTTPS (development loopback exception only), configured same origin, exact bounded Bearer credential and no query parameters before reading a body. It accepts at most 8 KiB, 4,096 chunks and five seconds of body input through the existing request guard. Ritual bodies are exact allowlists. Unchanged activity operations are delegated to their existing handler using the already bounded reconstructed body, without teeing an untrusted stream. Only the selected store authenticates and its existing rate gate charges the operation exactly once.

Responses are private/no-store with no-referrer. Ritual output uses the shared strict parsers and a 64 KiB envelope ceiling; arbitrary provider fields are not returned. Public errors are bounded codes, including `conflict`, `capacity`, `schedule_changed`, `no_future_occurrence`, `rate_limited`, `access_denied` and `unavailable`. Rate backoff is 1–60 seconds. Missing schema/version yields unavailable rather than suggesting an empty schedule list.

The browser uses fixed same-origin fetch, omitted cookies, Bearer authentication, rejected redirects, a default ten-second end-to-end deadline, a 64 KiB response ceiling and at most 4,096 stream chunks. It validates JSON content type and UTF-8. Account ID and epoch are checked before and after token, network and stream awaits; identity loss takes precedence over cancellation. Explicit signals and `close()` stop local requests without claiming rollback of a mutation already accepted by the server. After an ambiguous acknowledgement, refresh the authoritative list before choosing a revision. Never generate a new create ID merely to retry an uncertain create.

## Evidence and limits

Focused tests exercise all eight actual client-to-handler shapes, the real ritual store's single rate charge behind the handler, activity delegation, legacy projection/upgrade, exact mutation acknowledgement, forbidden authority fields, account changes during token/stream awaits, simultaneous abort, close, stalled token/stream deadlines, response byte/chunk caps and sanitised errors. These are local injected-transport tests, not hosted Supabase, reminder-provider or physical-device evidence. The existing 009 disposable SQL evidence remains separate; this tranche does not change SQL or require another database migration.
