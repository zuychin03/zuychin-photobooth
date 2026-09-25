# P7 host workspace

The account-gated host workspace lives at `/events` and `/events/[id]`. It checks the deployment flag, sign-in, base event capability and host capability before exposing service actions. Source availability does not enable the deployment.

This tranche provides bounded owner/moderator discovery, moderator invitation acceptance, draft creation, event settings with curated scene/frame preview, contribution status and storage occupancy, opening/pausing/closing/deletion, and contribution-invitation issuance/rotation/revocation. Publication, gallery and wall controls are intentionally absent. Owner moderator-edit controls remain a follow-up until accepted-member-preserving invitation retries are verified. Export panel integration is owned separately.

Dates are entered in the device timezone, explicitly labelled beside the fields. The named event timezone determines event-facing date display. Look and default caption controls lock after the first accepted contribution; other settings follow the server's retention and quota rules. The preview shows the scene and frame, not a synthetic claim about guest photo filtering.

## Recovery and account lifecycle

Mutation input is frozen in the mounted page before sending. Creation, settings and invitation retries retain their exact IDs, revision and payload. State retries first inspect the current status, acknowledge an already completed target, and refuse to overwrite a different later state. No invitation is automatically reminted after a missing response.

This is **in-memory recovery**, not a durable host journal. Refreshing or leaving loses the retry record. Copy explicitly instructs hosts to inspect their event list/current settings before creating or changing again. The workspace warns on document unload; its Home link redirects the host to the workspace's leave confirmation while unsaved work exists. Back and discard confirmations focus the safe choice and restore the invoking control, while competing actions are inert.

The runtime closes clients synchronously on account loss, including clients arriving during initialisation. Each request is cancellation/identity fenced. Page hiding cancels waiting requests without replaying them. Returning to the page permits an explicit exact retry. Sensitive settings and links are hidden after access loss, and an account switch unmounts the previous workspace.

## Synthetic native review

`/v2-lab/events/host` mounts the real host components and real browser client against a temporary in-memory server. Start seeds Alex's event, Bao's moderator invitation, and Casey's separate event. No hosted request, real account or valid guest capability is used. Stop clears the simulation. This fixture has no database and does not demonstrate durable server storage.

Exercise:

1. Start as Alex, open **Graduation afternoon**, inspect mobile dark/light layout and change the scene/caption.
2. Lose the next mutation response, save settings and retry. Inputs remain frozen and the retry acknowledges one change. Advance seeded settings while editing to exercise stale revision refusal.
3. Create a draft with a lost response, remount the same account, then discover the committed event instead of creating a duplicate. Page-only recovery is deliberately lost on remount.
4. Open contributions, create an invitation with a lost response, then retry the exact request. Inspect its fragment-only link, rotate it, and revoke it once the corresponding server seam is verified.
5. Pause/close/delete with safe confirmation focus. A retry after a committed state change reconciles instead of repeating it.
6. Accept a synthetic contribution, refresh and inspect locked look controls plus failed-delivery/held-storage status.
7. Switch to Bao, accept the moderator invitation and confirm read-only settings. Switch to Casey and confirm Alex's event is absent. Revoke account access and inspect immediate teardown.
8. Simulate an older host server and inspect the unavailable state, then restore support. Stop and clear the rehearsal.

Focused tests cover runtime close/late initialisation/account switching, state and invitation retry semantics, fixture creation recovery, stale settings and account isolation. Browser layout, keyboard focus and actual interactions require the separate native review; unit tests do not establish those results.

## Host integration follow-up

Invitation links now include the local QR component. Owner controls invite/revoke a moderator by account UUID through the corrected 017 seam; re-inviting an active moderator preserves acceptance. The rehearsal shows synthetic account UUIDs and models that behaviour.

The account runtime constructs an optional export client with the same owner/epoch/token fence and verified Supabase origin. Owner details render EventExportPanel. Its busy or retained export state locks host changes; only external host work/settings/confirmation disables the export panel, avoiding a self-cancelling busy loop. Back navigation confirms loss of prepared downloads and page-held requests. The synthetic host intentionally omits the real export panel until it has a matching backend; Run isolated export checks exercises the separate seven-check fixture without hosted access.

Validation: whole TypeScript and focused ESLint passed; 11 focused host tests passed, including shared export-client account invalidation. Native host/QR/export interactions remain a separate review.

## Observed host walkthrough, 23/09/2026

The root inspected desktop light and 390-pixel dark layouts using the actual components with synthetic transport. Settings edits retained their exact retry after a lost response; stale revisions were refused and recovered through explicit retry dismissal and refresh. The first accepted contribution locked the scene/caption controls. Invalid timezone entry showed inline feedback, and the schedule review stated its actual timezone.

The locally encoded QR rendered with a white quiet zone, rotated to a new Blob URL and disappeared after revocation. Moderator acceptance recovered a lost response; reinviting that active moderator preserved acceptance and read-only settings. Revoked account access immediately removed the private workspace. Pause recovered its lost acknowledgement; closing remained visible in discovery with the original retention. A lost create acknowledgement followed by remount revealed one existing draft instead of creating another. Keyboard focus was visible and confirmation initially focused the safe choice. The fixture was stopped and cleared.

Review clarified how to dismiss a retry before refreshing, and that dismissal preserves edited settings and does not undo a server action. QR scanning on a physical phone, clipboard/OS delivery, hosted authentication and production moderator access remain unverified. Later private-preview and reminder integration requires its own native checkpoint.
