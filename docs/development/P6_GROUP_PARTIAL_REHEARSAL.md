# Group challenge and partial recovery rehearsal

This supplements `P6_PARTIAL_UI.md`. The development cloud rehearsal uses the real challenge screens, clients and account-scoped IndexedDB journals against a temporary in-memory server. It is not hosted SQL, cross-device persistence or permission evidence.

## Native workflow

1. Start a three- or four-person rehearsal. The original two-person default remains available. Bao owns the seeded friendship project; each other named account has an invitation and its own private project.
2. Switch to Bao, open the friendship project and create a challenge with all seeded people. Switch to each invited account and accept the challenge. Return to Bao and open contributions.
3. Download the synthetic PNG and submit it through the normal file inputs for two people. Leave the others unsubmitted. Confirm their accounts cannot see concealed originals.
4. Propose a partial result with the two submitted people. Before sending, use **Lose next partial-proposal response**. The server records the proposal but the real UI retains its frozen request. Unmount and remount the workspace without reloading the page, open the same project and challenge, then continue the saved proposal. Retry must reconcile one proposal with the same people, not create another.
5. Repeat with **Fail next request** to exercise a failure before mutation. Switch accounts and confirm each account sees only its own saved recovery request. Return to the proposer to continue it.
6. Use the normal cancel-challenge confirmation, or expire the synthetic challenge and refresh. Existing submitted people can still propose and consent to a partial result; unsubmitted people cannot contribute after the deadline. Each included person gives separate consent. Excluded proposers cannot view the resulting composition.
7. Reveal the partial, inspect its remaining blank positions and download through the normal controls. Withdraw consent and refresh to verify future preview access disappears.
8. Use **Stop and clear rehearsal**. It closes clients, journals and repositories and deletes both uniquely named rehearsal databases. Reloading alone resets the simulated server and does not prove durable server recovery.

The expiry control marks the synthetic challenge expired while preserving its agreed deadline and frozen creation identity. It does not change the operating-system clock or expire image-upload reservations. This tests the server-expired state, not elapsed wall-clock scheduling. The response-loss control applies only to a successful partial proposal, so background list calls cannot consume it.

## Evidence boundary

Focused tests cover group assignment compatibility, incomplete concealment, final full reveal, exact proposal retry with a replacement client, and partial access after full cancellation. Native browser checks remain a separate step; this document describes the intended exercise, not a completed live result.

## Native results, 23/09/2026

Seven native partial-journal checks passed in Chromium 153 on Windows, covering exact pending identity/contributors, remount, account isolation, frozen edits and local dismissal. The four-person UI rehearsal created a Quiet company story, accepted all contributors and submitted four PNG originals each for Bao and Alex. Casey remained excluded from concealed originals.

Casey proposed Bao and Alex with the response-loss control enabled. The frozen proposal survived workspace unmount/remount. The same request reconciled a single existing proposal, with no consent inferred for either contributor. Alex and Bao agreed independently. The revealed partial rendered a 4060 x 3044 PNG with the two excluded columns blank, inspected at 390 x 844. Cancelling the full challenge still allowed the agreed partial to be rendered. Casey could inspect consent status but had no preview/download controls after reveal. The disposable rehearsal was stopped and cleared.

The original expiry helper incorrectly changed the frozen deadline, which the live client rejected. It now changes the fixture status only. Seven focused group/partial tests pass with a new same-client deadline-preservation assertion. A fresh three-person UI walkthrough confirmed refresh accepts the expired state with the original deadline unchanged. The earlier account-remount path also displayed the elapsed-deadline state, but it is not evidence of scheduling or production expiry. No provider, physical camera or OS download delivery was exercised.