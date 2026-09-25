# P7 guest contribution and receipt UI

This is a locally verified source tranche. Event activation, hosted migration/provider behaviour, physical camera behaviour and kiosk turnover remain separate gates.

## Routes and authority

`/events/{eventId}/join#invite={token}` captures a canonical invitation in memory and synchronously replaces browser history before starting asynchronous work. Query-string tokens, duplicate scope fields and unknown fragment fields are rejected. Existing contribution cookies are inspected first; continuing a current guest is explicit, and an invitation never silently replaces it. No account or nickname is required.

`/receipt/{submissionId}?event={eventId}#token={token}` preserves only the public event UUID after fragment removal. The private token is memory-only. Opening a receipt explicitly replaces the single receipt-cookie slot; a refresh without the fragment can use that current cookie. A receipt cannot contribute or moderate. Both pages declare no-referrer/noindex metadata and the shared response configuration supplies private/no-store and no-referrer headers.

The guest context RPC in 017 requires the current contribution capability. It returns title, civil timezone/window, event status, validated look and capacity/availability booleans. It does not expose owner identity, members, other submissions or capacity budgets. The HTTP handler checks expectedGuestId against the current verified cookie, rate-limits the request and rejects malformed server projections.

## Photo and recovery flow

Camera access occurs only after an explicit button. File import is bounded to the existing still-image contract. The shared compositor applies the host frame, filter and caption to a single photo; imported capture dates are omitted because their time is unknown. Scene looks retain the original background with an explicit warning until an approved cutout path is added. The prepared JPEG is bounded to 1,600 pixels on its longest edge and 2,000,000 bytes. Native decode/encode work keeps its occupied slot until late work settles; cancellation never makes that slot available early.

Submission, gallery and wall consent are independent, with gallery and wall off by default. Host/moderator management access is explained separately from public display consent. A recovery record is persisted before reservation. The private receipt and expiry are shown before upload. Lost acknowledgements retry the same request and submission IDs. Metadata-only is the default; temporary Blob retention requires a separate explicit choice. Without it, reopening an interrupted upload requires the exact prepared JPEG, so the UI provides a local download before leaving or preparing another photo.

There is no automatic polling or upload retry. Refresh/retry actions preserve uncertainty and use the current authorised session. A ready download rechecks receipt authority. Withdrawal removes event consent and warns that existing downloads cannot be recalled and issued media links can last up to five minutes. Removing a local request does not claim to remove its event submission.

Finish explicitly removes the exact guest journal and in-memory previews/links. It does not clear or revoke the contribution cookie, and the UI says this is not a kiosk reset. Kiosk operator capability, next-person handover and full shared-device cleanup remain required later work.

Confirmed authority loss closes the stale client/journal and unmounts the camera, preview, queue and receipt link immediately, without deleting the old guest's isolated recovery records. A fresh cookie inspection then offers explicit re-entry. Temporary worker admission failure is distinct: an existing guest can still enter recovery while new uploads are unavailable. The page requires the host/context capability before entry and labels service unavailability separately from a full event.

## Local rehearsal and evidence

Development-only `/v2-lab/events` uses the actual guest components, client and isolated IndexedDB journal with an in-memory fake transport. Its native synthetic photo is generated locally. Controls cover a lost reservation response, interrupted PUT, held verification, remount/recovery, paused event and replaced guest. The private-receipt view uses the actual component. No account, camera permission, provider or hosted network is used. Fake server state resets on reload; this is not evidence of server durability.

The journal button runs the disposable native probe, including a module worker with an independent JavaScript registry to check stale-handle fencing and preservation of another guest's queue. Native execution and visual findings are recorded by the root rehearsal, not inferred from source tests.

The guest journal uses IndexedDB version 2. Scope records contain a generation and a bounded local expiry. Version-one string generations upgrade unchanged, with a conservative 24-hour expiry because their original age was not recorded. Older version-one code cannot reopen the upgraded database. Before scope and record capacity checks, one bounded transaction removes expired records across scopes and retires expired empty scopes. It never returns another guest's records or removes their non-expired data. Recreated scopes receive fresh generations, so pending hash work and separate worker handles cannot recreate retired data. Expiry is checked when the journal is used; this is not a background deletion timer.

Receipt refresh accepts a monotonic event-retention extension from the authorised server response. The upload deadline remains exact, shortening is rejected, and the device record retains its original expiry. Local checks for this correction: 11 focused journal/runtime tests, whole TypeScript and focused ESLint passed. The expanded native probe covers the version-one upgrade, eight non-expired scopes, expired foreign capacity reclamation, a delayed prepare crossing retirement, and independent worker generation fencing. The root ran it through the normal development UI on 23/09/2026: all 21 checks passed. A first rehearsal exposed a fixture clock mismatch after the independent worker renewed a scope using real time; the corrected probe advances beyond that renewal rather than evicting a non-expired scope.

Local checks on 23/09/2026: whole TypeScript passed; scoped guest UI/runtime lint passed; design detector returned no findings. Thirty-seven focused client, journal, runtime and HTTP cases passed. The complete disposable 017 SQL suite passed, including guest-context authority/capacity, exact invitation/read-token revocation, preservation of existing guests and active moderator membership on invitation retry. No migration was applied to a hosted service.

## Corrected host operations

The follow-up retake check used only a labelled synthetic canvas stream. Reopening the camera replaced the prior photo with a playing 480 x 640 video (native readyState 4); closing restored the prior image. A new capture then released the video element and rendered a 1036 x 1600 composed JPEG. Hidden native file inputs no longer appeared as duplicate unlabelled controls. This checks the actual render/capture path without requesting physical camera permission. The fixture was stopped and cleared.

Root native evidence on 23/09/2026 covered an explicit guest join, a composed synthetic JPEG, all public consent defaults off, lost reservation acknowledgement, retained-photo recovery after remount, interrupted upload retry, held verification and a private ready receipt. Delivery removed the original from the device queue. The receipt download action ran without claiming OS delivery. Narrow dark receipt layout and paused contribution recovery were inspected.

A replaced browser guest initially exposed stale controls; the corrected path now immediately hides the old retained preview, pending records and receipt actions on confirmed access loss. Explicit continuation opens the new guest with an empty queue. A separate no-retention request survived remount as metadata only, rejected a mismatched file and became unavailable after explicit withdrawal. This review also removed duplicate unlabelled file-input controls and clarified that retry needs the exact finished file. Both guest walkthroughs ended with isolated queue deletion. Real camera and hosted cookie/provider behaviour remain unverified.

017 adds scoped service-only `pb_event_revoke_capability` for both invitation and read-token hashes. Foreign-event hashes fail and exact retries remain valid. Revoking an invitation blocks new redemption without implicitly revoking already admitted guests.

017 also adds `pb_event_invite_moderator`: re-inviting an active moderator preserves active membership; new or revoked membership becomes invited. The HTTP handler routes those operations through the corrected RPCs without changing the applied 005 baseline. These backend semantics do not claim that the complete moderator delegation UI is finished.
