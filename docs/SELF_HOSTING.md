# Self-hosting

This guide covers running your own copy of Zuychin Photobooth. The local tools (booth, editor, projects, templates and exports) need nothing beyond the app itself. Cloud features need a Supabase project, the database migrations, maintenance workers and their feature switches.

Nothing in this repository applies migrations, provisions services or deploys on its own. You decide when each step happens.

## 1. Run the app

Any host that runs Node.js 22 can serve the app:

```bash
npm ci
npm run build
npm start
```

- **Serve it over HTTPS.** Browsers only allow the camera on `localhost` or HTTPS.
- **Set `PB_PUBLIC_ORIGIN`** to the exact public HTTPS origin, with no path or query. Cloud mutation checks and reminder links use it. Behind a proxy or tunnel, the server may see its own bound address as the origin, so the app builds absolute URLs from this setting rather than from the request.
- **Rebuild after changing `NEXT_PUBLIC_*` values.** Browser code reads them at build time.
- **Trusted IP headers.** `PB_ROOM_TRUSTED_IP_HEADER` and `PB_EVENT_TRUSTED_IP_HEADER` name a single client-IP header that your ingress overwrites on every request. Never trust a header the caller can set, or a forwarded list.
- **Smaller deploys.** Adding `output: "standalone"` to `next.config.ts` produces a self-contained server bundle for a VM or container.

Copy `.env.example` to your environment and fill in only what you need. It contains no real credentials.

## 2. Release modes

`PB_RELEASE_MODE` decides what a deployment offers. Production uses `local` when the setting is missing or unrecognised. Development uses the full environment unless you choose `local`.

### Local

Keeps the solo booth, editor, exports and sharing, device projects and templates, with no Supabase or migrations. Together keeps the legacy live room: hosts open `/room/CODE?host=1` and guests open `/room/CODE`. Cross-device legacy rooms use the public Supabase URL and key for Realtime signalling, plus the optional TURN settings. Without Supabase, only tabs in the same browser can pair.

V2 room links (`?v=2`), relays, events, cloud projects, memories, accounts and the Shared Vault show a "Feature incoming" view. Account set-up and cloud saves are disabled, and the APIs refuse new online work even if a feature switch is on by mistake.

Existing personal event receipts and authenticated maintenance keep their own checks. A previously locked kiosk can finish accepted work and unlock, but can't start another guest or upload. This mode doesn't delete stored photos, revoke Supabase access, stop an already open older app or replace database permissions. Stored cloud media still needs its schema and retention workers.

### Full

Permits the hosted features. Each one still needs its own switch, schema, credentials and provider set-up. Follow sections 3 to 6, finish the checks for a feature, then set `PB_RELEASE_MODE=full` and turn on only the switches you've reviewed.

### Recovery

A compatible fallback. Keep the cloud and event switches, credentials, `PB_PUBLIC_ORIGIN` and maintenance configured, and pause event admission before switching.

Recovery keeps sign-in, account drafts, cloud originals and design reads, private event receipts and owner ZIP exports. Accepted cloud and event finalisation and cleanup continue. The server refuses new projects, reservations, upload grants, cloud design saves and wider sharing, including from older open clients. Export snapshots and checkpoints stay writable because resumable downloads need them.

Hosts can still pause or close events, delete, revoke and make a guest photo private. Rooms, relays, memories, public event displays, postcards and reminders are off. Storage grants already issued stay valid until they expire, and legacy direct Supabase access still relies on database policies.

## 3. Supabase

Everything here is optional for the local tools. This baseline enables accounts, pairing and the legacy Shared Vault. Other hosted features also need the migrations in section 4. Review policies, provider limits and existing data before sharing a Supabase project with other apps. Table prefixes alone don't isolate them.

