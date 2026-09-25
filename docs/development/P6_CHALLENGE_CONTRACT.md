# P6 challenge foundation

Migration `004_v2_memories.sql` in this tranche implements challenge permissions and consent only. It does not activate a challenge route, image worker, client recovery UI, activity ledger, ritual scheduler or voice attachment. No hosted migration is applied. `PB_CHALLENGES_ENABLED` and `PB_CLOUD_PROJECTS_ENABLED` must both be explicitly true, and the configured 002 scope/bucket capability must pass. Missing flags remain disabled.

## Frozen scope and assignments

Each challenge belongs to a 002 friend project. Its creator must own that project. The proposed roster contains exactly two to four known project member identities, including the creator, with unique A–D roles. Existing project invitations can be explicitly accepted through challenge acceptance; current couple relationships and room roles grant nothing.

At most thirty-two challenge records are retained per project, including cancelled and expired records. The project lock serialises the ceiling; exact UUID retries consume no extra record. There is no silent history deletion or automatic ceiling reset.

Creation binds an immutable request fingerprint, validated design, server-computed recipe hash, reveal policy, expiry instant, member identities and assignments. Every member has at least one assignment. There are two to sixteen distinct source assignments and at most four source indices per member. Up to sixteen output photo cells can reuse these sources, including Together companions. Source indices need not be consecutive, preserving existing layouts that reuse selected positions. All participants must explicitly accept before opening. Opening records the frozen instant; there is no roster replacement, recipe mutation or role reuse API.

The v2 create contract accepts `design: TemplateDesign`, validated by `validateTemplateDesign`, with the member roles, policy and expiry. It does not accept a caller hash, assignments, local project history, camera identifiers, account scope, URLs or arbitrary media. Primary cells and companions derive one assignment per distinct role/source index, sorted A–D then source index. Repeated cells do not demand repeated uploads. Sparse source indices remain sparse; `requiredSources` must equal the highest used index plus one for exactly the participating roles.

SQL independently derives and compares those assignments, sorts the member mapping, and computes SHA-256 over PostgreSQL's canonical `jsonb::text` representation of `{design,members,assignments}`. This is the database recipe digest, not a client JSON.stringify/JCS digest. Object key order does not change it. Full built-in asset/style and geometry validation belongs to the shared TypeScript parser at the trusted service boundary; SQL also checks bounded structural and source/reference invariants. SQL rejects a caller `recipeHash` field. Changed design or member/source bindings under the same UUID conflict.

Every PNG decoration ID is a cloud asset UUID in the same project. The database requires a ready, unprotected decoration, exact MIME/byte/dimension metadata, and an accepted asset owner. The creator already has accepted project-owner access. Missing, reserved, foreign-project or challenge-protected assets fail. Opening and reveal recheck decoration availability; deleted/revoked required decorations cannot be silently replaced or omitted. Text in this frozen shared design is explicitly shared design text, never an upload channel for concealed participant answers. Source-photo IDs are absent from the design.

Capability version 2 and recipeVersion 1 are required by the adapter. Retained hash-only rows have no design backfill: their view is `{id,projectId,unsupported:true,reason:'recipe_unavailable'}` and new mutations fail. The author can still resolve their own retained original through the normal project gate. No old recipe is fabricated, no old data is deleted, and no foreign full-result access is inferred. A retained partial from such a challenge similarly returns `{id,challengeId,unsupported:true,reason:'recipe_unavailable'}`. New proposals, consent changes and commits reject with `update_required`, preserving the old rows without offering an unusable consent flow. Future route/UI integration must show that unavailable history state.

## Submission and reveal

Submitted source bindings are immutable. A stable request UUID and complete fingerprint provide idempotent retries; changed payloads conflict. Each referenced object must already be ready, owned by the submitting member, in the same project, protected by this exact challenge and assigned to the submitted source index. Missing assignments, another member's asset, arbitrary paths and decoration-as-photo submissions fail. SQL does not accept captions, URLs, inline images or arbitrary metadata in a submission.

All normal mutation paths lock project, then challenge, then submission-specific rows. Last submission rechecks the accepted roster, project membership, deadline and every submitted asset before recording one immutable reveal snapshot/hash/timestamp. Concurrent final submissions and repeated requests return the same committed result.

Policies are explicit:

- `all_submitted`: others' contributions remain concealed until that atomic full reveal.
- `immediate`: a committed submission is visible to the frozen accepted audience while the challenge is open. The result is not described as fully complete until all members submit.

The challenge deadline is a submission deadline. Cancellation and expiry stop new submissions and do not create reveal permission. An author retains access to their own verified originals while their project membership remains accepted. They may export their own photos even when a round is incomplete. No new media-retention promise or automatic permanent Cloudinary archive is introduced; future UI must separately state project retention.

## One gate for every representation

004 replaces 002's protected read/write hooks. The generic project owner or accepted member cannot bypass the challenge gate. Direct table grants remain revoked and the private bucket's restrictive client policy remains in force.

Before reveal, projections contain member identities, roles, assignments and completion booleans, but omit another author's source IDs, paths, captions, thumbnail URLs and raw snapshots. The author can retrieve their own submitted source bindings. The project view and asset resolver call the same protected gate, so inspecting a broader project does not reveal concealed bytes.

