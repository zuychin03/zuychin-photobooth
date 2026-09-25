# Cloud project HTTP and worker integration

23/09/2026. These routes are implemented locally and remain disabled by `PB_CLOUD_PROJECTS_ENABLED=false`. No hosted schema, Storage write, production scheduler or account session was activated. This integration does not yet provide the complete cloud project or reciprocal challenge UI.

`POST /api/projects` accepts a bounded JSON object with an `operation`. It requires the configured same origin and a Bearer access token verified by the project store through `auth.getUser`. Production requests require HTTPS. Tokens, actor identity and object paths are never accepted in the URL or copied from caller-supplied authority fields. The request body is at most 8 KiB, and body reading has a five-second timeout. Responses are private, no-store and no-referrer.

| Operation | Request fields besides operation | Result |
| --- | --- | --- |
| capabilities | none | Authenticated migration/capability gate and public limits |
| list | optional after UUID, limit 1–50 | Keyset page of authorised projects and pending invitations |
| create | id, kind, title, maxBytes | New or idempotent personal/friend project |
| view | projectId | Allowlisted authorised metadata, members and visible ready assets |
| member | projectId, userId, action invite/accept/revoke | Authoritative membership result |
| reserve | projectId, asset | Immutable reservation, before any provider upload token |
| upload | projectId, assetId | Exact authorised no-overwrite upload capability |
| finalise | assetId | HTTP 202 with durable verification queue status |
| status | assetId | Authorised finalisation status without a lease or worker descriptor |
| read | assetId | Five-minute signed original URL, only through the protected resolver |
| delete | projectId, optional assetId | HTTP 202 pending cleanup, never a premature freed-storage claim |

The store's durable actor rate gate precedes operations: metadata/status/read requests use the read counter, mutations use write, and token minting uses upload. Rate exhaustion returns 429 and a bounded Retry-After. Pending invitations expose only their documented minimal project metadata. They grant no project view or asset access until accepted. Query strings, unknown fields, caller decoder assertions and arbitrary paths are rejected before privileged work.

Upload minting obtains a fresh typed authorisation first. Original reads resolve current membership and challenge access before signing and recheck the same immutable descriptor after the provider responds. If permission is withdrawn while signing, the route discards the capability. A URL already delivered before revocation can remain usable for its remaining five-minute validity, and downloaded copies cannot be recalled.

`GET /api/projects/maintenance` uses only the existing CRON_SECRET Bearer header plus the cloud feature gate. It rejects a query-string secret. Each invocation sweeps at most 25 expired reservations, processes at most one finalisation and one cleanup, and refuses a second simultaneous invocation in the same handler instance. Database leases coordinate different instances. The two independent worker lanes can overlap, but there is at most one native image verifier per process. No raw photo frames, URLs, leases, keys or provider exception details appear in the response.

Verification streams only the immutable claimed path, enforces the exact expected encoded size, checks actual codec output/hash/dimensions, and finishes under the current database lease. Membership, challenge state, deadline and reservation state are checked again by the final SQL transaction. A fulfilled finish that reports access lost or failure is not described as ready. A lost acknowledgement is retained for lease reconciliation rather than followed by a conflicting second assertion. The worker clears its owned byte buffers after use and never rewrites the private original.

Cleanup deletes only its leased immutable path and separately verifies authenticated HEAD 404. Unknown or still-present provider state is passed as false, retaining charges. The eighth acknowledged failure is reported as terminal failed, with operator investigation required; it is not labelled as an automatic retry. A stale lease or aborted request cannot assert success. SQL also verifies inactive asset state, the upload safety deadline and absent Storage metadata before releasing quota.

Provider and database calls each use ten-second deadlines; image verification also has a maximum ten-second caller deadline. With capability and sweep checks, then two bounded parallel lanes, the worst ordinary request budget is approximately 60 seconds. The route declares a 120-second runtime allowance. Deployment must actually support that allowance and the documented native-memory limits, or split/schedule these lanes in an equivalent bounded worker runtime. The native decoder may outlive a caller timeout while holding its single allocation slot; process termination is a separate operational recovery action. No automatic scheduler has been installed.

Local evidence combines injected HTTP/Storage failure tests, real Sharp PNG decoding and disposable PostgreSQL lease/concurrency tests. Route tests reject wrong origins, forged actors, unbounded bodies, concealed assets and decoder assertions; verify rate ordering, pending acknowledgements and post-sign revocation; and ensure sanitised failure responses. Hosted signed-token semantics, real Storage metadata triggers/deletion, authenticated UI and deployment scheduling remain activation checks.
