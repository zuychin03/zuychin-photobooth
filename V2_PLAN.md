# Zuychin Photobooth V2 plan

Status: approved by Danny. P0–P8 have local implementation evidence; P9 verification and release acceptance remain open. Updated 24/09/2026. See [development status](docs/development/V2_STATUS.md) for implemented work, evidence and remaining gates.

Sequencing update, 23/09/2026: Danny deferred real-phone testing because his Android device is not currently available for a test session. Complete local P0 and continue local implementation with phone acceptance pending. This does not waive device evidence before release or phone capability claims. See [P0 decisions](docs/development/P0_DECISIONS.md).

Prepared: 22/09/2026. Baseline: `main` at `6fd2387`, initially clean. Target: `2.0.0`, the V2 product update requested by Danny. P0 reconciled the package metadata to the locally documented `0.13.0` baseline; P9 now declares `2.0.0` in the package and lockfile. This is local release metadata, not evidence of deployment or final acceptance.

Environment update, 24/09/2026: Danny has no disposable staging environment and requested localhost for current testing. Local synthetic and disposable-database rehearsals may proceed; provider, real authentication and cross-subdomain acceptance remain unverified.

Scope update, 23/09/2026: Danny removed Vietnamese support. V2 uses an English interface and English authored pose prompts, with no language switcher. User-written Unicode captions and timezone-aware dates remain supported. This supersedes the earlier EN/VI requirement.

## 1. Outcome and scope

Make Zuychin Photobooth a connected place to create a keepsake alone, make one with people elsewhere, or collect them at a party. Danny explicitly requested all three directions in one large update. This plan includes all three; parts are delivery checkpoints within that update, not a reduction to a couples-only release.

The product has three entry points: **Create**, **Together**, and **Events**. They reuse the same capture, editable project, theme and export tools. Existing `/booth`, `/room/[code]`, `/customize`, `/timeline` and relay links continue to work. No account is required for local creation; cloud memories and event hosting remain optional.

The strongest potential distinction is continuity: a guided pose can be completed live, later through a relay, or by a remote guest at a physical event; its source images remain editable and its result can become a print, animation or revisitable memory. This is a product hypothesis, not a claim of worldwide originality.

Companion deliverables:

- [Market research and source register](docs/research/V2_MARKET_RESEARCH.md): direct browser competitors, creative/couple products and event systems, with pricing and evidence limitations.
- [Generated asset manifest and exact prompts](docs/assets/v2/ASSET_MANIFEST.md): 24 selected imagegen assets, comprising 18 backdrops and six material textures, with a [visual catalogue](docs/assets/v2/catalogue.html).
- [Source audit and verification record](docs/research/V2_CODEBASE_AUDIT.md): baseline capabilities, evidence and prerequisites.

Non-goals for V2: replacing Next.js/Supabase, changing hosting provider, merging sibling repositories, a public social network/template marketplace, payments, face recognition, AI face replacement, DSLR/360 hardware support, unattended printer control, or more than four simultaneous cameras in one live room. An event can have many independent guest sessions without putting everyone into one video call.

## 2. Grounded starting point

Read: README, ROADMAP, CHANGELOG, local handoff and project notes, generated repository wiki, package scripts, camera/session/composition/scene code, RTC, storage policies, relay, reminders, retention and service worker. The installed Next.js route-handler guide was checked; implementation must consult the installed guides for each changed framework area.

| Already implemented | Consequence for V2 |
| --- | --- |
| Solo camera/upload, eight layouts, six filters, seven frame colours | Improve control and recovery rather than selling basic capture as new. |
| Six theme presets, seven patterns, 64 Fluent stickers in three styles | Retain the existing visual system and extend it with reusable recipes. |
| Up to four RTC peers, synchronised still capture, full-resolution JPEG exchange | Harden this transport before adding collaborative editing or motion. |
| Six procedural Together scenes, local segmented preview, composited final result | A live preview containing all participants is a genuine addition to this codebase. |
| Optional couple vault, duo relay, reminders, push, weekly recap and archive | Extend these into guided memories; do not rebuild them as parallel features. |
| PWA and visited-asset caching | Offline assets exist; recovery of unfinished sessions does not. |

Important drift: README implies an all-person live Together preview; source paints the local person only. ROADMAP still lists shipped PWA work as backlog and refers to an absent setup document. Current retention is an ISO-week reset, not seven elapsed days after each capture. The generated testing wiki is guidance, not an implemented test suite. Source takes precedence.

## 3. Feature selection

Priority reflects dependency and user value, not measured market demand. **Essential** establishes a usable/reliable workflow. **Signature** is a coherent differentiating hypothesis. **Enhancement** improves it once its foundation exists. Effort: S = bounded UI/domain addition, M = several components and tests, L = subsystem or cross-device work, XL = multiple subsystems and external validation. These are relative estimates, not delivery promises.

### Create: useful for solo users and reusable everywhere

