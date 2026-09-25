# V2 codebase audit and planning verification

Inspected 22/09/2026. Repository: `C:\Users\kduy1\OneDrive\Desktop\Projects\zuychin-photobooth`. Branch: `main`. Commit: `6fd2387`. Working tree was clean before the planning artefacts were added. One worktree was listed. No existing files were edited during planning.

This is a source review and baseline static check, not a production security assessment or a claim that the failure scenarios below occurred in production. Live configuration, hosted schema, provider quotas, remote CI and real-device behaviour were not verified.

## Sources and authority

Read the root README, local ROADMAP/CHANGELOG, local handoff, applicable repository instructions, project/development notes, package scripts, selected generated wiki pages and relevant application modules. Read the installed Next.js route-handler guide before specifying route changes. Historical notes and generated wiki claims were checked against actual source where the plan depends on them.

The local changelog documents `0.13.0`; `package.json:3` still says `0.1.0`. The latest commits include brand geometry and wiki changes. Neither number proves what is currently deployed. The new plan proposes `2.0.0` as the V2 release target, with version reconciliation first.

## Current capability map

| Area | Confirmed source capability | Main source |
| --- | --- | --- |
| Framework | Next.js 16.2.10, React 19.2.4, TypeScript, Tailwind v4 | `package.json` |
| Solo capture | Camera/upload path, mirrored capture, fixed countdown, three/four shots, front/back switching, video requested without audio | `app/booth/page.tsx`, `lib/camera.ts:15`, `hooks/useCamera.ts` |
| Geometry | Eight layouts across solo, duo and group modes | `lib/layouts.ts:34` |
| Editing | Six filters, seven frame colours, six themes, seven patterns, captions/date, 64 stickers in three styles with transforms | `app/customize/page.tsx:64`, `lib/decor.ts`, `lib/themes.ts:34`, `lib/patterns.ts:53` |
| Rendering | One Canvas composition path used for preview and 2x PNG export | `lib/compose.ts:140`, `lib/compose.ts:263` |
| Rooms | Four-role P2P mesh, clock offset samples, capture plan, chunked full-resolution JPEG exchange | `lib/rtc/engine.ts:10`, `lib/rtc/engine.ts:309` |
| Together | Six procedural backgrounds, bundled segmentation model, local live cutout, final multi-person composition | `lib/scenes.ts:37`, `lib/live-preview.ts:18`, `lib/segmentation.ts` |
| Accounts | Optional auth/pairing, saved strips, asynchronous duo relay, photo dates, push and weekly recap | `lib/couple.ts`, `lib/relay.ts`, `app/timeline/page.tsx` |
| Retention | Current ISO-week vault, client-side ten-strip count, keep/archive via optional Cloudinary | `lib/retention.ts:12`, `app/customize/page.tsx:359`, `app/api/retention/route.ts` |
| Offline | Production service worker caches visited routes/assets; development unregisters it | `public/sw.js:39`, `components/PwaRegister.tsx` |
| Existing checks | Typecheck, lint, build scripts and seven branding tests | `package.json:5`, `scripts/brand-assets.test.cjs` |

## Documentation drift affecting planning

- README's Together description can be read as a live shared canvas. The live room paints the local participant only; peers remain separate ordinary video panes (`lib/live-preview.ts:43`, `app/room/[code]/page.tsx:150`, `app/room/[code]/page.tsx:423`). The final multi-person composite does exist.
- The PWA is already implemented but remains in ROADMAP's backlog. Offline assets do not imply durable unfinished photographs.
- ROADMAP and older handoff reference `SUPABASE_SETUP.md`, which is absent. Current setup instructions are in README and `supabase-setup.sql`.
- Old notes describe rolling seven-day retention. Current source clears at the ISO-week boundary (`lib/retention.ts:15`).
- The generated wiki's testing discussion is not an installed Jest/Vitest/Playwright suite. No app test script or `.github` workflow directory was found. This repository does have branding tests, so describing it as having no tests would now be inaccurate.
- `CHANGELOG.md`, `ROADMAP.md`, local handoffs and granular `/supabase/` migrations are ignored. New release plans and future migration artefacts must have tracked paths rather than relying only on those local files.

## Findings that gate the larger update

