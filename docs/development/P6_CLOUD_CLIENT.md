# P6 browser cloud client

This module is source-ready behind the existing disabled server feature. It does not start uploads, configure a provider, or activate the maintenance worker. Local tests do not establish hosted Storage behaviour.

`createCloudProjectClient({appOrigin,storageOrigin,identity,accessToken,fetch?})` binds one account ID and identity epoch. All API calls use the fixed same-origin POST endpoint, fresh access tokens, no cookies, no redirects, no cache, 10-second deadlines and a 128 KiB / 4096-chunk response bound. Account/logout epochs must change before UI accepts another identity. Close the client on account change. Tokens and signed URLs remain transient values; errors contain bounded codes.

The browser parser handles the API's camelCase projections explicitly; SQL-row parsers are not used on those objects without mapping. `read` and `download` require asset metadata plus `projectId` so the signed URL must match the configured Storage origin and exact bucket/project/owner/asset path. Downloads enforce the verified byte count and SHA-256 before returning a Blob. Callers create and revoke their own object URLs. A signed URL is never durable permission.

## Explicit upload and recovery

Open `openCloudUploadJournal(ownerId,{identity})`, then `createCloudUploadManager({client,journal})`. `prepare(projectId,blob,{kind,protection?})` checks the existing image decoder, actual size/dimensions/MIME and SHA-256, then stores stable asset/request UUIDs before networking. Photos remain bounded at 10 MiB/4096 edge/12 megapixels; PNG decorations at 4 MiB/2048 edge/4 megapixels. The server remains authoritative for aggregate quotas and challenge access.

`run(recordId,blob?,signal?)` reserves using those exact IDs, checks current status, uploads without overwrite, enqueues verification and performs at most six status observations with five two-second waits. Only server `complete` plus asset `ready` returns ready. Missing worker activation returns pending. This is a bounded attempt, not background synchronisation. One manager runs one transfer at a time.

A failed or timed-out request does not imply server rollback. The journal retains its last durable stage. An ambiguous PUT keeps its uploading marker even when status-only verification is queued; reselecting the exact original can resend without overwrite while reserved, including queued/retry verification. Changed bytes cannot replace that original. Status-only recovery never invents new IDs. The server's short mint window and immutable upload expiry can prevent another PUT; the client reports this rather than silently allocating a replacement. Cancellation stops local transfer/polling and preserves tracking, and never claims remote deletion.

The journal stores only bounded metadata, hashes, IDs, protection binding and timestamps, never original bytes, filenames, access tokens or signed URLs. Reloaded uploads require explicit user action; a file must be selected again if transmission is needed. Each account has 64 retained records. Confirmed-ready tracking may be pruned at the ceiling; uncertain records are never automatically evicted. `forget(id)` removes local tracking only. It neither deletes the cloud original nor releases its quota.

## Account removal

After successful sign-out, an explicit remove-local-copies flow calls `removeCloudUploadJournalForOwner(ownerId)`, returning `{removed}`. The helper invalidates opening handles, closes registered journals and aborts their transactions, then deletes exact-owner records while advancing a persistent owner generation. Every journal transaction checks that generation, so stale handles in another tab cannot recreate records after cleanup. Other accounts remain untouched. Ordinary sign-out closes handles but preserves their records. Callers must close the client/manager when their account epoch changes; cleanup itself performs no remote operation.

## Evidence

Focused injected tests cover HTTP projection sanitisation, exact signed paths, bounded streams/deadlines, account switches, integrity, non-overwrite PUT, stable retry IDs, uncertain zero-byte transfer recovery, changed-file rejection, cancellation and finite polling. The injectable journal port isolates lifecycle tests from IndexedDB. On 23/09/2026, `runCloudUploadJournalProbe` passed all 11 checks in the native desktop browser. Its disposable IndexedDB checks cover close/reopen, ready-only quota pruning, close-before-cleanup and other-account isolation. A separate module worker held both account journals open while the main context removed one account: old worker reads and writes were rejected, the other account remained writable, and a full reopen showed no resurrection. The worker terminates and the temporary database is removed. Provider URLs/tokens are synthetic; hosted uploads, CORS, real account refresh and device performance remain unverified.