| ID | Feature and bounded scope | Priority / effort | Acceptance and rationale |
| --- | --- | --- | --- |
| C1 | Local project library with autosave, resume, duplicate, rename, delete and portable project bundles | Essential / L | Refresh after each capture/edit, then resume with originals and settings intact. Clear distinction between saved on this device and uploaded. |
| C2 | Better capture: 3/5/10-second timer, named camera selection, mirror choice, optional screen fill light, single-shot retake and next-round reuse | Essential / M | Keep the current no-retake booth style as **Classic**, offer **Flexible** review. No forced microphone access. Camera denial still leads to import. |
| C3 | Import studio: mixed camera/uploads, reorder, per-cell crop/zoom/rotate/mirror/filter, undo/redo and keyboard controls | Essential / L | Preview/export parity, originals untouched, reasonable image limits, meaningful empty/error states. Auto-orient imports and strip location metadata from published derivatives. |
| C4 | Personal template shelf and constrained frame designer | Essential / L | Save layout/look/caption defaults; add bounded photo slots, text, stickers and PNG decoration. Private recipe export/import excludes source photos, tokens and personal captions by default. |
| C5 | Curated scene/theme packs with favourites and category browsing | Enhancement / M | Use existing themes plus the 18 generated scenes and six material textures. Photo-safe backgrounds, readable captions, full preview before applying, procedural fallback when assets are unavailable. Generate additional variants when a layout or occasion needs them. |
| C6 | Export studio: PNG/JPEG, story 1080 x 1920, square 1080 x 1080, wallpaper, exact-size PDF and A4 contact sheet | Essential / L | Show crop/fit and effective source resolution. 50.8 x 152.4 mm strips; 101.6 x 152.4 mm sheets with two strips; no stretching of existing layout geometry. |
| C7 | Motion keepsakes: animate existing shots, short solo boomerang, optional recorded video output | Enhancement / L | Start with four-shot GIF; bounded 2-second/12 fps/720p capture profile; cancellable encode; retain stills on failure. Actual output format is shown, never relabel WebM as MP4. |

### Together: couples and close friends

| ID | Feature and bounded scope | Priority / effort | Acceptance and rationale |
| --- | --- | --- | --- |
| T1 | Room lobby, readiness checks, host lock/admission, participant consent and reconnect recovery | Essential / XL | All intended peers ready before capture; no duplicate firing; recover interrupted frame transfer. Display missing participants/frames and offer retry or an explicitly incomplete result. |
| T2 | Guided four-cut photo stories | Signature / M | Launch with 12 authored decks across date, friends, celebration and accessible seated poses. Shared seed, director turns, skip and preview. No runtime AI dependency. |
| T3 | True shared Together preview | Signature / L | Everyone appears in the same live scene on capable devices, with consistent placement; two-person target first, adaptive four-person support. Local-only preview and final composition remain an honest low-power fallback. |
| T4 | Collaborative finishing | Enhancement / L | Shared recipe preview, host commits ordered changes, per-person layer ownership, versioned edits and transfer of an editable copy on exit. No CRDT or full live drawing suite in V2. |
| T5 | Then-and-now | Signature / M | Choose an owned/accessible original or import an old image, align with adjustable ghost overlay, recreate and export a dated comparison or alternating animation. If only a flattened strip exists, show the selected reference crop honestly. |
| T6 | Relay challenges and reciprocal reveal | Signature / L | Two to four people total, including the initiator, complete assigned slots asynchronously; optional reveal after all submit; cancel/expiry and partial-result choices. Server permissions withhold concealed media, not merely CSS. |
| T7 | Memory chapters, occasion labels, gentle rituals and annual recap | Enhancement / L | Build from retained accessible memories, fixed timestamps and durable activity records. Pause reminders, choose timezones, avoid punitive streaks. Never imply expired photographs can be recovered for a recap. |
| T8 | Optional voice caption, up to 30 seconds | Enhancement / M | Explicit mic request/recording indicator; playback never autoplays; text alternative; delete/export alongside the memory. No continuous call recording. |

### Events: parties with a complete host and guest lifecycle

| ID | Feature and bounded scope | Priority / effort | Acceptance and rationale |
| --- | --- | --- | --- |
| E1 | Event setup/dashboard: title, date, timezone, look, capacity, contribution window and expiry | Essential / XL | Preview/test event, open/pause/close, occupancy/storage status, failed uploads and clear export/delete controls. Closing stops contributions without deleting media. |
| E2 | QR invitation, account-free contribution and private session receipt | Essential / L | Guest consents, captures/imports and gets a private result without providing email. Receipt exists before upload completion and reports pending/ready/failed/expired honestly. |
| E3 | Gallery, host moderation and live wall | Essential / L | Contribution, permission to browse others, gallery inclusion and public-wall appearance are separate. Each publishing surface requires its own approval and opt-in; host can hide/report/remove/revoke links. |
| E4 | Shared-device kiosk mode | Essential / L | Minimal capture interface, short protected host exit, idle reset, new guest cannot access previous guest's receipt/draft/account UI, pending uploads survive safely. It is a browser kiosk workflow, not OS lockdown. |
| E5 | Guestbook and event missions | Signature / M | Photo + short message/signature; optional bounded audio/video later in this part after media gates. Private host-only messages by default; host-selected pose missions have a clear end. |
| E6 | Remote party postcards | Signature / L | A guest who cannot attend uses a live room or asynchronous challenge; the approved finished strip joins the same event. No access to the host's couple vault. |
| E7 | Event export, retention and moderator delegation | Essential / L | Resumable bounded ZIP batches with captions/manifest and failed-item report; precise expiry before upload; export opportunity before purge. Invite/revoke an authenticated moderator; ownership transfer is outside V2. Deleting media revokes receipt/gallery/wall access; hiding affects only the selected publication surface. |

Cross-cutting requirements: mobile-first layouts, keyboard/touch alternatives to drag, labelled controls, reduced motion/no-flash settings, legible countdown, loading/error/retry states, accessible contrast, localised dates, optional sound and truthful privacy copy. The interface and authored prompts are English only. P9 includes English copy review and local date formatting, with no forced translation of user-written captions.

### Why these features, and what makes them distinctive

Browser competitors already offer broad editing and animated/print output; remote competitors already offer synchronised group capture and collaborative decoration. Event products show that QR delivery, gallery consent and moderation are standard workflow needs. See the [market report](docs/research/V2_MARKET_RESEARCH.md) for the individual claims and links.

The strongest signature candidates are **Then-and-now**, **one pose story across live and relay**, and **remote party postcards**. Their combination fits the existing app; uniqueness remains unproven. Validate these workflows before expanding into a general-purpose editor. Asset generation is not credit-constrained: Danny prefers ample coverage, so create additional assets and variants as needed while keeping discovery organised.

