# P2 local project storage and portable bundles

Recorded 23/09/2026. This local layer uses the single [`PhotoProject` model](../../lib/projects/model.ts). It creates no cloud schema, account membership or hosted media. The P2 UI and capture/editor adapters are separate consumers.

## Repository contract

[`openProjectRepository(scope, options)`](../../lib/projects/storage.ts) opens IndexedDB `photobooth-projects-v2`, database version 2. The scope is exactly `{kind: "device"}` or `{kind: "account", ownerId}`. Each repository exposes only that namespace. A signed-in library may combine the device repository and that account's repository; logout must stop using the account repository. This prevents accidental cross-account display by the application; IndexedDB is origin storage, not encryption or protection against another script with the same origin.

| Operation | Result and boundary |
| --- | --- |
| `save(project, mediaMap, expectedRevision)` | Create requires revision 0 and expected `null`. An update requires the persisted revision and exactly its next revision. `mediaMap` contains new blobs or identical existing blobs; unchanged persisted sources may be omitted. Resolves only after transaction completion. |
| `load(id)` | Returns current editable project, or unsupported/corrupt read-only raw manifest, plus original blobs and the previous checkpoint. Missing media makes the record read-only, retaining available data for backup. |
| `list()` | Returns metadata for this exact namespace, marking unsupported/corrupt records read-only. |
| `rename(id,name,expectedRevision)` | Uses the same revision check; cannot overwrite another tab's edits. |
| `duplicate(id,{id?,name?})` | Creates a new project at revision 0 in the same namespace, retaining original source bytes and capture provenance; clears the device camera selection. |
| `delete(id,expectedRevision)` | Atomically removes that current-schema project, its media and identity records. A future or corrupt manifest cannot be accidentally deleted by this API. |
| `recoverCheckpoint(id,expectedRevision)` | Restores the previous supported manifest at a new revision, checks its media exist, and retains the displaced manifest as a checkpoint. Future-schema current records cannot be downgraded this way. |
| `exportRaw(id)` | Returns the preserved manifest as a JSON Blob, available original blobs and prior checkpoint for explicit local recovery. Raw recovery data is not redacted for sharing. |
| `close()` | Releases the database connection. A `versionchange` automatically closes it; callers must reopen before more operations. |

