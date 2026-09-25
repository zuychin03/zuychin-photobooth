# P0 room and event access spike

Recorded: 23/09/2026. Status: isolated local feasibility evidence, not a production authorisation layer. The approved V2 plan sections 5–7 provide the requirements. Existing RTC, production routes, Supabase identity configuration and hosted data are unchanged.

## Executable evidence

`lib/feasibility/access-model.ts` is an in-memory model with an injected clock. `tests/access-model.test.ts` covers its authorisation and capacity invariants. `tests/access-http.test.ts` starts an ephemeral Node HTTP server bound to `127.0.0.1`, sends real HTTP requests with bearer credentials and closes the server after the test. The HTTP adapter exists only inside the test.

Run from the repository:

```powershell
node --import tsx --test tests/access-model.test.ts tests/access-http.test.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js lib/feasibility/access-model.ts tests/access-model.test.ts tests/access-http.test.ts
```

Local result: 13 tests passed, including one HTTP integration test. TypeScript and focused lint passed. The sandbox initially blocked the test runner's child process with `spawn EPERM`; the same tests passed with authorised execution outside that restriction. There were no hosted requests, database mutations or real user accounts.

| Boundary | What the fixture proves |
| --- | --- |
| Capability | 32 random bytes become an opaque bearer token. Only its SHA-256 hash indexes the stored record. Scope, resource, role, expiry and explicit revocation are checked on each operation. Receipt tokens additionally bind one reservation/session, including when two sessions belong to the same guest. A code, guessed token or object ID alone grants no access. |
| Two rooms | Host/guest exchange SDP and ICE over actual loopback requests. A second room independently exchanges messages without receiving the first room's inbox. Foreign-room, guessed, spoofed-sender, expired, removed-member and revoked credentials are denied. |
| Bounded signalling | Four members maximum; only SDP/ICE messages; 32 KiB SDP and 4 KiB ICE UTF-8 limits; 64 queued messages per room; one-minute record TTL; 16 records per page; monotonic validated cursors. HTTP adapter caps body bytes at 40,000 and rejects extra/missing fields. Responses are private/no-store and contain a generic denial. |
| Event roles | Contribution does not grant receipt/gallery/wall reads. A personal receipt exists before finalisation but cannot read unfinished media. It reads only its permitted session once ready. Gallery and wall credentials are separate from receipt and contribution credentials. |
| Consent | Each contributor records choices through their own contribution capability. The submitter cannot invent another contributor's consent. Every included contributor must permit submission and each publishing destination. All four gallery/wall consent combinations are tested; moderator approval cannot override refusal. |
| Publication | Independent gallery/wall approval and hide controls. Withdrawing one destination preserves the receipt and other independent destination. Withdrawing submission or revoking an included contributor blocks future reads and pending finalisation immediately. |
| Lifecycle | Closing blocks new reservations and honours accepted ones until the earlier of their logical expiry or closure plus ten minutes. Removal, guest revocation and event deletion immediately deny affected operations. At the exact logical deadline a pending reservation expires. |
| Retry and capacity | A guest-scoped idempotency key consumes count/bytes once; another guest using the same key gets an independent reservation. Repeated finalisation and cleanup confirmations do not change accounting twice. Maximum staging bytes and derivative headroom are reserved before acceptance, regardless of smaller actual upload size. |
| Cleanup | Pending expiry releases unused derivative headroom, but staging remains charged. Removed ready delivery stays charged until explicit delivery-deletion confirmation. Staging remains charged until both the two-hour authorisation plus five-minute margin have elapsed and deletion is confirmed. Time passing alone is insufficient. |

## Budget result

The illustrative image fixture reserves 2,000,000 bytes of staging plus 2,100,000 bytes for delivery and a thumbnail. At the proposed 250,000,000-byte event cap, 60 simultaneous reservations consume 246,000,000 bytes; the 61st is rejected. The 100-image count ceiling does not imply 100 simultaneous uploads. One hundred outstanding authorisations plus these derivatives would require 410,000,000 bytes. These are deterministic accounting calculations, not provider measurements or a claim that any account has this capacity.

The logical reservation is ten minutes. Staging capacity is held for at least 125 minutes: the planned two-hour signed-upload lifetime plus this spike's explicit five-minute cleanup margin. A smaller uploaded object does not reduce the authorised maximum. Finalisation retains the conservative derivative allowance; actual implementation can release unused headroom only after validating durable object sizes within the transaction/lifecycle protocol.

The model treats finalisation as one synchronous transition. It does not create objects or derivatives. `confirmDeliveryDeleted` and `confirmStagingDeleted` represent trusted cleanup-worker evidence, not guest endpoints. A real finalising state must continue holding derivative capacity across worker crashes, failures, leases and retries. Expired/deleted event cleanup also needs an internal privileged path separate from guest access, which this small model intentionally does not implement.

## Decision and remaining gates

Continue the plan's capability-checked server signalling proposal into P5. This spike establishes a working local request boundary; it does not establish DB-backed signalling cost, latency or resilience. No private Realtime JWT design is claimed.

Before production, replace these in-memory maps with reviewed transactions, durable uniqueness constraints, per-event locking and scoped records. Run simultaneous reservations/finalisations from separate processes against the actual database, including direct REST/legacy bypass paths. JavaScript's synchronous map updates are not database race evidence. Exercise guest-denying RLS, private bucket policies, row/object isolation, signed URLs and caches independently in an authorised disposable environment.

The model's creation, capability issuance, moderation, membership removal and cleanup methods are trusted test control-plane actions. They do not implement authenticated hosts/moderators, host ownership checks, invitation redemption/rotation, rate limits, secure cookie exchange, CSRF/origin protection, audit logs, durable consent receipts, event rescheduling or quota revalidation. Raw bearers appear only in test request headers and memory. Production tokens must not be logged or cached; exchange, URL-fragment cleanup and signed-read expiry still need implementation. Existing downloaded or signed media cannot be recalled by this model.

Still unproven: persistence/restart recovery, message replay/acknowledgements and sequence protocol, lost cursor recovery, real SDP/ICE parsing and negotiation, TURN/cross-network transport, two/four-device behaviour, shared-preview performance, account-free abuse pressure, polling rate/egress/DB cost, storage metadata/type/decoded-dimension verification, actual upload-token lifetime and staging cleanup under late writes, signed-read cache revocation, per-contributor source-project membership/reveal checks and kiosk isolation. The signalling cap bounds retained data but does not replace per-IP/member rate limiting. A member may fill the shared room inbox until TTL expiry; fairness and sender quotas require P5 design.

No P1, P5 or P7 production gate is passed by these tests. New cloud features must remain disabled until their migrations, permissions, concurrency checks and device evidence are complete.
