# Direct challenge entry

The approved `/challenges/[id]` route now opens the existing scoped challenge workflow. The path contains a UUID identifier, not a credential. The challenge list also exposes a normal **Direct link** for each authorised result. No invitation is accepted, original downloaded or file uploaded by opening the route.

The Next page awaits its promise-valued `params` following the installed Next 16.3.6 dynamic-route guide. Malformed IDs return 404. The page is dynamic, requests no indexing and uses no-referrer metadata. It sends only the identifier and deployment availability to the client, never account-specific server-rendered data. The existing service worker excludes this private route from its public page cache; no service-worker change was needed.

Both `PB_CLOUD_PROJECTS_ENABLED` and `PB_CHALLENGES_ENABLED` must be true for the direct entry to initialise a cloud runtime. Disabled flags or missing public account configuration show a device-project fallback. The service still independently enforces its configuration, schema capability and current membership. A signed-out visitor gets a local, UUID-only `/login?next=...` return URL and is told to use the invited account. A link alone grants no access.

## Shared account lifetime

`openAccountCloudRuntime` and `useCloudRuntime` extract the established cloud library lifecycle. Both the cloud library and direct entry use the same implementation: a fresh account epoch, an authentication subscription, bounded account-scoped upload journal and existing cloud/challenge clients. Token retrieval still verifies the current session's user ID. A different account or logout synchronously clears identity and closes clients, upload manager and journal. Unmount unsubscribes and closes resources. A journal that finishes opening after cancellation is closed without publishing its runtime. A fresh instance for the same owner receives a new epoch.

The hook only publishes a runtime after another active-account check. React subtrees are keyed by the account and challenge so private view, selected files and preview URLs remain subject to the existing detail cleanup. The extraction does not introduce a shared durable cache or persist credentials.

## Invitation and access flow

`loadChallengeEntry` first requests the authorised challenge view. An invited or declined participant receives an invitation state without calling project media discovery. Legacy layouts remain an explicit unsupported state. The invitation screen displays the frozen people, photo positions, reveal rule and deadline. Accepting is an explicit button; declining has a confirmation. Acceptance uses the existing atomic challenge operation which also accepts the exact project invitation. It then reloads authoritative state.

For accepted participants, entry requests the exact active project, verifies current accepted membership and reloads the challenge before mounting `ChallengeDetail`. The identifier and project binding must match throughout. Account changes, cancellation, revocation and failed reads cannot return a ready entry. A withdrawn contributor can only reach the limited existing detail workflow if current project membership still permits it; source reads remain controlled by the existing service gates.

Stopping a request is described as stopping the wait, not rolling back a potentially accepted invitation. The screen clears its stale entry and directs the user to refresh before responding again. Request generation checks prevent an older interrupted request from clearing the busy state of a newer one. Challenge metadata and asset downloads still receive fresh server authorisation; a rendered screen is not permission.

## Local evidence

Six shared-runtime tests and seven direct-entry tests passed, alongside three existing challenge UI domain tests (16 total). They cover logout during journal open, synchronous authentication changes, construction failure cleanup, same-account new epochs, safe return URLs, invited/declined views without project fetches, legacy layouts, current accepted membership, wrong project binding, access loss during loading and cancellation. Targeted strict TypeScript passed. Focused ESLint and the UI detector are recorded in the tranche handoff. These injected tests do not claim live sign-in, hosted Supabase or physical-device acceptance. Root integration owns the normal UI/browser smoke and consolidated build.

Root's development HTTP smoke returned 200 for a valid UUID route and 404 for a malformed identifier. The actual unavailable state was visually inspected at 1280 × 720 and 390 × 844 with flags unchanged. The narrow document fit within its viewport, and the device-project recovery link was exercised. Authenticated invitation and account-entry behaviour remains covered by injected tests until live auth and hosted activation are authorised.
