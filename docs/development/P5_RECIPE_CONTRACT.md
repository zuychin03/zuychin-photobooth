# P5 collaborative recipe foundation

`lib/rtc/recipe-v2.ts` implements the pure client-safe T4 domain. It does not open channels, persist projects, transfer files, elect a host or establish a P5 device acceptance result. Protocol v2 wraps its two payloads in authenticated room/session/member/connection-epoch/roster envelopes.

## Wire contract

`RecipeProposal` contains `schemaVersion: 1`, a UUID `id`, `baseRevision` and one discriminated `edit`. It does not contain a claimed author. The authenticated envelope sender is passed separately to the coordinator.

`RecipeCommit` contains `schemaVersion: 1`, `revision`, `proposalId`, `authorId`, `recipeHash` and `recipe`. Revision zero is the initial snapshot with a null proposal ID. `recipe` contains validated `ProjectEditorSettings`, `owners` mapping roles to member UUIDs, and `stickerOwners` mapping free sticker keys to member UUIDs. It contains no source-order list, photos, camera IDs, account identity, room capabilities or URLs to fetch.

`validateRecipeProposal` and `validateRecipeCommit` validate and detach plain data, reject unknown/accessor/prototype fields, enforce catalogues and return frozen values. They perform shape validation, not sender authentication or hash verification. Transport must validate the envelope and require the current host to send commits. Payloads are capped at 16 KiB per proposal and 64 KiB per commit, below the 96 KiB control-envelope ceiling. An oversized template replacement fails; it is never truncated or split implicitly.

## Ownership and media

The host can propose `shared` patches for layout, frame, global filter, caption/date, pattern, theme, scene, sticker style, template and material. Every member, including the host, can change only their own `cell`, `template-cell`, `placement` and `sticker` values. Template-cell changes cover either the primary slot or the member's companion within that slot. Companion crops retain the primary photo, other companions and portrait slices. Source indexes remain bounded logical positions 0–3, never arbitrary media IDs.

Existing template text and decoration layers belong to the shared design. New participant stickers use the free sticker array and explicit member ownership. Template stickers plus free stickers have one 32-layer budget. Other bounds inherit the project/template validators: 16 photo cells, four roles, four source positions per role, quarter-turn crops, bounded zoom/offsets, 16 text layers of 500 codepoints, eight PNG decorations and known built-in assets only.

The host cannot overwrite another member's crop/filter/source mapping, cutout placement or free stickers through a shared patch or forged full snapshot. Structural template replacement that removes or rebinds another member's slots fails with `ownership_denied`; a new agreed project/recipe is required. Standard-layout changes retain all existing cell edits and must still validate against the new geometry.

`RecipeContext` contains the current `project`, `hostId`, admitted `members: {id, role}[]` and `availableMediaIds`. Project participant IDs/roles must exactly match those admitted members. Context switches, a changed host, removed members or role reuse cannot inherit a coordinator. The caller preserves the old project and creates a fresh project/coordinator for a changed roster. The context contains no pending or removed members.

A template decoration must match an existing project media declaration and have locally available bytes. Every non-null active source reference must also be available. Declared-but-missing media fails with `media_unavailable`; no layer or photo is silently removed. The caller must populate availability only after successful verified decoding/storage or acknowledged transfer. Empty source positions remain valid before capture.

## Ordering, hashing and recovery

1. The host calls `initialRecipeCommit(context)` and creates `new RecipeCoordinator(initial, () => currentContext)`. The initial value must come from that factory or a hash-verified accepted host snapshot.
2. Guests send `recipe-proposal`. The host calls `coordinator.commit(authenticatedSender, proposal)` and broadcasts the resulting `recipe-commit` only after any required durable project write succeeds. The domain does not persist or roll back the caller's storage.
3. The queue is serial, bounded at 16 pending proposals. A proposal must target the current base revision; each accepted edit advances exactly once. A cache of 128 receipts returns the original commit for the exact same sender/proposal retry. Changed payloads reusing a cached ID fail. Older retries outside that cache fail their stale base check. Duplicate old commits should not be rebroadcast as a new current state.
4. Followers call `acceptRecipeCommit(current, incoming, authenticatedSender, context)`. It verifies host authority, the hash, ownership-preserving changes and exactly the next revision. An exact duplicate of the current commit is harmless. A gap, conflicting duplicate or stale revision requests recovery.
5. `hashRecipe` SHA-256 hashes a canonical, key-sorted validated recipe including ownership metadata. Array order is preserved. Use the accepted host snapshot's `recipeHash` in a capture proposal and acknowledge only when the local accepted recipe hash matches. A hash is consistency evidence, not authentication.
6. On disconnect, retain a separate editable local fork. `chooseRecipeReconnect(..., "keep-local-fork")` returns the fork disconnected, without needing the host/media to be available. `"accept-host"` verifies the host snapshot and returns it with `preservedLocalFork`; the caller must retain that fork rather than overwrite it. There is no automatic merge.

`close()` fences pending work, including late SHA-256 completion. The coordinator also rechecks project ID, scope, host, roster ownership and media availability after hashing, before publishing a revision. The caller closes it on room exit or identity change. Creating a new coordinator, accepting a reconnect snapshot and writing an editable fork are explicit caller responsibilities.

Errors are typed: `invalid_recipe`, `update_required`, `ownership_denied`, `recovery_required`, `media_unavailable`, `queue_full` and `closed`. UI should preserve originals and unsaved local work for every failure. No operation silently rebases a stale edit.

## Local evidence

Focused tests exercise ordering and concurrent stale proposals, deduplication, rejected ownership changes, template companion preservation, real declaration/availability checks, canonical hashes, forged host snapshots, explicit fork decisions, executable/oversized payloads, combined sticker limits and late identity/cancellation fences. TypeScript and focused ESLint are checked separately. Transport integration, durable-write orchestration, rendered collaborative UI and real two/four-device cross-network sessions remain separate P5 gates.
