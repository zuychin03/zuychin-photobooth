# P4 local export and motion evidence

Updated 23/09/2026. This is the local C6/C7 checkpoint within the approved V2 plan. It does not pass the final all-page UI/UX, real-device or release gates.

## Delivered

The editor's Export action opens a keyboard-accessible dialog with original, story, square and wallpaper image profiles, PNG/JPEG selection, quality, contain/cover preview, source-detail feedback, and exact-size strip/two-up/A4 PDFs. PDF margins and cut marks are explicit. Preparing a file reports its actual encoded bytes before a separate Download/Share action. Sharing falls back to downloading where file sharing is unavailable.

Solo projects can animate their existing photos through the current frame and crop positions. Empty source positions remain empty rather than being filled with duplicate photos. GIF uses a lazy worker; MP4/WebM become selectable only after a synthetic sample has actually encoded and decoded in that browser. Every prepared video is independently checked for MIME/container, dimensions and complete bounded playback. The final photo remains held for its intended interval.

The solo booth offers a separate, explicit two-second recording flow, bounded to 24 JPEG frames at up to 12 fps and 1280 × 720 pixels. It borrows the active camera and records no sound. The dialog explains that captured loops are temporary and must be downloaded before closing. It cancels work on close/navigation and preserves the saved still project. GIF playback is opt-in, including for reduced-motion users. Video playback uses native controls without autoplay.

Implementation contracts: [still/PDF](P4_EXPORT_CONTRACT.md), [motion](P4_MOTION_CONTRACT.md). The separately requested [V2 PWA icon](PWA_ICON_V2.md) is included in this local build.

## Automated and native checks

`npm run check` passed TypeScript, full ESLint and **331/331 tests** at this checkpoint, including concurrently developed P5 foundation tests. `npm run build` passed compilation, TypeScript and prerendering. These are uncommitted local results, not remote CI. The existing parent-lockfile root warning remains.

Actual PDF parsing confirms exact page sizes, disabled print scaling and one embedded raster reused across one, two or three placements. Tests cover source resolution after crop/rotation/slicing, invalid dimensions, resource limits, cancelled/failed encodes, GIF bounds, one-operation fencing, late native decoder cleanup, frame pacing and held-video frames. Whole-pixel rounding no longer falsely reports a 4096-pixel resource cap.

The development lab ran in the actual desktop browser, Chrome 153 on Windows, with no camera, microphone, account or cloud uploads:

| Native probe | Result |
| --- | --- |
| Four still profiles, PNG and JPEG | All decoded to their declared dimensions and MIME |
| Preview/output parity | 490 solid-region samples matched known fixture colours and preview/output pixels across four profiles, both fits and both image formats, with an eight-level lossy tolerance |
| Composed photo loop | Four decoded frames had the expected rotating source colours and retained frame geometry |
| Cancelled composition | Original PNG hashes and source order remained unchanged |
| Sparse two-photo loop | First-frame PNG exactly matched a fresh native reference render with both empty positions preserved |
| GIF cancellation/retry | Aborted after the first acknowledged worker frame, retained all source hashes, then a fresh worker completed |
| GIF native playback data | Six boomerang frames decoded in the expected colour order, 640 × 360, 5,133 bytes, 1,200 ms |
| MP4 | Actual encode/decode passed, 1280 × 720, 16,334 bytes, 2,023 ms for the two-second sample |
| WebM | Actual encode/decode passed, 1280 × 720, 30,840 bytes, 2,138 ms for the same sample |

Final composition evidence was recorded at `2026-09-22T17:27:29.779Z`, and motion evidence at `2026-09-22T17:28:21.060Z` (23/09/2026 in Sydney). Both final probe groups passed 5/5 checks. The sparse reference was changed to a fresh canvas after a reused readback surface produced a different antialiased border; the exact PNG-hash assertion was retained.

The final composition/motion runs sampled JS heap peaks of 22,390,842 and 22,393,044 bytes respectively. These values exclude native/GPU allocations and do not prove a phone memory budget. The lab's common `mediaInventory` field describes the earlier P0 fixture inventory; it is not a measurement of all P4 surfaces. P4 bounds are separately documented in the export contracts. No long-session or physical memory-pressure acceptance is claimed.

## Normal UI checks

The regular editor produced a three-strip A4 PDF (20 KB), a four-photo GIF (224 × 640, 19 KB, two seconds), and an MP4 from a synthetic project. The first MP4 exposed a shortened final hold; that was fixed and the stricter native timing checks above passed. The custom dropdown worked inside the native modal, including Arrow/Home/End/Enter, Escape dismissing only the list, and viewport-safe placement at 390 × 844. Closing the modal by Escape restored focus to Export. Editor undo shortcuts no longer bubble through the modal and change borrowed source images mid-export.

The normal solo-motion dialog was exercised with a synthetic canvas stream through the development-only fixture. A two-second run captured 23 frames and produced a 640 × 360 boomerang GIF (656 KB, approximately four seconds). Opt-in play/stop preview, cancellation during recording, retry, and closing during recording worked. The borrowed synthetic camera remained available after the dialog closed. This is component and browser evidence, not a real-camera test.

