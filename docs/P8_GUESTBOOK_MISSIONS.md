# P8 private guestbook and pose missions

Source-only E5 foundation. Migration 023 follows the existing event and worker migrations. No hosted migration, feature activation or real account work was performed.

The host API selects up to six existing catalogue poses and a fixed end no later than contribution close. First accepted reservation locks this configuration. Reservation uses the existing worker readiness, global pending and upload deadline rules. A pose label is pinned atomically. Completion means verified ready delivery, not recognition of a pose.

Messages are private to the submitting guest, exact private receipt and current event owner or active moderator. Photo gallery and wall grants do not publish text. Message and typed signature are optional, bounded at 500 and 80 Unicode characters and 4 KiB combined. Text saves use revision CAS and 32 bounded exact request receipts. An old accepted request returns its accepted revision separately from current content. Withdrawal remains possible at the save receipt cap.

Guest UI offers no mission by default. Before network dispatch, the device journal retains the exact optional mission selection. IndexedDB version 3 preserves both existing stores, records, scope generations and original expiry. Older records have no missionChoice and retain the original reservation path. New records with missionChoice use reserveMission even when the selected mission is null. Pre-mission clients fail their older database version open rather than rewriting these records.

The private guestbook editor stores its draft only in the current page. Unconfirmed saves freeze the exact request for retry. Checking saved text or closing requires confirmation when this discards a page draft. Reload does not claim durable text recovery. Receipt holders can read and withdraw text but cannot edit or acquire guest authority. The parent photo controls are inert while this editor is open. Guest authority loss clears the whole guest surface; expiry clears displayed guestbook content.

Export snapshots pin each note revision. UTF-8 guestbook.txt contains only exact available revisions; the manifest records absence or failure. A fresh authority and revision check precedes download and saved acknowledgement, including empty and all-failure batches. Withdrawal or later changes cannot silently revive or replace an older snapshot note.

## Local verification

Focused tests cover bounds, pinned labels, exact request acknowledgements, journal compatibility, optional mission recovery after lost response, guest isolation, refusal with withdrawal, ready-only completion, UTF-8 ZIP notes and fresh withdrawal checks. The disposable PostgreSQL suite exercises reservation readiness, mission locking, private authority, CAS, capped receipts, withdrawal and pinned export revisions.

Native rehearsal is `/v2-lab/events`. Use the three synthetic missions, Lose next reservation response, Remount guest UI and Recover private receipt to inspect journal recovery. Use Private guestbook and mission, Lose next text save response, Refuse text saves and Allow text saves to inspect private editing and withdrawal. Release verification then reload the guestbook to see completion. Show latest private receipt exposes read/withdraw only. Replace browser guest tests the identity fence. Stop and clear fixture removes the isolated database. The native journal probe includes immutable mission remount and changed-choice refusal checks.

The host detail now provides owner mission configuration and private guestbook pages for owners and active moderators. Its busy, dirty and confirmation guards participate in the existing moderation, reminder, export and preview locks. The host rehearsal adds 26 private notes and a withdrawal control, alongside the existing lost-acknowledgement and accepted-contribution controls. Nine focused host/helper tests, whole TypeScript and scoped lint pass. Native browser evidence is recorded separately by the root task. Optional voice and video are not included.

## Native rehearsal evidence, 23/09/2026

Root completed 24 native journal checks. The happy-mood mission survived a lost reservation acknowledgement and guest remount with exact recovery. Message and signature survived a lost save response and exact retry. Mission acknowledgement stayed pending until verified ready delivery. Private receipt read and explicit text withdrawal cleared message/signature while retaining the ready photo and mission. Replacing the browser guest cleared the old private surface and opened an empty queue for the new guest.

Host rehearsal covered two selected missions, lost save response and exact retry, locking after acceptance, private guestbook pagination (25 then 5 entries), withdrawn-note refresh and the corrected heading focus. The final guest focus patch targets the heading after successful load, save and withdrawal. The development guest rehearsal now includes light/dark switching for the remaining post-fix visual check. These are isolated fake-server browser results, not hosted or real-account evidence.
