# P7 local test look and private contribution review

This tranche implements E1's local test-photo preview and the P7 private gallery skeleton. It does not implement the public event gallery or wall, and does not activate event services.

## Authority and migration

Apply additive migration `020_v2_event_review.sql` after the event foundations. It adds service-only capability, listing and thumbnail access RPCs without changing existing event rows, quotas or worker operations. The separate capability is version 1, with 12 metadata entries per page, 100,000 thumbnail bytes and a 400-pixel edge. Missing or incompatible schema remains unavailable.

Private review requires the current authenticated event owner or an active moderator. Invitations alone grant no review access. The event must not be deleted, expired or have its allocation released. A thumbnail additionally requires ready delivery, a completed verified finalisation job, an exact bounded Storage object and every included contributor's current underlying submission consent. Revoked guests and withdrawn submissions fail closed.

Gallery and wall consent, approval and hiding are deliberately independent of private host management. A guest who allowed private delivery but declined both publication surfaces can still be reviewed by the host. No guest contribution, receipt, gallery or display token authorises this endpoint. Public browsing and moderation surfaces remain P8 work.

## Transport and bounded resources

`POST /api/events/[id]/review` supports `capabilities`, `list`, `access` and `media`. It uses the existing same-origin HTTPS/Bearer authentication, private/no-store responses, finite request body and actor rate gate. The actor never comes from the body. Listing returns delivery/publication state, fixed creation time, promised expiry and thumbnail availability, with no guest identity, caption or signed URL.

Media signing requires fresh authority before and after the provider operation. Only the exact private `/thumbnail` path is accepted, with a read grant bounded to five minutes and the retained-media expiry. Existing exact `/image` signing and worker effects remain unchanged. Previously downloaded copies cannot be recalled.

The account-fenced browser client validates the configured Storage origin, exact bucket/path, response bytes, JPEG structure and native dimensions. It checks SHA-256 when the descriptor includes a digest. Existing finalisation checkpoints retain the delivery-image digest but not a thumbnail digest, so current SQL explicitly returns `sha256: null`; this does not claim immutable thumbnail hash verification. The worker already verified the thumbnail before marking delivery ready. Hosted Storage metadata/provider behaviour remains a separate activation gate.

Only one native thumbnail pipeline is active at a time. Byte streams have a 4,096-chunk ceiling, no redirect is accepted, and a cancelled or timed-out native decode retains its occupied slot until it settles and closes. A fresh access check follows download/decode. No URL or thumbnail is written to durable storage.

## Integrated host components

`EventHostTestPreview` takes current settings and an explicitly selected local image. It reuses the guest compositor, applies the current frame/filter/caption, preserves the source and creates no reservation or upload. Imported capture dates remain unknown. Unsupported scene replacement is labelled honestly. Settings changes, cancellation, visibility loss and unmount release the generated preview.

`EventHostContributionPreview` is available to accepted hosts/moderators. Listing and each thumbnail download are explicit. The component displays one private thumbnail, reauthorises it approximately every ten seconds while visible, clears it on failed reauthorisation and hides the metadata/actions after confirmed authority loss. Hiding the page, changing account/client/event, starting a conflicting host action or unmounting cancels work and releases the URL. This periodic check is not a promise that an offline or disconnected browser receives immediate server revocation.

The host account runtime owns and closes the review client. Parent busy controls include preview work, while each child excludes its own busy state from its external disabled prop. Cancel remains available during preparation. Public event flags remain false by default.

The development host rehearsal has explicit controls to add one locally generated private JPEG and withdraw it. It uses the real review client with isolated synthetic HTTP responses, including a thumbnail hash, and retains the existing moderator/account controls. The local look preview accepts an explicitly chosen file through its normal picker. Nothing in this rehearsal authenticates against or uploads to a provider.

## Evidence

The disposable PostgreSQL 16 harness passed empty/populated reruns, exact owner and active moderator reads, invited/foreign denial, private and hidden publication combinations, withdrawn/revoked contributors, missing thumbnail bytes, incomplete verification, closed-event reads, expired/deleted-event denial and direct RPC grant denial. Its Storage metadata is synthetic, not evidence of hosted Storage behaviour.

Twenty-four focused review/provider/host-runtime/fixture tests passed, including real client-to-handler projections, optional digest verification, late native-decode settlement, account changes, post-sign/post-decode revocation and exact image/thumbnail signing restrictions. The fixture regression exercises private delivery with publication declined, invited denial, active moderator review, withdrawal, remount, account replacement and an unavailable server version. Whole TypeScript and scoped integration/fixture lint passed after the fixture extension. The UI detector reported no findings. Native host UI verification remains separate from these source checks. Physical camera, hosted provider and all-page/device acceptance remain pending.

## Native follow-up, 23/09/2026

The root used the actual host rehearsal at 390-pixel dark and desktop light sizes. Choosing a synthetic PNG produced a 1072 x 1096 local preview with the selected Sage frame and caption, without event reservation or upload. Changing the caption cleared the stale preview. The labelled chooser remained the only exposed file control after the accessibility correction.

An explicit contribution load and thumbnail open decoded the synthetic private 120 x 160 JPEG. Withdrawal caused periodic reauthorisation to clear both image and stale contribution actions. This exercised the real client/component with fake transport; it does not establish hosted Storage or physical device behaviour. The fixture was stopped and cleared.
