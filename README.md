# Zuychin Photobooth

Create a keepsake on your own, make one with people elsewhere, or collect photos at an event. Zuychin Photobooth V2 combines a local capture/editor library with optional private cloud projects, live rooms, memories and event workflows.

Package version: **2.0.0**, following the [approved V2 plan](V2_PLAN.md). The friends release enables local creation tools and places online features behind a shared incoming screen. See [development status](docs/development/V2_STATUS.md) for current checks and outstanding full-V2 work. Hosted features remain disabled by default; physical-phone testing was explicitly deferred, not passed.

The booth, editable projects and exports work locally without an account. Browser storage is best effort, so keep portable backups. Live-room originals travel over peer connections; optional cloud/event uploads use separate private scopes. Event gallery and wall publication require their own consent and approval, rather than inheriting couple or room access.

## Friends-only deployment

Set `PB_RELEASE_MODE=local` for this release. Production also defaults to local mode when the setting is missing or unrecognised; development keeps the full acceptance environment unless local mode is explicitly selected. Only `PB_RELEASE_MODE=full` permits the online features, and their individual feature switches still apply.

Local mode keeps the solo booth, editor, exports/sharing, device projects and templates available without Supabase or database migrations. Together, live rooms, relays, Events, cloud projects, Memories, accounts and the Shared Vault show a shared **Feature incoming** view. Direct links and client navigation use the same view. Account initialisation and cloud-save controls are disabled, and app APIs reject new online work even if individual V2 switches were accidentally enabled. Use a normal production build/start and HTTPS hosting; this is a limited local release, not completion of V2's hosted acceptance.

Existing personal event receipts and authenticated maintenance retain their own checks. A previously locked kiosk can finish accepted work and unlock/exit, but cannot create a device, start another guest, reserve or mint another upload in local mode. This switch does not delete stored photos, revoke existing Supabase access, stop an already-open older app, or replace database permissions. Previously stored cloud media still needs its compatible schema and retention workers. Review migration 001 and the current cron setup before replacing an existing cloud deployment; the local-only tools themselves need neither. Cloud account recovery needs the compatible full deployment, since sign-in is unavailable in local mode.

To enable hosted features later, follow the database/worker sequence below, finish the relevant acceptance checks, set `PB_RELEASE_MODE=full` and enable only the reviewed feature switches. No commit, push or deployment is performed by changing this setting.

## Features

