# P3 local evidence

Recorded 23/09/2026. This covers the passed local templates and curated visual-pack checkpoint in the uncommitted V2 working tree. It is not release, phone, authenticated cloud or physical-print acceptance.

## Implemented scope

- A device/account-scoped template shelf, strict recipe format and portable `.pbtemplate` import/export. Source photos and room credentials cannot appear in a recipe; captions and text are excluded from export by default. PNG decoration pixels are intentionally included.
- A constrained frame designer with photo slots, text, existing stickers, PNG decorations, crop/rotation/mirroring, position/size controls, keyboard movement, undo/redo and local save/apply. Existing projects gain embedded templates through project schema 2, with additive schema-1 reads and future-version recovery.
- One compositor for existing layouts and templates, preserving Together companions and whole-cell original-photo fallback when cutouts are incomplete. Applying a template preserves captured source requirements; a fresh round derives requirements from the current template.
- The 18 generated scenes and six materials now have verified, lazy WebP delivery, thumbnails, category browsing, favourites, full previews, selected-resource preloading and bounded offline pack caching. Originals remain unchanged. See [asset contract](P3_ASSETS.md) and [template contract](P3_TEMPLATE_CONTRACT.md).
- The shared custom dropdown uses the app's card, border, accent and typography tokens. Capture, photo edits, reminders, template controls and visual categories use the same component rather than native selects.

## Actual desktop browser checks

Environment: Codex in-app Chromium 153 on Windows, development origin `http://127.0.0.1:3005`. Checks used generated colour/label fixtures, with no real camera, microphone, account or cloud media. Desktop 1280 × 900 and narrow 390 × 844 viewports were inspected; a narrow desktop viewport is not a phone result.

| Check | Observed result | Limits |
| --- | --- | --- |
| Native template shelf probe, 23/09/2026 02:17 Sydney | 6/6 passed: exact PNG reopen, competing-writer CAS, injected quota rollback, account scope/duplicate, bundle privacy/round trip, future-version raw recovery | Synthetic files in an isolated IndexedDB; real storage exhaustion and hosted auth remain untested |
| Native delivery probe, 02:18 | 4/4 passed: verified 1536 × 1024 decode, explicit bitmap close, unavailable-image fallback and corrupt-byte refusal | Failure requests are deliberately injected; not a network endurance test |
| Native compositor probe, 02:19 | 72/72 passed: eight layout conversions, 16 complete/incomplete Together comparisons and 48 material caption-backing checks | Mean RGBA difference was zero except split-layout conversion at 0.0007/255; this is geometry and sampled backing evidence, not a full print/contrast audit |
| Native scene crops, final rerun 02:37 | 18/18 geometry/opacity checks, each in 3:2, 4:3 and 3:4 | Visual review of all scenes led to nine focal corrections. Final native crops retain the moon, lanterns, sculptures, origami, chrome, sconce, balloons, graduation drape and winter foliage while leaving open face space. Full 3:2 images stay unchanged |
| Shelf/designer workflow | Saved a named frame with text and Rose Washi, reopened it, added a PNG decoration, applied it and performed a real page reload | Saved frame, text, material and PNG remained visible |
| Photo replacement | Imported the four synthetic originals into the template's named source positions | Missing labels cleared; all four appeared in the strip at desktop and narrow viewport sizes |
| Portable import/privacy | Imported the reproducible 7,669-byte fixture through the normal file chooser; its caption and text-layer fields were empty in the designer | Actual native import, not just a fixture parser test |
| Undo/redo | Text edit reverted to empty, redid to the exact edit, then reverted again | Leaving the modified designer displayed its unsaved-changes confirmation |
| New project/next round | Created a fresh project from the imported frame, imported four originals, returned to the booth and started another round | Fresh round reported 0/4 with the template and settings retained; the prior round remained separate. Camera was blocked and imports remained available |
| Favourites | Added Rooftop Blue Hour, then selected Favourites | Only the selected favourite appeared |
| Production offline category | Saved Together, cleared it, then saved it again through the normal picker on port 3006 | Each MessagePort-backed action reported success. After the production server stopped and HTTP connections were refused, Lantern Courtyard still rendered in the full preview; uncached Graduation Atelier displayed the labelled procedural fallback |
| Final dropdown keyboard check | Timer opened with ArrowDown, PageDown reached 10 seconds, Alt+Up selected/closed it; Alt+Down/Home/Enter restored 3 seconds; Tab moved to Camera | An observed focus loss during settings autosave was fixed. Focus now returns to the originating control only when the same project/control remains and the user has not moved focus elsewhere. Real assistive-technology and pinch-zoom checks remain pending |

The renderer probe's largest observed JavaScript heap sample was 59,377,957 bytes; the final scene probe observed 22,309,775 bytes. These counters exclude native image, browser and GPU memory. They do not establish total peak memory or a safe phone workload.

## Delivery sizes

The 24 unchanged PNG sources total 58,547,417 bytes. Full WebP files total 4,917,760 bytes and thumbnails 192,498 bytes, for 5,110,258 delivery bytes. The largest full file is 548,304 bytes and the largest thumbnail 22,784 bytes. These are optional selected downloads, not an initial all-pack fetch. Focal changes modify registry metadata only.

## Final checkpoint checks

- Final `npm run check`: TypeScript, whole-repository ESLint and 284/284 tests passed, with zero failures, skips or cancellations, including the final booth focus correction.
- Final `npm run build`: passed compilation, TypeScript and prerendering. The existing warning about a parent-directory lockfile remains.
- Final local production HTTP checks: `/`, `/booth`, `/customize`, `/projects`, `/templates` and `/templates/design` returned 200; `/v2-lab` returned 404. Production offline-pack workflow passed as recorded above.
- Corrected portrait crop rerun: 18/18 passed with final visual review. Dropdown keyboard and focus regression passed in the actual desktop browser.

## Remaining acceptance

Real Android/iPhone Safari and installed-PWA testing remains explicitly deferred by Danny. Camera capture, segmentation edges on people, OS download/share delivery, account transitions against hosted auth, physical print dimensions/colour, browser eviction, sustained native memory pressure and production cross-network behaviour are not passed by this record. No hosted SQL, deployment, commit or push was performed. P4 owns export/media acceptance and P5 owns secure live rooms and multi-person preview.
