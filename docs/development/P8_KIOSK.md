# P8 kiosk contract and local evidence

The E4 kiosk is a browser workflow for a dedicated managed profile. It is not operating-system lockdown and cannot protect against developer tools, another application, or a person who knows the operator PIN. Production event flags remain off. No hosted database or provider was changed.

## Authority and handoff

Migration `024_v2_event_kiosk.sql` adds an owner-created event device capability, stored only as a hash, and independent short-lived operator unlock. The server derives PIN proof with the existing transport secret and event/device identity. It stores no raw PIN. Five failed attempts exhaust a 15-minute window; successful unlock lasts 60 seconds. Limits are two active devices and eight retained device registrations per event.

Owner setup requires a six-digit PIN, a dedicated-profile acknowledgement, and confirmed account sign-out before admitting a guest. It clears ordinary contribution, receipt and audience cookies. A non-secret cookie and local marker restrict navigation to this device's kiosk. The root guard initially hides private children, checks back/visibility/navigation and the proxy denies other API paths. Protected exit requires fresh server unlock and clears old ordinary guest credentials again. Existing account/device drafts are preserved rather than silently deleted.

Each guest is assigned a new immutable device generation. Reset clears the guest component, photo URL, camera and receipt QR before awaiting the server. It also closes the old HTTP client and drains its IndexedDB transactions. Reset requests are idempotent. Startup clears expired queue entries before advancing the generation. Idle reset is two minutes; hiding the page resets immediately. The next guest never adopts an old receipt or receives queue access.

The temporary queue stores only approved JPEG bytes, exact digest/dimensions, independent submission/gallery/wall consent, opaque job identifiers and the original generation. It stores no receipt capability, PIN, account token or signed URL. A fresh operator unlock is required before and after queue enumeration. Existing registered jobs can upload, finalise and check status through the device capability after handoff. They cannot read event media, recover receipt tokens or change consent.

## Original approval and recovery

The selected event look is applied locally before the guest approves the finished image. Approval persists exact JPEG bytes before any reservation request. `reserving` is committed before dispatch, so an unacknowledged request cannot later masquerade as never sent. Exact request and submission IDs are retained for retry. The server maps those approved bytes to the registration; the worker verifies original hash, size and dimensions before derivative effects. A database trigger also prevents ready state without that matching source proof.

The journal retains at most eight pending photos and 16 MB globally, across at most eight device scopes. A photo expires at the earlier of 24 hours and the event expiry. Global housekeeping deletes only expired temporary records; live uncertainty is never silently evicted. Removed record UUIDs remain bounded tombstones to prevent late resurrection. The event's existing logical upload deadline remains unchanged; local retention is not an upload extension.

Verified ready acknowledgement removes the local photo. Pending or ambiguous results keep it. Operator export requires fresh unlock and, whenever reservation was dispatched, fresh exact registered-job status. Confirmed withdrawal, deletion, expiry or denied authority prevents export. Only a strictly never-dispatched `prepared` photo may use its explicit local-retention approval independently of a server registration. Export requests a browser download; it does not prove a file reached disk. Explicit local removal never claims server deletion or quota release.

The current minimal kiosk capture offers private delivery and independent gallery/wall choices. Guestbook/missions and multi-person postcard approval remain their separate surfaces; this tranche does not claim their kiosk integration.

## Local validation

- Disposable PostgreSQL migration harness passed empty/rerun/populated preservation, owner/direct-access restrictions, PIN limits, current-generation admission, stale reset, immutable approval replay, worker readiness, old registered-generation upload recovery, source-proof ready rejection and concurrent device capacity.
- Nine focused HTTP/client/runtime/fixture tests passed, including preseeded ordinary-cookie clearing, lost reservation acknowledgement, exact retry, concurrent reset drain, dispatched-job export denial after withdrawal/revocation, verified temporary-copy removal and late client closure.
- Fourteen event-worker tests passed when the source-approval seam was added, including actual Sharp JPEG metadata and mismatch rejection. Later postcard worker changes are independently owned and require their own integrated run.
- Whole TypeScript and focused kiosk ESLint passed. Production build and native kiosk UI checks are not claimed by these source checks.

`/v2-lab/events/kiosk` is development-only. Its explicit Start creates a unique isolated IndexedDB database and a synthetic JPEG, uses actual client/runtime/journal/components, and never writes real auth cookies or a production kiosk lock. Stop closes tracked clients/journals and deletes only that database. Controls cover lost reservation acknowledgement, failed upload, remount, verified completion, withdrawal and device revocation. The operator fixture PIN is 123456, not a production credential.

The separate native queue button exercises 13 real IndexedDB checks, including reopen, previous-guest denial, stale connection and late hash fencing, exact generation recovery, tombstones, CAS, capacity, expiry cleanup and other-device isolation. At this document checkpoint it is source-ready but has not yet been run by the parent browser reviewer. Synthetic camera pictures do not establish real camera permission, phone memory, hosted Storage cookie/token behaviour or deployment security acceptance.


## Native rehearsal receipt, 23/09/2026

The parent ran all 13 native kiosk queue checks successfully in desktop Chromium, then exercised the actual isolated kiosk interface. Guest one recovered a lost reservation acknowledgement with the same request, reached verified ready and finished into a clean welcome with no old QR. Guest two began with every consent checkbox false, chose gallery only, retained a failed upload across remount and returned to a clean welcome. A wrong operator PIN exposed no queue; the correct fixture PIN exposed one pending record. Local download was requested, uploads were restored, retry reached ready and removed the temporary bytes, and protected exit stopped the rehearsal. Narrow dark operator and desktop receipt-QR views showed no horizontal overflow in the reported inspection.

The run found focus falling to the document body after asynchronous guest/operator actions and guest finish. A scoped source correction now restores the current receipt or guest heading, the queue heading after operator actions, the PIN field after unsuccessful unlock, and Start my photo after a clean handoff. Scoped lint passed; post-fix rendered confirmation is pending. This receipt uses synthetic camera/transport and a unique real IndexedDB database. It does not prove real auth-cookie setup/sign-out, hosted provider behaviour, physical devices, or that a requested download reached disk.

The post-fix root pass confirmed Start my photo focus, guest-heading focus after the lost-reservation failure, receipt-heading focus after successful retry, PIN-field focus after incorrect unlock, and queue-heading focus after successful unlock. Revoking the synthetic device denied a pending-photo download, cleared the queue surface and returned focus to PIN. Protected operator exit remained available and stopped the disposable rehearsal. Idle turnover was observed returning to the welcome page, without claiming an independently measured two-minute duration.