- **Solo booth**: choose a 3, 5 or 10-second timer, camera, mirror and optional screen fill light. Classic keeps the original booth sequence; Flexible lets you review and retake individual shots. Imported photos can fill the remaining positions when camera access is unavailable.
- **Local projects**: autosave originals and edits on this device, resume after reload, rename, duplicate and keep an editable `.pbproject` backup. Browser storage is best effort; an exported backup remains important. Account drafts stay hidden after sign-out, with a separate choice to remove their local copies.
- **Personal templates**: save a reusable frame, arrange bounded photo slots, text, stickers and PNG decorations, and move recipes between browsers with `.pbtemplate` files. Source photos stay out of recipes; captions and text are excluded from export by default.
- **Visual packs**: preview 18 generated scenes and six materials, browse by category, keep favourites and download selected packs for offline use. Missing images fall back to built-in backgrounds. Capture and editing controls share a themed, keyboard-accessible dropdown.
- **Live rooms for two to four**: V2 adds host admission/lock, explicit camera readiness, committed capture plans, bounded original transfer and recovery. Any admitted member can request capture; the host prepares it when everyone is ready. Actual cross-device timing and TURN behaviour still require measurement.
- **Shared Together preview**: capable browsers segment all intended participants into one scene. Slow or missing inputs fall back honestly to original tiles or local preview. Post-capture preparation is explicit; real-person edge quality and phone performance remain device checks.
- **Original-photo exchange**: each participant captures a JPEG from their own camera within the room's agreed byte/pixel profile and transfers it separately from the video preview. Missing originals remain visible and recoverable; a video screenshot is not silently substituted.
- **True-to-strip viewfinder**: the live camera view shows the selected capture framing. Review template crops and per-cell edits in the editor before export.
- **Guided photo stories**: twelve authored English decks for dates, friends, celebrations and seated poses, with shared ordering, director turns, preview and skip. Local, live and asynchronous challenge flows reuse the story catalogue without a runtime AI service.
- **Strip editor**: reorder photos, crop/zoom/rotate/mirror each cell, choose individual filters and undo/redo edits. Existing frames, themes, patterns and stickers remain available. Date stamps use the saved capture time and timezone. Shared dropdowns follow the app's light, dark and booth themes and support keyboard selection.
- **Sticker library**: 8 packs of 8 stickers in three rendering styles: Flat and 3D (bundled Fluent Emoji assets, consistent on every device) and Ink (monochrome glyphs tinted to the frame color).
- **Layouts**: classic 4-strip, 2x2 grid, and tall three for solo; taking turns, side-by-side, and twin strips for duos; trio and quad strips for groups.
- **Export studio**: PNG/JPEG at original, story, square and wallpaper sizes, plus exact-size strip, two-up and A4 PDFs with safe margins and cut marks. Prepare and preview the file before downloading or sharing. Camera denied? Build a strip from uploaded photos instead.
- **Solo motion**: animate existing photos inside their saved design, or explicitly record a silent two-second camera loop. GIF is available alongside browser-tested MP4/WebM support, with boomerang playback and cancellable preparation. Original still photos stay intact.
- **Accounts and a Shared Vault** (optional): sign in, pair with your partner via a code, and save strips to one private couple vault, backed by your own Supabase project. Without one configured, the booth works exactly the same and the account UI stays hidden.
- **Relay strips** (optional): shoot your half now and your partner finishes the strip whenever they can, no need to be online together. Plus a weekly streak counter in the vault.
- **Memories and rituals** (optional): private chapters/occasion labels, civil-year browsing, an annual recap from up to twelve currently accessible photos, and timezone-aware once/weekly/monthly/yearly rituals. Each recipient explicitly chooses their own reminder channels. Deleted or expired photos cannot be reconstructed from activity history.
- **Then & Now**: choose an original from the current local project scope or import an old photo/flattened strip, align a ghost overlay and export a dated comparison or alternating animation. Unknown dates and strip crops remain labelled.
- **Private cloud designs and challenges** (optional): explicit accepted personal/friend scopes, verified originals, owner-canonical editable checkpoints and new local copies on reopen. Two-to-four-person challenges have assigned sources, server-enforced reciprocal reveal and explicit contributor-only partial results.
- **Voice captions** (optional): explicit microphone recording up to thirty seconds, a text alternative, local draft recovery and private playback/export/deletion tied to current memory access.
- **Events** (optional): host settings/test look, account-free QR contribution, private receipts, separate gallery/wall consent and moderation, reports, protected browser kiosk, private guestbook/pose missions and unanimous remote postcard approval. Owner ZIP exports are bounded and resumable; authenticated moderators have narrower authority.
- **Legacy Shared Vault retention** (optional): ten ordinary strips plus one recap per couple per configured ISO week. Maintenance queues archive/delete work; a pending or failed archive never authorises removal of the last verified source. Storage capacity is released only after confirmed cleanup.
- **Installable PWA**: revised V2 icons, cached public application assets and explicitly downloaded visual packs. Local work can continue when its required assets are available; cloud services, private receipts and audience media are not offline caches. Installation and offline behaviour on physical phones remain separate checks.
- **Push notifications** (optional): enable the bell in the vault and get nudged when it's your turn on a relay strip, when your partner saves a strip, and when a photo date is due. Uses configured VAPID keys and browser push services; device delivery still needs verification.

## Tech stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| Styling | Tailwind CSS v4 with CSS-variable design tokens |
| Fonts | Geist, Fraunces, Noto Emoji (monochrome) via next/font |
| Room signalling | V2 scoped HTTP/RPC signalling and peer mesh; legacy Realtime links remain supported |
| Media | WebRTC peer-to-peer, getUserMedia, Canvas 2D |
| Icons | lucide-react |
| Sticker assets | Microsoft Fluent Emoji (bundled SVG/PNG) |

## Getting started

Use Node.js 22 or later for development and tests. CI uses Node.js 22.

```bash
npm install
cp .env.example .env.local   # then fill in the values below
npm run dev
```

Open http://localhost:3000.

### Environment variables

