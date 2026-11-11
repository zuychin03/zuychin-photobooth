# Zuychin Photobooth

A photobooth that runs in the browser. Take a photo strip on your own, make one with friends on other devices, or collect photos at an event. The booth, editor, projects and exports work on your device with no account and no server setup. Cloud features are optional and run on your own Supabase project.

**Version 3.0.0.** V3 brings a Liquid Glass redesign, 14 new layouts, strip styles and a light/dark theme toggle. The [V3 strip plan](V3_STRIPS_PLAN.md) and the [V2 plan](V2_PLAN.md) explain how each feature was scoped.

## Features

### Make a strip

- **Solo booth.** A 3, 5 or 10-second timer, camera choice, mirror and a screen fill light. Retake or replace any shot and keep the rest. No camera? Import photos instead.
- **23 layouts.** Pick a shape (Strips, Grids, Feature, Wide, Single or Together), then a layout drawn as a mini diagram. There are 11 solo, 5 duo and 7 group layouts, and solo layouts take up to 8 photos.
- **Strip editor.** Reorder photos and crop, zoom, rotate, mirror or filter each one, with undo and redo. Add frames (including gradients), themes, patterns, stickers and a caption.
- **Date stamp.** Shows the day the photos were taken, or any day you pick. Put it in the footer or on the photo, in one of three formats.
- **Strip style.** Photo finish (classic, rounded, keyline or lifted), film edges, spacing, caption position, a one-line footer and the caption font.
- **Stickers.** 8 packs of 8 in Flat, 3D and Ink styles.
- **Scenes and materials.** 18 scenes and 6 frame materials, with favourites and packs you can save for offline use.
- **Templates.** Save a reusable frame with photo slots, text, stickers and PNG decorations, and share it as a `.pbtemplate` file.
- **Export studio.** PNG or JPEG in several sizes, print-ready PDFs with cut marks, and GIF, MP4 or WebM motion.
- **Projects.** Edits autosave on your device. Keep a `.pbproject` backup, because browsers can clear their storage.
- **Then & Now.** Line up an old photo with a new one and export a comparison.

### Together

- **Live rooms** for 2 to 4 people. The host admits people and can lock the room. Everyone opens their own camera, and each person's original photo is sent separately from the video.
- **Shared scene preview.** Browsers that can segment people place everyone in one scene. Others fall back to separate tiles.
- **Photo stories.** Twelve guided decks of poses and prompts for dates, friends, celebrations and seated photos.
- **Relays and challenges** (optional). Shoot your half now and someone else finishes the strip later.

### Optional cloud features

These need Supabase, the database migrations and their own feature switch. Each one is off by default.

- **Accounts and the Shared Vault.** Sign in, pair with a partner and save strips to one private vault.
- **Cloud projects.** Save editable designs to your account and reopen them on another device.
- **Memories and rituals.** Chapters, a yearly recap, reminders and private voice captions.
- **Events.** Account-free QR uploads, private receipts, moderation, a gallery and wall, kiosk mode, a guestbook and postcards.
- **Reminders.** Email through Resend and web push.

It also installs as a PWA, keeps the local tools working offline, and follows your system's light or dark theme until you pick one.

## Quick start

You need Node.js 22 or later.

