# Zuychin Photobooth

A photobooth for two, any distance. Snap Life4Cuts-style photo strips together from anywhere: one room code, one synchronized countdown, two cameras, one strip. Built for long-distance couples and small groups of friends.

Strips are captured, composed, and exported right in the browser, and in a shared room the frames travel only peer to peer. Anything you choose to save is stored privately, just for the two of you.

## Features

- **Solo booth**: pick a layout, pose through a 3-2-1 countdown with flash and shutter sound, and get a strip of 3 or 4 shots. No retakes per shot, that's the booth way.
- **Live rooms for up to 4**: create a room, send the code, and shoot together over a WebRTC mesh. Anyone can press the shutter; a clock-synchronized countdown fires every camera at the same instant (typically within a few tens of milliseconds).
- **Together mode**: pick a scene and MediaPipe segmentation cuts everyone out of their own background and composites them into one shared backdrop, previewed live before the shot.
- **Full-resolution exchange**: each device captures its own camera at native resolution and sends the frame over the data channel, so nobody's part of the strip is a compressed video screenshot.
- **True-to-strip viewfinder**: the live camera view is boxed to the exact crop that lands on the strip, solo and in rooms; what you frame is what you get.
- **Pose prompt roulette**: every screen rolls the same random prompt for each cut ("mirror each other's pose", "everyone point left").
- **Strip editor**: 7 frame colors, 6 live-preview filters (applied losslessly after capture), captions, a film-style orange datestamp, and draggable stickers.
- **Sticker library**: 8 packs of 8 stickers in three rendering styles: Flat and 3D (bundled Fluent Emoji assets, consistent on every device) and Ink (monochrome glyphs tinted to the frame color).
- **Layouts**: classic 4-strip, 2x2 grid, and tall three for solo; taking turns, side-by-side, and twin strips for duos; trio and quad strips for groups.
- **Export**: 2x-resolution PNG download and native share sheet on mobile. Camera denied? Build a strip from uploaded photos instead.
- **Accounts and a Shared Vault** (optional): sign in, pair with your partner via a code, and save strips to one private couple vault, backed by your own Supabase project. Without one configured, the booth works exactly the same and the account UI stays hidden.
- **Relay strips** (optional): shoot your half now and your partner finishes the strip whenever they can, no need to be online together. Plus a weekly streak counter in the vault.
- **Photo dates and recaps** (optional): schedule recurring photo dates that email both partners a reminder, and compile a week's strips into one shareable recap image.
- **Weekly vault with a keep switch** (optional): the Shared Vault holds up to 10 strips per couple each week; when the next week starts it clears out, archiving bookmarked strips and weekly recaps to Cloudinary first (when configured) so they last, and deleting the rest.
- **Installable PWA**: add it to your home screen (there's an install button on the landing page) and it opens like an app. Build assets are cached on first use, so the solo booth and editor keep working offline once you've visited them.
- **Push notifications** (optional): enable the bell in the vault and get nudged when it's your turn on a relay strip, when your partner saves a strip, and when a photo date is due. Free web push via your own VAPID keys, no service account.

## Tech stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| Styling | Tailwind CSS v4 with CSS-variable design tokens |
| Fonts | Geist, Fraunces, Noto Emoji (monochrome) via next/font |
| Realtime signaling | Supabase Realtime broadcast channels |
| Media | WebRTC peer-to-peer, getUserMedia, Canvas 2D |
| Icons | lucide-react |
| Sticker assets | Microsoft Fluent Emoji (bundled SVG/PNG) |

## Getting started

Requires Node.js 20.9 or later.

```bash
npm install
cp .env.example .env.local   # then fill in the values below
npm run dev
```

Open http://localhost:3000.

### Environment variables

All variables are optional for local development. See `.env.example` for the template.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL, for WebRTC signaling and (if the schema is installed) accounts + the shared album |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `NEXT_PUBLIC_TURN_URL` | TURN relay URL(s) for networks where direct peer-to-peer fails. Must start with `turn:`/`turns:`; comma-separate multiple transports |
| `NEXT_PUBLIC_TURN_USERNAME` | TURN credential |
| `NEXT_PUBLIC_TURN_CREDENTIAL` | TURN credential |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only; used by the reminder and retention crons |
| `NEXT_PUBLIC_COOKIE_DOMAIN` | Optional; shares the login cookie across sibling apps of your own served under one parent domain (see Supabase setup below) |
| `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME` | Cloudinary account for archiving kept strips past the weekly reset. Optional |
| `CLOUDINARY_API_KEY` | Cloudinary key (server-only) |
| `CLOUDINARY_API_SECRET` | Cloudinary secret (server-only) |
| `RESEND_API_KEY` | Resend key for reminder emails (optional) |
| `REMINDER_FROM` | Verified sender for reminder emails (optional) |
| `CRON_SECRET` | Shared secret guarding the `/api/reminders` and `/api/retention` cron routes (optional) |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Web push: VAPID public key (`npx web-push generate-vapid-keys`). Optional |
| `VAPID_PRIVATE_KEY` | Web push: VAPID private key (server-only) |
| `VAPID_SUBJECT` | Web push: `mailto:` contact sent to push services |

Without Supabase configured, rooms fall back to a BroadcastChannel: two tabs in the same browser can pair (handy for development), but two devices cannot, and the account features stay hidden. Without TURN, some mobile and cross-country connections will fail to establish; free credentials are available from providers such as metered.ca or ExpressTURN.

To enable accounts and the Shared Vault, create a free Supabase project and follow [Setting up Supabase](#setting-up-supabase) below.

### Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript, no emit |

## Setting up Supabase

Everything here is optional — the booth runs with no backend. Add Supabase to
enable accounts, pairing, and the **Shared Vault**. Any free project works, and
everything the script creates is `pb_`-prefixed and additive, so it coexists
with other apps of your own on the same project.

**1. Environment.** From Project Settings → API:

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

`NEXT_PUBLIC_*` values are baked in at build time, so redeploy after changing them.

**2. Database.** In **SQL Editor → New Query**, paste and run
[`supabase-setup.sql`](supabase-setup.sql) once. It is the entire schema
end-to-end — a `profiles` identity mirror (created only if the project has
none), `pb_couples`, `pb_strips`, relays, photo dates, the weekly-retention and
Cloudinary-archive columns, every RLS policy, and the Storage policies — and it
is safe to re-run.

**3. Storage bucket.** In **Storage → New bucket**, create `photobooth-strips`
as **Private**. Its policies are already in the script; a strip is stored at
`<owner-uid>/<strip-id>.png` and only the owner and their paired partner can
read it, through short-lived signed URLs.

**4. Auth.** Enable the **Email** provider. The login page offers email +
password and magic link (a magic link creates the account on first sign-in).
Under **Authentication → URL Configuration**, set **Site URL** to your
production URL and add `https://<your-app>/auth/callback` (plus
`http://localhost:3000/**` for development) to **Redirect URLs** — magic links
silently fall back to the Site URL when the callback is not allowlisted.

**5. The weekly reset and reminders (optional crons).** The Shared Vault holds
at most 10 strips per couple per week. When a new week begins, a cron clears it:
bookmarked strips and weekly recaps are archived first (see step 6), everything
else is deleted. Photo-date reminder emails run on the same mechanism. Both need:

```
SUPABASE_SERVICE_ROLE_KEY=...   # server-only, never exposed to the browser
CRON_SECRET=...                 # any random string
```

Point a scheduler ([cron-job.org](https://cron-job.org) is free) at these, with
header `Authorization: Bearer <CRON_SECRET>` (or `?secret=<CRON_SECRET>`):

- `https://<your-app>/api/retention` — the weekly clear. Run it at least once a
  day so the vault empties on the rollover. Returns
  `{ cleared, archived, skipped, weekStart }`, or
  `{ skipped: "service role not configured" }` until the service role is set, so
  nothing is deleted before you wire it up.
- `https://<your-app>/api/reminders` — photo-date reminders; every 15 minutes is
  plenty. Delivers by email with a [Resend](https://resend.com) key
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

Without these, bookmarking still spares a strip from the weekly delete, but it
lives only in Supabase Storage. Where kept strips are displayed afterward is up
to you — any app of your own with the same Cloudinary credentials and read
access to `pb_strips` can sign delivery URLs from `cloudinary_public_id` (RLS
scopes rows to the owner and their partner).

**7. Push notifications (optional web push).** Generate a VAPID key pair once
(`npx web-push generate-vapid-keys`) and set:

```
NEXT_PUBLIC_VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...            # server-only
VAPID_SUBJECT=mailto:you@example.com
```

A bell appears in the Shared Vault header; each partner enables notifications
per browser (on iPhone the app must be installed to the home screen first,
iOS 16.4+). You'll get a nudge when it's your turn on a relay strip, when your
partner saves a strip to the vault, and when a photo date is due (alongside or
instead of the email). Delivery rides the browser vendors' push services — no
account or fee involved.

**8. One login across your own apps (optional).** If you serve several of your
own apps under one parent domain (say `booth.example.com` and
`photos.example.com`) against the same project, set
`NEXT_PUBLIC_COOKIE_DOMAIN=.example.com` (leading dot, identical in every app)
to share the auth cookie, and add each app's `/auth/callback` to the Redirect
URLs. Leave it blank on localhost or a standalone deploy.

## How a shared room works

1. The host creates a room (a 6-character code) and shares the link; up to 3 more people can join.
2. Supabase Realtime carries the WebRTC offer/answer/ICE handshake; the browsers then connect directly in a full mesh. The host assigns roles (A-D) in join order and broadcasts the roster.
3. When someone presses the shutter, the leader schedules a fire time and every peer estimates its clock offset over the data channel, so all cameras capture at the same moment.
4. Each peer sends its full-resolution JPEG to the others over the data channel. Everyone ends up with every original and can edit and export the identical strip.

## Project structure

```
app/
  page.tsx            landing: solo booth, create room, join room
  booth/              solo capture flow
  room/[code]/        live shared room
  customize/          strip editor and export
  timeline/           the Shared Vault: pairing, strips, relays, photo dates
  relay/              async relay strips (shoot your half, finish theirs)
  login/              email + magic-link sign-in
  api/                keep, push/notify, reminders, retention (cron) routes
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
  rtc/                signaling, peer engine, clock sync
public/stickers/      bundled Fluent Emoji assets (flat SVG, 3D PNG)
supabase-setup.sql    complete Supabase schema, run once in the SQL editor
```

## Roadmap

- GIF / live-photo cuts: a short synced burst per cut, exported as an animated strip.
- Print-ready export (4x6 / 2x6 PDF at real Life4Cuts dimensions).
- AR face props during the live preview.
- AI pose prompts and AI-generated Together-scene backdrops.
- Larger rooms via an SFU (beyond the ~4 the mesh handles comfortably).
- Yearly "our year in strips" recap.

## Credits

- Sticker artwork from [Fluent Emoji](https://github.com/microsoft/fluentui-emoji) by Microsoft, MIT license.
- Ink-style glyphs rendered with [Noto Emoji](https://fonts.google.com/noto/specimen/Noto+Emoji), SIL Open Font License.
