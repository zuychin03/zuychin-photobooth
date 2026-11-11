# Zuychin Photobooth V3 plan: strip variations

Status: approved by Duy on 11/11/2026, to be built P1 to P7 without pausing between parts.

## Wave summary

V3 started with the Liquid Glass redesign (`0026b3e`). This wave is the first V3 feature set. It adds more photo strip layouts, frame and finish styles, and caption and datestamp options. They reach the solo booth, live rooms of 2 to 4 people, relays, challenges and event guest photos.

Going in, there are 9 built-in layouts: 3 solo, 3 duo and 3 group. Each one is a uniform grid with a single cell aspect. A strip has 7 flat frame colours, a fixed bottom footer with a centred Fraunces caption, and an orange datestamp. Layouts are chosen in five places, and each one does it differently: tiles in `/booth`, a dropdown in the editor, rooms and challenges, and a list in `/relay/new`.

Non-goals:
- More than 4 photos per person in shared flows. The room server (`shotIds` 1 to 4), the relay table (`shots BETWEEN 1 AND 4`) and the challenge SQL (`sourceIndex ~ '^[0-3]$'`) all enforce it.
- New canvas fonts. Captions stay in Fraunces, Geist and Geist Mono (`lib/strip-fonts.ts`).
- The home page `StripMockup` fan. Duy prefers the original.
- Legacy v1 rooms (`components/rooms/LegacyRoom.tsx`). They keep the V2 catalogue, because v1 peers check plans against their own copy of it.

## Features in this wave

| Part | Features |
|---|---|
| P1 | Shared strip geometry: one function gives cell rectangles, owners and shot numbers to the renderer, exports, template conversion and editors. Existing layouts render pixel-identical. |
| P2 | 12 new layouts within 4 photos per person, the categorised layout picker in all five flows, and version-skew safety (project schema 5, recipe v2, template v2, migration `029`). |
| P3 | Solo cap raised from 4 to 8 photos: Six grid and Eight-cut. Imported photos are scaled to the per-shot budget. |
| P4 | Strip style: 3 deep and 3 gradient frames, photo finishes (Rounded, Keyline, Lifted), film sprockets, gap spacing, caption on top, one-line footer, datestamp on the photo, caption font and date format. Available in the editor, frame designer and rooms. |
| P5 | Exports: wide strips rotate onto portrait print tiles, and the resolution report uses the shared geometry. |
| P6 | Events: event look v2 lets hosts pick the new frames and strip style for guest and kiosk photos. |
| P7 | Visual QA on desktop and mobile in light and dark, plus docs, DESIGN.md and memory updates. |

## Decisions

Duy made these in kickoff, 11/11/2026:
1. **Every proposed layout is in.** Solo: Polaroid, Two-up, Square grid, Film row and the two feature layouts. Shared: Couple grid, Two film rows, the quick group shots and group side by side.
2. **No 4-photo cap for solo; the new cap is 8.** This adds Six grid (2×3) and Eight-cut (2×4). Shared flows stay at 4 per person.
3. **Categorised picker, grouped by shape.** Pick a category first, then a layout, so the control stays compact. It's one shared component in the booth, editor, rooms, relay and challenges.
4. **All four finish styles are in**: photo finishes, film sprockets, more frame colours and gap spacing.
5. **All four caption options are in**: datestamp on the photo, caption on top, one-line footer, and font and date format.
6. **Events are included**: hosts get the new frames and strip style for guest photos.

