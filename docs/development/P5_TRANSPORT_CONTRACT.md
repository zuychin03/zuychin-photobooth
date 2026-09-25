# P5 transport foundation

Recorded 23/09/2026. New isolated protocol modules; legacy `engine.ts`, `signaling.ts`, existing room routing and the compositor remain unchanged. This is an integration foundation, not a completed P5 device/UX gate.

## Root integration

Construct `RoomEngineV2` from `lib/rtc/engine-v2.ts` with:

```ts
{
  initial: RoomState,
  scope: ProjectScope,
  iceServers: RTCIceServer[],
  readiness(capture): Promise<boolean>,
  captureShot(capture, index): Promise<Blob>,
  commitRemoteFrame({manifest, blob, capture}): Promise<void>,
  onState(state), onStatus(status), onRemoteStream(member, stream), onError(code)
}
```

`captureShot` must capture and durably persist the local original before returning the bounded transport Blob. The blob must have a verified still-image MIME and fit the agreed capture profile. `commitRemoteFrame` must persist verified original bytes and the correct capture/member/shot identity atomically before resolving. It must be idempotent for the same transfer/slot: a crash after project commit but before the journal acknowledgement can invoke it again. It must also retain the Session account/project-generation fences when asynchronous work completes after navigation or sign-out. These callbacks are the root adapter's responsibility; the engine never writes Session or invents a second project schema.

Root explicitly grants capture readiness through the callback. Merely opening the camera is not participant consent. Verify actual camera dimensions, expected encoded bytes, project inventory, decoration headroom and the exact recipe before returning true. The room budget leaves 16 MiB/12 MiPixels below current project limits; some otherwise-valid P3 recipes need a smaller profile or an explicit incompatibility message. Never drop sources/decorations to fit silently.

Methods: `start(stream)`, `refresh(renewConnection?)`, `reconnect()`, `prepareCapture(proposal)`, `commitCapture(id)`, `abortCapture(id)`, `admit(id)`, `remove(id)`, `lock(boolean)`, `end()`, `close()`. The `state` getter returns a detached projection. `onRemoteStream` receives an authoritative member record, including its stable ID and role. Local video tracks are borrowed; the owning camera hook still stops them on exit. No microphone track is added.

`peerReadiness` returns detached `{member, connected}` entries for every admitted remote member. Connected requires both the channel hello and a fresh authority lease. Recipe integration adds optional asynchronous `onRecipeProposal(proposal, sender)` and `onRecipeCommit(commit, sender)` callbacks. Guests call `sendRecipeProposal(proposal)`; the host applies its own proposals through the local coordinator. After durable coordinator acceptance, the host calls `sendRecipeCommit(commit, optionalMemberId)` to broadcast or resynchronise one guest. The transport validates bounded recipe wire shapes and host-only commit authority. Ownership, revision reconciliation and project persistence remain coordinator responsibilities.

`RoomV2Status` includes connecting, waiting admission, connected, host absent, capture ready/committed/started, local-original-saved, shot-saved, capture complete/incomplete, per-member transfer progress, recovery required and closed. A local original can be saved even if later transport encoding/reservation fails; the separate status keeps that distinction visible. On recovery, retain drafts and offer reconnect or local export. There is no host election.

## Protocol and capture

Control frames are strict JSON with version 2, room/session/member IDs, connection epoch, roster revision, monotonic sequence, type and UTF-8 payload length. Maximum control bytes are 96 KiB. The initial channel hello proves the expected recipient epoch. The sender identity is bound to the negotiated peer and current server roster; payload claims never replace it. Duplicate sequence numbers are ignored, gaps and unsupported versions are rejected. There is one ordered reliable data channel per pair and at most four members.

Signalling uses `createRoomApi` with same-origin credentials and no token access in JavaScript. State refresh runs every five seconds; actions stop after a 15-second authorisation outage. Setup/reconnect polls are limited to a 60-second attempt, at one-second intervals. Connection loss is explicit recovery, not automatic host promotion. SDP and ICE come only from current admitted members/epochs and are validated before browser RTC calls.

Capture notice messages only prompt an authenticated server lookup. They cannot themselves commit a plan. The server freezes the roster/recipe/shot IDs and authorises commit after all acknowledgements. The engine acknowledges only when its peer handshakes and local readiness callback succeed. Server clock offset uses the best observed HTTP round trip; round trips above 500 ms prevent readiness rather than claiming synchronisation. This is a conservative local decision, not measured phone accuracy.

`CaptureRunner` writes an IndexedDB shot claim before the scheduled fire. A reloaded page cannot fire a claimed shot again, including a crash between claim and save. Such a shot may remain explicitly incomplete; at-most-once capture cannot promise an image after a device crash. A deadline more than 250 ms late is skipped, never caught up. Membership/authority loss cancels future shots. Local-save failure stops progression. Physical timing/skew across real devices remains unverified.

## Transfer and temporary storage

