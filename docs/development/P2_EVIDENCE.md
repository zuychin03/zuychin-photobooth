# P2 local project and editor evidence

Recorded 23/09/2026, Australia/Sydney. This is a local implementation checkpoint for C1–C3, not a V2 release or physical-device acceptance. Danny's phone-test deferral still applies. No commit, push, hosted migration or deployment was made.

## Implemented

- Strict versioned project model, immutable original media, bounded undo/redo and portable `.pbproject` files. IndexedDB writes use atomic revision checks, recoverable checkpoints and exact device/account scopes. Future and damaged records remain read-only with recovery files. See [storage contract](P2_STORAGE_CONTRACT.md).
- Project library: resume, rename, duplicate, explicit deletion, portable import/export, storage estimates and optional persistence request. Active project state follows library mutations. Logout offers keeping hidden account drafts or removing their local copies after successful sign-out.
- Capture: Classic/Flexible, named camera, 3/5/10-second timers, mirror, optional fill light, mixed imports, single-shot retakes and reuse for the next round. Failed shots remain available for retry or immediate local download. Late camera permissions and disconnected tracks cannot become a ready stale camera.
- Editor: source reordering, per-cell source selection/crop/zoom/rotation/mirroring/filter, immutable capture dates, undo/redo including the empty-photo state, sticker keyboard movement and history shortcuts. Together cutouts are invalidated when their sources change and prepared sequentially.
- Failed editor saves retain the latest optimistic recipe. Up to eight dirty projects survive navigation in the same tab, keyed by exact project and account identity; the ninth edit is refused rather than silently evicting another draft. Leaving the document warns while edits are pending. Recovery is volatile until retry succeeds or a backup is exported. Intentional deletion retires and drains the corresponding queue.
- Still and portable export can retain unsaved edits when local persistence fails, with explicit copy distinguishing them from saved changes. Export controls lock the snapshot during preparation. Project identity checks prevent late captures/queued edits from attaching to another active project. Required source decoding precedes advancing the durable revision.
- Danny's additional request is implemented as a reusable custom dropdown. All eight native selects in capture, crop and reminder controls use the shared component, with themed surfaces, 44-pixel targets, disabled options, typeahead, arrows/Home/End/Enter/Space/Escape/Tab and menus constrained to the viewport. Native popovers retain inherited booth tokens; the fallback portal copies the relevant tokens.
- Legacy room and relay adapters await local project/photo persistence. Room progress counts durable unique frames, bounds retained failures and offers an explicit incomplete-result action after a missing-frame timeout. This is P2 compatibility work; it is not the authenticated P5 transport.

## Automated checks

`npm run check` passed TypeScript, full ESLint and **223/223 tests**, with no skipped tests. This includes 15 editor queue/recovery tests, image header/resource limits, portable parser/integrity tests, capture sequencing and camera lifecycle checks, model/history and composition tests, three dropdown navigation/placement tests, four account-cleanup tests and the earlier P0/P1 suite. The Windows subprocess permission used in prior checkpoints was retained.

`npm run build` passed compilation, TypeScript and prerendering. The existing Next parent-lockfile root warning remains. Static design detection returned no findings for the editor, booth, library, dropdown and capture/crop controls. This detector is supplementary to rendered inspection.

The temporary production server returned 200 for `/`, `/booth`, `/customize` and `/projects`, and 404 for `/v2-lab`. It was stopped after the check; the development preview remains available.

## Actual desktop browser checks

Browser: Codex in-app browser, Chromium 153 on Windows. Origin: `http://127.0.0.1:3005`. No camera or microphone permission was accepted. Synthetic colours and development-only fixtures were used; no personal or cloud photos were involved.

| Check | Observed result |
| --- | --- |
| Production repository probe, 23/09/2026 01:38 Sydney | **10/10 passed**: commit/reopen original bytes, concurrent revision fence, immutable media identity, injected quota rollback, exact scope isolation, duplicate/delete/checkpoint, corrupt wrapper identity, future read-only backup, blocked upgrade timeout and version-change closure. |
| Real page reload, 23/09/2026 01:30 Sydney | Original PNG hash and saved manifest recovered from a different page document. |
| Native renderer probe, 23/09/2026 01:37 Sydney | **5/5 passed**: byte-exact PNG bundle round trip, actual JPEG EXIF-6 orientation, crop/rotate/mirror/zoom/pan pixels at 1×/2×, independent source selection and stable Sydney/UTC capture dates. |
| Normal import flow | Camera-denied page accepted four local PNGs and reported four durable shots. Flexible review opened the editor. |
| Editor recovery | Caption and 90-degree rotation saved; Undo restored 0 degrees, Redo restored 90, and both caption and rotation survived a real reload. |
| Library | Rename and duplicate produced separate visible entries. The copy retained the caption and transform. Normal `.pbproject` import opened its saved caption and originals. |
| Empty history | Undoing all four imported captures kept the editor open with explicit empty-state copy and an enabled Redo action. Redo restored a source. |
| Dropdown, desktop 1280 × 900 | ArrowDown/Enter changed layout; End/Escape cancelled source selection. Pointer selection changed a cell filter and closed the menu. |
| Dropdown, narrow viewport 390 × 844 | Menu remained within the viewport above the editor's clipped scroll area. Missing sources had `aria-disabled=true`; End/Enter skipped them. Capture timer selection persisted to the next round, with Flexible style and mirror settings retained. |

The portable-export UI prepared the backup successfully. The browser automation download event timed out, and no matching file was found in the normal Downloads folder, so operating-system download delivery is **not confirmed**. The native browser probe separately verified the generated bundle contents and exact original hashes. Importing a separately generated real bundle through the library succeeded.

## Pending external and device evidence

- Real Android/iPhone capture, physical-camera retakes/unplugging, Safari decoding, native share/download delivery and installed-PWA behaviour.
- Real browser storage exhaustion/eviction and crash/power-loss durability. The passing quota case is a transaction-level injected error.
- Authenticated multi-account UI/sign-out against the hosted service. Account scope and cleanup were checked with local repository cases and mock adapters; no real account deletion/sign-out was performed.
- Live two/four-device room and cross-network transfer; P5 admission/security, reconnect protocol and complete participant cutout fallback remain separate work.
- Phone memory pressure and native/GPU memory. Resource ceilings and desktop heap observations do not measure total process memory or establish a safe phone budget.
- Remote CI and release acceptance. The full approved P3–P9 scope remains outstanding.