Project keys contain the exact scope and project ID. Blob keys add a validated media ID, never a caller-supplied path. The project, media and immutable media-identity stores participate in one read/write transaction. The revision comparison happens inside that transaction, including when two tabs save at once. Every provided blob is checked for actual size, MIME, image signature and decoded dimensions, then hashed before opening the transaction. No image decoding or hashing is awaited inside an IndexedDB transaction. Request callbacks enqueue dependent database operations while the transaction is active, following the [IndexedDB transaction model](https://www.w3.org/TR/IndexedDB/).

Existing media IDs cannot acquire different bytes, MIME or dimensions. Small identity records survive blob pruning so a previously used media ID cannot later be repurposed. Source changes use new IDs. `createdAt`, capture timezone and an established `capturedAt` are immutable; update time cannot move backwards. Capture time is set once when the first photo is retained.

The latest manifest and one previous manifest checkpoint retain their blob inventories. Blobs outside both inventories are pruned in the same transaction; identity records remain until the project is deleted. Each manifest keeps the approved 64 MiB media budget, so distinct current/checkpoint inventories can temporarily retain up to twice that amount. Bounded undo history may keep old originals referenced by the current manifest. Canvases and decoded bitmaps are transient and never persisted.

Any request failure, quota exception or explicit abort rolls back the new media and manifest together. A request succeeding does not mean the project is saved; only transaction completion does. Open and transaction waits default to ten seconds. A blocked upgrade reports a retryable error, and a late open after timeout is closed/aborted. Upgrades create missing stores/indexes additively; they never delete existing stores or records.

Browser storage remains best effort. Transaction completion is not a promise against later eviction, user-cleared storage, device loss or power failure. Storage estimates and persistence requests belong to the UI; portable export remains the independent backup path. An IDB failure must leave the active in-memory edits available for retry/export rather than advancing the saved indicator.

The `/projects` library exposes device drafts and only the current account's drafts. Account rows disappear immediately when auth changes. It offers resume, inline rename, duplicate, export, import and an explicit confirmation before permanent local deletion. Recovery files remain available for unsupported/corrupt drafts; supported previous checkpoints can be restored with confirmation. Regular imports commit the whole project before opening the editor. Previews decode one source at a time, downsample to at most 160 pixels per edge and release canvases/Blob URLs; thumbnails are not persisted. The storage estimate covers the whole origin, and a persistence grant is described separately from an exported backup.

Shared Vault sign-out offers keeping account drafts hidden (the default action) or explicitly removing their local copies. The session pauses new saves and settles pending work first. Authentication failure does not trigger removal or falsely report success. Removal opens only that exact account repository, skips read-only records, uses revision-checked deletion and rescans for remaining drafts. Recovery-required records and failed/racing removals stay hidden and are reported. Device projects are outside this operation. The result remains visible after sign-out, including a storage-cleanup failure; this is not a secure-erasure guarantee for browser-managed files.

## Portable `.pbproject` envelope

[`bundle.ts`](../../lib/projects/bundle.ts) uses a sequential uncompressed binary format, without ZIP extraction, file paths or network fetches. `exportProjectBundle(project, mediaMap)` validates the current schema, clears account scope and `capture.cameraId`, and preserves capture time, timezone, editable recipe and original bytes. Unknown fields, including credential fields, are rejected by the shared schema.

All integer fields use big-endian byte order:

| Part | Encoding |
| --- | --- |
| Signature | Eight bytes: `PBPROJ` followed by CR LF |
| Envelope version | Unsigned 16-bit integer, currently 1 |
| Manifest length | Unsigned 32-bit UTF-8 byte length, at most 64 KiB |
| Entry count | Unsigned 32-bit integer, at most 24 |
| Manifest | Exact-length UTF-8 JSON following the current shared project schema |
| Each media entry | One-byte ID length (1–64), UTF-8 ID, unsigned 32-bit byte length, 32-byte SHA-256 digest, then exact media bytes |

The media payload budget remains 64 MiB. The whole file has a fixed ceiling of 64 MiB + 64 KiB + 24 × 101 bytes + 18 bytes, so a valid full-size project can still include its manifest and framing. Individual image, pixel and decoration bounds are the shared [resource limits](P0_RESOURCE_BOUNDS.md). Truncated lengths, excess entries, duplicate/unknown IDs, manifest inventory mismatches, extra trailing bytes and SHA-256 mismatches reject before the relevant image is decoded. Hashes detect corruption, not authenticity or ownership.

`importProjectBundle(blob,{inspect?,newId?,now?})` validates the entire file, sequentially invokes the image inspector, and returns `{project,media}` without writing a database. The returned project has a new ID, revision 0 and device scope; account ownership and camera selection are cleared again even if a file was manually crafted. The caller commits it with `save(...,null)` before displaying Saved. Future envelope/manifest versions are rejected without modifying the input file. Future manifests already in local storage remain read-only with a raw backup; ordinary portable export cannot safely redact fields from an unknown schema.

## Evidence and remaining checks

Nine Node bundle tests pass for byte-preserving round trip/redaction, empty drafts, strict framing limits, oversized input, hash corruption, unknown IDs and lengths, unsafe/future manifests, decoder mismatch/failure and invalid export inventories. Their image-header inspector is injected because Node does not provide the browser decoder. This proves parser/integrity behaviour, not native image decoding.

Four mocked account-cleanup tests cover exact account scope, future/corrupt retention, revision/deletion failure, newly appearing drafts and unavailable storage. They make no authentication request and delete no real drafts; hosted sign-out behaviour still requires its own safe integration evidence.

[`runProjectStorageProbe`](../../lib/feasibility/project-repository-probe.ts) is a browser-callable harness using fresh synthetic databases and native canvas PNGs. It covers close/reopen byte recovery, two-connection revision contention, immutable sources, an injected quota exception after media requests, device/account isolation, duplicate/delete/checkpoint recovery, future read-only backup, blocked additive upgrade and version-change closure. Quota injection wraps only the test repository's factory/connection; it changes no global IndexedDB prototype. Its databases are removed in `finally`.

Separate `saveProjectReloadCheckpoint`, `verifyProjectReloadCheckpoint` and `clearProjectReloadCheckpoint` functions use only `photobooth-p2-reload-probe`. Verification requires a different page document and compares the original PNG hash. The root integration records actual named-browser runs in the phase evidence; the presence of these probes alone is not a passed browser test. Real storage exhaustion/eviction, phone recovery and cross-browser decoder behaviour still need their own observations.
