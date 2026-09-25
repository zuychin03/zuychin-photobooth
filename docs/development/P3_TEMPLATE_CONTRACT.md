# P3 template contract

`lib/templates/model.ts` owns recipe schema version 1. `TemplateDesign` embeds only canvas, source requirements, photo slots, decoration layers/files, shared look and caption defaults. It has no project/account identity. `TemplateRecipe` adds a name, ID, revision, local scope and canonical UTC creation/update times. Project schema migration and composition consume this contract separately.

## Bounds and rendering

- Canvas dimensions use the incumbent strip's abstract pixel units: each edge 128–4096, at most 12 MiPixels. A renderer scales geometry uniformly for the selected output resolution.
- At most 16 photo cells, one to four roles A–D, and source indices 0–3. A Together cell can contain its primary source and up to three distinct companion roles, bounding drawing at 64 participant placements. Each declared role count equals its highest referenced index plus one, including companions. Gaps remain valid for incumbent alternating layouts. Repeated slots may reuse a source.
- Slot bounds are normalised x/y/width/height, remain inside the canvas, and have positive dimensions. Crops allow zoom 1–4, offsets −1–1, quarter-turn rotation and mirroring. Optional `sliceX` preserves an incumbent split portrait, with `0 <= start < end <= 1`. Optional `filterId` is null or a built-in filter.
- Companions carry their own role, source index, crop, optional slice and filter. Optional `splitFallback` requires companions and retains the explicit split behaviour when cutouts are unavailable. Optional per-role `places` retain Together positioning, with dx −0.5–0.5, dy −0.25–0.25 and scale 0.5–1.6. Companions remain declared when a scene is turned off.
- Photo slots draw in array order, followed by decoration layers in array order. Layer rotation is degrees, −180–180. Layer bounds use the same normalised canvas coordinates. Text font size is a fraction of canvas width. Fonts are the fixed sans/serif/mono choices and colours are six-digit hex.
- At most 16 text layers, 500 Unicode codepoints per text/caption, 32 built-in stickers, and eight PNG decoration layers/files. Decorations are still PNG only, at most 4 MiB and 2048 pixels per edge. Aggregate resource ceilings remain 24 files, 64 MiB encoded and 48 MiPixels decoded; recipe-only decoration ceilings are stricter.
- Frame, filter, pattern, theme and sticker identifiers come from existing built-in catalogues. Scene/material IDs also accept the curated asset registry. Recipes cannot declare URLs, source photos, room capabilities, SVG, HTML or executable fields. Text renders as literal text.

Validators reject unknown fields, accessors, sparse arrays, duplicate layer/slot IDs, missing or unused decoration declarations, nonfinite numbers and unsupported asset IDs. Validated values are detached and recursively frozen. JSON is limited to 64 KiB. Future schema JSON remains exactly preserved and read-only through `parseTemplateRecipe`; it is never coerced into the current schema.

`templateForNewProject` maps abstract roles in order to A–D only when explicitly starting a new project. It preserves source indices, crops and layers, and remaps companion roles and Together placements consistently. Applying to an existing project retains its role mapping and must check participant compatibility. Capture requirements freeze at first capture; applying a template cannot trigger remote captures.

## Local shelf

`openTemplateShelf(scope)` opens the independent `photobooth-templates-v1` IndexedDB. Device and account scope keys isolate list/load operations. The caller hides account rows on logout and fences asynchronous actions when the active account changes.

`save(recipe, decorations, expectedRevision)` validates/decode-checks every PNG before opening a transaction. Creation requires revision 0 with null expected revision; updates require the exact previous revision plus one. The revision comparison, recipe and all Blob writes share one transaction and are confirmed only on transaction completion. Quota/abort errors propagate. Concurrent writers cannot silently replace each other. Existing decoration IDs cannot acquire different bytes in one update. IDs can be replaced deliberately with a fresh identifier.

The shelf supports list, load, rename, duplicate, explicit delete and raw export. Unknown future/corrupt records remain read-only with exact raw manifest/Blob recovery. Duplicates receive a fresh ID and revision 0. There is no automatic eviction of templates or failed edits. Database open and individual transactions each time out after 10 seconds by default; a late database handle is closed.

`/templates` presents device and current-account shelves, 20 visible rows at a time, inline rename/deletion confirmation, duplication, recipe import/export and separate raw recovery downloads. Regular export starts with text excluded. Saving a current design waits for the exact project's retained editor queue and session writes before taking its snapshot. Explicit account-copy removal can call `removeLocalAccountTemplates`, which reports failed or future-version rows retained for recovery.

## Portable bundles

`exportTemplateBundle(recipe, blobs, { includeText: false })` removes account scope, blanks the caption default and every text layer, and retains geometry/style. Explicit `includeText: true` opts into text. Source photos and capabilities have no representable fields. PNG decoration pixels are intentionally included, so the user should choose decorations suitable for sharing.

The `.pbtemplate` format uses `PBTMPL\r\n`, a big-endian uint16 bundle version, uint32 manifest length and uint32 file count, followed by UTF-8 JSON. Each PNG entry contains a uint8 ID length, UTF-8 ID, uint32 byte length, 32-byte SHA-256 and the original PNG bytes. Import checks whole-file bounds before allocation, strict UTF-8, all declared lengths/IDs/counts, duplicate entries, integrity hashes and trailing bytes before native image inspection. Native decoding verifies actual PNG type and dimensions, rather than trusting headers alone. Unsupported versions reject import while asking the caller to retain the original file.

Import creates a fresh device-scoped recipe ID and revision 0. It preserves PNG bytes exactly and does not write IndexedDB until the entire bundle passes. Bundle and shelf imports use the same real image inspector as projects.

## Evidence

Focused Node tests cover strict data bounds, exact source requirements, split slices, privacy defaults, curated identifier validation, corrupt bundles, decoder errors, CAS decisions and late storage-open cleanup. Injected test inspectors do not prove browser decoding.

`runTemplateProbe()` in `lib/templates/probe.ts` is development-only and uses synthetic canvas PNGs plus a unique disposable database. It exercises native reload/hash preservation, two concurrent connections, quota rollback, account isolation, duplication, stale deletion, portable import/export and future-version recovery. The lab records its browser result separately. Device, cloud and physical print gates remain separate from these local checks.