Rendered dark-theme layouts were inspected at desktop and 390 × 844 sizes. Dialog headers remain reachable while settings/results scroll. The final cross-page light/dark, English copy and assistive-technology review remains in [the UI/UX gate](V2_UI_UX_REVIEW.md).

The production manifest and all five revised install/favicon assets returned 200 with the correct MIME; `/v2-lab` returned 404. The same revisioned favicon also returned 200 from development. Installed Android/iOS icon refresh remains unverified.

## Bounded repeated media acceptance

On 23/09/2026, the native browser completed all six sequential rounds at `/v2-lab/media-acceptance` in 63,142 ms. Every round passed GPS-tagged JPEG import, exact-original IndexedDB reopen, PNG/JPEG metadata inspection, five project-render checks, five composition checks and five motion checks including GIF cancellation/retry and actual GIF/MP4/WebM decoding. An exact flattened PNG copy also survived account-scoped storage reopen, while a second account could not read it. Synthetic databases were removed after each round.

The imported GPS JPEG was 968 bytes in every round, with unchanged SHA-256 `c1ea27fc6146f3266c8e27684f1947da744b93967236789c0d76254311cff6d2`. The independently Sharp-decoded fixture contains real EXIF GPS latitude/longitude rational entries. Native PNG derivatives were 75,959 bytes and JPEG derivatives 24,668 bytes, both 1072 × 3044. The PNG derivatives contained no eXIf or text metadata chunks; JPEG derivatives contained no APP1, APP13 or comment metadata segments. Stored originals remained byte-exact after rendering.

Each native GIF had six decoded frames, 640 × 360 pixels, 5,133 bytes and 1,200 ms duration. MP4 outputs were 1280 × 720, 16,334 bytes and approximately 1,990–2,036 ms; WebM outputs were 1280 × 720, 30,840 bytes and approximately 1,977–2,001 ms. All six rounds passed the native decode and cancellation/retry checks.

The run collected 638 JavaScript heap samples: 23,507,538 bytes initially, 20,679,806 bytes finally and 25,885,883 bytes at peak. Garbage collection was not forced. Native and GPU allocations were not measured, and the helper's resource-limit values are declared ceilings rather than observed allocation counts. This is a bounded 63-second repeated-session result, not hours-long stability, physical memory-pressure or real-device acceptance; it does not fully close long-session acceptance.

Thirty-round follow-up, observed 24/09/2026: the completed native run passed all 30 rounds in 300,224 ms, with 150 project-render checks, 150 composition checks and 150 motion checks. Every motion result passed, including mid-encode GIF cancellation/retry and native GIF/MP4/WebM decoding. All original hashes remained identical to the GPS fixture above. Each round also passed derivative metadata checks, original storage reopen and account-isolated flattened-copy reopen. MP4 durations were 2,010–2,042 ms; WebM durations were 1,971–2,078 ms. One WebM was 24,069 bytes and the other outputs were 30,840 bytes; all decoded successfully.

The follow-up collected 3,033 JS heap samples: 25,811,699 bytes initially, 17,371,474 bytes finally and 26,505,075 bytes at peak. No forced garbage collection or native/GPU measurement occurred. This is five-minute desktop repetition evidence, not hours-long, phone or memory-pressure acceptance. An earlier 30-round tab was closed before its result was collected and is not counted.

## Still pending

The built production editor on port 3006 prepared a four-photo GIF (27 KB, 224 × 640, two seconds) and an A4 three-strip PDF (30 KB) through the normal export dialog. This confirms the production GIF worker and lazy PDF pipeline execute, in addition to development probes. Neither OS download delivery nor native sharing is claimed.

Physical print measurements/colour, real Android/iPhone camera and codec behaviour, installed PWA launcher appearance, native sharing and confirmed OS download delivery remain pending. Danny explicitly deferred real-phone checks. No hosted service was activated, and no commit, push or deployment was made. Later P5–P9 work and the final all-page/component review remain required before the V2 goal can be complete.

## Legacy weekly recap follow-up, 24/09/2026

The legacy Shared Vault recap now downloads and decodes one original at a time, verifies bounded PNG input, reduces originals to bounded thumbnails and uniformly scales its existing layout within 4096 pixels per edge and the output pixel/file limits. Fresh source identity and account checks gate the completed result. Cancellation refuses publication immediately while late native work retains its allocation slot until cleanup. The vault reports failure and distinguishes an already requested download from an unconfirmed vault save.

Native `/v2-lab` Run weekly recap checks passed 4/4 in Chromium on Windows at 1280 × 720. Four synthetic Quad strips rendered to 4096 × 775 with all four sampled source colours and at most one decoded original alive. Revoking a source after encoding prevented output publication; changing the synthetic account after encoding also prevented publication. A subsequent fresh attempt completed at 2388 × 1732. The probe used generated PNGs and injected fetch/authority ports, with no actual account or provider request. The lab's generic mediaInventory is not a measurement of this recap's native/GPU use.

Photo-date helper checks separately cover resolved database errors and lost acknowledgements. The UI now awaits delete success, displays failures and freezes uncertain creation details while retrying the same request ID. Full authenticated vault reminder/recap interaction and real provider delivery remain unverified.
