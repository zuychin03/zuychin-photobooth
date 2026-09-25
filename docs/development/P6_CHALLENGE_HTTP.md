# P6 challenge HTTP contract

`POST /api/challenges` is a local implementation candidate. Both `PB_CLOUD_PROJECTS_ENABLED=true` and `PB_CHALLENGES_ENABLED=true` are required; unset values keep it unavailable. This work does not enable either flag, apply hosted SQL, or establish production acceptance.

Requests require HTTPS, the configured exact `PB_PUBLIC_ORIGIN`, an authenticated bearer access token and JSON. Loopback HTTP is allowed only in development. Query parameters are rejected, including token parameters. A forged Host header does not change the configured origin. Browser cross-site requests are denied. Unsupported HTTP methods use the same private response boundary.

The body is limited to `CHALLENGE_LIMITS.requestBytes` (65,536 UTF-8 bytes), including when Content-Length is absent or misleading. Body receipt has a five-second deadline and cancels the reader on expiry or overflow. Each existing authenticated store fetch has a ten-second abort timeout. These are body and individual-fetch bounds, not a hard total transaction deadline. A lost response after a database commit must be retried with the same operation identifiers.

## Operations

Every body has exactly the fields listed below. UUIDs, lowercase SHA-256 digests, booleans, member limits and frozen recipes are validated before opening a store.

| Operation | Additional fields | Rate | Success |
| --- | --- | --- | --- |
| `capabilities` | none | read | 200, enabled/version/limits |
| `list` | `projectId`, optional `after` UUID and `limit` (1–20) | read | 200, version-1 challenge summaries and next cursor |
| `create` | `projectId`, `challenge` (existing `ChallengeCreate`) | write | 201, challenge view |
| `view` | `challengeId` | read | 200, challenge result |
| `manage` | `challengeId`, `action` | write | 200, challenge view |
| `submit` | `challengeId`, `submission` (existing `ChallengeSubmission`) | write | 200, challenge view |
| `proposePartial` | `challengeId`, `partialId`, `contributors` | write | 201, partial result |
| `partial` | `partialId` | read | 200, partial result |
| `consentPartial` | `partialId`, `digest`, `consent` | write | 200, partial result |
| `commitPartial` | `partialId`, `digest` | write | 200, partial result |

Manage actions are `accept`, `decline`, `open`, `cancel` and `withdraw`. Create accepts the bounded design, policy, expiry and frozen member roles. The server derives assignments and the canonical recipe hash. The caller cannot submit actor IDs, hashes, assignments, arbitrary URLs, Storage paths or decoder assertions. A submission contains only a request UUID and one to four unique source-index/asset-UUID pairs. Partial contributors are one to four unique account UUIDs; SQL verifies the authoritative recipient set and exact consent digest.

The project store verifies the token and checks the durable actor read/write rate before the challenge store is constructed. The challenge store independently verifies the token and its schema capabilities, then binds the actor to each SQL operation. Missing or incompatible migrations fail closed. `capabilities` is authenticated and rate limited too.

Discovery requires migration 007 and its additive discovery markers. Core challenge operations remain compatible with 004. See `P6_CHALLENGE_DISCOVERY.md` for participant-only summaries and cursor semantics.

## Response and access boundary

The challenge store allowlists and bounds all projections with `CHALLENGE_LIMITS.responseBytes`. The HTTP layer returns only those projections. Concealment, frozen membership, revoked access, recipient isolation and atomic reveal remain authoritative in migration 004. This endpoint does not mint Storage capabilities or fetch original bytes; project asset resolution retains the challenge gate.

Historical hash-only challenges and partial proposals return `unsupported: true, reason: "recipe_unavailable"`. Partial history contains no consent digest or concealed snapshot. Consent and commit return `update_required` instead of reporting unusable success. Supported views preserve `accessLost` and server-filtered `visibleSources`; the endpoint never fills missing sources locally.

All responses use `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`. Public errors are an explicit code/status allowlist. Provider messages, tokens, paths and unexpected exceptions become `unavailable`. Rate exhaustion returns HTTP 429 with Retry-After restricted to 1–60 seconds, defaulting to 60 if the adapter supplies an invalid delay. Invalid bodies cannot trigger auth, rate or challenge operations.

## Local verification

`tests/challenge-requests.test.ts` exercises real Request/Response handlers with injected stores and one real challenge-store adapter backed by synthetic RPC results. It covers both disabled flags, origin/TLS/bearer boundaries, operation envelopes, actual UTF-8 overflow, a stalled stream deadline, all operation dispatches and rate ordering, bounded Retry-After, lost access, unsupported history, private projection stripping and sanitised errors. `tests/challenge-store.test.ts` separately covers authentication, schema negotiation, recipe/source validation and legacy mutation denials. These tests make no hosted requests or Storage writes.

The disposable SQL evidence is recorded in `P6_CHALLENGE_CONTRACT.md`. Browser cloud UI, hosted configuration, real signed object delivery and deployment acceptance remain separate checks.