Engineering decisions that follow from these:
7. **Layouts become rows of cells, not a uniform grid.** Each layout lists rows. A row has one aspect ratio and a list of cells, and each cell has `owners` (one role, or several for a split frame) and a `shot` number. Cells in a row share its width equally. Row heights round to whole units, because template canvases must be whole numbers. The old `cols`, `rows`, `cellAspect` and `duoPattern` fields are removed, so the compiler finds every consumer. The current layouts are rebuilt with a `grid()` helper that gives the same numbers. Rejected: storing absolute rectangles per layout. It's harder to keep gaps and spacing consistent, and the row model already covers every layout in this wave.
8. **Shot numbers are explicit per cell.** Today shared layouts assume "each row is one synced round". Two film rows (round = column) and Quad grid (one round over two rows) break that, so `cellShotIndex` reads the cell instead.
9. **Group split frames generalise `AB`.** A split cell with N owners gives each person 1/N of the width. Duo `AB` keeps its current `[0.25, 0.75]` source slice, which is the same as a cover crop for 3:2 photos. Three-way and four-way splits cover-crop the full photo into each slice. The group split rows use wider cells (9:4 for three people, 3:1 for four), so every slice is 3:4, like the duo version.
10. **Strip style is one optional `strip` object**, on the project editor, on template `look` and on event looks. It's stored only when it differs from the default, so untouched projects stay at schema 4. It lives inside template `look`, not at the top level, because the challenge SQL rejects unknown top-level design keys (`004_v2_memories.sql`) but doesn't inspect `look`.
11. **Older clients degrade to read-only, never to a crash.** This follows the repo's existing pattern (export settings bumped projects to 4):
    - A project that uses a V3 layout, frame or strip style, or more than 4 solo photos, saves as schema 5. Older clients show it as read-only "unsupported".
    - Room recipes carry `schemaVersion: 2` when they use V3 features. Older peers get the existing "This shared design needs a newer version of the app" message.
    - Template recipes go to version 2 under the same rule.
    - Event looks go to version 2 when they use V3 frames or strip style.
    - Challenge designs have no version field. An old tab opening a V3 challenge fails validation and asks for a refresh. This is accepted.
12. **The server waits for the migration.** Saving a schema 5 cloud design or a v2 event look returns `unavailable` until the `029` capabilities report it. This copies the `exportSettingsVersion` check in `lib/server/project-design-store.ts:49`. A deploy without the migration keeps working for everything else.
13. **The 8-photo cap is solo only.** `sourcesPerParticipant` stays 4. A new `soloSources: 8` applies when the project has one participant. Templates allow source counts up to 8 only when role A is the only role, so challenge and postcard designs (always shared) stay at 4.
14. **The per-shot pixel budget scales with the shot count.** The project budget is 48 MP across all originals (`RESOURCE_LIMITS.totalPixels`). An imported photo is scaled to at most `min(12 MP, 48 MP / requiredShots)` before it's stored, which is 6 MP for Eight-cut. Without this, 8 phone imports would fail the quota, and 8 full-size canvases would use about 380 MB of memory on a phone. Camera captures are 1920×1080 (about 2 MP), so they're never scaled.
15. **The picker remembers nothing new.** It opens on the category of the current layout, and it hides categories that are empty for the flow.
16. **Rooms expose a compact subset of strip style**: Finish, Film edges and Date placement, as host dropdowns. Spacing, caption position, footer, font and date format are set in the editor and the frame designer. The shared recipe still carries the full `strip` object, so a room design started from a template keeps all of it.
17. **Templates ignore spacing.** A template's slots are fixed. Converting a project to a template bakes its spacing and band position into slot positions, and `look.strip.band` tells the renderer where to draw the caption band.
18. **The plan file is `V3_STRIPS_PLAN.md`**, so a later V3 wave can have its own plan without a name clash.

## Design

### Layout catalogue

Sizes are in strip units at Classic spacing: margin 28, gap 18, footer 132, and a 480-unit column. New entries are in bold.

