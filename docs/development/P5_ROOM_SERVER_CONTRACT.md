# P5 room server foundation

Recorded 23/09/2026. Local implementation and fixture evidence only. `PB_ROOM_V2_ENABLED` remains false. This foundation does not activate hosted rooms or complete P5's transport/device acceptance.

## Boundary and activation

`database/migrations/003_v2_rooms.sql` adds room, member, capability, signal, capture and bounded rate-counter tables. It does not alter legacy couple/strip/storage access. The migration is rerunnable on empty and populated fixtures. Root maintains the consolidated setup artifact after review.

All room tables deny direct `anon`, `authenticated` and `service_role` access. Only five public operations are granted to `service_role`: `pb_room_capabilities`, `pb_room_check_rate`, `pb_room_create`, `pb_room_join`, `pb_room_call`, plus the bounded `pb_expire_rooms` cleanup. Internal functions have no public grants. Privileged functions use a fixed search path and check the service role; normal clients receive neither a service key nor an RPC capability hash.

Activation requires the flag, matching schema capability version 1/protocol 2, Supabase service configuration, canonical HTTPS `PB_PUBLIC_ORIGIN`, and:

- `PB_ROOM_RATE_SECRET`: an independently generated secret of at least 32 characters, used to HMAC the client IP before recording rate buckets.
- `PB_ROOM_TRUSTED_IP_HEADER`: a lowercase header name whose single IP value is overwritten by the deployment's trusted ingress. Never configure a client-controlled header. Comma-separated forwarded lists, invalid IPs and absent headers fail closed. Deployment-specific proxy behaviour still needs verification.

Development loopback permits HTTP and uses a loopback rate identity. This exception is restricted to development mode and localhost/loopback hosts. Production requires HTTPS and Secure cookies. Flags only enable the route; credentials and database checks still authorise each action.

## HTTP contract

The pure client-safe types and limits are in `lib/server/room-contract.ts`. All responses use `private, no-store` and `no-referrer`. Mutations require an exact same-origin header, JSON, strict fields, a 40,000-byte streamed body ceiling and a five-second body deadline. Query parameters never supply authority.

| Endpoint | Body | Result |
| --- | --- | --- |
| `GET /api/rooms/capabilities` | None | `{enabled,protocol:2,limits}`; unavailable configuration returns disabled with HTTP 503 |
| `POST /api/rooms` | `{displayName}` | `RoomState`, HTTP 201, host cookie |
| `POST /api/rooms/join` | `{code,displayName}` | Pending `RoomState`, HTTP 201, admission cookie |
| `POST /api/rooms/:id/state` | `{}` or `{renewConnection:true}` | `RoomState`; admitted pending identity exchanges its cookie |
| `.../admit`, `.../remove` | `{memberId}` | Updated host `RoomState` |
| `.../lock` | `{locked:boolean}` | Updated `RoomState` |
| `.../end` | `{}` | `{ended:true}` and expired caller cookie |
| `.../signal` | `{messageId,toMemberId,connectionEpoch,kind:'sdp'|'ice',payload:string}` | `{cursor}` |
| `.../poll` | `{cursor,limit?:1..16}` | `{signals,cursor,serverNow,resetRequired}` |
| `.../prepare` | `RoomCaptureProposal` | `RoomCapture` |
| `.../ack` | `{captureId,recipeHash,rosterRevision}` | `RoomCapture` |
| `.../commit`, `.../abort` | `{captureId}` | `RoomCapture` |
| `.../capture` | `{captureId,peerId?}` | Earlier `RoomCapture` for transfer recovery; caller and optional peer require current admission and membership in that frozen capture |

`RoomState` contains room/session/host/self IDs, own role and connection epoch, code, lifecycle/lock state, roster revision, expiry/server time in epoch milliseconds, visible member records and the latest capture. Pending guests see only their own member record and no capture. Admitted participants see admitted members; the host additionally sees pending admissions. A six-character code does not authorise any privileged operation.

Errors are bounded codes: `unavailable` (503), `invalid_request` (400), `origin_denied`/`access_denied` (403), `room_full`/`state_conflict`/`not_ready` (409), `rate_limited` (429). Rate responses include `retryAfterMs:60000` and `Retry-After:60`. Foreign, removed and expired identities deliberately share the access-denied response. Raw SQL/provider messages never reach clients. `room_full` also denotes a bounded room/capture resource allocation refusal; UI must not describe every such refusal as four occupied seats.

## Credentials, limits and reconnection

Host/admission credentials use 32 random bytes. Only SHA-256 hashes are persisted. Cookies are HttpOnly, SameSite=Strict, Secure in production, and scoped to `/api/rooms/<uuid>`. Each room has its own cookie name. Nothing puts credentials in a URL, client-readable response, local project or portable bundle.

A room lasts two hours; pending admission lasts five minutes. A host admits at most three guests, under the room row lock. There are at most eight pending members and 32 historical member records per room. Admitted members live until room expiry. An admission credential cannot signal or acknowledge capture, even after the host approves its member record. A `state` exchange issues a separate member cookie. Its domain-separated deterministic derivation permits retry after a lost response; the old admission credential remains limited to state/exchange until its original five-minute deadline. Removing the member revokes every associated credential.

