# P4 still and PDF export contract

Implemented locally on 23/09/2026. The export core borrows `ComposeInput` source/decorative canvases and ready asset handles. Callers prepare fonts, sticker images, curated assets and cutouts before export. Original media are never modified. The root Export Studio owns loading/error feedback, navigation cancellation and download links.

## Profiles and geometry

`lib/exports/profiles.ts` exports `STILL_PROFILES`, `PDF_PROFILES`, typed profile IDs and `ExportOptions`. `exportGeometry(sourceSize, profileId, options)` is the shared preview/export contract. Rectangles use top-left coordinates in pixels for screen profiles or millimetres for print. Each placement contains a nominal trim `tile`, inset `box` and uniform-scale `draw` rectangle. `contain` centres the whole composition with margins; `cover` centres and crops to the box. Neither stretches the composition to a new aspect ratio.

| Profile | Page/output | Default placement |
| --- | --- | --- |
| Original | Existing composition at bounded 2× scale | Preserve proportions |
| Story | 1080 × 1920 px | Contain |
| Square | 1080 × 1080 px | Contain |
| Wallpaper | 1080 × 1920 px | Cover |
| Print strip | 50.8 × 152.4 mm | One strip, contain, 2 mm inset |
| Print two-up | 101.6 × 152.4 mm | Two 50.8 × 152.4 mm strips, each with 2 mm inset |
| A4 contact sheet | 210 × 297 mm | Three full-size strips centred, 4 mm gaps, each with 2 mm inset |

Print strip/two-up `marginMm` controls each strip's content inset, from 0 to 10 mm. A4 `marginMm` controls the outer page safety requirement, defaults to 10 mm, and is bounded to 20 mm; its per-strip inset remains 2 mm. Optional cut marks stay within the physical paper. A single strip page is already the trim size, so it has no exterior marks. Two-up has two short centre seam marks; A4 has external corner marks. The PDF viewer preference requests actual-size printing (`PrintScaling.None`), but users must still check printer scaling and non-printable margins.

At 300 ppi, each physical strip tile is 600 × 1800 pixels. PDF pages use 72 points per inch: 144 × 432 points for a strip, 288 × 432 for two-up. A4 preserves the exact millimetre conversion, without rounding the page to bitmap pixels. All profiles reuse `compositionSize` and `composeStrip`. A4 is never allocated as a full-page bitmap.

PNG/JPEG exports declare pixel dimensions; browser-generated resolution metadata may remain 96 dpi. The exact physical size guarantee belongs to PDF placement, not the standalone image's metadata.

## API and resources

- `exportStill(input, stillProfileId, options)` encodes PNG by default, or JPEG with quality 0.1–1 (default 0.92). Browser MIME fallback, empty output and failed encoding reject instead of relabelling a file.
- `exportPdf(input, pdfProfileId, options)` lazily imports `pdf-lib` only on PDF export. It encodes one 600 × 1800 PNG tile and embeds that one image for every placement on the page. `pdfFromStripPng` is the bounded PNG-to-PDF seam tested with generated, subsequently decoded PDF files.
- `renderExportPreview(canvas, input, profileId, options, maxEdge = 1200)` uses the same placement and clipping function as export. The caller retains/releases its preview canvas; temporary source canvases are released immediately.
- Artifacts return `{blob,mime,extension,bytes,width,height,unit,geometry,resolution}`. Screen dimensions are pixels; PDF dimensions are millimetres. `resolution` includes per-source values and warnings.

Each transient canvas stays within 4096 pixels per edge and 12 MiPixels. Original output and intermediate raster scale are capped before allocation. Source media handles are borrowed, and temporary canvas backing stores are zeroed in `finally`. Stills use at most a bounded source plus output canvas; PDFs use a bounded source plus 600 × 1800 tile, release the source before PDF embedding, and reuse the encoded raster. These arithmetic surface bounds exclude browser/native decoder, fonts, PDF library, PNG buffers and GPU overhead; they do not establish total process memory usage. Encoded files are capped at 64 MiB.

Abort signals and a 30-second default job budget (configurable 1–120000 ms) reject pending encoding and library waits. Checks surround synchronous render stages. JavaScript cannot interrupt an already-running synchronous canvas draw or PDF compression operation; cancellation discards its result at the next check. Rejected native encoding may finish internally later. No worker or hard CPU deadline is claimed for still/PDF export. Navigation should abort and dispose the preview; retained originals remain available for retry.

