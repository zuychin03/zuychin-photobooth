# P6 challenge interface checkpoint

23/09/2026. This is an in-progress P6 checkpoint, not V2 completion or hosted activation.

## Integrated flow

Accepted shared-project members enter Photo challenges from the cloud project. The project owner selects two to four known members, an existing compatible layout, an immutable reveal rule and an explicit deadline. Creation shows role/source counts and the local deadline before sending. The same mounted creation request is reused after a failed acknowledgement. After leaving or reloading, the participant-only challenge list must be refreshed before creating another. Creation drafts are not yet persisted across reload.

The interface supports discovery, invitations, accept/decline, opening contributions, protected photo preparation/upload, explicit immutable submission, full result preview/PNG preparation, cancellation and withdrawal. Submitted originals follow the current authorised projection, including immediate-policy visibility. Layout guides preserve sparse source positions rather than renumbering them. All controls use the existing theme and Dropdown. Destructive decisions have inline confirmations and focus management.

Choosing a file does not upload it. Uploading does not submit it. Up to four selected Files remain in memory; replacing or deselecting one releases the unused reference. Server-confirmed ready originals are discovered through migration 008's actor-owned challenge upload list, in at most two pages within the 24-file project ceiling. Ready journal rows are never treated as authority when a successful server result omits them. Pending metadata retains the existing same-file, stable upload-ID and explicit status-check workflow.

After remount or on another authenticated browser, a contributor can select and review their own verified originals without the original upload journal. Submission IDs derive from the exact challenge, actor and sorted source mapping, so retrying the same mapping has the same ID. An uncertain mounted submission freezes those assignments while the contributor refreshes or retries. The server remains authoritative for single submission, expiry and source validity. No signed URLs or photographs are stored in a new browser cache.

Preview and PNG preparation use the bounded challenge renderer with fresh authorisation before and after composition. Refresh, mutations and exit revoke transient preview URLs. Account changes close the challenge client and upload manager. Download feedback says the PNG was prepared; it does not claim delivery to the OS.

## Local evidence

The complete local check passed 626 tests, TypeScript and full ESLint. Three UI-contract tests cover all offered two/three/four-person layouts, sparse positions, deterministic retry identity, and bounded authoritative upload recovery. The production build passed. Migration 008's own-upload and partial-result boundaries passed separate disposable PostgreSQL checks, including normal draft/cancelled-unopened empty discovery.

The actual interface/client/upload manager ran against the explicitly synthetic in-memory cloud fixture and a real isolated IndexedDB journal:

- Creator selected a two-person Taking turns layout, with roles A and B assigned source positions 1/3 and 2/4. The exact deadline and reveal rule were visible. Opening remained disabled until the other account accepted.
- Both people accepted the project/challenge and the creator opened contributions. Four synthetic 400 × 1000 PNGs were explicitly chosen and uploaded using the normal file picker. Uploads did not submit automatically.
- The creator cleared all completed local upload tracking and unmounted/remounted. Both verified photos remained recoverable through account discovery, with no duplicate upload. The custom picker disabled reuse of the same asset in a second distinct position. Recovered original preview passed integrity download.
- First submission exposed only the author's originals. The other account saw the submitted status but no concealed source preview.
- An injected failure before the final submission preserved the exact selection and retry state. Refresh and retry succeeded; the final contribution changed the challenge to revealed.
- Native decoding/composition produced a visible 1072 × 3044 PNG. The enlarged-source warning was shown. Desktop 1280 × 720 and narrow 390 × 844 layouts, light/dark presentation, form/confirmation/success focus and preview cleanup were inspected.
- Withdrawal cleared the loaded result and removed full preview/export controls. Switching to the other account also showed access loss, the withdrawn role and only that account's own originals.

The explicit Download action prepared a fresh PNG and invoked the browser download path. The in-app browser did not report a download event within ten seconds. Actual OS-file delivery remains unverified, as in earlier export checkpoints. No repeated download was attempted.

Review fixed retained replaced Files, missing cloud recovery after journal pruning, stale ready journal entries after source deletion, draft upload-discovery errors, creation-screen focus and a roster label that hid withdrawal behind Submitted. These fixes do not replace the final all-page/component or English copy review.

## Still required

Partial proposal/consent/export screens and native lifecycle checks now have a separate [evidence record](P6_PARTIAL_UI.md). Direct challenge links have an [entry contract](P6_CHALLENGE_ENTRY.md). In-app challenge camera capture, durable creation-draft recovery, cloud editable manifests and the rest of P6 memory/ritual/audio integration remain unfinished. Real authentication, provider Storage, cross-device capture, physical phones and installed PWA refresh are separate unverified checks. No migration, feature flag, commit or deployment was applied to hosted services.

Final production-mode recheck: `/projects/cloud` returned 200; all three development labs returned 404; project/challenge/memory POST endpoints remained disabled with private/no-store 503. All six V2 icon assets returned 200 with the expected MIME type, and the manifest retained standard 192/512 and maskable 512 entries. Brand raster reproducibility passed with Sharp 0.35.4. The final build/TypeScript and focused lint passed after the withdrawn-role label correction. The temporary production server was stopped after this check; the development library remains available.