| Priority | Source-level finding | Evidence | Required response |
| --- | --- | --- | --- |
| P0 prerequisite | Stored strip/object access follows the owner's current partner broadly, regardless of an individual strip's `couple_id`. Reusing those paths would expose new personal/event material to that audience. | `supabase-setup.sql:219`, `supabase-setup.sql:299` | Separate personal/friend/event scope records and private buckets; cross-scope row/object tests; preserve existing Gallery reads. |
| P1 high | Cron authentication only rejects a mismatch when `CRON_SECRET` exists. A service-role deployment without the secret can perform privileged work without authentication. | `app/api/retention/route.ts:26`, `app/api/reminders/route.ts:36` | Missing secret disables execution. Verify unauthorised and misconfigured requests cause zero mutations or delivery. |
| P1 high | Retention does not check several database/storage mutations and can remove an original after an unchecked archive-reference update. | `app/api/retention/route.ts:80`, `app/api/retention/route.ts:94`, `app/api/retention/route.ts:109` | Durable state transitions, checked errors, retries and reconciliation; failure injection before deletion. |
| P1 high | Uploads precede row writes; relay deletion removes only the row; strip deletion does not fully remove Cloudinary media. | `lib/couple.ts:80`, `lib/couple.ts:135`, `lib/relay.ts:61`, `lib/relay.ts:107` | Upload intents/finalisation, orphan cleanup, relay TTL and deletion across every storage destination. |
| P1 high | Host designation and received roster identities do not constitute authenticated room admission. | `app/room/[code]/page.tsx:103`, `lib/rtc/signaling.ts:29`, `lib/rtc/engine.ts:225` | Host/member capabilities, message validation, waiting/lock and explicit room lifetime. |
| P1 high | RTC lacks capture/session correlation, acknowledged transfer recovery and buffered-amount backpressure; parses control JSON without a guarded protocol schema. | `lib/rtc/engine.ts:335`, `lib/rtc/engine.ts:373` | Protocol v2, bounded transfer limits, IDs, acknowledgements, timeouts and retry/recovery. |
| P2 medium | Any connected peer can make aggregate status connected; disconnection removes peers immediately; simultaneous arm events can overlap. Missing frames reach editor after a fixed timeout. | `lib/rtc/engine.ts:140`, `lib/rtc/engine.ts:160`, `app/room/[code]/page.tsx:177`, `app/room/[code]/page.tsx:242` | Per-peer readiness, one committed capture, duplicate suppression and incomplete-session recovery. |
| P2 medium | Captures and editor settings exist in React state, so refresh loses them. The date stamp is regenerated at render time. | `lib/session.tsx:6`, `lib/session.tsx:47`, `app/customize/page.tsx:64`, `lib/compose.ts:238` | Versioned local projects, encoded source blobs, deterministic capture timestamp, schema migration and quota handling. |
| P2 medium | Weekly cap is a client-side count, not atomic server enforcement. | `app/customize/page.tsx:359`, `supabase-setup.sql` | Transactional count/byte reservation and idempotent finalisation. |
| P2 medium | Week/recurrence depends on runtime timezone; streak calculation reads media filtered to exclude purged history. | `lib/streak.ts:39`, `lib/photo-dates.ts:15`, `lib/couple.ts:102`, `app/timeline/page.tsx:100` | Explicit IANA timezone, fixed expiry semantics, activity history independent of media retention. |

These findings were deliberately not fixed in a planning-only task. The [implementation plan](../../V2_PLAN.md) schedules them before features amplify their impact.

## Feasibility constraints

**Projects:** persistent state must contain serialisable recipes and encoded Blob media, not `HTMLCanvasElement` objects. Account scope, local-only status and quota errors must be explicit. A local draft is not an off-device backup.

**Print:** the current classic strip is 536 x 1522 logical pixels, exported as 1072 x 3044 at 2x. It is not exactly a 1:3 strip. A physical 50.8 x 152.4 mm strip at 300 pixels per inch is 600 x 1800. New physical templates or honest fit/margin choices are required, followed by real printing checks.

**Motion:** there is no encoder/recorder subsystem. One 1920 x 1080 RGBA frame occupies about 8.3 MB; sixteen frames alone total about 133 MB before additional render/cutout copies. Record bounded encoded chunks and progressively decode, rather than holding raw video frame arrays. Browser/device codecs and low-memory behaviour need a prototype.

**Scenes:** `SceneDef.draw` is currently synchronous. Raster scenes need preloading, versioned asset metadata, crop rules and procedural fallbacks. Generated files are planning sources until the renderer, picker and cache integration exists.

**Events:** many guest capture sessions can feed a gallery without expanding the RTC mesh. Event membership and consent must remain separate from couple pairing. Anonymous participation, host auth, personal receipts, gallery viewing and display access are different permissions.

## Checks performed during planning