## 4. Prerequisites that cannot be postponed

These are source-level findings, not claims of observed production incidents. They matter more as the app holds more people's photographs.

1. **Audience isolation.** Existing `pb_strips`/Storage policies grant the owner's currently paired partner access broadly. Do not save personal or event media into the old shared owner folder. New scopes and private buckets must pass cross-audience denial tests.
2. **Fail-closed cron authentication.** Retention/reminders currently check a secret only if configured. With a service-role key but no secret, destructive work is not authenticated. Missing credentials must disable execution; never treat them as permission.
3. **Durable archive/delete operations.** Verify archive persistence before removing originals; check Storage and DB errors; retry idempotently; reconcile upload orphans and Cloudinary deletion. An archive must have a durable usable reference before source deletion.
4. **Capture protocol.** Current host identity is not an admission credential. Add scoped room tokens, validated messages, session/shot IDs, readiness and duplicate suppression, bounded transfer/acknowledgements/backpressure and explicit reconnection.
5. **Local durability and limits.** React canvas state is lost on reload. Save encoded media and serialisable recipes, handle quota denial, offer immediate export, and bound memory before motion recording.
6. **Timezone and quotas.** Make recurrence/retention timezone explicit; enforce cloud counts and bytes atomically on the server. Current editor-side ten-strip counting is not a concurrency-safe quota.

## 5. Architecture decisions

### Retain the stack and unify project state

Keep Next.js 16.2.10/React 19.2.4/TypeScript/Tailwind, the existing Canvas compositor, MediaPipe, Supabase and optional Cloudinary/Resend/push. Do not upgrade frameworks as part of feature work unless a demonstrated compatibility/security requirement demands it.

Introduce `lib/projects/` with a versioned `PhotoProject` manifest: project ID, schema version, capture mode, immutable capture time, owner/scope, media IDs, ordered slots, crops, filter/scene/theme IDs, text, sticker transforms, export settings and bounded undo history. Blob media live separately in IndexedDB. HTML canvases and decoded image bitmaps are transient rendering resources, never persisted records.

Template limits: at most 16 photo slots, four participant roles and one to four unique source shots per role. Solo uses one role. Freeze source requirements when capture begins; later template changes may reuse existing shots or request explicit imports, never silently trigger new remote captures. Persistent participant IDs are independent of transient A-D room slots, so reconnecting/reordering cannot change ownership. Cap text/sticker layers and decoded image dimensions in the schema during P0.

Use a small IndexedDB adapter; choose a helper library only after checking its current maintenance/license. Existing `SessionProvider` becomes an adapter for active project state so capture/editor can migrate incrementally. Save media before advancing capture state. Keep a recoverable manifest checkpoint and never show "Saved" until the transaction succeeds. Version upgrades are additive; unsupported future versions open read-only with an export option.

Local projects default to device-only. Account logout hides account-scoped drafts and asks whether to remove local copies; a shared kiosk never exposes them. Browser storage is best-effort and may be evicted; use storage estimates/persistence requests where available and offer portable project export. [Browser storage limits](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)

### One renderer for preview and every output

Extend `ComposeInput` with deterministic timestamps, crop transforms, explicit output geometry and preloaded resource handles. Use the same composition rules for preview, stills, PDF raster placements and motion frames. Keep photo slots separate from decorations; imported recipes cannot reference arbitrary remote URLs or execute code. Normalise/validate JSON, cap dimensions/layers/files, reject decompression bombs and unsupported SVG/HTML, and report missing assets.

A 2x render is not automatically print-ready. At 300 pixels per inch, a 50.8 x 152.4 mm strip needs 600 x 1800 pixels; a 101.6 x 152.4 mm sheet needs 1200 x 1800. Preserve the old layout as fit-with-margins or use a new physical template; do not distort faces to match it. Label effective resolution when source crops are smaller. PDF page size, safe margins and optional cut marks are explicit; physical prints remain a required acceptance check.

### Motion as a bounded optional pipeline

P0 prototypes encoder support and memory; P4 ships animated existing frames and solo short loops; P6 may enable synchronised duo motion only after P5 passes. Remote group motion and segmentation plus motion together are later capability-gated additions, not a promise for every device.

Record encoded chunks, keep original stills, cap clip size/time and cancel cleanly on navigation. Use a lazily loaded worker encoder for GIF and bounded export work. Test codec capability and actual encode/decode, not just API existence; MP4 is offered only if verified on that device, otherwise WebM/GIF/PNG. Avoid loading a general-purpose FFmpeg runtime into every capture session. [MediaRecorder capability limitations](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static), [canvas stream API](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream)

