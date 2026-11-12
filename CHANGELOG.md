# Changelog

## Security fixes (unreleased)

- Partner push notifications only go to the push services the subscribe path already accepts, and give up after 10 seconds.
- `/api/push/notify` refuses requests from other origins, like the V2 routes. It needs `PB_PUBLIC_ORIGIN`, which the deploy env already sets.
- The shared session cookie is `Secure` whenever `NEXT_PUBLIC_COOKIE_DOMAIN` is set.
- The magic-link form gives the same answer for every address, so with Supabase sign-ups off it no longer shows who has an account. Open installs still create the account on first sign-in.
- `deploy/` is gitignored.

## 3.0.0 (unreleased, V3 strip variations)

- Layouts are rows of cells with one shared geometry (`stripGeometry`) used by compose, templates, exports and rooms. The nine V2 layouts render pixel-identical.
- Added 14 layouts: Two-up, Square grid, Feature + two, Feature + three, Film row, Polaroid, Six grid and Eight-cut for solo; Couple grid and Two film rows for duos; Trio and Quad side by side, Trio row and Quad grid for groups. Rooms opened by V2 clients keep the V2 set.
- A shared `LayoutPicker` (shape categories plus whole-pixel mini diagrams) replaces the booth tiles and the editor, room, relay and challenge lists.
- Solo projects take up to 8 photos. Imports scale to `min(12 MP, 48 MP / shots)` so eight imports stay within the project budget. Shared flows stay at 4 per person.
- Strip style: photo finishes, film edges, spacing, caption band position, one-line footer, date on the photo, caption font and date format, and six new frames (three gradients). Stored only when it differs from the default, so untouched projects stay at schema 4.
- Version skew: project schema 5, template schema 2, room recipe v2 and event look v2 are written only when a V3 feature is used. Cloud design saves and v2 event looks return `unavailable` until migration `029` reports support.
- PDF exports turn a landscape strip 90° into portrait tiles when that fits at least 1.5× more area.
- The four-cut story guide shows only for layouts that take 4 photos per person.
- A strip can print a chosen date instead of the day it was taken. The date is stored as `stripDate` and needs project schema 5.
- The README is rewritten for V3, with a new self-hosting guide, contributing guide, security policy, code of conduct and GitHub issue and pull request templates.
- Upgrading: apply `database/migrations/029_v3_strip_variations.sql`, then deploy. It only replaces functions.

## V2 release (29/09/2026)

- Challenges are on in production, with the final event wording (`2fe553d`).

## Notification fixes (29/09/2026)

- Unsupported browser push endpoints are rejected before a subscription is saved, and notifications show as on only after the saved subscription is checked (`9443567`).
- Registration and removal failures stay visible in a keyboard-accessible bell menu, with retry and turn-off actions. Existing unsupported subscriptions can still be managed.
- Event and ritual workers check push endpoints before recording a dispatch and carry on with other supported targets.

## Reminder loading (29/09/2026)

- The first event reminder read retries when a conflicting host action interrupts it. Ambiguous saves and access failures still need an explicit retry (`7eff723`).

## Load-check harness (29/09/2026)

- Added `scripts/deployment-load-harness.mjs`, a bounded HTTP scenario runner. It defaults to a dry run and needs an explicit flag for remote runs, with request, time and byte limits (`2916755`).

## Archive reads and cleanup (29/09/2026)

- Signed and unsigned Cloudinary archive paths are both accepted, with fresh provider metadata still checked (`4d111f0`).
- Storage absence checks skip stale cached responses. Ordinary reads are unchanged (`7cfe30f`).

## Shorter copy and relay diagnostics (29/09/2026)

- Shorter interface wording that keeps the privacy, withdrawal and data-loss guidance (`bd7d6ff`).
- Added a development-only relay diagnostic that shows each peer's transport state. The route is unavailable in production.

## Online recovery and mobile refinements (28/09/2026)

- Event grants are checked against server-issued time and elapsed time, and older request shapes still work. Guest missions refresh with event context without changing frozen choices (`5643ff3`).
- Added `PB_RELEASE_MODE=recovery`. It keeps authorised reads, exports, accepted finalisation and safe maintenance, and refuses new allocations and sharing (`e55a4bb`).
- Ended rooms stay closed during late refreshes, and pending original-photo recovery is kept (`1f29425`).
- Refined mobile selection styling, aligned sheet headers, spaced the project footer and made every mobile navigation item reachable (`b4f2f97`, `f8e3738`, `791504a`, `1eae45d`, `684969a`).

## Mobile capture and selected retakes (28/09/2026)