| Id | Name | Mode | Category | Rows (aspect × cells) | Shots | Size |
|---|---|---|---|---|---|---|
| **`polaroid`** | Polaroid | solo | Single | 1:1 × 1 | 1 | 536 × 668 |
| **`strip2`** | Two-up | solo | Strips | 2 rows of 3:2 × 1 | 2 | 536 × 846 |
| `strip3` | Tall three | solo | Strips | 3 rows of 4:3 × 1 | 3 | 536 × 1304 |
| `strip4` | Classic strip | solo | Strips | 4 rows of 3:2 × 1 | 4 | 536 × 1522 |
| `grid4` | 2×2 grid | solo | Grids | 2 rows of 4:3 × 2 | 4 | 1034 × 926 |
| **`square4`** | Square grid | solo | Grids | 2 rows of 1:1 × 2 | 4 | 1034 × 1166 |
| **`grid6`** | Six grid | solo | Grids | 3 rows of 4:3 × 2 | 6 | 1034 × 1304 |
| **`cut8`** | Eight-cut | solo | Grids | 4 rows of 3:2 × 2 | 8 | 1034 × 1522 |
| **`film4`** | Film row | solo | Wide | 1 row of 3:4 × 4 | 4 | 2030 × 828 |
| **`feature3`** | Feature + two | solo | Feature | 3:2 × 1, then 3:2 × 2 | 3 | 1034 × 1178 |
| **`feature4`** | Feature + three | solo | Feature | 3:2 × 1, then 1:1 × 3 | 4 | 1034 × 1172 |
| `duo-alternate` | Taking turns | duo | Strips | 4 rows A / B / A / B | 4 | 536 × 1522 |
| `duo-twin` | Twin strips | duo | Strips | 4 rows of A B | 4 | 1034 × 1522 |
| `duo-split` | Side by side | duo | Together | 4 rows of one A+B frame | 4 | 536 × 1522 |
| **`duo-grid`** | Couple grid | duo | Grids | A B, then B A (3:2) | 2 | 1034 × 846 |
| **`duo-film`** | Two film rows | duo | Wide | A A A A, then B B B B (3:4), round = column | 4 | 2030 × 1486 |
| `trio` | Trio strips | group, 3+ | Strips | 4 rows of A B C | 4 | 1532 × 1522 |
| `quad` | Quad strips | group, 4 | Strips | 3 rows of A B C D | 3 | 2030 × 1184 |
| `quad-story` | Four-cut group story | group, 4 | Strips | 4 rows of A B C D | 4 | 2030 × 1522 |
| **`trio-split`** | Trio side by side | group, 3+ | Together | 4 rows of one A+B+C frame (9:4) | 4 | 1034 × 1982 |
| **`quad-split`** | Quad side by side | group, 4 | Together | 4 rows of one A+B+C+D frame (3:1) | 4 | 1034 × 1546 |
| **`trio-row`** | Trio row | group, 3+ | Wide | A B C (3:4), one round | 1 | 1532 × 828 |
| **`quad-grid`** | Quad grid | group, 4 | Grids | A B, then C D (4:3), one round | 1 | 1034 × 926 |

Where each layout appears follows from its mode and people count:
- Solo layouts appear in the booth and the solo editor.
- Duo layouts appear in rooms of 2, relays and 2-person challenges.
- Group layouts appear in rooms of 3 or 4, using the current rule that every member must have a cell, and in challenges whose count equals `minMembers`.
- Layouts with fewer than 4 shots can't hold a 4-step story, and the existing rules already disable stories for them.

### Layout picker (`components/LayoutPicker.tsx`)

- A `segmented` row of category chips (Strips, Grids, Feature, Wide, Single, Together), showing only the categories this flow has. Below it, tiles in `grid-cols-3`, or `grid-cols-2` in the 22rem room sidebar.
- Each tile shows a mini diagram drawn from the geometry, the layout name, and a meta line: "4 photos" for solo, or "4 rounds" / "1 round" for shared. In shared diagrams, each person's cells use a glyph tone: A rose, B violet, C amber, D sky. The selected tile uses today's booth treatment (`bg-accent/15` plus an inset accent ring). Buttons use `aria-pressed`, like `segmented`.
- It replaces the booth tiles (`app/booth/page.tsx:339`), the editor dropdown (`components/PhotoEditPanel.tsx:46`), the room host dropdown (`components/rooms/RoomWorkspace.tsx:170`), the relay list (`app/relay/new/page.tsx:215`) and the challenge dropdown (`components/cloud/ChallengeCreate.tsx:61`). Disabled states and story locks carry over.
- Glass stays off the picker, since it's content inside panels.

### Strip style (`strip` object)

| Field | Values (default first) | What it draws |
|---|---|---|
| `finish` | `classic`, `rounded`, `keyline`, `lifted` | Square photos. Rounded clips each photo to a 6% radius. Keyline draws a 2-unit ink line 4 units outside each photo. Lifted adds a soft shadow under each photo. |
| `sprockets` | `false`, `true` | Rounded 14×20 holes at a 36-unit pitch along the long edges, in the ink colour at 85%. Those edge margins grow to at least 40. |
| `spacing` | `classic` (28/18), `tight` (16/8), `airy` (44/30) | Margin and gap. Ignored by templates. |
| `band` | `bottom`, `top` | Where the caption band sits. The strip size doesn't change. |
| `footer` | `stacked`, `inline` | Stacked keeps today's 132-unit band. Inline puts the caption on the left and the date on the right in an 84-unit band. |
| `date` | `band`, `photo` | Photo puts the orange datestamp in the bottom-right corner of the last cell, sized to 8% of its height. |
| `font` | `serif`, `sans`, `mono` | Fraunces, Geist or Geist Mono for the caption. |
| `dateFormat` | `dots`, `film`, `long` | 11·11·2026, '26 11 11 or 11 Nov 2026. |