Each immutable manifest binds transfer, room, session, capture, member, role and shot, with actual byte/MIME/dimension declaration, SHA-256, expiry and chunk count. A binary chunk carries its transfer UUID, index and exact length. Payloads are at most 16 KiB. Receiver requests contain a four-chunk window; each chunk is persisted before opening the next window. Sender honours data-channel backpressure with a five-second deadline. Missing chunks are retried at two-second intervals, at most eight attempts without progress; reconnect offers only incomplete durable transfers.

Incoming offers and final commits freshly authorise both peers through `capture {captureId,peerId}`. Chunk windows use the bounded current membership lease rather than issuing a database request for every chunk. After full checksum verification, the shared image inspector validates headers, dimensions and actual native decoding. Only then may the project-commit callback run. A transfer ACK follows project commit and the durable journal checkpoint. Failed checksum/decode/storage never claims receipt success.

`photobooth-room-transfers-v2` is a separate version-two IndexedDB journal, scoped by device or exact account plus room/session/self identity. Its additive second version adds per-scope generation fences checked inside transactions, so explicit account removal invalidates older connections. It stores encoded Blob chunks, not decoded canvases. Active reservations are bounded to 24 transfers and 64 MiB globally, including declared outstanding bytes; transaction locks serialise concurrent tabs. A capture/member/shot slot cannot acquire a conflicting transfer identity. Chunks cannot be overwritten with different hashes. There are at most 512 transfer records and 1,024 shutter markers. Temporary records expire no later than the two-hour room lifetime. Opening a journal or explicitly cleaning it removes expired temporary records across its exact device/account scope, including abandoned rooms. It never removes another account's staging or a project database. Other scopes can still consume the shared ceiling; users must enter that scope to clean expired staging or explicitly remove its local copies. A capacity error never silently evicts private data from another account.

Outgoing retries locate the exact immutable room/session/capture/member/shot slot, compare all manifest fields except the newly requested transfer UUID, and refill only missing chunks under the original UUID. Changed bytes, dimensions, role or expiry are rejected. Completed transfers are not rehydrated. Offers use that retained manifest after fresh peer/capture authorisation. This repairs partial staging without changing original project bytes or extending the room lifetime.

Successful receiver project commits release temporary chunk bytes, retaining small verification/ACK metadata. Sender bytes release after every frozen recipient acknowledges; the original project copy remains. Interrupted network transfers retain unacknowledged chunks across close/reopen. Failure while initially creating the outgoing journal can still require recovery from the saved local original/export; the foundation does not reconstruct an unspecified transport derivative from a project automatically. A complete transfer receipt is not a promise to recover a project the recipient later deletes.

Database upgrades are additive; blocked opens time out, version changes close the connection, and late opens close after timeout. The browser remains responsible for its storage quota and eviction; the journal cannot guarantee persistence against OS/browser deletion.

## Evidence

The 25 focused server/transport Node tests passed, along with TypeScript and focused lint. They cover message identity/epoch/replay, bounded recipe wire shapes, framing limits, response bounds, durable-before-fire ordering, reload duplicate suppression, late-fire refusal, authorisation/storage failure, missing-chunk resume, four-chunk backpressure, checksum failure and ACK ordering after project commit. Transfer/capture tests use an injected in-memory journal and image inspector; they do not claim native IndexedDB or image-decoder evidence.

`runRoomTransferJournalProbe()` in `transfer-store.ts` opens a uniquely named temporary browser database and cleans only that database. It exercises two-connection shutter claims, immutable-chunk transaction rollback, close/reopen recovery, device/account scope isolation and concurrent 64 MiB reservation enforcement. The recovery extension injects partial outgoing staging failure, retries after reopening under one original UUID with exact bytes, then opens a different room to clean expired same-scope staging while retaining another account's chunks and shutter marker. The extended checks await a new native run; implementation alone is not evidence.

`runRoomMeshProbe(2 | 4)` in `probe.ts` uses native RTC connections with no external ICE servers, synthetic canvas streams, multi-chunk PNGs, actual image inspection, temporary transfer journals and actual project repositories. It checks every mesh handshake, future-time capture, byte-identical saved originals after repository reload and durable ACKs before staging release. Its injected authority fixes the roster/epochs, so it complements rather than replaces the real PostgreSQL/HTTP checks. It uses no camera, account or hosted service and removes only uniquely named fixture databases. Root observed both two- and four-peer native probes passing on 23/09/2026 (Australia/Sydney). This does not prove cross-network negotiation, real-camera timing or full interruption recovery.

Root also observed the local two-person synthetic UI saving all eight originals, sharing a caption and guest sticker, and copying an editable project. Remaining transport acceptance includes full-flow interruption/reload recovery, host-loss/rejoin/export, cross-network/TURN and real-camera/phone performance. Shared-preview capability evidence is tracked separately in `P5_SHARED_PREVIEW_CONTRACT.md`; passing its fallback lifecycle is not proof of actual Together rendering. Cloud room flags remain disabled until activation checks pass.