## Effective resolution

`sourceResolution(input, geometry)` follows the compositor's selected source indices, per-cell cover fit, crop zoom, quarter-turn rotation, horizontal slices, split portrait cells, template companions and Together fallback behaviour. Ready Together groups use actual cutout dimensions and participant placement scale. Missing cutouts report the photo fallback actually drawn; missing photos produce an explicit placeholder warning. Mirror/translation do not add source detail. The report is capped by the intermediate raster's actual scale and expresses effective ppi for print or source pixels per output pixel for screens. Sub-percent rounding differences are reported numerically without a low-resolution warning.

Resolution is an estimate of sampling density, not sharpness, segmentation quality, visual contrast, printer colour or a guarantee of a good print. It covers photos/cutouts, not sticker/font/scene/PNG decoration sharpness. A high-resolution or enlarged flattened composition cannot restore missing source detail. Transparent cutout padding is counted as part of the decoded image, so this is canvas sampling density rather than a face-detail measurement.

## Evidence and remaining gates

Focused Node checks cover proportional fitting/cropping, physical dimensions, source zoom/rotation/slices/companions, resource bounds, cancellation/timeout and MIME mismatch. Generated PDF files are reloaded using `pdf-lib`; tests check page dimensions, actual image dimensions, one shared image object across repeated placements, drawing count and actual-size print preference. This is structural PDF/file evidence, not independent visual rendering or a physical print.

The native export probe also compares normalised solid-interior photo and margin pixels between the export preview and native-decoded PNG/JPEG output, across four still profiles and both contain/cover fits. Samples must match the fixture's expected colours as well as each other, with an eight-level channel tolerance for lossy JPEG. A Node test checks that every case includes photo samples and every contain case includes margin samples; only running the browser probe establishes native pixel results.

Native preview/download/decode parity, independent PDF viewer rendering, sustained memory observations, physical size/colour print samples, and iPhone/Android device acceptance remain separate checks. None is passed by these unit tests. The root agent records UI/native evidence separately.

Primary references: [pdf-lib PDFPage image/page API](https://pdf-lib.js.org/docs/api/classes/pdfpage), [pdf-lib viewer preferences](https://pdf-lib.js.org/docs/api/classes/viewerpreferences), [pdf-lib MIT licence](https://github.com/Hopding/pdf-lib/blob/v1.17.1/LICENSE.md), [canvas toBlob format and encoding behaviour](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob). Dependency version is pinned by the root task to `pdf-lib@1.17.1`.

## Per-project export preferences

On 23/09/2026, still and print preferences became durable `editor.exportSettings`: version 1, profile ID, fit, PNG/JPEG format, JPEG quality, margin in millimetres and cut marks. Validation rejects unknown keys/profiles/versions, non-finite or out-of-range values and accessor properties. ExportStudio edits use the existing project editor queue; preparation flushes the selected settings, and failed local saves remain visible in the dialog with the selected values available for retry. Undo/redo, project reopening and portable `.pbproject` backups preserve these settings. Temporary prepared files, browser sharing capability and motion encoder availability are not persisted.

New projects use manifest schema 4. Existing schema-3 manifests and frozen cloud-save journal requests retain their exact project payload, without silently adding defaults or changing request hashes. The default reader supplies prior export defaults when the field is absent. Saving the first export-settings edit explicitly upgrades that project to schema 4; v1/v2 imports retain their established migration to schema 3 until such an edit. Prior schema-3 readers recognise schema 4 as unsupported and retain a read-only raw backup instead of classifying its new editor key as corruption. Migration `028_v2_project_export_settings.sql` accepts both 3 and 4 without changing old receipts, scope gates or asset authority. Schema-4 cloud writes require its `exportSettingsVersion:1` capability.

Focused verification: 95 tests passed across export preferences, model, templates, portable bundles, cloud designs/save journal, editor queue and room recipes. The disposable PostgreSQL design suite passed schema-3 original save, schema-4 successor, exact old-request replay, current/previous identity, future-version denial and repeated migrations alongside existing ownership/CAS/retirement tests. Native export-dialog reload verification belongs to the integrated UI review; these focused checks do not establish provider or device acceptance.