New frames (`lib/decor.ts`). A frame can have an optional `gradient`, painted top-left to bottom-right:
- Deep: Cherry `#be123c` with ink `#fff1f2`; Midnight `#1e293b` with ink `#e2e8f0`; Kraft `#c8a27a` with ink `#3b2a1a`.
- Gradient: Peach sunset `#fecaca → #fde68a` with ink `#7c2d12`; Lilac haze `#ddd6fe → #fbcfe8` with ink `#4c1d95`; Sea glass `#a7f3d0 → #bae6fd` with ink `#134e4a`.

Where the controls go:
- **Editor (`app/customize/page.tsx`).** "Frame & look" gains the new swatches (gradient ones show the gradient) and three controls: "Photo finish" (Classic, Rounded, Keyline, Lifted), a "Film edges" switch and "Spacing" (Tight, Classic, Airy). "Caption & date" gains four: "Position" (Bottom, Top), "Footer" (Stacked, One line), "Date" (In footer, On photo) and "Font" (Serif, Sans, Mono), plus a date format choice. Labels use the UI font, per DESIGN.md, which keeps canvas fonts out of the UI.
- **Frame designer (`app/templates/design/page.tsx`).** The look panel gets the same controls except Spacing.
- **Rooms.** The host gets Finish, Film edges and Date dropdowns (decision 16).
- **Event host form (`components/events/EventHostForm.tsx`).** Everything except Spacing goes in a "Strip style" group.
- **Copy.** Minimal labels, no explanatory subtitles. Spelling is "colour". Write `&apos;` in JSX text.

## Data model changes

All changes are additive. Untouched data stays valid as it is, and no rows are rewritten.

- **`lib/layouts.ts`.** Adds `LayoutCategory`, `LayoutRowSpec`, `LayoutCellSpec` and `CellRect`, a `legacy` flag on V2 entries, and the geometry function `stripGeometry(layout, strip?)`. That function returns the width, height, margin, gap, cells, band rectangle, band edge and sprocket edges. It also keeps `getLayout`, `cellShotIndex`, `stripSize` and `layoutsForMembers`. `layoutsForMembers` returns legacy layouts only, so legacy rooms keep the V2 set.
- **`lib/projects/model.ts`:**
  - `PROJECT_SCHEMA_VERSION = 5`, and `validatePhotoProject` accepts 3 to 5.
  - The editor gets an optional `strip`, allowed at schema 5 or above.
  - Solo `requiredShots` is 1 to 8, and solo `sourceOrder` holds up to 8.
  - Cell edit `sourceIndex` is 0 to 7, checked against the role's own source count.
  - `update()` sets schema 5 when `requiresStripV3(editor, sources)` is true.
- **`lib/templates/model.ts`.** `TEMPLATE_SCHEMA_VERSION = 2`, and recipes 1 and 2 both parse. `look.strip` is optional and allowed only in v2. A solo-only design allows `requiredSources` and `sourceIndex` up to 8.
- **`lib/rtc/recipe-v2.ts`.** `SHARED` gains `strip`. Recipe `schemaVersion` is 1 or 2, and 2 is emitted only when the recipe uses V3 features.
- **`lib/events/host-contract.ts`.** `EventLook` is v1 or v2. v2 adds `strip` and allows the new frame ids.
- **`database/migrations/029_v3_strip_variations.sql`.** Idempotent: it only replaces functions and changes no data.
  - `pb_project_design_capabilities()` adds `'stripVersion',1`.
  - `pb_project_design_save()` accepts `schemaVersion` `'3'`, `'4'` or `'5'`. The rest of the body is copied from `028`.
  - `pb_event_valid_look()` accepts today's v1 rules unchanged. It also accepts v2: the v1 keys plus `strip`, with frame ids extended by `cherry`, `midnight`, `kraft`, `peach`, `lilac` and `seaglass`, and the `strip` keys and values from the table above. The `pb_event_safe_look` check calls this function, so the constraint updates without being dropped.
  - A new `pb_event_look_capabilities()` returns `{version: 1, lookVersion: 2}`. It is separate from `pb_event_host_capabilities()`, because hosts check that function for an exact key set, so adding a key there would break the live app before the deploy.
