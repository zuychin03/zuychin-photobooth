# Async challenge story UI

The existing challenge creation, detail and camera surfaces now expose an optional four-pose story. This is an extension of the incumbent themed controls, not another challenge flow. All authored UI and the twelve existing story decks remain English.

Creation checks `capabilities().storyVersion === 1` before enabling the themed story picker. A missing capability preserves free-pose creation. A saved story remains visible and creation stays blocked until support is confirmed; an editable draft may explicitly choose free poses instead. A pending request is never silently changed. Guided stories use a layout whose collective assignment source indices are exactly 0, 1, 2 and 3. Choosing a story or changing participant count selects a compatible layout when needed; incompatible layout options are disabled while a story is selected.

Selecting a deck creates its seed once. The four-row review shows each pose, assigned roles and a comfortable alternative. Relaxed choices retain that seed. On a frozen request, the review reads `request.story`, including an absent story on a legacy free-pose request, rather than mutable form state. The contract and version 2 creation-draft implementation own persistence and fingerprint compatibility.

Detail and camera guidance use `assignment.sourceIndex`, not the assignment's list position or `slot`. For alternating duo assignments A0, A2, B1, B3, the displayed story poses are 1, 3, 2 and 4 respectively. Contributors can follow a comfortable alternative without changing the agreed story. Copy explains that contributions are asynchronous; it does not claim a live director or host-controlled camera.

## Checks

Two focused tests cover alternating assignment mapping, stable role ordering, four-pose support and frozen review retaining the exact story/seed/relaxed choices even when the editable form differs. Scoped ESLint and full TypeScript checking pass. The Impeccable mechanical detector reports no findings on the changed challenge components.

Native UI review remains separate: select a story and relaxed pose, change participant count/layout, freeze and reopen the saved request, verify unsupported-server fallback without losing the story, then inspect the alternating contributor prompts and camera guidance. No camera permission, hosted migration, invitation or deployment was performed by these checks.

## Native review, 23/09/2026

The real IndexedDB challenge-request probe passed all 14 checks at 10:23:15 UTC in Chromium 153 on Windows (1280 x 720). New checks proved explicit editable-draft upgrade and exact guided request/seed/alternatives after close/reopen; old-format migration, CAS, frozen mutation denial, abort, future records, capacity and account cleanup remained green.

Using the actual challenge components with synthetic transport, the owner selected **Same energy**, relaxed pose 3 and the alternating Taking turns layout. A failed creation left a frozen request. Workspace unmount/remount recovered the same story, relaxed pose and concrete deadline; retry created one challenge. The invited account reviewed and accepted the story, then the owner opened contributions. Role A saw poses 1 and 3; role B saw poses 2 and 4. Camera guides for A3 and B2 matched those exact prompts without starting hardware capture.

At 390 x 844, dark and light camera guidance remained readable with document width 385 pixels. Opening focused the camera heading and locked competing actions; closing returned focus to Your photos. The fixture was stopped and cleared. Participant-count/layout changes, unsupported-server draft UI and the final all-surface review remain additional checks; physical cameras, external invitations and hosted services are unverified.

A later native pass checked three- and four-person layouts. Quiet company selected the four-cut group layout with four sources per person. The three-person Trio strips layout retained all collective poses for Pass a smile. After saving that draft, the synthetic server advertised storyVersion 0; reopening preserved the story and deadline, disabled creation and offered an explicit free-pose choice. Choosing that fallback retained the three people/layout and allowed creation. This verifies the fallback UI without enabling any hosted feature. The fixture was cleared afterwards.