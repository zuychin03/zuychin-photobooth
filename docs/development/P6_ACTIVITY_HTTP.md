# Activity HTTP and browser contract

This tranche adds source-ready private HTTP and browser boundaries over migration 006 and `ActivityStore`. It does not enable memories, change sources, run backfills, add UI or send reminders. Migration 006 and its shared project rate RPC must exist before `PB_MEMORIES_ENABLED=true` can be considered. The store validates the schema capability, verifies the fresh bearer through `getUser`, and charges one read/write rate unit per operation. No additional cloud-project feature flag is needed for activity over legacy strips.

`POST /api/memories` accepts only same-origin JSON with an exact Bearer header. Production requires HTTPS and `PB_PUBLIC_ORIGIN`; development permits loopback HTTP. Queries, other methods, extra body keys and caller-supplied actors are rejected. All responses are private, no-store, no-referrer and nosniff. Bodies are limited to 8 KiB, 4,096 chunks and five seconds. SQL and provider errors are reduced to a finite public code list; rate responses have a bounded Retry-After value.

| Operation | Request fields after operation | Response |
| --- | --- | --- |
| list | after?: UUID, limit?: 1..50 (default 20) | ActivityPage |
| summary | year: 1970..2199 | ActivitySummary |
| chapters | none | {chapters: MemoryChapter[]} |
| putChapter | chapter: {id, expectedRevision, title} | MemoryChapter |
| annotate | annotation: {id, expectedRevision, chapterId, occasion} | MemoryActivity |
| deleteChapter | id, expectedRevision | {deleted: true} |

There is no uncharged capabilities operation. A normal list request reports availability through success or the typed unavailable response. Listing is UUID keyset order, not chronology. Summary totals are retained own source records grouped in UTC, including records whose media is no longer available. They must not be labelled a local civil year, current available-photo count, session count or shared couple total. Chapter creation uses expectedRevision -1; later chapter and annotation changes must name the exact current revision. Conflicts require a fresh read and a deliberate retry. Deleting a non-empty chapter does not silently erase occasion labels.

`createActivityClient({appOrigin, identity, accessToken, fetch?, timeoutMs?})` exposes ownerId, assertActive, close, list(after?,limit?,signal?), summary(year,signal?), chapters(signal?), putChapter(input,signal?), annotate(input,signal?) and deleteChapter(id,expectedRevision,signal?). The identity is `{ownerId,epoch}` from the authenticated account wrapper. Create a new client on each account epoch and close the old client synchronously. Every request fetches a fresh token and checks identity before and after asynchronous work. The client stores no tokens, activity records, signed URLs or account data durably.

Requests omit cookies, reject redirects and opt out of caching. A single maximum ten-second deadline includes token acquisition, fetch and response streaming. Responses are bounded to 64 KiB and 4,096 chunks, require JSON and valid UTF-8, and are projected to allowlisted fields. HTTP activity uses nested source/annotation fields; the browser deliberately maps that shape to the shared SQL projection validator. Minimal own access_lost entries require source:null; shared entries cannot include personal annotations. Mutations verify returned IDs, labels and the exact incremented revision. Summary year and list cursor boundaries are checked against the request.

`ActivityClientError` exposes only code, status and optional retryAfterSeconds. Closing or cancelling aborts local work. It does not prove an already dispatched mutation was rolled back; reload before retrying an ambiguous write, preserving its ID and expected revision. No automatic retries or background polling are implemented.

Focused Node tests cover HTTP guards, strict bodies, private errors, client/handler projection compatibility, account changes during token acquisition and streaming, cancellation/deadlines, UTF-8/byte/chunk bounds, UUID cursors, exact CAS results and explicit UTC summaries. These are local handler/transport fixtures, separate from the migration's actual disposable PostgreSQL evidence. No hosted Supabase, deployed HTTP, browser UI or delivery behaviour is claimed by this tranche.
