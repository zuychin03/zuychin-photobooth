# Cloud design reopen contract

`openCloudDesignCopy({ client, projectId, checkpoint?, expectedReceipt?, signal? })` opens the current or previous canonical design as a **new account-scoped local project**. It never navigates, overwrites a local project, saves a canonical design, or writes an upload journal.

The opened result is `{ kind: 'opened', project, receipt, source }`. `source` carries the cloud project ID, checkpoint, exact media bindings, participant mapping, and the canonical project's `id`, `createdAt`, `capturedAt` and `captureTimeZone`. A later save coordinator must retain that canonical identity separately from the new local ID and creation timestamp. Participant labels and roles describe the design; account bindings identify uploaders, not depicted-person consent.

An unsupported project schema returns `{ kind: 'unsupported', record }` with its bounded raw snapshot for explicit read-only export. It performs no asset download or local write. An optional expected receipt prevents reopening a different checkpoint from the one the user reviewed.

## Access and resources

The helper requires design capability support and a fresh authorised checkpoint. It matches every inventory item, including retired shots, undo/redo dependencies, decorations and reference images, against the current accepted project view. Owner, asset ID, kind, MIME, encoded bytes, dimensions and SHA-256 must agree. The existing cloud client obtains private read grants and verifies each sequential download; the helper also checks signatures, dimensions and hashes before passing originals to the repository's real decoder.

The current project validator enforces 24 files, 64 MiB encoded inventory, 48 megapixels total and existing per-image bounds. Only one reopen operation runs in this module at a time. All originals remain encoded; native validation decodes sequentially. No signed URL is persisted or returned. A fresh view, every asset read gate and the exact checkpoint receipt/payload are checked again before the single atomic manifest/media save at revision zero.

## Cancellation and cleanup

The cloud client keeps its ten-second per-request bound. A two-minute operation timer requests cancellation; a native decode or already-started IndexedDB write is still awaited rather than claimed to be synchronously cancelled. The occupied operation and exact-account lifecycle registration remain held until that work settles.

Account cleanup aborts and drains this writer using the existing scope lifecycle. If cancellation or account loss arrives during a successful local save, the helper deletes only its new revision-zero copy before rejecting. If that deletion fails, `cleanup_failed` includes the exact account scope and project ID for recovery. It never returns an opened success in that case, and it never puts those originals in device scope. Repository CAS prevents overwriting or deleting a concurrently edited copy.

## Evidence boundary

Focused tests use the actual CloudProjectClient with synthetic HTTP responses, real PNG bytes and injected repository transactions. They cover complete inventory preservation, previous checkpoints, collisions, unsupported schemas, receipt changes, metadata mismatch, integrity failure, revocation, account loss, awaited-write cancellation and scope drain. Native IndexedDB reopen, provider reads and the integrated UI remain separate browser/provider checks.