Only explicitly submitted assets can become visible to others; unused protected uploads remain author-only. Any future cutout, thumbnail, voice caption, flattened composition, exported bundle, recap or event derivative must preserve the same protected subject and source provenance. These representation endpoints are not implemented by this tranche. A new unprotected derivative must not be used as a shortcut around the gate. New URLs require fresh authorisation and remain limited to the 002 five-minute bound; already issued URLs and downloads cannot be recalled.

Withdrawal is irreversible for that challenge membership. A withdrawn member cannot read other contributions again, even after an earlier reveal. Revoked project membership prevents new challenge/project access entirely. If a required participant or source asset becomes unavailable, full composition access is invalidated, `accessLost` becomes true and only still-authorised own sources remain visible. There is no automatic re-accept/re-pair path that restores the old full result. Historical `revealedAt` does not mean the original is still accessible.

## Explicit partial results

A partial proposal snapshots exact submitted sources and recipe for one to four included contributors. Its recipient set is those included contributors. Proposal UUID and server SHA-256 digest bind the snapshot; no asset IDs or private snapshot contents are returned with a consent request. Each included contributor separately consents using their own verified identity and the exact digest. Consent is not inferred from submitting, creating a proposal, accepting the original challenge or another person's approval.

Any refusal rejects that proposal. A new proposal needs fresh consent; old approvals cannot be reused across IDs or changed inclusion. At most twenty proposals are retained per challenge. Committing requires all included grants, current membership, the same immutable source bindings and available originals. The partial result is recorded separately; it does not turn a cancelled/expired/all-submitted challenge into a full reveal. Participants excluded from the partial do not gain its access.

Withdrawing partial consent removes future partial reads. Underlying challenge withdrawal or project revocation also invalidates applicable partial access. `accessLost` explicitly distinguishes a historically revealed partial from currently available content. An independently authorised full reveal is not revoked merely by withdrawing a separate partial-result grant; underlying withdrawal is the distinct action for that scope.

## Server contract

`createChallengeStore(accessToken)` verifies the token through Supabase `auth.getUser`, binds the actor and checks versioned capabilities before operations. It exposes create/view/manage/submit, propose/read/consent/commit partial operations. The SQL `pb_challenge_*` entrypoints are service-only. Returned projections are allowlisted and validated; unexpected private fields are not forwarded. Recipe creation, including its mapping and RPC envelope, is bounded to 64 KiB; ordinary submission SQL remains bounded to 8 KiB. Responses are bounded to 96 KiB to carry the validated frozen design and lifecycle projection. Each fetch has a ten-second abort, not a hard total request deadline. Instantiate the store per request, never across accounts.

Expiry sweep processes at most twenty-five challenges per call. It changes lifecycle state without revealing media. The 002 reservation sweep/cleanup remains responsible for unused uploads and retained charges. Late uploads cannot finalise after cancellation, expiry or withdrawal. No new uncharged storage pool is introduced. A recipe references already charged decoration originals.

Apply 001/002 before 004; rerun current migrations in order. Replaying only an older migration can replace a newer protection hook and is not a supported migration sequence. 004 itself is rerunnable against populated data. No legacy relay or couple permission is widened.

## Following tranches

Durable per-account activity must be independent of deleted media, idempotent by source event, and preserve known timestamps/provenance without inventing historical timezones. A newly paired partner must not inherit an old scope. Recaps must resolve available archived/retained assets and honestly omit expired ones.

Rituals need explicit IANA zone, local anchor, DST gap/fold and month-end/leap policies, recipient opt-in/pause and occurrence-keyed durable delivery receipts. Existing process-local `nextOccurrence` is not suitable for the new scheduler. No scheduler is installed here.

Optional voice requires a verified audio/container/duration profile of at most thirty seconds, explicit microphone consent, no autoplay, a text alternative and shared export/delete/protection accounting. The existing image-only 002 resource shape cannot be relabelled as audio. Source schema, worker and bundle changes must precede audio activation.

## Evidence

`tests/challenge-store.test.ts` exercises configuration/auth/version denials, bounded roster/source parsing, getter rejection, verified actor binding, opaque projections and exact-digest partial consent. Frozen recipe tests cover repeated/companion/sparse sources, role coverage, caller-hash rejection, unsupported history, unknown URL/metadata fields and altered returned designs.

`node database/tests/run-memories.mjs` creates and removes a disposable PostgreSQL database. It applies legacy/P1/002/004 and reruns 004 empty and populated. Real concurrent connections exercise two-, three- and four-person final submissions, duplicate retries, one reveal snapshot, final submission versus withdrawal, and project/proposal metadata ceilings. Reserved uploads cannot mint or finalise after cancellation, expiry, project revocation or challenge withdrawal; failed finalisation keeps its charge. Adversarial checks cover owner/current-couple/extra-project-member access, direct grants, foreign source binding, broad Storage policy attempts, cancellation/expiry, stale/refused/withdrawn partial consent, excluded recipients and post-reveal withdrawal/revocation/source loss. Frozen-design tests exercise canonical hash/key-order stability, immutable changed-payload retries, SQL assignment agreement, exact ready/unprotected decoration authorisation and hash-only legacy projections.

Storage rows and decoder assertions in this suite are metadata fixtures. No hosted SQL, actual token mint, native image verification, signed-URL/cache behaviour or real browser challenge flow is proven. Those remain required integration and release gates.