Device-only creation needs no service configuration. Optional hosted tracks fail closed without their flags, reviewed schema, credentials and provider setup. See [`.env.example`](.env.example); it contains no active credentials.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL, for WebRTC signaling and (if the schema is installed) accounts + the shared album |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `NEXT_PUBLIC_TURN_URL` | TURN relay URL(s) for networks where direct peer-to-peer fails. Must start with `turn:`/`turns:`; comma-separate multiple transports |
| `NEXT_PUBLIC_TURN_USERNAME` | TURN credential |
| `NEXT_PUBLIC_TURN_CREDENTIAL` | TURN credential |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only; required for authorised cloud, room, memory and event operations and their workers |
| `PB_PUBLIC_ORIGIN` | Canonical HTTPS app origin for cloud mutation checks and reminder links; no path, query or credentials |
| `NEXT_PUBLIC_COOKIE_DOMAIN` | Optional; shares the login cookie across sibling apps of your own served under one parent domain (see Supabase setup below) |
| `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME` | Cloudinary account for archiving kept strips past the weekly reset. Optional |
| `CLOUDINARY_API_KEY` | Cloudinary key (server-only) |
| `CLOUDINARY_API_SECRET` | Cloudinary secret (server-only) |
| `RESEND_API_KEY` | Resend key for reminder emails (optional) |
| `REMINDER_FROM` | Verified sender for reminder emails (optional) |
| `CRON_SECRET` | Required when running crons; sent only as `Authorization: Bearer <secret>` |
| `PB_ROOM_V2_ENABLED` | V2 room switch; leave `false` until room/auth/TURN acceptance |
| `PB_ROOM_RATE_SECRET`, `PB_ROOM_TRUSTED_IP_HEADER` | Separate 32+ character HMAC secret and trusted ingress-overwritten single-IP header for rooms |
| `PB_CLOUD_PROJECTS_ENABLED`, `PB_CHALLENGES_ENABLED` | Independent project/challenge switches; default `false`; challenge requires both |
| `PB_MEMORIES_ENABLED`, `PB_VOICE_CAPTIONS_ENABLED` | Memories/rituals and optional private voice; default `false`; voice requires both |
| `PB_EVENTS_ENABLED` | Event switch, default `false`; upload admission also needs verified worker readiness |
| `PB_EVENT_TRANSPORT_SECRET`, `PB_EVENT_TRUSTED_IP_HEADER` | Stable random 32+ character event secret and trusted ingress-overwritten single-IP header |
| `PB_EVENT_REMINDERS_ENABLED` | Separate owner expiry-reminder switch, default `false`; requires events plus explicit channel opt-in |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Web push: VAPID public key (`npx web-push generate-vapid-keys`). Optional |
| `VAPID_PRIVATE_KEY` | Web push: VAPID private key (server-only) |
| `VAPID_SUBJECT` | Web push: `mailto:` contact sent to push services |

Legacy room links retain their same-browser BroadcastChannel development fallback when Supabase is absent. New V2 room entry fails unavailable unless its explicit server capability is configured. TURN is required for some networks; provider capacity, credential handling and actual forced-TURN sessions must be verified before activation.