- Capture actions sit directly below the preview, and secondary mobile controls are grouped in sheets. Desktop settings stay inline, with keyboard focus recovery.
- Retake selected shots, or replace them with an import of the same count, in both capture styles. Other photos and the design are kept.
- Shared hover, press, focus and popup feedback, with reduced-motion support. Improved cloud upload controls and event confirmation dialogs.

## Together restoration (26/09/2026)

- The Together create and join flow is back in the friends release. Home and Together use legacy room codes and invitations. Accounts stay off, and cross-device rooms use the existing Realtime and TURN settings.
- V2 room links and APIs stay behind Feature incoming with the other unfinished online features. Server and client gates tell legacy invitations apart from V2 queries, including duplicate query parameters.
- Fixed the Together join form overflowing narrow screens.

## 2.0.0 (25/09/2026, friends release)

Limited release of V2's local creation tools. The full V2 implementation covers Create, Together and Events; online features stay behind Feature incoming until their separate activation and acceptance.

- Production defaults to `PB_RELEASE_MODE=local`: solo capture, editing, exports, device projects and templates remain available without database setup. Shared incoming views and server checks block new online work while preserving existing private receipts, authenticated maintenance and locked-kiosk recovery. Previously stored cloud media still requires compatible schema and retention services.
- Shared navigation uses the app's two-colour wordmark, a sticky desktop pill and a floating mobile bar with icons and labels. Account controls stay hidden in the friends release.
- Release checks passed 1,147 tests, TypeScript, scoped lint, an isolated production build, 43 HTTP checks and desktop/narrow browser navigation.

- Durable local projects with original-photo recovery, undo/redo, per-photo editing, portable backups and reusable template recipes with bounded custom layouts and decorations.
- Eighteen generated scenes and six materials, favourites and explicit offline pack downloads, guided English photo stories, flexible retakes, camera settings and capture feedback preferences.
- Export Studio with prepared PNG/JPEG sizes, exact-size print PDFs, solo GIF/video motion and Then & Now comparisons.
- Optional two-to-four-person rooms with admission/readiness controls, original-photo exchange and recovery, shared scene previews, director turns and collaborative finishing. Remote group motion remains deferred.
- Optional private cloud designs and reciprocal challenges, chapters and annual memories, timezone-aware rituals and private voice captions with a text alternative.
- Optional event hosting, QR contributions and private receipts, separate gallery/wall consent, moderation and reports, protected kiosk queues, text guestbooks, pose missions, remote postcards and bounded owner exports. Guestbook audio/video is not included.
- Themed keyboard-accessible dropdowns, updated V2 PWA icons, English-only interface and authored prompts, responsive/focus corrections, private cache exclusions and recovery screens.
- Hardened storage accounting, idempotent upload/finalisation, archive/delete reconciliation and separate project/event maintenance workers. Reviewed V2 migrations live in `database/migrations`; apply the documented sequence instead of replaying the legacy baseline over later schema.
- Local contract/database/browser rehearsals, service-worker update checks and a retained fallback artifact. These are local evidence, not proof of hosted services, cross-network TURN, physical printing or installed-PWA behaviour.

## 0.13.0 (2026-07-16)

Push notifications and an install button.

- Web push via your own VAPID keys (`npx web-push generate-vapid-keys`; three new env vars, all optional). A bell in the Shared Vault header enables notifications per browser; subscriptions live in the new `pb_push_subscriptions` table (added to `supabase-setup.sql`, re-run it once).
- Notifies your partner when you start a relay strip ("Your turn in the booth", opens the relay) and when you save a strip to the vault. A `/api/push/notify` route validates via RLS that the caller authored the object, so only the preset partner messages can ever be sent.
- Photo-date reminders now also arrive as push notifications — alongside the email, or instead of it if Resend isn't configured (the cron runs with either channel).
- Expired subscriptions are pruned automatically on send failures; the service worker gained `push` and `notificationclick` handlers (tapping opens the relevant page).
- New "Install to device" button at the bottom of the landing page: native install prompt on Chrome/Edge/Android, Share → Add to Home Screen instructions on iOS, hidden once installed.

## 0.12.0 (2026-07-16)

Installable PWA.

- Web app manifest (`app/manifest.ts`) with 192/512 and maskable icons rendered from the Zuychin monogram on the brand dark background, plus an `apple-touch-icon` and Apple web-app metadata; the booth now installs to the home screen and opens standalone.
- Service worker (`public/sw.js`, registered by `components/PwaRegister.tsx` in production only): hashed build assets and the MediaPipe/sticker bundles are cached on first use, so the solo booth and editor work offline after one online visit. Navigations are network-first with a cached-page fallback, then a branded `/offline.html`. Cross-origin and `/api`/`/auth` requests are never cached.
- In dev the register component instead unregisters any leftover worker, so cached assets can't mask live edits.
- `next.config.ts` serves `/sw.js` with `no-cache` headers so deployed updates are picked up promptly.