```bash
git clone https://github.com/zuychin03/zuychin-photobooth.git
cd zuychin-photobooth
npm ci
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000. The local tools work with `.env.local` exactly as copied. Browsers only allow the camera on `localhost` or over HTTPS.

To try cloud features, set up Supabase as described in [Self-hosting](docs/SELF_HOSTING.md).

## Release modes

`PB_RELEASE_MODE` decides what a deployment offers.

| Mode | What it's for |
| --- | --- |
| `local` | The booth, editor, projects, templates, exports and legacy live rooms. Needs no database. Production uses this when the setting is missing. |
| `full` | Adds the cloud features you've switched on and set up. |
| `recovery` | A fallback that keeps sign-in, reads, exports and cleanup working, but refuses new uploads and sharing. |

Development runs as `full` unless you set `local`, which the example env file does. [Self-hosting](docs/SELF_HOSTING.md) covers each mode in detail.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript, no emit |
| `npm test` | Unit and contract tests for projects, media, rooms, memories, events and branding |
| `npm run test:rehearsal` | Service worker, fallback and rollback rehearsals using synthetic files and loopback HTTP |
| `npm run check` | Typecheck, lint and tests. CI runs this, then the rehearsals and a build. |
| `node database/tests/run-local.mjs` | PostgreSQL lifecycle and concurrency tests in a Docker fixture |
| `node database/tests/run-rest.mjs` | PostgreSQL and PostgREST integration tests in their own containers |
| `node database/tests/run-full-chain.mjs` | The baseline plus every numbered migration on a disposable database |

In development, `/v2-lab` has rehearsal pages for storage, canvas, media, print geometry and synthetic rooms and events. They never ask for the camera or microphone, and they return 404 in production.

## Documentation

- [Contributing](CONTRIBUTING.md): setup, checks, and code, design and copy conventions.
- [Self-hosting](docs/SELF_HOSTING.md): running your own copy, Supabase, migrations and maintenance workers.
- [V3 strip plan](V3_STRIPS_PLAN.md) and [V2 plan](V2_PLAN.md): what each version set out to build.
- [Development status](docs/development/V2_STATUS.md): which checks have and haven't passed on real hosting and devices.
- [`docs/development/`](docs/development/): the contract and evidence notes for each part of V2.
- [Product brief](PRODUCT.md): who the app is for and its design principles.
- [Security policy](SECURITY.md): how to report a vulnerability.

## Tech stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| Styling | Tailwind CSS v4 with CSS-variable tokens and Liquid Glass surfaces |
| UI fonts | Mochiy Pop One and Zen Maru Gothic |
| Strip fonts | Fraunces, Geist and Geist Mono, plus Noto Emoji for Ink stickers |
| Rooms | WebRTC peer mesh with scoped server signalling. Legacy rooms use Supabase Realtime. |
| Media | getUserMedia, Canvas 2D and MediaPipe segmentation |
| Storage | IndexedDB on the device, and optional Supabase (Postgres, Auth and Storage) |
| Tests | Node's test runner with tsx, and Docker-based SQL suites |
| Icons | lucide-react |

## How a live room works

1. Open Together and create a room. The six-character code finds the room. An HttpOnly browser capability, not the code, authorises what each person can do.
2. The host admits people and can lock entry. Each person opens their own camera. Media and original photos travel through the peer mesh.
3. Everyone picks the shared story and look. Anyone can ask to take the photo, and the host commits the capture plan once every camera is ready.
4. Each device saves its own original before the shot counts. Missing photos stay visible, and you can retry or resend them without taking another shot.
5. The host orders the shared finishing, and each person edits only their own layers. Everyone leaves with their own editable copy. Older room links still open the legacy room.

## Project structure

```
app/
  page.tsx              home: Create, Together and Events
  booth/                solo capture, stories and Then & Now
  customize/            strip editor and export studio
  projects/             device and account projects
  templates/            template shelf and frame designer
  together/, room/      live rooms and their entry
  relay/, challenges/   asynchronous strips
  memories/, timeline/  memories, rituals and the Shared Vault
  events/, e/, receipt/ event hosting, guest uploads and private receipts
  api/                  room, project, memory and event APIs, and workers
  v2-lab/               development-only rehearsal pages
components/             UI, including LayoutPicker and StripStyleControls
hooks/                  camera lifecycle and other shared hooks
lib/
  layouts.ts            layout catalogue and shared strip geometry
  compose.ts            canvas strip composition for preview and export
  strip-style.ts        strip style options and date formatting
  projects/             versioned project model, IndexedDB and bundles
  templates/, exports/  template recipes, and still, PDF and motion output
  rtc/                  signalling, transfer journals and the room workspace
  memories/, events/    browser clients for cloud features
  server/               verified-actor services, handlers and maintenance
database/
  migrations/           forward-only SQL migrations, 001 to 029
  tests/                SQL and PostgREST suites
workers/                Cloudflare scheduler for the maintenance endpoints
supabase-setup.sql      legacy baseline plus migration 001
```

## Status

V3 is built on the V2 foundation. The local tools are complete and covered by tests. Hosted checks still need sign-off before the cloud features go live: providers and capacity, schedulers, physical phones, forced-TURN rooms and physical prints. The [development status](docs/development/V2_STATUS.md) tracks each one.

## Credits

- Sticker artwork from [Fluent Emoji](https://github.com/microsoft/fluentui-emoji) by Microsoft, MIT licence.
- Fonts: [Mochiy Pop One](https://fonts.google.com/specimen/Mochiy+Pop+One), [Zen Maru Gothic](https://fonts.google.com/specimen/Zen+Maru+Gothic), [Fraunces](https://fonts.google.com/specimen/Fraunces), [Geist](https://vercel.com/font) and [Noto Emoji](https://fonts.google.com/noto/specimen/Noto+Emoji), all under the SIL Open Font License.

## Licence

[MIT](LICENSE).
