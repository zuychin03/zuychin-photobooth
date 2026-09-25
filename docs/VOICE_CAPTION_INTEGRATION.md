# P6 voice captions

Full T8 uses `VoiceMemoryCaption`, attached to the exact existing memory activity ID. A caption is private to its author even when the photo is shared. Audio and editable text can be saved, exported separately or deleted. Playback never autoplays. There is no transcription or continuous call recording.

## Capture and allocation bounds

`voice-pcm-recorder.ts` explicitly requests microphone access and uses the same-origin `voice-pcm-worklet.js`. The worklet captures mono signed PCM16 at 48 kHz, stops at exactly 1,440,000 samples and emits sequenced blocks of at most 4096 samples. The main thread preallocates 2.88 MB, validates each block and builds one canonical WAV of at most 2,880,044 bytes. Setup and finalisation have bounded timeouts; cancellation, late permission resolution, component exit and account invalidation release streams and audio contexts. An unsupported audio context/worklet falls back to editable text.

`voice-wav.ts` validates the actual RIFF/WAVE bytes, exact 44-byte header, PCM encoding, channel count, sample rate, byte rate, alignment, sample count and total length. Extra chunks, trailing bytes and duration beyond 30 seconds are rejected. Duration comes from sample count rather than client metadata. The server does not need a compressed-audio decoder. Client downloads also verify the actual digest and canonical format before playback/export.

## Draft and request lifecycle

`voice-drafts.ts` uses the central cloud journal version 4 `voiceDrafts` store, including its account identity, epoch and cross-tab cleanup-generation fences. Exact-owner cleanup removes voice drafts atomically alongside upload, challenge and design drafts. There is no separate untracked private database. At most 20 drafts are kept per owner, each with at most one bounded WAV and 2000 text characters. Draft reads inspect WAV bytes before returning them to the player.

A saved local draft has an optimistic local revision and the remote caption revision it was based on. Freezing persists a stable request ID before upload. Pending requests are immutable. If the server acknowledgement or local cleanup fails, the frozen request remains and can be retried without changing its identity. Deletion also has a durable pending request ID and an explicit confirmation. Dismissing a pending draft explains that it does not undo a request that may already have reached the server.

Editing a recovered draft preserves its original server revision in both the UI and journal; seeing a newer remote snapshot never silently rebases old content. The native draft probe exercises this mismatch. The PCM rehearsal can simulate a newer server edit and remount the editor without resetting the service, so stale-draft conflict handling can be checked directly. Confirmation prompts freeze competing edits, pin the deletion revision, focus the safe cancellation button and restore focus on exit. Parent close confirmation locks the caption editor while the decision is pending.

Fresh recorded audio is journaled before cloud save. Text changes require “Keep draft on this device” or “Save caption”; this is stated beside the field. Refresh asks before discarding unsaved changes. The component reports dirty and busy state to its parent so closing or changing memories can protect unsaved work. Key the component by owner and activity ID. Closing the voice client lifetime clears loaded private text/audio and cancels recording.

## Integration contract

`createVoiceClient` accepts the existing app origin, account identity/epoch and token provider. `openVoiceDraftJournal` accepts the same identity. `VoiceMemoryCaption` takes `activityId`, `client`, `journal`, `onDirtyChange` and `onBusyChange`. Production parents must use the latter callbacks to guard close/filter actions and close the client/journal when their account runtime ends.

POST `/api/memories/[activityId]/voice` supports `read`, `save`, `delete` and `download`. Snapshots contain version, activity ID, revision, text and optional canonical audio metadata. Save requests contain request ID, expected revision, text and audio `keep`, `remove` or `replace`; replacement carries bounded base64 WAV. The JSON body cap is 3,850,000 bytes. Download returns WAV with generation and SHA-256 headers. The private voice bucket and schema are separate from existing image-only project media; those image contracts are not broadened.

Migration 014 and the server attachment lifecycle are coordinated with the backend owner. Their acceptance requires fresh source visibility and challenge concealment checks, immutable generation reservations, quota accounting including staged/deleting objects, idempotent finalisation, provider deletion confirmation and durable cleanup. Neither being the original activity subject nor a retained history row bypasses current source visibility. No hosted migration, bucket write or feature activation is part of this local work.

## Rehearsals and evidence

`/v2-lab/voice/pcm` is development-only. It uses the native worklet and central IndexedDB implementation, a synthetic tone and a labelled simulated service. It never requests microphone access. Its buttons simulate a lost mutation acknowledgement and revoked access, and reset removes the exact synthetic owner's drafts. The simulated server resets on reload; this does not demonstrate hosted persistence.

`/v2-lab/voice` retains the earlier native MediaRecorder format experiment. Its WebM/Ogg/M4A output is tab-local, not an accepted production attachment. It verifies actual recorder format extension, final chunks, byte/time bounds and cancellation separately from the canonical PCM path.

Fifteen focused tests pass for recorder permission/lifecycle, exact worklet cap, forged WAV headers, large base64 validation, client digest verification and account changes before token resolution or after a response. Scoped lint and full TypeScript checking pass at this tranche. Native browser rehearsal, SQL/backend integration, real microphone/device acceptance and hosted persistence have separate evidence; these unit checks do not prove those gates. Photo recap/export must explicitly disclose if caption sidecars are not included.

Eight additional runtime lifecycle tests cover pre-start cancellation, synchronous authentication invalidation, client-construction races, late journal arrival, journal failure, idempotent close, new account epochs and cleanup after a teardown error. Background visibility cancels recording and pauses playback; pagehide aborts active operations, and returning from the browser back-forward cache releases busy state with a recovery prompt. The parent entry rejects a runtime belonging to a different owner. Browser lifecycle behaviour still requires native rehearsal.