Voice/video guestbook entries use a distinct opt-in capture mode with visible duration and upload size. Initial targets: voice 30 seconds, video 10 seconds at 720p, each at most 10 MB. The feature is disabled if storage/media checks are not satisfied. Native sharing checks `canShare` and offers download when unavailable. [Web Share](https://developer.mozilla.org/en-US/docs/Web/API/Web_Share_API)

### Rooms and collaborative projects

Keep the four-peer ceiling. In online mode, a server-created room has an expiry, host identity and separate admission/participant capabilities. The six-character code is a human lookup code, not a secret or authority. The host may admit, remove, lock and end a room; participants must approve capture readiness. Same-browser BroadcastChannel development remains available and clearly has no remote-room security guarantee.

P0 must resolve account-free signalling with a working two-room isolation prototype. Default proposal: capability-checked server endpoints forward SDP/ICE through short-lived DB records, with bounded polling during setup/reconnect only; media still travels peer to peer. Private Supabase Realtime may replace polling only after room-scoped credentials, refresh, expiry and removed-member rejection are proven without broadening shared-project identity access. Do not treat an opaque guest cookie as a Realtime JWT. If the default misses measured setup/cost budgets, record the alternative and its environment requirements before P5.

Protocol v2 messages carry version, room/session/capture IDs, member ID, monotonic sequence, payload type/length and validated bounds. Only the host commits capture plans; any participant can request one. Require acknowledgements before a future fire time, ignore duplicates, checksum/chunk/retry bounded media transfers, and resume only missing chunks. Keep local originals if transport fails. On host loss, preserve drafts and offer rejoin or local export; automatic host election is outside V2.

Collaborative finishing uses host-ordered recipe revisions with per-participant ownership of their photo/cutout layers. A disconnect produces a local editable fork; reconnection requires choosing the host revision or keeping the local copy, never silently merging conflicting crops. Older protocol clients receive an update/rejoin prompt before capture. A running old room may finish under its old code; do not force service-worker activation mid-session.

For live Together preview, benchmark sending small background masks with video versus segmenting received feeds. Prefer a low-rate shared composition, not sending full-resolution cutout streams. Measure CPU and latency on real mobile devices; automatically fall back with an accurate label. Full-resolution still compositing remains the output authority.

### Explicit scopes and event capabilities

Do not generalise `pb_couples` into an all-purpose event membership table. Preserve legacy couple rows and Gallery's existing `pb_strips` contract. New personal/friend projects use a separate private project bucket and membership checks; events use a separate event bucket and tables. A private QR receipt is a bearer capability and can be forwarded; say so clearly.

Recommended guest model: event-scoped opaque session capabilities issued by the server, stored as hashes, exchanged into short-lived host-only secure HttpOnly cookies. Hosts/moderators use normal Supabase auth. This avoids creating permanent Supabase auth users for every guest on the shared identity project. Do not enable anonymous sign-ins globally just to simplify events: they use the authenticated role and have shared-IP abuse/rate-limit implications. [Supabase anonymous user model](https://supabase.com/docs/guides/auth/auth-anonymous)

Different tokens grant **contribute**, **personal receipt**, **gallery**, and **display** permissions. Invite and receipt secrets use a URL fragment where practical, then a POST exchange and URL cleanup; never embed them in analytics, logs or referrers. Use restrictive Referrer-Policy and no third-party scripts on redemption pages. Printed QR URLs must work directly on the verified production host.

Guest APIs validate the capability, event lifecycle, guest status, size/type, consent and quota before authorising exactly one server-chosen staging object path, with overwrite disabled. Guests never receive a service key or a raw Storage listing. RLS denies public/event guest table access; narrowly scoped server handlers perform capability checks before privileged work. Authenticated hosts still use membership checks. Verify row, object, signed-URL and cache behaviour independently. [Storage access control](https://supabase.com/docs/guides/storage/security/access-control)

Supabase native signed upload tokens last two hours; they are not configurable five-minute read links. Reserve the maximum bytes accepted by the chosen upload path/bucket, not an untrusted guest size claim. Keep staging capacity reserved until token expiry plus a cleanup margin, even when the logical submission expires sooner. Use type/size-limited private staging buckets, then validate actual bytes/type/decoded dimensions and consent/expiry/quota again at finalisation. Late or revoked uploads stay unreadable and are removed after token expiry; never publish them. [Signed upload token lifetime](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl)

Delivery state: **reserved -> uploading -> finalising -> ready / failed -> expired -> deleted**. Publication state is independent for each destination, **event gallery** and **public wall**: **private / awaiting approval / approved / hidden / rejected**. Each destination records its own consent and moderation decision; approval alone cannot override missing or withdrawn consent. A finalised result is privately retrievable even if neither destination is approved. Hiding a wall item does not hide it from an independently authorised gallery or revoke its receipt; content deletion or access revocation does. An idempotency key and DB transaction reserve count/bytes and consume the reservation exactly once. Background sync is an enhancement; foreground resume must work without it. A receipt separately shows delivery state and the two publication choices.

Logical upload reservations last ten minutes. Pausing/ordinary closing prevents new reservations but allows already accepted ones to finalise until the earlier of their expiry or ten minutes after closure. Emergency guest revocation, content removal or event deletion rejects finalisation immediately. Already-issued upload tokens may still write to staging for their remaining lifetime; explain this distinction, retain the capacity reservation and clean these objects. Guests with only local queued work are offered local export if the event cannot accept it.

Upload consent, event-gallery inclusion and public-wall appearance are separate choices, with both publication choices off by default. A guest can receive a private copy without agreeing to either publication surface; private delivery still permits the event owner to manage the submission, which the consent screen must explain. Revoking one publication grant removes the contribution from that destination without changing the other grant or the private receipt. Invite rotation blocks new redemption; existing guest sessions require a separate explicit revoke action. A revoked read session cannot mint new URLs, while already-issued read URLs expire within five minutes. Connected gallery/wall clients remove revoked media within a proposed ten-second refresh window and purge affected caches. Existing downloads cannot be recalled. Account for these limits in product copy.

Remote postcards require a scope-transfer confirmation from every app participant whose contribution appears in the result. Record each participant's event-owner submission consent and separate gallery/wall grants; publish to a destination only when every included participant permits it. Create an event derivative, never grant event access to the source project. One refusal leaves the source private and permits a fresh composition excluding that person's media, not a silent override. Unrevealed challenge inputs cannot be published by another participant. Withdrawal of a destination grant removes the derivative from that destination; withdrawal of the underlying event submission removes it from all future event reads, subject to the stated signed-link/download limits. Guests importing photographs confirm they may share them; the app cannot establish consent from depicted people who are not participants.

Kiosk reset removes guest UI state, receipt secrets, object URLs and camera/microphone tracks immediately after handoff or timeout. Pending encoded uploads sit in an operator-only recovery queue using an event-device upload capability, never a previous guest's read credential. Delete delivered local originals/drafts after acknowledgement; failed pending entries expire within 24 hours or earlier event expiry, with operator export before removal. On next launch, run expired-queue cleanup before admitting another guest. A browser cannot erase storage while it is closed or defend it from an OS/devtools user; use a dedicated managed browser profile and verify ordinary guest isolation rather than promising physical-device secrecy.

### Retention and cloud cost

Keep existing couple retention semantics during migration. Add explicit zone/expiry for new scopes and do not retroactively expire old media earlier. Preserve durable activity metadata independent of media so annual views/streaks do not disappear when thumbnails are purged.

Proposed private-beta event profile: 25 guests, at most 100 final image contributions, maximum 2 MB per published image, maximum 250 MB committed byte budget including outstanding upload authorisations, staging, delivery copies, thumbnails and optional clips, seven-day contribution window and 30-day retention. The count is an upper ceiling subject to available bytes, not a promise of 100 simultaneous submissions. Originals/working projects remain on the capturing device by default. These are proposed operational caps, not measured provider capacity. Show a smaller allowed capacity or disable event creation if the deployment's shared storage/egress budget cannot accommodate them. Do not advertise unlimited events on a free tier.

Persist `starts_at`, IANA `timezone`, `contribution_closes_at` and `expires_at` as explicit instants. Defaults are seven and 30 elapsed days after `starts_at`, shown as local dates/times before consent. An unpublished event can be rescheduled; after the first accepted contribution, never shorten the promised expiry. Extending windows requires an owner action and budget revalidation. Early close does not move expiry. Export reminders are opportunities, not a condition that postpones deletion indefinitely; unexported event media still expires on the stated date. Moderator invitations require authenticated acceptance, are revocable, and grant moderation only; owner-only actions include budgets, delegates, bulk export and event deletion.

Illustrative sizing: 100 images x 2 MB = 200 MB before derivatives. While two-hour staging authorisations remain reserved alongside delivery copies, their combined commitment can reach 400 MB before thumbnails, exceeding the proposed 250 MB cap. P0 must measure this transient peak; reservation transactions must also reserve derivative headroom, and the dashboard must show available bytes and temporary upload capacity. Pause new reservations when that budget is exhausted; do not promise immediate capacity reclamation by deleting an object while its upload token remains valid. Twenty-five people loading every original once is about 5 GB of delivery; loading 100 thumbnails at 100 KB each is about 250 MB. Use pagination, thumbnails, bounded wall prefetch and per-event storage/egress observations. TURN and video add separate traffic. Recheck actual provider/account allowances before raising limits; do not infer them from historic low traffic.

The lifecycle worker uses batches, leases and durable checkpoints. Archive states: pending -> uploaded -> reference verified -> source removable -> complete. Deletion tracks DB, Supabase and Cloudinary outcomes independently; failures are retried, not reported as success. Keep fail-safe original preservation for couple keepsakes. Event expiry is independent and never grants automatic permanent Cloudinary archiving. Notify hosts before expiry when an enabled channel exists; the dashboard always shows it. Pause uploads at quota; never remove kept media to make space.

## 6. Proposed data and migration changes

All names below are implementation targets, not existing objects. Add reviewed, rerunnable, `pb_`-prefixed migration artefacts under tracked `database/migrations/`, plus the consolidated `supabase-setup.sql` path for fresh installations. Existing `/supabase/` is ignored, so it is not a reliable sole release artefact. No SQL has been applied.

| Planned artefact | Objects / purpose | Security and compatibility |
| --- | --- | --- |
| `database/migrations/001_v2_lifecycle.sql` | `pb_media_jobs`, operation/idempotency records, additive status/error fields; database-enforced save quota | Atomic quota enforcement covers every insert path, including legacy direct writes; preserve current `pb_strips` columns and Gallery readers. |
| `002_v2_projects.sql` | `pb_projects`, `pb_project_members`, `pb_project_assets`, `pb_saved_templates`; private `photobooth-projects-v2` bucket | Owner/accepted-member RLS; separate personal/friend scopes; legacy couple access unchanged until an explicit migration proves compatibility. |
| `003_v2_rooms.sql` | `pb_rooms`, `pb_room_members`, expiring admission hashes, bounded signalling records and capture metadata | Expiring guest/host capability checks; server-mediated signalling by default. A private Realtime alternative requires a proven scoped credential flow. No open channel carrying privileged roster decisions. |
| `004_v2_memories.sql` | `pb_challenges`, `pb_challenge_members`, `pb_challenge_submissions`, `pb_memory_activity`; timezone/occasion metadata | Reciprocal reveal enforced on reads and signed URLs; private media belongs to an explicit project scope. |
| `005_v2_events.sql` | `pb_events`, `pb_event_members`, `pb_event_guests`, `pb_event_invites`, `pb_event_submissions`, `pb_event_publication_grants`, `pb_event_upload_intents`, `pb_event_tokens`; private `photobooth-events-v2` delivery bucket plus `photobooth-event-images-staging-v2` (2 MB) and `photobooth-event-clips-staging-v2` (10 MB) | Owner/moderator RLS, guest API-only access, per-contributor and per-destination consent, atomic count/byte reservations including staging and outstanding upload authorisations, unique idempotency constraints and scoped paths. |

Each migration needs local empty-DB and existing-data tests, indexes for membership/status/expiry, explicit grants/revokes, and safe `search_path` on privileged functions. Verify constraints with concurrent requests, not only UI flows. New code probes schema capability and disables unavailable cloud features. The old no-env local booth remains runnable.

Legacy direct `pb_strips` writes mean a new quota RPC alone is bypassable. Enforce the invariant in a database transaction/trigger shared by all inserts, with a per-couple lock and documented cap error; test direct REST writes and concurrent old/new clients. If direct writes must instead be revoked, first ship an adapter release and require stale clients to export locally/reload before save. Never report quota enforcement while an unguarded write path remains.

Existing flattened strips are not editable originals. Offer duplicate-as-image; do not fabricate recoverable crops, raw shots or old motion. Existing relay deep links remain valid. Re-pairing/unpairing must not grant a new partner access to prior scoped projects; removal immediately revokes future signed-URL issuance. Legacy broad partner access is documented and must not silently widen during migration. Gallery integration for new scope types is deferred until its reader contract is separately reviewed.

## 7. Routes, services and graceful degradation

| Proposed surface | Purpose / access |
| --- | --- |
| `/studio`, `/projects`, `/projects/[id]` | Local creation/library/editor; cloud controls only when authenticated and configured. Existing `/customize` adapts into this project model. |
| `/templates` | Bundled/personal recipes and validated private import/export, no public marketplace. |
| `/together`, `/challenges/[id]`, `/memories` | Guided live/relay entry, scoped challenges, retained memories. `/timeline` remains supported. |
| `/events`, `/events/new`, `/events/[id]/manage` | Authenticated host/moderator routes. Never reachable through guest capability alone. |
| `/e/[slug]`, `/e/[slug]/booth`, `/receipt/[id]` | Guest exchange, contribution and personal retrieval; IDs alone never authorise reading. |
| `/e/[slug]/gallery`, `/e/[slug]/wall` | Separate gallery/display capabilities, approved derivatives only. |
| `/api/rooms/*`, `/api/projects/*`, `/api/challenges/*` | Schema-validated mutations and scoped media access. |
| `/api/events/*` | Host lifecycle, capability exchange, upload reservation/finalisation, consent, moderation, receipts, batched export. |
| `/api/media/maintenance` | Authenticated scheduled, bounded reconciliation/expiry; old cron URLs remain accepted during transition. |

Mutation endpoints enforce same-origin/CSRF protections where cookies authorise work, auth/capability checks, rate limits, finite request bodies and safe error responses. Event/media responses are private/no-store. The service worker must exclude tokens, receipts, management pages and private signed URLs from generic caches; only explicit local project storage retains media.

No new paid service is required for the proposed core. Existing Supabase/Cloudinary/email/push remain optional. Add server flags `PB_EVENTS_ENABLED=false`, `PB_CLOUD_PROJECTS_ENABLED=false`, `PB_ROOM_V2_ENABLED=false` until the relevant schema and checks pass. The server reports enabled capabilities to the client; flags are not authorisation controls. Add `PB_PUBLIC_ORIGIN` for canonical QR/notification links; if missing or invalid, remote event publishing is unavailable while local previews work.

Use `CRON_SECRET` for maintenance with mandatory configuration for execution. Event storage/count limits belong in validated deployment configuration plus persisted per-event snapshots. If an anti-abuse service is added after the spike, make its keys and failure mode explicit before activation; do not quietly open guest uploads when verification is unavailable. No runtime image-generation API key is needed for the curated assets.

Image assets extend `SceneDef` through a resource registry with ID/version, local path, dimensions, focal point, crop rules, byte budget, provenance and fallback. Preload before capture; optimise and lazy-cache selected packs in P3. Do not fetch third-party image URLs into the canvas at runtime. Asset sources are in `docs/assets/v2/scenes/` and `docs/assets/v2/materials/`; application-ready derivatives will go in `public/scenes/v2/` and `public/materials/v2/` during implementation. The 24 selected originals total 58.55 MB; they must not become an initial download or mandatory precache.

Asset production has no arbitrary count or credit cap. Generate standalone scene/crop/occasion variants where needed, inspect each, preserve its prompt and selected original, and add it to the manifest. Use the current 24 as a coverage baseline rather than a ceiling. Materials are opaque clipped fills, not verified seamless tiles; check grain scaling and text contrast before using them in print. Generate dedicated portrait compositions when centre-cropping would remove the recognisable theme.

## 8. Design and experience

Keep the rose accent, warm neutrals, Fraunces display type, Geist UI type, Code Z logo and restrained glass surfaces already in the app. Capture remains dark to avoid polluting skin tones. The update changes information architecture and controls, not the brand identity.

Landing: three clear entry points with recent local projects below. Avoid presenting every feature as a top-level tab. Studio uses capture/import -> review -> decorate -> export. Together uses invite -> check cameras -> choose story -> capture -> finish -> save. Event guests see join -> consent -> capture/import -> review -> submit -> receipt; host configuration is elsewhere.

Mobile editor: preview remains visible, one active tool drawer, reachable export action. Desktop: preview plus a bounded sidebar. Event wall hides controls during display, offers reduced motion and a host-visible connection status. Kiosk never shows account navigation. Long text, keyboard overlays, small phones, landscape tablets and 1366 x 768 laptops must be tested.

Generated library: six Together scenes (rooftop, rainy cafe, coast, lantern courtyard, snowy cabin, spring blossom); six studio scenes (paper moon, porcelain, origami, chrome, noir lobby, candy clouds); six event scenes (garden, birthday, disco, graduation, winter, summer); six frame/cover materials (cotton paper, rose washi, indigo bookcloth, champagne metal, charcoal photo paper, pearl film). Names, dates, prompts and QR codes remain editable text/vector elements. Do not generate raster logos, frame cut-outs or text-heavy UI when deterministic components work better.

## 9. Delivery parts and acceptance

Every part ends with a runnable app and a reviewable result. Existing features stay available behind stable routes; new cloud capabilities stay off until activated. Do not mark the major update complete after only the Create track.

| Part | Deliverables and main files | Dependencies | Exit evidence |
| --- | --- | --- | --- |
| **P0: baseline and feasibility** | Reconcile docs/version; automate current capture/composition tests; spike IndexedDB recovery, mobile encode/print, room credentials and event capability abuse model; create test/CI scripts without deploying | None | Fixture baseline; named real-browser/device results; unresolved codec/preview constraints recorded; approved data boundaries and workload budgets. |
| **P1: secure storage and operations** | Harden `app/api/{retention,reminders,keep}`, `lib/{couple,relay,retention}`; migration 001; upload jobs, archive/delete reconciliation, server quotas | P0 | Unauthenticated/misconfigured cron performs zero work; archive-write/remove failure injection preserves media; orphan/relay cleanup; concurrent cap tests; legacy Gallery-compatible reads. |
| **P2: durable project and edit core** | C1-C3, `lib/projects/`, SessionProvider adapter, editor/capture decomposition, versioned import/export, shared rendering contracts | P0, P1 for cloud paths | Reload/close/reopen recovery, quota-full rollback, lossless source retention, undo/redo, correct retake, upload orientation and preview/export fixtures. |
| **P3: templates and visual packs** | C4-C5, template schema/editor, asset registry, 24-asset starting library plus needed variants, thumbnails and pack caching | P2 | Malformed recipe rejected; no photos/tokens in shared recipes; missing asset fallback; scene crops/material readability across eight layouts and mobile/desktop; measured delivery sizes. |
| **P4: print and solo motion** | C6-C7, export profiles, lazy PDF/GIF/recording pipeline, cancellation and file-size feedback | P2, P3 | Measured PDF sizes, physical sample print, video/GIF decode on supported devices, still fallback under encoder failure, memory/long-session profile. |
| **P5: trustworthy live rooms** | T1, protocol v2/credentials, per-peer readiness, transfer resume, all-person preview T3, bounded shared finishing T4 | P1-P3 | Two/four device cross-network/TURN sessions, forged/duplicate messages rejected, host-loss recovery, interrupted transfer resumed, mobile low-power fallback. |
| **P6: rituals and memories** | T2, T5-T8, challenge and memory schemas, guided sessions, then-and-now, reciprocal relay, audio, retained-year recap; optional duo motion | P1-P5 | Live and async full lifecycle, withheld media inaccessible before reveal, timezone/DST/unpair tests, archived memories remain in activity view, audio denial/delete/export. |
| **P7: event core** | E1-E2/E7, event schema/capabilities, guest upload intents, receipts, private gallery skeleton, host dashboard, expiry and batch export | P1-P4; P0 event spike | Guest without account completes contribution; no cross-event/couple access; quota races, invite revocation, failed finalisation/retry, expiry and export manifests. |
| **P8: event experience** | E3-E6, moderation/wall, shared-device kiosk, guestbook/missions, remote postcard integration | P5-P7 | Full event rehearsal with successive guests, pending queue across reload, all four gallery/wall consent combinations, per-contributor refusal/withdrawal, moderation removal, paused/closed behaviour, remote guest joins safely. |
| **P9: accessibility, localisation and release** | English copy/prompts, local date formatting, settings, responsive polish, docs/setup/release notes, release `2.0.0`, beta improvements | P0-P8 | All three end-to-end tracks pass; production build; remote CI for exact authorised commit; device/print/event beta records; activation checklist and rollback rehearsal. |

Dependency parallelism: after P3, P4 and P5 may run in parallel. Preparatory protocol and renderer spikes may overlap P3 without passing later exit gates. P7 can progress alongside P6 after their listed dependencies pass and shared contracts stabilise. Assign clear ownership of the compositor, schema and project format. Do not have separate tracks invent incompatible media models.

Sizing: P1/P2/P5/P7 are the largest risks. This is a multi-month solo programme at ordinary engineering throughput, not a weekend feature pack. Estimate calendar dates only after P0 and a review of available weekly time. Optional enhancement subfeatures can remain flagged in beta, but any reduction of the agreed three-track release scope must be stated and approved, not silently omitted.

## 10. Validation and release criteria

Automated tests should exercise actual failure boundaries: project migrations/quota failure; deterministic composition and print geometry; malformed/duplicate/out-of-order RTC frames; captured-membership changes; row/object/capability denials; upload finalisation races; archive/delete retry; signed-link expiry/revocation; timezone/DST recurrence; service-worker update with an active draft. Use fake cameras and a disposable DB for repeatability. They complement, not replace, real devices.

Required manual matrix: current Safari on iPhone in browser and installed PWA; Chrome on Android; Chrome/Edge on Windows; Safari on macOS if supported as a target. Record versions/hardware at test time. Cross-network sessions need separate networks and a forced TURN route; same-browser tabs do not prove this. Test 2 and 4 participants, refresh/background/foreground, camera unplug/denial, slow links, battery-saving mode and one missing frame. Do not promise sub-frame synchronisation without measuring it.

Physical output: measure a PDF page and one printed sheet using actual-size print settings; inspect margins, cut guides, face crop and colour. PDF pixel dimensions alone do not certify printer output. No silent/USB printing claim.

Four small validation cohorts before broad launch: five solo creators complete import/edit/print; five distant pairs complete a live story and a relay, then voluntarily return; at least two friendship groups of three or four complete director turns, collaborative finishing and a relay with one late or departing member; two event hosts run rehearsals with at least ten guest sessions each. These are usability samples, not statistically representative market proof. Observe success without help, retries, time to first usable result, next-session return, host interventions and actual storage/egress. Ask which output they kept or shared and why.

Test the positioning as well as task completion: give willing participants one matched task using their current workflow or a relevant free competitor, then the equivalent Zuychin flow. Counterbalance the order where practical, use consenting participants' own or neutral sample images, and compare time, intervention, lost work, chosen output and reasons for preference. Do not infer a market advantage solely from a successful Zuychin session.

Proposed beta targets: no loss of a successfully autosaved draft in the tested failure matrix; zero cross-scope access in adversarial fixtures; every successful submission produces one retrievable receipt; no duplicate media after retries; at least 90% unassisted guest completion in rehearsal; no unreconciled media deletion. Small sample percentages are directional. Set capture-latency/encode performance budgets after measuring target devices in P0.

For capacity, test the proposed deployment at 1x/2x/5x expected launch traffic. Workload example to refine: five concurrent four-camera rooms, one 25-guest event, ten concurrent still uploads, and an event wall. Higher load must reject/degrade predictably, not bypass quotas. Measure CPU, memory, request count, DB/Realtime limits, object bytes, egress and TURN separately. Do not claim current account quotas or production headroom from historic notes.

## 11. Activation and rollback checklist

No external activation has been performed. Implementation completion and production activation are separate statuses.

- [x] Plan approved; begin development with P0. No application code was changed during planning.
- [ ] Back up relevant data and apply each reviewed tracked migration plus private bucket/policy setup to a disposable environment. Danny applies hosted SQL unless he explicitly authorises a platform write.
- [x] Read-only review of Gallery's legacy `pb_strips` reads and shared cookie/auth contract completed, with limitations recorded in the [P9 review queue](docs/development/P9_REVIEW_QUEUE.md). Actual provider and cross-subdomain sign-in checks remain open. No sibling repository was changed; this does not extend cookie sharing to UsTime.
- [ ] Confirm actual production origin and hosting provider; set `PB_PUBLIC_ORIGIN` to that exact HTTPS origin. It is deliberately not guessed from stale handoff notes.
- [ ] Set optional feature flags only after their schemas pass. Default values: `PB_EVENTS_ENABLED=false`, `PB_CLOUD_PROJECTS_ENABLED=false`, `PB_ROOM_V2_ENABLED=false`.
- [ ] Verify existing Supabase, TURN, archive, email and push configuration without logging secret values. Existing `NEXT_PUBLIC_*` configuration changes require rebuilding. TURN transport/security and credential rotation need a deployment-specific review.
- [ ] Configure maintenance scheduler at `{PB_PUBLIC_ORIGIN}/api/media/maintenance`, initially every 15 minutes, with `Authorization: Bearer <CRON_SECRET>`. Keep existing `/api/reminders` every 15 minutes and `/api/retention` daily until their responsibilities migrate; use shared leases to prevent double work. The placeholder denotes the verified origin, not a literal URL to paste.
- [ ] Schedule `/api/projects/maintenance` separately, with enough bounded passes to process work before its ten-minute reservation deadline. Verify the provider supports the route's 120-second allowance; see [project operations](docs/development/P6_PROJECT_HTTP.md). The legacy media worker does not drain project jobs.
- [ ] Schedule `/api/events/maintenance` separately, starting a pass at least every 60 seconds and permitting overlapping invocations. Verify its 90-second application deadline, 120-second route allowance and 150-second readiness window against measured deployment capacity; see [event worker operations](docs/development/P7_EVENT_WORKER_RUNBOOK.md). A 15-minute legacy schedule cannot keep event admission ready.
- [ ] Confirm sign-in callback allowlist `{PB_PUBLIC_ORIGIN}/auth/callback`, QR/direct links, schema capability checks, private cache exclusions, and no-env local mode.
- [ ] Measure shared-provider budgets and set event caps before enabling hosting. Confirm export/expiry notifications and deletion retries with test data.
- [ ] Complete authorised commit's remote CI, configured-service/device/event checks, then a separately authorised production release with an immutable rollback artefact. Localhost is the current authorised test environment. No automatic hosted migrations or production release.
- [ ] Rollback: retain and rehearse a V2-compatible fallback build with project read/export, private receipts and safe maintenance endpoints before enabling new writes. Reverting directly to the current `0.13` baseline cannot read V2 projects or serve event receipts. Disable new cloud flags/reservations in the fallback; finish accepted safe operations or explicitly pause them. Additive data remains, never down-migrate/delete it to roll back code. Retain prior service-worker assets while open sessions finish; do not wipe IndexedDB. Verify rollback with actual V2 drafts and accepted event submissions.

The [retained local fallback rehearsal](docs/development/P9_REVIEW_QUEUE.md#retained-local-fallback-rehearsal-24092026) passed a process switch, saved-draft recovery and separate handler/database receipt checks. It used one unchanged application build and synthetic provider bytes, so it does not close the deployed or different-release rollback gate above.

## 12. Deferred and reconsideration triggers

| Idea | Why deferred / when to revisit |
| --- | --- |
| More than four live cameras / SFU | Separate transport and bandwidth programme; reconsider after repeated observed demand from groups unable to use independent event sessions. |
| Runtime AI backdrops or portrait transformations | Curated generated scenes already provide visual variety without per-capture spend or face-upload processing. Revisit with explicit consent, budget, moderation and identity-preservation evaluation. |
| AR face props | Performance, tracking quality and new asset requirements; revisit after real-device motion/Together budgets are stable. |
| Public frame marketplace | Ongoing content/licensing/moderation burden. Private recipe sharing first. |
| Continuous voice/video calls | Changes the app's purpose and adds audio echo/recording complexity. Optional voice captions suffice for V2. |
| Silent printer bridge, DSLR, 360 rigs, fleet tools, CRM and payments | Operator/hardware support is a separate product commitment. Validate a real host need before taking it on. |
| Native home-screen photo widgets | Not a normal browser PWA capability; native companion app would be a separate decision. |
| UsTime automatic calendar integration | Existing roadmap dependency is unverified and cross-repository. Keep future event-link/export interfaces stable, but do not make V2 depend on its readiness. |

Recommended first implementation action after approval: P0 and P1, followed by the durable project core. They make the creative, remote and event work share a safe foundation rather than expanding today's failure modes.
