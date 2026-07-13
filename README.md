# Zuychin Photobooth

A photobooth for two, any distance. Snap Life4Cuts-style photo strips together from anywhere: one room code, one synchronized countdown, two cameras, one strip. Built for long-distance couples and small groups of friends.

Photos never touch a server. Everything is captured, composed, and exported in the browser; in a shared room, frames travel only peer to peer.

## Features

- **Solo booth**: pick a layout, pose through a 3-2-1 countdown with flash and shutter sound, and get a strip of 3 or 4 shots. No retakes per shot, that's the booth way.
- **Live rooms for up to 4**: create a room, send the code, and shoot together over a WebRTC mesh. Anyone can press the shutter; a clock-synchronized countdown fires every camera at the same instant (typically within a few tens of milliseconds).
- **Together mode**: pick a scene and MediaPipe segmentation cuts everyone out of their own background and composites them into one shared backdrop, previewed live before the shot.
- **Full-resolution exchange**: each device captures its own camera at native resolution and sends the frame over the data channel, so nobody's part of the strip is a compressed video screenshot.
- **Pose prompt roulette**: every screen rolls the same random prompt for each cut ("mirror each other's pose", "everyone point left").
- **Strip editor**: 7 frame colors, 6 live-preview filters (applied losslessly after capture), captions, a film-style orange datestamp, and draggable stickers.
- **Sticker library**: 8 packs of 8 stickers in three rendering styles: Flat and 3D (bundled Fluent Emoji assets, consistent on every device) and Ink (monochrome glyphs tinted to the frame color).
- **Layouts**: classic 4-strip, 2x2 grid, and tall three for solo; taking turns, side-by-side, and twin strips for duos; trio and quad strips for groups.
- **Export**: 2x-resolution PNG download and native share sheet on mobile. Camera denied? Build a strip from uploaded photos instead.
- **Accounts and shared timeline** (optional): sign in with your Zuychin account (shared with Zuychin Gallery), pair with your partner via a code, and save strips to one private couple timeline. Without accounts configured, the booth works exactly the same and the account UI stays hidden.

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
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL, for WebRTC signaling and (if the schema is installed) accounts + timeline |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `NEXT_PUBLIC_TURN_URL` | TURN relay URL for networks where direct peer-to-peer fails |
| `NEXT_PUBLIC_TURN_USERNAME` | TURN credential |
| `NEXT_PUBLIC_TURN_CREDENTIAL` | TURN credential |

Without Supabase configured, rooms fall back to a BroadcastChannel: two tabs in the same browser can pair (handy for development), but two devices cannot, and the account features stay hidden. Without TURN, some mobile and cross-country connections will fail to establish; free credentials are available from providers such as metered.ca.

To enable accounts and the shared timeline, point these at the same Supabase project as Zuychin Gallery and follow [`SUPABASE_SETUP.md`](SUPABASE_SETUP.md).

### Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript, no emit |

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
components/           camera preview, countdown, filter bar, strip mockup
hooks/useCamera.ts    getUserMedia lifecycle and device switching
lib/
  layouts.ts          strip geometry definitions
  compose.ts          canvas strip composition (preview and export)
  filters.ts          filter definitions (CSS and canvas parity)
  capture.ts          frame capture and blob helpers
  decor.ts            frames, sticker packs, sticker styles
  prompts.ts          pose prompt packs and seeded roulette
  rtc/                signaling, peer engine, clock sync
public/stickers/      bundled Fluent Emoji assets (flat SVG, 3D PNG)
```

## Roadmap

- Together mode: segment both people out of their backgrounds and composite them into one shared scene per cut.
- Async relay strips: one partner shoots their half, the other completes it later.
- Accounts, strip history, and couple rituals (scheduled photo dates, monthly strips).
- Zuychin ecosystem integration.

## Credits

- Sticker artwork from [Fluent Emoji](https://github.com/microsoft/fluentui-emoji) by Microsoft, MIT license.
- Ink-style glyphs rendered with [Noto Emoji](https://fonts.google.com/noto/specimen/Noto+Emoji), SIL Open Font License.