- **Sibling apps.** Gallery reads `pb_strips.layout_id` as text and doesn't render by layout, so nothing changes there. `pb_relays` and `pb_strips` need no change, because `layout_id` is free text and `shots` stays 1 to 4 for relays.

## Routes and API changes

- No new routes.
- `PUT` of cloud project designs refuses schema 5 with 503 `unavailable` until `stripVersion` is 1. Event settings saves refuse a v2 look the same way until `pb_event_look_capabilities()` reports `lookVersion` 2. A look is saved as v2 only when it uses a V3 frame or a non-default strip, so plain looks stay v1.
- Existing deep links, saved projects (schema 3 and 4), templates (v1), room recipes (v1), relays and challenges keep working unchanged.

## Environment and services added

None.

## Part plan

Each part ends with `npm run check` passing (typecheck, lint, tests) and a short report to Duy.

**P1. Shared geometry (riskiest, no visible change)**
- Rework `lib/layouts.ts` into rows of cells, add `stripGeometry`, and rebuild the 9 existing layouts with `grid()`.
- Move every cell-math consumer onto the geometry:
  - `lib/compose.ts` (cell loop, footer, together cells, split cells)
  - `lib/exports/geometry.ts` (`sourceResolution`)
  - `lib/templates/from-project.ts`
  - `components/PhotoEditPanel.tsx`
  - `components/rooms/RoomWorkspace.tsx` (`ownCells`, `roomLayouts`, `hasEmptyRoles`)
  - `app/booth/page.tsx` (preview aspect)
  - `lib/events/guest-photo.ts` (single-cell layout)
  - `components/rooms/LegacyRoom.tsx`
- Verify: the existing `tests/composition.test.ts` fixtures pass without changes, which proves pixel-identical positions and sizes. A new `tests/strip-geometry.test.ts` checks that cells stay inside the canvas without overlapping, that shot numbers map correctly, that every row adds up to the content width, and that `grid()` matches the old formula for all 9 layouts.

**P2. Catalogue, picker and version skew**
- Add the 12 new layouts that stay within 4 photos per person. Six grid and Eight-cut follow in P3.
- Generalise split cells to N owners in compose, the template conversion (slots with companions plus `splitFallback` in scene mode) and the resolution report.
- Build `LayoutPicker` and fit it into the booth, editor, rooms, relay and challenges.
- Add the legacy filter for v1 rooms.
- Add project schema 5, recipe v2 and template v2, with their `requires…` checks.
- Add migration `029` and the server capability check.
- Verify:
  - Composition fixtures for every new layout (size, cell rectangles, owner and shot per cell).
  - Project model tests: schema 5 only when needed, and v3 and v4 still parse.
  - Recipe tests: v2 only when needed, and a v1 peer gets `update_required`.
  - `challengeLayouts` and `challengeDesign` produce valid designs within 16 slots for 2, 3 and 4 people.
  - `validateRelayMeta` accepts the new duo layouts.
  - Template round trips for the split and feature layouts.
  - A visual check of the picker in each flow.

**P3. Solo up to 8 photos**
- Add `soloSources: 8`, the project and template rules from decision 13, and `session.importShot` bounds of 0 to 7 for solo.
- Scale imports to the per-shot budget (decision 14).
- Booth: 8 thumbnails in the existing `grid-cols-4`, and the preview aspect follows the next empty cell.
- Editor: "Photo in this slot" lists the role's real source count.
- Add `grid6` and `cut8`.
- Verify:
  - Project model tests: solo 8 is valid, shared 5 is rejected, and the media budget holds with 8 scaled imports.
  - Composition fixtures for `grid6` and `cut8`.
  - Booth capture and retake of 8 shots with the stubbed camera.
- Coordination: another agent is editing `lib/session.tsx` and `lib/projects/images.ts` right now. These edits are exact-match and made after re-checking `git status`.