## 0.11.0 (2026-07-16)

Weekly vault (was: shared album).

- The shared album is now the **Shared Vault**: it holds the current ISO week only, capped at 10 non-recap strips per couple per week. Hitting the cap prompts you to pick one of your own strips to discard before saving.
- The retention cron clears the vault at the week boundary: bookmarked strips and weekly recaps are archived to Cloudinary first (a keepsake that can't be archived is left intact, never lost), everything else is deleted. Recaps now archive automatically.
- Bookmarking reports whether the strip actually reached Cloudinary; the vault shows a warning when a deployment isn't configured to archive, and an N/10 this-week counter.
- All Supabase SQL consolidated into one idempotent root script, `supabase-setup.sql` (run once, re-runnable); the granular `supabase/` migrations are git-ignored local-dev files now, and `SUPABASE_SETUP.md` folded into the README as "Setting up Supabase".

## 0.10.0 (2026-07-14)

Branding, viewport rework, shared album, public-repo prep.

- Zuychin logo and favicon wired up: theme-aware SVG favicon, inline `Logo` component tracking the accent color, and a landing brand header (logo top-center, account button beneath).
- True-to-strip viewfinders: the booth camera is boxed to the selected layout's cell aspect; room panes are shaped to each member's strip footprint (side-by-side layouts show the half-cell portrait crop, matching compose exactly); the editor preview is locked to the strip's ratio.
- Desktop layouts reworked: controls sit in a right sidebar on wide screens (booth, room, editor), content centers on ultrawide monitors, pill rows wrap instead of clipping, and the editor's Download/Share/Save bar is pinned to the bottom. Everything fits the viewport with no page scrolling, mobile included.
- "Timeline" is now the **shared album** everywhere in the UI (route unchanged); album load failures show an error with a retry instead of an endless spinner.
- Cross-site login fix: `AuthCookieMigration` (mounted in the root layout) promotes host-only auth cookies created before `NEXT_PUBLIC_COOKIE_DOMAIN` was set onto the parent domain, so sibling apps see the session and duplicate-cookie shadowing is cleaned up.
- Copy: dropped the "photos never touch a server" claim (saved strips live in Supabase/Cloudinary); removed the dev-only local-mode hint from the room waiting screen.
- Public-repo prep: `supabase/` schema + migrations and `SUPABASE_SETUP.md` now ship in the repo, and README + setup docs are rewritten for standalone use with your own Supabase/Cloudinary accounts (no dependency on the private Zuychin Gallery). The base schema now creates a `profiles` identity table + auth mirror trigger when the project lacks one (guarded, so it stays a no-op on the shared project).

## 0.9.0 (2026-07-14)

Keep strips in Zuychin Gallery (more of Stage 4).

- Bookmarking a strip now pushes it to the shared Cloudinary account (folder `zuychin-photobooth/<uid>/`, private/authenticated delivery) via a new `/api/keep` route, so it has a permanent home in Zuychin Gallery.
- Zuychin Gallery gains a **Photobooth** view (new `/photobooth` route, a public nav entry): your kept strips and any your partner shared, grouped by month, with a click-to-enlarge lightbox and download. Reads the shared `pb_strips` table, RLS-scoped to owner-or-partner. Signed out, it shows a sign-in prompt and still links to the booth.
- The weekly purge now *archives* kept strips instead of exempting them forever: once a kept strip is a week old and safely in Cloudinary, its Supabase Storage copy is dropped and the row is marked `purged`, so Supabase stays small while the strip lives on in Gallery.
- New: `supabase/migration_cloudinary.sql`; new env vars `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (same Cloudinary account as Zuychin Gallery). Without them, bookmarking still keeps a strip in Supabase; it just is not pushed to Gallery.

## 0.8.0 (2026-07-14)

One-week retention (starts Stage 4).

- Strips now clear from Supabase Storage a week after they are taken, purged by a `CRON_SECRET`-guarded `/api/retention` route that a cron service calls (reuses the reminder route's secret and service role, so no new env).
- Bookmark a strip on the timeline to keep it past the week; kept strips and weekly recaps are never purged.
- The timeline shows a "clears after a week" note and an expiry badge on strips with two or fewer days left.
- New: `supabase/migration_retention.sql` (adds `pb_strips.kept` and an owner-update policy).
- Next in Stage 4: keeping a strip pushes it into a Zuychin Gallery album (Cloudinary) for permanent storage, so the Supabase copy can always age out.

## 0.7.0 (2026-07-13)

Photo-date reminders and weekly recaps (completes Stage 3).

- Schedule photo dates (one-time or recurring weekly/monthly/yearly) on the timeline; both partners get an email reminder when one is due.
- Reminders send via Resend, triggered by a `CRON_SECRET`-guarded `/api/reminders` route that a cron service calls; it advances recurring dates and deactivates one-offs.
- Weekly recap: compile this week's saved strips into one shareable image, downloaded and saved back to the timeline. (Weekly to match the planned one-week Supabase retention, after which strips move to Cloudinary via Zuychin Gallery.)
- New: `supabase/migration_photo_dates.sql`; new env vars `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `REMINDER_FROM`, `CRON_SECRET`.
- TURN config now accepts a comma-separated `NEXT_PUBLIC_TURN_URL` for multiple transports.

## 0.6.0 (2026-07-13)

Async relay strips and streaks (more of Stage 3).

- Relay strips: shoot your half of a duo strip now, and your partner finishes it whenever they can. Timezone-proof, no need to be online together. Frames exchange through each person's own private Storage folder; the finished strip opens in the editor to save or export.
- Timeline shows relays waiting on you ("your turn") or on your partner, plus a Start-a-relay button.
- Weekly streak counter: consecutive weeks with at least one saved strip, shown on the timeline.
- New: `supabase/migration_relays.sql` (run after the base schema).
- Not yet included: scheduled photo-date reminders (needs an email/cron choice) and monthly auto-compiled recaps.

## 0.5.0 (2026-07-13)

Accounts and a shared timeline (Stage 3 foundation).

- Sign in with your Zuychin account (shared Supabase project with Zuychin Gallery): email + password or magic link. Same account across both apps.
- Couple pairing: create a code, your partner enters it once, and your strips share one private timeline.
- Save a finished strip to the timeline from the editor; strips upload to a private Storage bucket and are visible only to you and your partner via signed URLs.
- Timeline page lists your saved strips newest-first, with delete.
- Fully optional: with no Supabase env configured, the booth works exactly as before and the account UI stays hidden.
- New: `supabase/photobooth_schema.sql` and `SUPABASE_SETUP.md`.

## 0.4.0 (2026-07-13)

Group rooms for up to 4 friends.

- Rooms now support up to 4 participants over a full WebRTC mesh; the host assigns roles (A-D) in join order and broadcasts the roster.
- Each screen shows a live pane per connected member with a colored role badge.
- New group layouts (Trio strips, Quad strips) appear automatically once 3 or more people are in the room; duo layouts stay for 2.
- The synced shutter, Together scenes, and pose prompts all work across the whole group; group-specific prompt pack added.
- The editor composes every member's frames into the strip and offers per-person placement controls in Together mode.

## 0.3.0 (2026-07-13)

Live scene preview in the room.

- Partners can pick a Together scene inside the room before shooting; the choice syncs over the data channel to both screens.
- The local preview shows you cut out of your background and standing in the scene in real time (~15fps video-mode segmentation), so you can pose into the backdrop before the countdown.
- The chosen scene rides along with the shot plan: both editors arrive with the scene already applied and cutouts running automatically.

## 0.2.0 (2026-07-13)

Stage 2: Together mode.

- Together scenes: MediaPipe selfie segmentation cuts both partners out of their backgrounds and composites them into one shared backdrop per cut. Duo sessions only.
- 6 canvas-drawn scenes: cream studio, rose studio, sunset, night sky, beach, polaroid wall.
- Per-person placement controls in the editor: nudge left/right/up/down and resize, for both You and Partner.
- Segmentation runs fully client side; the wasm runtime and model are bundled under public/, nothing loads from a CDN.

## 0.1.0 (2026-07-12)

First release: the complete Stage 1 booth.

- Solo booth: layout picker, live mirrored preview, countdown with flash and shutter sound, front/back camera toggle, upload fallback when the camera is blocked.
- Live duo room: 6-character room codes, WebRTC peer-to-peer with Supabase Realtime signaling (BroadcastChannel fallback for same-browser development), clock-synchronized shutter, full-resolution frame exchange, pose prompt roulette.
- Strip editor: 7 frames, 6 filters with live preview parity, draggable stickers, caption and datestamp, 2x PNG export and mobile share sheet.
- Sticker library: 8 packs of 8, rendered as bundled Fluent Emoji (Flat or 3D) or frame-tinted monochrome Noto glyphs (Ink).
- Layouts: 3 solo (classic strip, 2x2 grid, tall three) and 3 duo (taking turns, side by side, twin strips).
