# P5 local evidence

Recorded 23/09/2026, Australia/Sydney. P5 passed its local implementation checkpoint. The server, transport, recipe, workspace and preview contracts describe implementation separately from observed evidence. No hosted room feature has been activated; external and physical-device acceptance remains pending.

## Native browser observations

Desktop Chrome 153 on Windows, synthetic images and streams only. These runs request no camera or microphone, and use isolated disposable databases. Same-browser peers use a synthetic authority with native RTCPeerConnection, not hosted room credentials. They do not prove cross-network, TURN or physical-device behaviour.

| Probe | Observed result | UTC timestamp |
| --- | --- | --- |
| Transfer journal | 6/6: concurrent shutter claims, conflicting chunks roll back, close/reopen resumes partial data, exact scope, concurrent byte ceiling and expiry | `2026-09-22T17:52:25.153Z` |
| Two-peer mesh | 4/4: native handshakes, scheduled capture, byte-identical multi-chunk originals reloaded from project storage, durable acknowledgements and released staging; 8,781 ms | `2026-09-22T17:52:46.882Z` |
| Four-peer mesh | Same four checks passed with four peers; 19,858 ms | `2026-09-22T17:54:01.825Z` |
| Workspace | 6/6: inspected immutable image save/retry, reload with revision/frozen roster, conflicting retry preserves original, device/account isolation, finishing retains capture hash, changed roster preserves previous projects | `2026-09-22T18:01:44.713Z` |
| Shared preview, initial run | 6/6 native allocation/fallback/disposal checks. Both two- and four-source runs selected original tiles because measured work exceeded the bound. This is **not** proof of actual Together drawing. Warm-model retry evidence is still being collected. | `2026-09-22T18:07:37.803Z` |
| Account cleanup | 5/5: close-and-drain precedes deletion, old handles cannot rewrite removed data, other scopes retain metadata/Blobs/markers, untouched scopes reopen, expired metadata cleanup preserves active records and projects | `2026-09-22T18:14:19.356Z` |
| Shared preview, warm retry | 9/9: actual two- and four-source Together drawing, explicit unchanged-bound warm retry, paused/missing fallback and disposal. Two-source work 231.7 ms; four-source trial 173.4 ms selected fallback, then a same-model retry measured 43.2 ms and reached Together. | `2026-09-22T18:15:46.014Z` |
| Workspace, extended recovery | 7/7, including a real saved PNG recovered after both project and transfer databases reopen, repairing interrupted outgoing staging with the same UUID and exact bytes | `2026-09-22T18:22:02.541Z` |
| Transfer journal, extended recovery | 7/7: partial outgoing repair after reopen, exact scope, concurrent 64 MiB ceiling and new-room expiry cleanup that preserves another account | `2026-09-22T18:29:50.776Z` |

Initial shared-preview playback timed out because the fixture awaited playback before starting its canvas repaint interval. Starting the bounded interval first fixed that fixture deadlock; the timeout and failure assertions remain. The first successful native preview run measured 4,501.4 ms for the first two-source inference group and 329.1 ms for the four-source trial, both selecting the documented performance fallback. JS heap observations exclude native/GPU allocations. The common lab `mediaInventory` field still describes P0 arithmetic, not total P5 memory.

The later warm-retry run reached actual Together composition for both group sizes. No performance threshold was relaxed; the four-source case reused its already loaded model once after a slow first trial. This demonstrates the desktop composition and fallback paths with synthetic silhouettes, not human segmentation edges or physical-phone performance. The sampled JS heap peak was 30,492,777 bytes.

## Integrated room UI rehearsal

`/v2-lab/room` hosts the actual `Workspace` component with synthetic camera streams, native engines, isolated databases and injected room authority. Only the selected participant's live preview should run segmentation. This fixture is development-only and must return 404 in the production build.

The stable two-person rehearsal passed host admission, peer readiness and a coordinated four-shot round. Each browser participant saved all eight originals. The capture state returned to idle and another-round control became available. A host caption advanced the shared design to revision one; a guest-owned heart advanced it to revision two. The host saw the shared change without receiving controls to edit the guest's sticker. Leaving created an independent project ID in the fixture database. Selecting Cream studio propagated the shared scene and exposed the saved-photo Together preparation control. The fixture then stopped and cleaned up its own databases.

The four-person rehearsal admitted Bao, Cleo and Dara sequentially. After selecting Quad strips, a coordinated three-shot round saved all 12 originals on both the host and Dara. An explicit host reconnect restored all three peer connections without changing the saved round. Resending the host's three saved originals did not add duplicate positions. Selecting Cream studio then preparing the saved Together preview paused live processing, completed the saved composition and resumed live preview. These flat synthetic sources are not people, so their transparent masks do not establish human-edge quality. The fixture stopped cleanly before source edits resumed.

This rehearsal found that the default group layout selected Trio for four people. New drafts now choose their layout by the highest admitted role, preserving role gaps after removal. Shared layout choices and recipe validation include every current participant; source tests and the final rendered regression passed.

The final four-person recovery rehearsal selected Quad automatically. Keyboard selection changed the frame to Noir and returned focus to its dropdown after the durable revision. A one-shot injected `QuotaExceededError` on the host's first original left nine remote originals saved, one local original retained, and the leave-with-copy action disabled. Retrying saved that same original, producing 10/12 without another shutter. The explicit preserve-incomplete/new-round action then completed a distinct 12/12 round on the host and Dara. Removing Bao retained A/C/D roles, Quad geometry and visible guidance about the empty position. No false signal-floor expiry appeared in this run.

The interface was reviewed at 1280 × 720 and 390 × 844, including dark and light surfaces, visible keyboard focus, dropdown placement and 44 px room controls. A guest saved an independent editable design after host loss before the first capture. Removed guests retain their local copy action without active shared editing or reconnect controls. Normal `/room/new?v=2` renders an unavailable state with retry, solo and saved-project recovery while server activation is disabled.

The initial admission rehearsal exposed replayed SDP answers after roster changes. The engine now binds signalling payloads to the roster and recipient connection epoch, suppresses exact replays, handles individual page failures and fences late completion. Focused tests exercise sequential admission and duplicate SDP. A separate review caught repeat committed-capture polling that could re-enter the busy state after completion; the notification is now emitted once per capture.

## Final checks and remaining acceptance

The final `npm run check` passed TypeScript, full ESLint and **411/411 tests**. The first test attempt could not start any Node test workers because the Windows sandbox returned `spawn EPERM`; the permitted child-process retry passed without changing assertions. `npm run build` passed. The temporary production server returned 200 for Home, Projects, room entry, manifest and revisioned PWA icons, and 404 for both `/v2-lab` and `/v2-lab/room`. Room capabilities returned the expected disabled 503 response. The normal Projects page's explicit room-storage inspection displayed its empty state without changing saved projects.

Deferred or unavailable acceptance remains separate: real Android/iPhone camera and installed PWA behaviour, two/four physical devices, cross-network/forced TURN, hosted schema/credential activation, real-person segmentation, assistive technology, OS download/share and remote CI. No commit, push or deployment has been made.
