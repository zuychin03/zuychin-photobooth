# Challenge result PNG adapter

`renderChallengePng({ challenges, projects, challengeId, signal?, timeoutMs? })` uses account-bound `ChallengeClient` and `CloudProjectClient` instances. It returns `{ challengeId, recipeHash, blob, mime: "image/png", extension: "png", bytes, width, height, warnings }`. This is a local export primitive, with no upload, autosave, segmentation request, or persisted signed URL.

The adapter obtains a fresh frozen challenge view and authorised project view before downloading anything. Every assigned role/source position must have a visible, accepted-owner photo with matching project metadata. Decorations must be authorised project assets matching the frozen declaration. Downloads use the cloud client's byte and SHA-256 verification. Native header inspection and oriented decode must then agree with the verified dimensions. Sources are downloaded and decoded sequentially, retained in exact sparse positions, and reused for repeated slots.

PNG composition uses the same `composeStrip` and original-export geometry as the editor. All slot crops, rotations, filters and explicit companion splits remain in the immutable template. No Together cutouts are generated. The established original-photo fallback is permitted only when it includes every intended participant; a companion cell without `splitFallback` returns `unsupported`. Scene recipes receive an explicit original-background warning. A requested date is omitted with a warning because the challenge contract contains no shared capture date/time zone. Export time is never substituted.

After encoding, the adapter obtains both views again and compares the recipe, assignments, visible sources, accepted owners and original metadata/hash assertions. Withdrawal, missing access or changed assertions discard the PNG. This is a fresh server authorisation check, not a promise that a downloaded local file can later be revoked. Caller UI must abort on navigation and account changes. Both clients also fence their bound account identity at every asynchronous boundary.

## Bounds and cancellation

- One active render per JavaScript context, without a waiting queue.
- Default caller deadline 60 seconds; configurable up to 120 seconds.
- At most 24 media files, 64 MiB encoded input and 48 MiPixels of decoded inventory, with the existing stricter photo/decoration file limits.
- Output at most 4096 pixels per edge, 12 MiPixels and 64 MiB PNG. Original export uses the existing bounded 2x scale.
- One download/decode in flight, one output canvas, and at most one transient native bitmap. Inventory canvases and output rasters still require substantial browser memory; these limits are allocation bounds, not a total process-memory guarantee.

Abort/deadline rejects as soon as the browser can schedule it; synchronous canvas drawing cannot be pre-empted. Elapsed time is also checked at asynchronous boundaries. Native `createImageBitmap` and `toBlob` work cannot be forcibly cancelled, so the active slot remains occupied until it settles. Its late bitmap/canvas is released before another render is allowed. Every error path releases accumulated canvases and owned curated assets. No user-photo buffers are retained by the adapter after successful return other than the returned output Blob; no object URLs are created.

Errors use `ChallengeRenderError.code`: `not_ready`, `access_lost`, `unsupported`, `resource_limit`, `cancelled`, `timeout`, `integrity_failed`, `account_changed`, `busy`, or `unavailable`.

## Explicit partial results

`renderPartialChallengePng({ challenges, projects, partialId, digest, signal?, timeoutMs? })` returns the same PNG fields plus the exact `partialId` and `digest`. It requires the version-one `partialDetail` projection introduced by migration 008. The caller must be a current included recipient, every included contributor must have consented and remain available, the result must be revealed, and its immutable digest must match exactly. Pending/rejected/unsupported or inaccessible details cannot trigger any original download.

The partial path uses the server's contributor-only template and source assignment, including promoted companion cells and retained blank areas. It does not request the full challenge view or require excluded participants to remain accessible. The strict partial parser prevents extra roles, missing sources and private caption defaults from entering the renderer. The shared full/partial pipeline then validates exact project owners, downloads only the included sources and declared authorised decorations, and repeats the partial and project reads after encoding. Any consent, access, source/hash, recipe or projection-identity change suppresses the output. No partial permissions are inferred from a full challenge or project membership alone.

The output always warns that it is a partial result and unused areas remain blank. Existing date, resolution and original-photo fallback warnings still apply. Full and partial exports share one resource slot and the same cancellation, decode, composition and cleanup implementation.

## Evidence

Focused injected-port tests exercise the actual access/download/mapping/recheck pipeline, sparse and repeated cells, companion fallback, authorised decorations, integrity failure, account change, resource rejection, cancellation with a late decoder, and timeout with a late encoder. These are not native browser pixel tests. Native composition and UI integration checks remain separate; no hosted access or provider writes are part of this verification.
