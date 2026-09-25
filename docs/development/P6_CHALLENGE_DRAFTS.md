# Durable challenge request recovery

This tranche integrates device recovery for challenge creation and partial-result proposals. It does not upload photos, grant consent, activate hosted services or prove hosted behaviour.

## Storage and authority

`pb-cloud-upload-journal` upgrades additively from version 2 to version 3. Its existing `uploads` and `generations` stores remain; `challengeRequests` uses the same exact account identity and persisted cleanup generation. The upload journal's public API remains compatible. The existing sign-out removal branch now removes both stores in one transaction through `removeCloudUploadJournalForOwner`.

Each account has at most 32 request records, 70 KiB per record and 2 MiB total JSON. There is at most one creation draft per project and one partial-proposal draft per challenge. Capacity never evicts a draft or an uncertain request. Account-level recovery allows explicit dismissal after explaining that an online request may already exist and local dismissal does not cancel it, revoke consent, remove an original or free cloud capacity.

Creation drafts hold the chosen member order, built-in layout, reveal policy and absolute deadline. Partial drafts hold only the contributor identities and project/challenge context. They contain no photographs, source identifiers, captions, signed URLs, access tokens or consent decisions. These are private account metadata, not authorisation evidence. Current server access is checked before an explicit send or retry, and normal server authority remains decisive.

## Save, send and retry

`openChallengeDraftJournal` exposes `list`, `get`, `saveDraft`, `freezeRequest`, `rejectedRequest`, `forget` and `close`. Writes use a single native IndexedDB transaction and an exact expected revision. Two tabs cannot silently replace each other's draft. A failed transaction preserves the prior record.

Forms use `createChallengeDraftWriter`: one active save and one latest replacement snapshot. Editing does not append an unbounded promise queue. Save failure remains visible and prevents request dispatch until persistence succeeds. Leaving via the normal back action waits for the latest save; explicitly leaving without the latest failed changes retains the last confirmed checkpoint.

Before the first network mutation, the exact validated request and UUID are frozen durably. Pending requests cannot be edited through `saveDraft`. A timeout, abort, lost acknowledgement, account change or access loss retains the frozen request for deliberate recovery. A validated successful acknowledgement retires the exact local revision. If retirement fails, the same frozen identity remains safely replayable. A definitive `invalid_request` or `capacity` rejection can atomically return the request to an editable draft; this transition also uses CAS. No replay happens automatically on mount or account login.

Creation recovery preserves the original absolute deadline. An editable draft can explicitly choose a new window starting now; a frozen pending request retains its original deadline. A partial proposal freezes the contributors the user can currently see selected. It does not record or reuse consent. Consent still requires each included person's separate online action.

## Lifecycle and compatibility

The shared cloud runtime opens and closes upload and challenge recovery together, checks account identity around asynchronous setup, and closes a late journal if auth changed during opening. Cleanup closes local handles, aborts outstanding transactions, atomically advances the persisted account generation and removes both account stores. Another context's stale handle fails on its next transaction; other accounts remain usable.

Database upgrade closes old connections on `versionchange`. Old version 2 code cannot reopen a version 3 database, so its older upload-only cleanup cannot silently report success while leaving private request drafts. A future database version rejects this implementation's open and cleanup operations. Unknown or corrupt request records remain read-only and are never overwritten or evicted by normal editing. Explicit removal of all local account copies remains the destructive recovery operation; missing/newer database support is reported as incomplete cleanup.

Recovery uses browser storage on a best-effort basis. Browser eviction, manual site-data deletion and private browsing can remove it. No server operation relies on the local record as permission. A page closed before the latest asynchronous autosave commits retains only the last confirmed checkpoint, and the UI distinguishes saving from saved.

## Verification

Focused Node tests cover strict payload validation, future schema rejection, one-active/one-latest write coalescing, quota failure retry, close suppression, account changes during each journal-open stage and fail-closed runtime construction. Existing cloud client and upload retry tests remain in the focused regression set.

`runChallengeDraftsProbe()` in `lib/memories/challenge-drafts-probe.ts` is a development-only native IndexedDB probe. It uses unique disposable databases and exercises v2-to-v3 preservation, concurrent CAS, exact pending recovery, old-version cleanup refusal, explicit transaction rollback, future metadata preservation, the 32-record ceiling, combined account cleanup, other-account retention and persisted-generation fencing. Its synthetic quota abort proves transaction rollback, not physical device quota exhaustion. The existing independent-worker cloud upload journal probe exercises the shared transaction-generation mechanism across browser contexts.

At this source handoff, the focused 30-test set, whole TypeScript check and targeted ESLint have passed. The new native probe and creation/partial reload UI rehearsal are available for the parent integration check; no native execution is claimed here until that receipt is recorded. Real-account/provider writes and phone testing remain unperformed.

On 23/09/2026, the parent ran the new probe through the normal `/v2-lab` button in desktop Chromium 153. All 12 native checks passed, including additive upgrade, concurrent revisions, exact request reopening, old-version refusal, transaction rollback, future metadata, capacity, combined cleanup, foreign-account survival and persistent-generation fencing. The probe's disposable databases were removed in its final cleanup. This confirms native IndexedDB execution; the creation/partial interface reload flow and physical quota exhaustion remain separate checks.

The parent then exercised creation recovery through the actual cloud interface. Selecting a second contributor and immediate reveal, leaving the form, unmounting and remounting preserved both choices and the exact absolute deadline. A failed request froze the creation, disabled edits and exposed its explicit retry. Remount rediscovered it as confirmation pending; switching to the other synthetic account hid it. Returning and retrying produced one challenge with the saved policy and deadline. The generic connection error was clarified to point to this form's saved retry instead of its disabled Refresh control. This is workspace remount evidence, not a page-reload claim: the rehearsal deliberately resets its simulated server on page reload. Partial-proposal UI recovery and real hosted reload acceptance remain pending.