The connection epoch is server-issued. `state {renewConnection:true}` rotates only the caller's epoch, clears related signalling and aborts an uncommitted capture. Normal polling never rotates it. Signalling binds the sender to both the cookie identity and current epoch. Transport must also bind the remote peer handshake to its current member/epoch and roster/session snapshot. A removed member cannot regain authority through a new peer ID; the host must admit a new request.

| Conservative implementation limit | Value |
| --- | --- |
| Room TTL / pending TTL | 2 hours / 5 minutes |
| Retained room rows | 250; expired rows reconciled in bounded batches |
| Create per minute | 3 per IP hash, 20 globally |
| Join per minute | 12 per IP hash, 120 globally |
| Other HTTP operations per minute | 300 per IP hash, 1,200 globally |
| Member operations per minute | 30 for state/controls; 90 each for signal/poll/capture lookup |
| Signalling retained | 64 per room, at most 16 per sender, 60-second TTL |
| SDP / ICE UTF-8 payload | 32 KiB / 4 KiB |
| Poll page | At most 16 signals |
| Suggested setup/reconnect polling | Once per second, bounded to 60 seconds per attempt |
| Control state/authorisation refresh | Every 5 seconds; 15-second readiness presence lease |

HTTP rate admission is a separate committed RPC before the requested room mutation, so rejected code/credential lookups still consume its allowance. Counters expire after two minutes. These are fixed-minute conservative beta ceilings, not sliding-window guarantees or measured provider capacity. Distributed denial of service can still exhaust a global allowance; ingress abuse protection and NAT usability need deployment review. No identity-wide Supabase setting is changed.

Signal IDs are room-monotonic cursors. A message UUID is idempotent while its record remains retained; reusing it with altered content is rejected. Polling never deletes an unacknowledged page. Expiry or epoch-reset gaps return `resetRequired` so transport renegotiates instead of silently pretending no records were missed. Wire-level sequence and transfer replay rejection remain transport responsibilities after signal TTL expiry. Media never passes through this database inbox.

## Capture transaction and resource reservation

The host prepares `{captureId,rosterRevision,recipeHash,shotIds,fireAt,intervalMs,profile}`. The database freezes the exact admitted member IDs. There are one to four distinct shot IDs, a 64-character recipe hash, three to thirty seconds of initial lead, and one to thirty seconds between shots. Each included member explicitly acknowledges that same hash/revision, including the host. Only the host can commit, at least one second before fire, with every acknowledgement and fresh presence lease. Duplicate commit returns the same capture. A roster change, epoch change, timeout or explicit abort invalidates a prepared capture. A committed capture is not retrospectively un-fired; client membership guards must cancel future shots when a peer departs, preserve completed stills and never catch up missed fire times.

At most 32 capture metadata records are retained per room; a second active capture cannot overlap the first. Expired room cleanup removes only protocol records, never local projects or photographs.

`ROOM_PHOTO_BUDGET_BYTES` is 48 MiB and `ROOM_PHOTO_BUDGET_PIXELS` is 36 MiPixels. The database reserves `members × shotsPerMember × per-photo ceiling` against both. This leaves 16 MiB/12 MiPixels below the existing project's 64 MiB/48 MiPixels aggregate limits for decoration and other retained media. It does not prove every valid P3 template fits: local readiness must inspect its actual decoration inventory and all original capture sizes, refuse an incompatible combination or explicitly choose a smaller capture profile, and never silently drop decorations or originals. The server authorises metadata, not the truth of a camera's byte/pixel claim. Receiver inspection and durable project commit remain mandatory.

## Local evidence and remaining gates

`node database/tests/run-rooms.mjs` uses a unique `pb_v2_rooms_*` database inside the existing task-owned PostgreSQL 16 container. It tests migration reruns, real grants/RLS, concurrent admission, two-room isolation, sender/epoch binding, queue fairness, capture budgets/acknowledgements, concurrent commit, removal/lock/end and expiry.

`node --import tsx database/tests/run-room-rest.mjs` creates and removes its own disposable PostgreSQL 16/PostgREST 14.16 containers and network, publishes only loopback HTTP, then invokes the actual Supabase RPC adapter and room request handlers through a bounded local HTTP bridge. It passed eight concurrent admissions with exactly three guest seats, separate cookie issuance/exchange, two-room signal isolation, deduplication, host-only authority, all-member acknowledgements, six concurrent idempotent commits, removal and end. The bridge maps the SDK's `/rest/v1` prefix to PostgREST; it is not a hosted Supabase emulator.

Seven focused Node request tests pass for configuration/origin denial, cookie hashing/scope, stable admission exchange, cookie confusion, strict bodies, separately committed rate admission and safe error output. Focused ESLint passes. Root owns subsequent whole-app validation.

Still required: real browser Secure-cookie behaviour under deployment HTTPS, trusted ingress IP configuration, provider request/DB-cost measurements, cross-network/TURN two/four-device sessions, phone CPU/latency/memory, interrupted durable transfer, all-person preview and collaborative-finishing acceptance. Physical phones remain explicitly deferred, not passed. No hosted schema, secret, account or service configuration was modified.