**P4. Strip style**
- Add the `strip` type, defaults and normalisation.
- Compose: gradient frames, finishes, sprockets, spacing, band position, inline footer, date on photo, fonts and date formats.
- Add the new frames to `lib/decor.ts`.
- Add the controls in the editor, frame designer and room host sidebar.
- Templates carry and apply `look.strip`. Applying a template resets `strip` to the template's value.
- Verify:
  - Compose tests with a recording canvas for each finish, the sprocket edges (tall vs wide), spacing sizes, band top/bottom, inline footer, date on photo, and each font and date format.
  - Default `strip` leaves the output identical to P2.
  - Visual check in the editor.

**P5. Exports**
- In `lib/exports/geometry.ts` and `still.ts`, PDF placements rotate a landscape source 90° into portrait tiles (Strip, Two strips, A4 contact). Still profiles don't rotate. Built rule: a placement turns only when the turned fit covers at least 1.5× the area of the level fit, so a near-square layout such as a 2×2 grid stays level in a two-up sheet.
- The resolution report uses the geometry for feature, split and wide cells.
- Check that photo loops and GIFs handle 8 shots.
- Verify: tests in `tests/export-geometry.test.ts` and `tests/export-pdf.test.ts` for rotation and for the resolution of feature and split layouts. Export a wide strip and an Eight-cut to PDF and PNG in the browser.

**P6. Events**
- Add event look v2 to the contract, the server store's capability check and the host form.
- `prepareEventGuestPhoto` applies the strip style. Kiosk photos use the same path.
- Verify: event look tests (v1 unchanged, v2 valid and invalid cases), guest photo composition with each option, and the host form in the UI fixture.

**P7. Finish**
- Visual QA of every picker and of rendered strips, desktop and mobile, light and dark, including booth mode.
- Update DESIGN.md (picker, strip style controls), `CHANGELOG.md`, `ROADMAP.md`, `README.md` (layout list), and the project memory.
- Bump the version in `package.json`, which still says 2.0.0. Duy confirms the number.

## Activation checklist

| Step | Owner | Status |
|---|---|---|
| Run `database/migrations/029_v3_strip_variations.sql` in the Supabase SQL editor. It only replaces functions and changes no data, so no dump is needed. Run it before or after the deploy. | Duy | Pending |
| Check that `select public.pb_project_design_capabilities()` shows `stripVersion: 1` and `select public.pb_event_look_capabilities()` shows `lookVersion: 2`. Both are service-role functions, so run them as the SQL editor owner. `pb_event_host_capabilities()` is unchanged. | Duy | Pending |
| Deploy with `deploy/deploy.sh` to the Oracle VM. Never deploy to Vercel. | Duy | Pending |
| Smoke test in production: save an Eight-cut project to the cloud; create a room of 2 with Two film rows; save an event look with a gradient frame and a finish, then take a kiosk photo. | Duy | Pending |

## Build notes (11/11/2026)

All seven parts are built and uncommitted. Duy chose version 3.0.0 (`package.json`, `package-lock.json` and the `CHANGELOG.md` heading). Changes from the plan above:

- **Picker glyphs use whole device pixels.** Duy saw tiles touching and uneven gaps, so `LayoutGlyph` lays out cells in device pixels with one gap (at least 2 px) for every row, column and split slice. `tests/strip-flows.test.ts` checks every layout at 40 and 48 px boxes and pixel ratios 1 to 3.
- **Event look capability.** `pb_event_look_capabilities()` replaces the planned `lookVersion` key on the host capabilities (see Data model changes).
- **Export rotation threshold.** Turn only when it gains 1.5× the area (see P5).
- **Four-cut story only for 4-photo layouts.** Duy asked for the story panel to show only when the layout takes 4 photos per person. The solo booth checks `requiredShots === 4`; rooms check the layout's shots, or that every template role takes 4. The TogetherEntry preview still shows every story, and its "Pick a story in the solo booth" link lands without the panel when the booth layout isn't 4 photos.
- **Not checked in the browser:** the export studio preview of a wide strip and an Eight-cut. Rotation and its painting are covered by `tests/export-geometry.test.ts`.

## Deferred

- More than 4 photos per person in shared flows. It needs the room server, relay table and challenge SQL to change together.
- A 3×3 nine grid (solo cap 9). Duy chose 8.
- New canvas fonts (for example a handwritten caption) and die-cut or scalloped edges.
- A 4×6 postcard PDF profile for square and wide layouts. It fits the existing "print-ready export" backlog item.
- New layouts in legacy v1 rooms.