**Environment.** From Project Settings, API:

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...   # server-only, never sent to the browser
```

**Baseline database.** [`supabase-setup.sql`](../supabase-setup.sql) has the legacy schema plus the marked `PB_LIFECYCLE_V1` block, identical to [migration 001](../database/migrations/001_v2_lifecycle.sql). It is not the full schema. A fresh installation starts here. An existing legacy installation can apply 001 alone.

Before enabling cloud writes or maintenance, choose the timezone your ISO weeks follow and call the service-only `pb_configure_lifecycle(p_timezone)` with that IANA timezone. There's no default. `pb_lifecycle_capabilities()` must report `version: 1` and `ready: true`.

**Storage bucket.** Create a private bucket named `photobooth-strips`. Its policies are in the setup script, and strips are stored at `<owner-uid>/<strip-id>.png`.

**Auth.** Enable the Email provider. The login page offers email and password, and magic links, which create the account on first sign-in. Under Authentication, URL Configuration, set the Site URL to your production URL and add `https://<your-app>/auth/callback` (plus `http://localhost:3000/**` for development) to the Redirect URLs. Magic links fall back to the Site URL when the callback isn't allowed.

**Vault retention.** The Shared Vault accepts ten strips plus one recap per couple each ISO week, with a 16 MiB object limit and a 176 MiB combined limit. Unpaired users have their own quota. When a week rolls over, maintenance archives kept strips and recaps and deletes other old strips. An archive is verified before its source is removed, and capacity is released only after confirmed deletion.

