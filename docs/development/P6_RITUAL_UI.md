# Ritual interface

Updated 23/09/2026. `/memories/rituals` adds the account/pair-scoped schedule interface, linked from the album. The server checks `PB_MEMORIES_ENABLED`; missing configuration shows a recovery link, not an empty reminder list. The account component obtains a fresh session for every client call, aborts pairing discovery, closes the client on identity loss and removes late subscriptions. It uses the existing ritual HTTP and scheduler contracts. No provider or hosted feature was activated.

## Behaviour

The creator can create, review a legacy upgrade, edit, pause, resume or explicitly confirm deletion. Each member can change only their own email/push choices. All calendar choices use the shared custom Dropdown. The form requires a civil date/time and explicit IANA zone, defaulting visibly to Australia/Sydney. Advanced controls expose missing-date clamp/skip, daylight-saving gap shift/skip and repeated-time earlier/later policies. Travel does not change the stored zone. A review shows both local and UTC instants and applied calendar adjustments before saving.

Legacy reminders keep their current instant until explicit upgrade. An unchanged one-off preserves its exact instant, including sub-minute precision and the earlier occurrence of a repeated local time, through upgrade and later title-only edits. A past one-off cannot advance into another year. Native date/time inputs handle input as well as change events, so their displayed values reach the reviewed schedule. The server remains authoritative for current time and the next occurrence.

Requests use current revisions. A create retry retains its exact ID and reviewed payload while the form is mounted. Ambiguous mutation responses disable further changes until refresh. Refresh closes stale edit/upgrade forms; an uncertain create retains its exact reviewed request for explicit retry. Leaving or reloading this form does not persist that request: users are told to check the list before another create, and nothing is resent automatically. Confirmed access/account loss clears the pair's titles, schedules and forms and shows only recovery navigation. This is distinct from a transient failure.

The list shows at most 20 rows per page, with explicit next-page and first-page refresh. Paused, finished, pending, retrying, failed and uncertain delivery are separate states. An uncertain occurrence does not claim either delivery or non-delivery. Resume schedules only a future occurrence. Pausing/deleting explains that an already-sent reminder cannot be recalled. Delivery messages contain no addresses or push endpoints.

## Local evidence

Twelve focused editor/client-fixture tests passed. They cover month-end clamp, gap/fold handling, unsupported input, preserved exact one-off instants, lost create acknowledgement/exact retry, changed-payload conflict, creator-only operations, member channel isolation, stale revisions and unpairing. The full integrated checkpoint passed **715/715 tests**, whole TypeScript and ESLint. The static design detector reported no findings in the new ritual surfaces.

The actual browser client and components were exercised through development-only `/v2-lab/rituals`, using temporary in-memory reminders. Native checks covered:

- Create/review, custom frequency dropdown and Sydney's 04/10/2026 02:30 gap resolving explicitly to 03:30 AEDT / 03/10/2026 16:30 UTC.
- A mutation accepted before a lost acknowledgement, then refresh and same-request retry producing one visible ritual.
- Explicit legacy upgrade with the same displayed UTC instant; pause/resume feedback and personal reminder choices.
- Switching accounts: the second member had no creator edit/pause/delete controls and saw only their own channel settings.
- Explicit deletion confirmation, refresh after unpairing clearing every private row/form, and focus on the recovery heading.
- Keyboard focus moving to form/review headings, reminder-choice checkbox and deletion confirmation, then back to the list heading after changes.
- 1280 × 720 desktop and 390 × 844 narrow layouts, light and dark themes, readable controls and no horizontal overflow (385-pixel document within the 390-pixel viewport).
- The real route's unavailable state and device-project recovery link at the narrow viewport.

The rehearsal was stopped. It does not establish hosted authorisation, native notifications, actual email/push delivery, phone date pickers or assistive-technology behaviour. Final English copy, all-page/component review and physical devices remain separate gates.

The production build passed. Production smoke returned 200 for `/memories/rituals`, 404 for its development rehearsal, and private/no-store 503 for the disabled retained-read endpoint. All six revisioned V2 icon assets still returned 200 with correct image types. The temporary production server was stopped; the development library remains available with the viewport reset.