| Check | Result | What it proves |
| --- | --- | --- |
| `npm run typecheck -- --incremental false` | Passed | Current source satisfies its TypeScript check; no build/runtime claim. |
| `npm run lint` | Passed | Existing ESLint configuration passed on the baseline plus documentation-only additions. |
| `node --test scripts/brand-assets.test.cjs` | Initial launcher blocked by `spawn EPERM` | The sandbox prevented the test runner's subprocess launch; this was not an assertion failure. |
| `node scripts/brand-assets.test.cjs` | Passed, 7/7 | The same node:test file ran directly and all seven branding assertions passed. |
| Image output inspection | 24 selected PNGs inspected: eighteen 1536 x 1024 scenes and six 1254 x 1254 materials | Source dimensions verified; copied originals match their generation outputs by SHA-256. Visual review covers scene composition and material appearance. No real-person cutout integration test. |
| Asset catalogue | Category filters, crop previews and asset details checked in the local browser | The standalone planning catalogue makes all 24 originals reviewable. It does not exercise the application renderer or segmentation. |
| Planning artefact validation | Passed for all four Markdown files; 22 unique feature IDs and P0-P9 in order | Local links resolve, LF endings, no conflict markers/trailing whitespace, balanced fences and coherent feature/part identifiers. |
| Production build / app runtime / physical devices | Not run in this planning task | No claim of current browser or deployment acceptance. |
| Hosted Supabase / Cloudinary / TURN / email / push / remote CI | Not exercised | Configuration and production behaviour remain unverified. |

Created files are the plan, market research, this audit, asset manifest, 24 selected generated images, their provenance records and a standalone HTML catalogue. The original three-scene set was expanded after the user authorised generous asset generation without a credit constraint. No application source, pre-existing docs, database or configuration was changed. Nothing was staged, committed, pushed or deployed.

## Independent plan review

Two reviewers checked the completed proposal against the source and event research. Their actionable findings were incorporated: all-path quota enforcement, distinct upload/read token lifetimes, a V2-compatible rollback build, contributor-level publication consent, explicit account-free signalling feasibility, separate delivery/moderation states, bounded closure grace, kiosk cleanup, anchored expiry and moderator delegation without ownership transfer. These are plan improvements, not implemented fixes.

## Final request coverage audit

Rechecked on 22/09/2026 against the current worktree. The requested outcome is inspection, market research, brainstorming, a V2 plan and useful generated assets. The implementation parts and release gates in that plan are future work, not claims of completed development.

| Requested outcome | Evidence inspected | Conclusion |
| --- | --- | --- |
| Understand the existing code and docs | README/package versions, source references and capability/risks tables above; current Git state remains `main` at `6fd2387` | Source-grounded understanding documented; documentation drift and unverified deployment state are explicit. |
| Deep research of comparable apps | [Market report](V2_MARKET_RESEARCH.md), eleven consumer/adjacent and seven event products, first-party source register, price qualifications and evidence limitations | Broad competitive workflow comparison completed. Fresh focused rechecks of five consumer and three event sources supported the retained claims. |
| Brainstorm essentials and distinctive additions | [Plan sections 1-3](../../V2_PLAN.md), C1-C7, T1-T8 and E1-E7; research triage and validation experiments | All three requested audiences covered by 22 feature groups. Differentiation is labelled as a hypothesis and has a comparative validation task. |
| Make this a substantial V2 | Target `2.0.0`, proposed architecture/data/routes/design, P0-P9, dependencies, acceptance and activation/rollback sections | One coherent major-version plan exists. No track is silently reduced to a later version. Approval and implementation remain separate. |
| Generate useful image assets without a credit constraint | [Asset manifest](../assets/v2/ASSET_MANIFEST.md), index/provenance records, selected PNGs and catalogue | 24 selected originals exist: eighteen scene backdrops and six materials. Copies match generation sources; further variants are explicitly permitted as needed. |
| Make the result reviewable | [Visual catalogue](../assets/v2/catalogue.html), exact prompts, crop limits and source/delivery distinction | Local browser checks covered category filters, crop controls, composition guide and detail opening/closing. Application compositing and delivery optimisation remain implementation gates. |
| Preserve the repository and authority boundaries | Current Git diffs, staged diff and status | Only new planning/asset artefacts are present. Existing application files remain unchanged; nothing staged, committed, pushed or deployed. |

The final source review found one dependency-wording inconsistency, now corrected: P4/P5 may run in parallel after P3. Domain rechecks added friendship-group validation and matched competitor/current-workflow tasks, removed the obsolete small-catalogue restriction, separated gallery and wall publication grants, and accounted for two-hour staging reservations coexisting with delivery copies. Bounded rereviews confirmed the consumer and event corrections. The consumer researcher rechecked their own original work; that pass is source verification, not an independent-authorship review.

Planning is complete at this evidence level. Remaining unknowns are explicitly assigned to P0, implementation acceptance or beta validation: actual device/codec/segmentation performance, cross-network recovery, hosted quotas and policies, physical print output, observed user preference and willingness to pay. No claim of production readiness or demonstrated market advantage is made.