**Archiving kept strips (optional Cloudinary).** With [Cloudinary](https://cloudinary.com) configured, keeping a strip uploads it to `zuychin-photobooth/<uid>/` with authenticated delivery, so it survives the weekly clear:

```
NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
```

Without them, the queued keep job still protects the original in Supabase Storage, but the archive isn't reported complete.

**Reminder emails (optional).** Set `RESEND_API_KEY` from [Resend](https://resend.com) and `REMINDER_FROM` with a sender on a verified domain.

**Web push (optional).** Generate a VAPID key pair once with `npx web-push generate-vapid-keys`:

```
NEXT_PUBLIC_VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...            # server-only
VAPID_SUBJECT=mailto:you@example.com
```

A bell appears in the Shared Vault. Each person turns on notifications per browser, then gets nudges for relay turns, new vault strips and photo dates. Delivery goes through the browser vendors' push services.

**One login across your own apps (optional).** If several of your apps share one parent domain and Supabase project, set `NEXT_PUBLIC_COOKIE_DOMAIN=.example.com` (with the leading dot, the same in every app) and add each app's `/auth/callback` to the Redirect URLs. Leave it blank on localhost or a standalone deploy.

## 4. Database migrations

[`database/migrations/`](../database/migrations/) holds forward-only SQL migrations. They're source files, not proof that a database has them. Apply them yourself, after a backup and a rehearsal on a disposable database. Nothing applies them automatically.

For a fresh database, apply `supabase-setup.sql` (which includes 001), then every migration from 002 to 029 in numeric order. For an existing installation, work out which ones were applied, then apply the missing ones in order. Later migrations replace earlier functions and policies, so never rerun an older file over a newer schema. Stop or isolate app traffic while migrating, because the in-between states aren't supported for serving.

Take a dump of the database before any migration that changes or removes data. Some hosted plans keep no usable backups.

| Migrations | What they add |
| --- | --- |
| 001 | Lifecycle, durable archive, delete and upload intents, and quota accounting |
| 002 to 005 | Private projects, V2 rooms, reciprocal challenges and the event core |
| 006 to 008 | Retained activity, challenge discovery and contributor-only partial results |
| 009 to 011 | Ritual schedules and delivery, and authorised retained-strip reads |
| 012 to 015 | Editable cloud designs, civil-year browsing, voice captions and asynchronous stories |
| 016 to 018 | Event transport, host settings and export snapshots |
| 019 to 021 | Worker readiness and admission, private host review and owner expiry reminders |
| 022 to 026 | Publication and moderation, guestbook and missions, kiosk, postcards and consent fencing |
| 027 to 028 | Event admission pause, and export settings for cloud designs |
| 029 | V3 strip styles for cloud designs and event looks |

After 029, `pb_project_design_capabilities()` reports `stripVersion: 1` and `pb_event_look_capabilities()` reports `lookVersion: 2`. Until then, cloud saves of V3 designs and V3 event looks return "unavailable". Older designs and looks keep working.

The migrations create separate private buckets: `photobooth-projects-v2`, `photobooth-event-images-staging-v2`, `photobooth-events-v2` and `photobooth-voice-captions`. Check the installed private flags, size and type limits, policies and service-only grants. A feature switch alone never grants access; its adapter needs a positive capability version from the database.

Project, event and voice storage budgets default to zero. Set them with the service-only `pb_project_configure(p_bytes)`, `pb_event_configure(p_bytes)` and `pb_voice_configure(p_bytes)`. They're independent, so split your real provider capacity between them, legacy media and anything else on the project.

`node database/tests/run-full-chain.mjs` applies the baseline and every numbered migration to a uniquely named database in the local `pb-v2-p1-postgres` Docker container. It checks fresh and populated reruns, capabilities, private buckets, grants and recovery paths, then removes only its own database. The track-specific suites in `database/tests/` cover more edge cases.

## 5. Maintenance workers

Each worker endpoint needs `Authorization: Bearer <CRON_SECRET>` and valid server configuration. Secrets in the query string are refused. Missing server configuration returns 503 before any work, and a bad secret returns 401.

| Endpoint | What it does and how often |
| --- | --- |
| `GET /api/media/maintenance` | Legacy retention, archive, delete and orphan work, plus voice cleanup when voice is on. `/api/retention` is an alias, so don't schedule both. Every 15 minutes, with repeated runs to drain the queue. |
| `GET /api/reminders` | Legacy dates, rituals and opted-in event expiry reminders. Every 15 minutes. |
| `GET /api/projects/maintenance` | Project original verification and cleanup, one job per lane per call. Uploads must finish within ten minutes, so schedule and load-test enough passes. |
| `GET /api/events/maintenance` | Event verification and cleanup. Starts at least every 60 seconds, with overlapping runs allowed. A good pass renews a 150-second heartbeat, and a stale heartbeat blocks new uploads. |

Unfinished retries return 503 with the jobs kept for the next run. Inspect failed jobs before retrying one with the `pb_retry_media_job` RPC. Use your exact production host in the scheduler, because many schedulers don't follow `www` or apex redirects.

### Cloudflare scheduler

[`workers/maintenance-scheduler/index.ts`](../workers/maintenance-scheduler/index.ts) is a Cloudflare Worker that calls these endpoints, with [focused tests](../tests/cloudflare-scheduler.test.ts). Before deploying it for your own copy:

1. Change `ORIGIN` in `index.ts` to your app's origin. It points at the original deployment.
2. Note that the checked-in [`wrangler.jsonc`](../workers/maintenance-scheduler/wrangler.jsonc) has no crons and every switch set to `"false"`. Deploying it as-is provisions the worker with all jobs stopped, and it will replace settings made in the dashboard.
3. Enter `CRON_SECRET` as a secret, matching the app's value:

   ```sh
   wrangler deploy --config workers/maintenance-scheduler/wrangler.jsonc
   wrangler secret put CRON_SECRET --config workers/maintenance-scheduler/wrangler.jsonc
   ```

4. After your checks pass, set `SCHEDULER_ENABLED="true"` and only the job switches you need (`EVENTS_ENABLED`, `PROJECTS_ENABLED`, `MEDIA_ENABLED`, `REMINDERS_ENABLED`), then add the crons. `* * * * *` dispatches events and projects only; `*/15 * * * *` dispatches media and reminders only. A legacy-only set-up needs just the 15-minute cron with media and reminders.

The worker refuses redirects, aborts each request after 120 seconds and logs only fixed labels, status and timing. `http_ok` means the endpoint acknowledged the call, not that the queue is empty.

Any other scheduler works if it sends the bearer header, waits for each response and meets the cadences above.

### Event workers

`/api/events/maintenance` needs a scheduler that starts it at least every 60 seconds and lets runs overlap. Handler guards and database leases stop two runs claiming the same job. A scheduler that skips a start while a long run is still going doesn't meet this, so keep `PB_EVENTS_ENABLED` off until yours does. Each pass claims one job with a 90-second deadline, and finalising comes before cleanup.

New guest uploads need a worker heartbeat less than 150 seconds old and room in the admission limit, which allows two pending submissions across the whole deployment. When either is missing, new reservations return `not_ready`, while receipts, exports, withdrawal and cleanup keep working. Only a good pass renews the heartbeat, so restore the worker rather than forcing it.

To run passes yourself, put `PB_PUBLIC_ORIGIN`, `CRON_SECRET` and `PB_EVENTS_ENABLED=true` in the process environment. These scripts never read `.env` files, and without `--apply` they make no network calls.

```sh
node --import tsx scripts/run-event-worker.ts
node --import tsx scripts/run-event-worker.ts --apply --max-passes=3 --deadline-ms=300000
```

The runner exits 0 after a dry run, an idle worker or the pass limit, 2 after `retry`, `refused`, `deadline` or `cancelled`, and 1 for invalid configuration.

Migration 027 adds a deployment-wide admission pause. Put `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the process environment, read the current revision, then pass it to pause or resume:

```sh
node --import tsx scripts/control-event-admission.ts --action=status --apply
node --import tsx scripts/control-event-admission.ts --action=pause --expected-revision=REVISION --apply
node --import tsx scripts/control-event-admission.ts --action=resume --expected-revision=REVISION --apply
```

A pause stops new reservations and upload links, but uploads already accepted can still finish. Keep the scheduler and `PB_EVENTS_ENABLED=true` running so the queue drains. Turning off the whole event switch also stops its worker, so it isn't a cleanup strategy.

Before you open events to guests, run one worker pass to create the first heartbeat, and rehearse a reserve, upload and finalise within the ten-minute deadline. Then stop the scheduler and check that new reservations fail after 150 seconds while receipts still load, and that queued work resumes once it restarts.

### Memory backfill

After applying the memory migrations and before turning on `PB_MEMORIES_ENABLED`, record activity for existing strips and photos. Put `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the process environment:

```sh
node --import tsx scripts/backfill-memory-activity.ts
node --import tsx scripts/backfill-memory-activity.ts --apply --batch-size=25 --max-batches=10 --deadline-ms=60000
```

The first command is a dry run. Repeat the applied run until it reports `no_unlocked_work`. After `uncertain`, wait for the database to settle, then rerun the same command. Reruns skip anything already recorded.

## 6. Before you turn on a hosted feature

1. Rehearse the matching migrations and the scope and capacity tests on a disposable database, then check your hosted provider separately.
2. Configure `PB_PUBLIC_ORIGIN`, the auth callbacks, service credentials and trusted IP headers. Keep room and event secrets separate, and never log service keys, receipt tokens or signed URLs.
3. Schedule each worker and check its real cadence, run time and retry behaviour.
4. Turn on only the feature switches whose checks have passed. Keep a compatible recovery build ready, watch for failed jobs, and never reset accounting to free up capacity.

Limits to plan hosting around:

- **Cloud projects** (`PB_CLOUD_PROJECTS_ENABLED`). Each `/api/projects/maintenance` call sweeps up to 25 expired reservations and runs one finalisation and one cleanup. The route can take up to 120 seconds and needs enough memory to decode one image.
- **Voice captions** (migration 014, `PB_MEMORIES_ENABLED` and `PB_VOICE_CAPTIONS_ENABLED`). Recordings are mono WAV of up to 30 seconds, and each person can hold up to 20. `/api/media/maintenance` cleans them up.
- **Reminders.** Each `/api/reminders` run handles at most five reminders within 45 seconds, shared by legacy dates, rituals (migration 010, `PB_MEMORIES_ENABLED`) and event expiry reminders (migration 021, `PB_EVENT_REMINDERS_ENABLED`). Event owners who opt in are reminded 24 hours before expiry. An email is retried only with the same content within 23 hours, using Resend's idempotency key.

## Rolling back

Keep a build that can still read, export and maintain data written by the current version. Don't clear IndexedDB, down-migrate data or return to a baseline that can't read accepted records. Stopping new writes must not stop the cleanup that's already owed, so read the worker runbook before turning switches off.