To enable accounts and the Shared Vault, use a Supabase project with verified capacity and access policies and follow [Setting up Supabase](#setting-up-supabase) below.

### Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript, no emit |
| `npm test` | Local regression suites for project/media/room/memory/event contracts and branding |
| `npm run test:rehearsal` | Service-worker, retained-artifact and rollback-proxy regressions using synthetic files and loopback HTTP, without Docker or hosted credentials |
| `npm run check` | Typecheck, lint and tests |
| `node database/tests/run-local.mjs` | PostgreSQL lifecycle/concurrency tests in the separate task-owned Docker fixture |
| `node database/tests/run-rest.mjs` | Isolated PostgreSQL/PostgREST integration tests; creates and removes its own local containers |
| `node --import tsx scripts/backfill-memory-activity.ts --help` | Bounded activity-backfill options; default invocation is zero-network dry-run |
| `node --import tsx scripts/run-event-worker.ts --help` | Bounded event-worker runner; default invocation is zero-network dry-run |

In development, `/v2-lab` runs synthetic local-storage, canvas, media and print-geometry probes, plus the actual template recovery controls and framework error/retry screen. It requests no camera or microphone and returns 404 in production. These checks do not replace real-device, physical-print or hosted-service acceptance. The CI workflow runs static checks, application tests, rehearsal regressions and a production build without deployment or service credentials. The separate PostgreSQL rollback integration remains an explicit local check requiring its disposable Docker fixture.

## Setting up Supabase

Everything here is optional for the local booth. The following baseline enables accounts, pairing and the legacy **Shared Vault**; V2 hosted tracks additionally require the numbered migration sequence below. Shared-project policies, provider limits and existing data must be reviewed by an authorised operator. Table prefixes alone do not establish isolation or spare capacity.

**1. Environment.** From Project Settings → API:

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

`NEXT_PUBLIC_*` values are baked in at build time, so redeploy after changing them.

**2. Baseline database.** [`supabase-setup.sql`](supabase-setup.sql) contains the legacy schema plus the marked `PB_LIFECYCLE_V1` block, identical to [migration 001](database/migrations/001_v2_lifecycle.sql). It is **not the full V2 schema**. A fresh reviewed installation starts here; an existing legacy installation can apply 001 alone. Do not replay the baseline or an older migration independently after later V2 functions/policies have replaced it. See the ordered V2 sequence below before any hosted application.

Before enabling cloud writes or maintenance, an authorised operator must review
the old deployment's timezone and the intended ISO-week policy, then call
service-only `pb_configure_lifecycle(p_timezone)` with the chosen IANA timezone.
There is no default production timezone. `pb_lifecycle_capabilities()` must
report `version: 1` and `ready: true`; missing/unready schema disables dependent
operations. Existing rows retain their timestamps and receive an eight-day
retention floor after migration. See the [P1 database contract](docs/development/P1_DATABASE_CONTRACT.md)
for reconciliation requirements, local evidence and remaining hosted Storage checks.

**3. Storage bucket.** In **Storage → New bucket**, create `photobooth-strips`
as **Private**. Its policies are already in the script; a strip is stored at
`<owner-uid>/<strip-id>.png` with legacy owner/partner policies. V2 memory reads additionally check the immutable original couple and current access; a newly paired partner does not inherit historical memory access.

**4. Auth.** Enable the **Email** provider. The login page offers email +
password and magic link (a magic link creates the account on first sign-in).
Under **Authentication → URL Configuration**, set **Site URL** to your
production URL and add `https://<your-app>/auth/callback` (plus
`http://localhost:3000/**` for development) to **Redirect URLs** - magic links
silently fall back to the Site URL when the callback is not allowlisted.

**5. Media maintenance and reminders.** The Shared Vault accepts ten ordinary
strips plus one recap per couple per ISO week, with a 16 MiB object ceiling and
176 MiB combined ceiling. Unpaired users have an owner quota. Confirmed deletion
releases capacity; a pending or failed cleanup does not. On rollover, maintenance
queues archive work for kept strips/recaps and deletion for other old strips.
Archive verification precedes source removal. These server operations require:

```
SUPABASE_SERVICE_ROLE_KEY=...   # server-only, never exposed to the browser
CRON_SECRET=...                 # any random string
PB_PUBLIC_ORIGIN=https://<your-app>
```

Point a scheduler at these endpoints with header
`Authorization: Bearer <CRON_SECRET>`. Query-string secrets are rejected. Missing
required server configuration returns HTTP 503 before work begins; invalid
authentication returns HTTP 401.

- `https://<your-app>/api/media/maintenance` - bounded discovery and processing
  of retention, deletion and tracked orphan jobs. `/api/retention` remains an
  alias. Schedule repeated runs so queued work can drain and retry. Returns
  `{ enqueued, processed, completed, retrying, failed, weekStart }`; unfinished
  retry/failed results return HTTP 503 with durable jobs retained. Inspect failed
  jobs before an operator uses the bounded `pb_retry_media_job` RPC.
- `https://<your-app>/api/reminders` - the existing legacy/ritual/event-expiry reminder scheduler; every 15 minutes is the baseline cadence, with bounded work and explicit recipient choices. Delivers by email with a [Resend](https://resend.com) key
  (`RESEND_API_KEY`, and `REMINDER_FROM` on a verified domain for real
  delivery), by push notification when web push is set up (step 7), or both.

Use your exact production host: many schedulers do not follow `www.`/apex
redirects, which silently breaks the job.

**6. Keeping strips past the reset (optional Cloudinary).** Bookmarking a strip
marks it `kept`. With a [Cloudinary](https://cloudinary.com) account configured,
keeping a strip (and the weekly clear) uploads it to `zuychin-photobooth/<uid>/`
with authenticated (private) delivery, so it survives after the Supabase copy is
cleared:

```
NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
```

Without these, the queued keep intent still protects the original in Supabase
Storage, but the archive is not reported complete. Configure Cloudinary and
retry the preserved job before removing its source. The V2 retained-strip resolver verifies the persisted private archive identity and current source access before returning bounded bytes. A stored public `cloudinary_url` is not authorisation. Integration with another application needs its own access review.

**7. Push notifications (optional web push).** Generate a VAPID key pair once
(`npx web-push generate-vapid-keys`) and set:

```
NEXT_PUBLIC_VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...            # server-only
VAPID_SUBJECT=mailto:you@example.com
```

A bell appears in the Shared Vault header; each partner enables notifications
per browser where the installed/browser environment supports it. Physical iPhone/Android notification behaviour remains unverified in this update. You'll get a nudge when it's your turn on a relay strip, when your
partner saves a strip to the vault, and when a photo date is due (alongside or
instead of the email). Delivery uses browser-vendor push services and the configured sender. Provider acceptance does not prove a person saw a notification.

**8. One login across your own apps (optional).** If you serve several of your
own apps under one parent domain (say `booth.example.com` and
`photos.example.com`) against the same project, set
`NEXT_PUBLIC_COOKIE_DOMAIN=.example.com` (leading dot, identical in every app)
to share the auth cookie, and add each app's `/auth/callback` to the Redirect
URLs. Leave it blank on localhost or a standalone deploy.

## V2 database and activation sequence

The files under [`database/migrations/`](database/migrations/) are tracked source artefacts, not evidence that a hosted database has been updated. Danny or a separately authorised operator applies hosted SQL after backup and a disposable-environment rehearsal. No application startup, build or script here automatically applies migrations.

For a **fresh** database, apply the reviewed baseline `supabase-setup.sql` (already includes 001), then every reviewed migration **002 through 028 in numeric order**. For an existing installation, establish which matching revisions were actually applied, then apply the reviewed missing sequence. Later migrations deliberately replace earlier gates, so do not rerun one older file over the final schema. A populated rerun must use the complete compatible dependency chain, with its grants/policies rechecked. Rehearse migrations with application traffic stopped or isolated; intermediate older definitions are not a supported serving state.

| Migration range | Foundation |
| --- | --- |
| 001 | Legacy lifecycle, durable archive/delete/upload intents and quota accounting |
| 002-005 | Private projects, V2 rooms, reciprocal challenges and event core |
| 006-008 | Retained activity, challenge discovery and contributor-only partial results |
| 009-011 | Explicit ritual schedules/delivery and authorised retained-strip reads |
| 012-015 | Canonical editable cloud designs, civil-year browsing, voice captions and asynchronous stories |
| 016-018 | Event capability transport, host settings/discovery and export snapshots |
| 019-021 | Worker readiness/admission, private host review and owner expiry reminders |
| 022-026 | Independent publication/moderation, guestbook/missions, kiosk, remote postcards and own-consent revision fencing |
| 027-028 | Durable event admission pause and schema-4 export-settings compatibility for cloud designs |

The migrations configure separate **private** buckets: `photobooth-projects-v2`, `photobooth-event-images-staging-v2`, `photobooth-events-v2` and `photobooth-voice-captions`. They do not reuse the legacy couple bucket for these audiences. Verify the actual installed private flags, size/MIME restrictions, restrictive policies, Storage write fences and service-only grants. A positive capability version is required by the matching adapter; an environment flag alone never grants access.

Project, event and voice deployment allocations default to **zero**. Service-only `pb_project_configure(p_bytes)`, `pb_event_configure(p_bytes)` and `pb_voice_configure(p_bytes)` set reviewed allocations. These are independent budgets, so partition real provider headroom across all tracks, legacy media and other applications. There are no environment byte-cap overrides. Event ceilings of 25 guests, 100 active contributions and 250,000,000 bytes do not imply all can fit concurrently; staged uploads and pending deletion remain charged until confirmed cleanup.

Before enabling a hosted track:

1. Rehearse the full matching migrations and adversarial scope/capacity tests in a disposable environment, then verify actual hosted provider/token behaviour separately.
2. Configure exact HTTPS `PB_PUBLIC_ORIGIN`, authenticated callbacks, service credentials and verified ingress-overwritten IP headers. Keep room and event secrets independent. Never put service keys, receipt tokens or signed URLs in logs.
3. Arrange each worker below, verify supported runtime duration, actual scheduler cadence and failure/retry behaviour, and test that accepted jobs remain recoverable.
4. For retained historical memories, use the [bounded activity-backfill runbook](docs/development/P6_ACTIVITY_BACKFILL.md). The CLI defaults to zero-network dry-run; `--apply` requires separate target authorisation, uses finite batches and durable per-source markers for continuation. It does not restore deleted photo bytes.
5. Enable only the reviewed feature flags after their gates pass. Retain a compatible recovery build, monitor terminal failed/uncertain jobs and do not reset accounting to manufacture spare capacity.

### Separate maintenance responsibilities

All worker endpoints require the exact `Authorization: Bearer <CRON_SECRET>` header and valid server configuration. Query secrets are rejected. The repository installs **no scheduler**.

| Endpoint | Responsibility and scheduling boundary |
| --- | --- |
| `GET /api/media/maintenance` | Legacy retention/archive/delete/orphan work; also bounded voice cleanup when voice is enabled. `/api/retention` is its compatibility alias, not another independent queue. The baseline cadence is 15 minutes with repeated runs to drain work. |
| `GET /api/reminders` | Existing legacy dates, versioned rituals and opted-in event expiry reminders share a five-occurrence/45-second pass budget. Baseline cadence is 15 minutes; provider timeouts and uncertain acknowledgements remain explicit. |
| `GET /api/projects/maintenance` | Dedicated project original verification and cleanup, at most one job in each lane per invocation. Reservations must finish within ten minutes, so the operator must schedule and load-test enough bounded passes for admitted uploads. It is not processed by the legacy media endpoint. Route allowance is 120 seconds; hosting support is not implied. |
| `GET /api/events/maintenance` | Dedicated event verification/cleanup with a 90-second application deadline and 120-second route allowance. Scheduler starts must occur at least every 60 seconds, including safe overlapping invocation support. A verified pass renews a 150-second heartbeat; absent/stale health blocks new reservation/upload minting. |

The [event worker runbook](docs/development/P7_EVENT_WORKER_RUNBOOK.md) specifies the bounded runner, bootstrap, provisional two-pending global admission ceiling, measured-throughput gate and revision-fenced admission pause/rollback. Both `scripts/run-event-worker.ts` and `scripts/control-event-admission.ts` default to zero-network dry-run. The pause survives verified cleanup passes; it blocks new reservations and upload URLs while retaining exact reservation replays, uploaded-byte finalisation, private reads and cleanup. An accepted reservation without a usable upload URL must wait for deliberate resume within its unchanged deadline or expire safely. Fifteen-minute legacy maintenance cannot satisfy the event ten-minute completion window. A scheduler that skips starts during a long invocation is insufficient. Current provider/hosting support and throughput are **not verified** by local SQL or synthetic UI tests.

`node database/tests/run-full-chain.mjs` checks the complete baseline plus 002-028 on a uniquely named disposable database in the existing local `pb-v2-p1-postgres` Docker container. It verifies the embedded 001 matches its source, fresh and populated reruns, final capabilities/private buckets/grants, frozen challenge identity, ordinary/kiosk/postcard recovery, physical cleanup accounting and pause/admission contention. It never applies hosted SQL and removes only its own temporary database. Track-specific SQL suites remain necessary for their wider adversarial coverage.

Read-only receipts, export, consent reduction and accepted recovery do not depend on a fresh event heartbeat. Disabling the entire event flag also disables its worker, so it is not a cleanup strategy. See [project HTTP/worker](docs/development/P6_PROJECT_HTTP.md), [ritual delivery](docs/development/P6_RITUAL_DELIVERY.md), [voice backend](docs/development/P6_VOICE_BACKEND.md) and [event reminders](docs/development/P7_EVENT_REMINDERS.md) for exact bounds and terminal recovery semantics.

## How a V2 shared room works

1. Open Together and create a V2 room. The six-character code finds the room; an HttpOnly browser capability, not the code or `host=1`, authorises actions.
2. The host admits intended participants and can lock entry. Each person explicitly opens their camera. V2 uses scoped server signalling; media and originals travel through the peer mesh.
3. Choose the shared story/look. Any admitted person may request capture; the host commits a versioned plan only when all intended peers are ready. Actual shutter timing depends on the tested network/device.
4. Each device saves its bounded original before counting success. Missing frames remain visible; reconnect, retry a failed local save or resend retained originals without silently firing another shot.
5. Host-ordered shared finishing respects each person's layer ownership. Leave with a separate editable local copy, or explicitly preserve an incomplete result. Existing legacy room URLs still open the legacy flow.

## Project structure

```
app/
  page.tsx            landing: Create, Together and Events
  booth/              solo capture, stories and Then & Now
  projects/           device/account library and optional cloud projects
  templates/          local template shelf and constrained designer
  together/           live, asynchronous and guided-story entry
  memories/           retained activity, chapters, rituals and voice
  challenges/         direct asynchronous challenge/recovery entry
  events/             owner/moderator and guest contribution surfaces
  e/                  private gallery/wall and remote postcard entry
  receipt/            separate private submission authority
  room/[code]/        live shared room
  customize/          strip editor and export
  timeline/           the Shared Vault: pairing, strips, relays, photo dates
  relay/              async relay strips (shoot your half, finish theirs)
  login/              email + magic-link sign-in
  api/                scoped room/project/memory/event APIs and separate workers
  manifest.ts         PWA web app manifest
components/PwaRegister.tsx  service worker registration (production only)
public/sw.js          service worker: offline caching, push + notification clicks
components/           camera preview, countdown, filter bar, strip mockup, logo
hooks/useCamera.ts    getUserMedia lifecycle and device switching
lib/
  layouts.ts          strip geometry definitions
  compose.ts          canvas strip composition (preview and export)
  filters.ts          filter definitions (CSS and canvas parity)
  capture.ts          frame capture and blob helpers
  decor.ts            frames, sticker packs, sticker styles
  prompts.ts          pose prompt packs and seeded roulette
  couple.ts, relay.ts accounts, pairing, album strips, relays
  rtc/                legacy/V2 signalling, transfer journals and workspace
  projects/           versioned manifests, IndexedDB and portable bundles
  templates/, exports/ bounded recipes and shared still/PDF/motion output
  memories/, events/  scoped browser contracts and recovery clients
  server/             verified-actor services, handlers and maintenance
public/stickers/      bundled Fluent Emoji assets (flat SVG, 3D PNG)
supabase-setup.sql    legacy baseline plus migration 001 only
database/migrations/ reviewed forward V2 migrations, currently 001-028
```

## Release and remaining acceptance

V2 is implemented against the [approved feature and delivery plan](V2_PLAN.md). The [development status](docs/development/V2_STATUS.md) owns current local check counts and the all-page review outcome. This README does not mark those gates passed by changing the package version.

Hosted schema/auth/Storage/cookie/provider checks, a verified scheduler and measured capacity, physical camera/microphone and phone/PWA acceptance, forced-TURN multi-device sessions, physical prints, OS download/share delivery, user/event rehearsals and exact-authorised-commit remote CI remain separate release evidence. Phones were explicitly deferred for local development. Optional remote group motion and guestbook audio/video are not advertised as shipped. AR props, more than four live cameras, runtime AI image generation, silent printing and payments remain outside this release's implemented scope.

Rollback must keep a V2-compatible read/export/receipt/maintenance build. Do not erase IndexedDB, down-migrate data or return to an old baseline that cannot read accepted V2 records. Stopping new writes must not silently stop required cleanup; see the worker runbook before disabling flags.

## Credits

- Sticker artwork from [Fluent Emoji](https://github.com/microsoft/fluentui-emoji) by Microsoft, MIT license.
- Ink-style glyphs rendered with [Noto Emoji](https://fonts.google.com/noto/specimen/Noto+Emoji), SIL Open Font License.
