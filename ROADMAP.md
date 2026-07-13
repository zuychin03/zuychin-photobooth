# Roadmap

Zuychin Photobooth is a remote photobooth for long-distance couples and small
groups: shoot Life4Cuts-style strips together from anywhere, on one synchronized
countdown. It is part of the Zuychin ecosystem (Zuychin Gallery, UsTime).

This file tracks what is shipped and what is planned. Per-release detail lives in
[`CHANGELOG.md`](CHANGELOG.md).

## Shipped

### Stage 1 — Core booth and live rooms
- Solo booth: layout picker, mirrored preview, 3-2-1 countdown with flash and
  shutter sound, front/back camera toggle, upload fallback when the camera is
  blocked.
- Strip editor: frame colors, live-preview filters (applied losslessly after
  capture), captions, film-style datestamp, draggable stickers, 2x PNG export and
  mobile share sheet.
- Live rooms: create/join by 6-character code, WebRTC peer-to-peer with Supabase
  Realtime signaling (BroadcastChannel fallback for same-browser dev), a
  clock-synchronized shutter, full-resolution frame exchange, and pose prompt
  roulette rolled from a shared seed.
- Sticker library: 8 packs of 8 in three styles (Flat and 3D bundled Fluent Emoji,
  plus frame-tinted monochrome Ink).

### Stage 2 — Together mode and groups
- Together scenes: MediaPipe selfie segmentation cuts everyone out of their own
  background and composites them into one shared backdrop per cut, with 6
  canvas-drawn scenes and per-person placement controls.
- Live scene preview in the room: pose into the shared scene before the shot; the
  chosen scene syncs to every screen and rides along into the editor.
- Group rooms for up to 4 over a full WebRTC mesh: host-assigned roles, a live pane
  per member, and trio/quad layouts that appear once 3 or more people join.

### Stage 3 (foundation) — Accounts and shared timeline
- Sign in with a Zuychin account (shared Supabase project with Zuychin Gallery, so
  it is the same identity): email + password or magic link.
- Couple pairing via a share code.
- Save a finished strip to a private couple timeline (private Storage bucket,
  couple-scoped by RLS, served via signed URLs).
- Fully optional: with no Supabase env configured, the booth works unchanged and
  the account UI stays hidden. See [`SUPABASE_SETUP.md`](SUPABASE_SETUP.md).

## Planned

### Stage 3 (remainder)
- Async relay strips: one partner shoots their half, the other completes it later
  from a link. Timezone-proof.
- Rituals and timeline: scheduled photo dates with reminders, a streak counter, a
  monthly auto-compiled strip, and anniversary compilations.

### Stage 4 — Ecosystem integration
- Push a saved strip into a real Zuychin Gallery album (Cloudinary).
- UsTime: photo-date calendar events deep-link into a booth room, and the finished
  strip attaches back to the calendar day.

## Backlog (nice-to-have)
- AI pose prompts generated from context (occasion, anniversary number).
- AI-generated shared-scene backdrops for Together mode.
- GIF / live-photo cuts: a short synced burst per cut exported as an animated strip.
- Voice note attached to a saved strip.
- AR face props during the live preview.
- Larger rooms via an SFU (beyond the ~4 the mesh handles comfortably).
- PWA install and an offline solo booth.
- Print-ready strip export (4x6 / 2x6 PDF at real Life4Cuts dimensions).
- Yearly "our year in strips" recap.
