# Partial challenge interface

Implemented and reviewed locally on 23/09/2026. P6 and the complete V2 UI/UX gate remain in progress.

`ChallengePartials` is integrated into `ChallengeDetail` for accepted contributors after the challenge opens. It uses the existing list, exact-digest detail, proposal, consent and reveal APIs from migration 008, then the bounded native partial PNG renderer. A cancelled full challenge does not automatically disable a separately authorised partial result.

## Behaviour

- Choose explicitly from accepted people who have submitted. Creating a proposal does not consent for anybody. An excluded proposer is told that they can follow consent status but cannot receive the result.
- Review the exact included roster, each response and the export consequences before agreeing. Shared originals become accessible only under the server's reveal gates. Personal captions are omitted; missing photo positions remain blank.
- Proposal retry keeps its ID and contributors while this screen remains mounted. A definitive invalid-request or capacity rejection unlocks the selection. An ambiguous failure retains it. After leaving or reloading, existing proposals must be reviewed before another creation; durable creation-draft recovery remains separate work.
- Every included person must explicitly agree. Reveal is a separate action. Declining or withdrawing consent has an inline confirmation, blocks future access and cannot reopen that proposal. The interface explains that downloaded copies cannot be recalled.
- Parent and child operations share one busy/abort boundary. Refresh, mutation, another preview or exit clears the owned object URL. Preview and download use fresh server detail and source access checks, including a post-encode recheck.
- Summaries contain no concealed photo previews. A stale or unavailable result fails closed. Account changes close the shared clients and unmount the view. The proposal list is bounded at the existing 20-proposal limit.

## Native browser evidence

The actual cloud UI, browser clients, upload manager, IndexedDB journal, image decoder and canvas renderer ran against the development-only in-memory transport at `/v2-lab/cloud`. This rehearsal uses synthetic accounts and the checked-in synthetic strip PNG. It does not establish hosted authentication, Storage or SQL permissions; those have separate tests.

1. Bao created a two-person Taking turns challenge. Alex accepted and Bao opened contributions. Bao chose and uploaded the two sparse assigned positions through the native file chooser and explicitly submitted them.
2. Submission confirmation disabled photo selection, and focus moved to its confirmation button. Alex could see Bao's submission status without receiving original-preview controls.
3. Alex selected only Bao for a partial proposal. The interface explained that Alex was excluded. Injected failure before mutation retained the frozen selection and retry ID; refreshing and retrying created one proposal without anybody's consent.
4. Alex's pending review exposed status only, without consent, preview or download controls. Bao's review required explicit agreement. Agreement enabled the separate reveal action; it did not auto-reveal.
5. Bao revealed and prepared a native PNG. The loaded preview was **1072 × 3044 pixels**. Visual inspection confirmed the original canvas geometry and blank spaces where Alex's two photos would have been. Source enlargement and partial-result warnings were visible.
6. Alex could still only inspect consent status after reveal. Alex withdrew from the full challenge. Bao's full challenge showed cancellation/access loss, while a fresh partial export still produced the same dimensions with the correct blank geometry.
7. Opening consent withdrawal cleared the preview immediately. The confirmation worked with the keyboard, returned focus to the review heading and removed preview/download controls after success. No image remained in the rendered DOM. The proposal showed declined/access lost and explained that it cannot reopen.
8. A subsequent failed proposal refresh displayed one recovery message and left a working refresh control. No permanent loading indicator remained.

Desktop 1280 × 720 and narrow 390 × 844 layouts were visually inspected. Both light and dark narrow views were legible, controls wrapped, UUIDs fit, and the narrow document width was 385 pixels within a 390-pixel viewport. Creation/review/confirmation headings received focus after actions. This is desktop viewport testing, not a physical-phone or assistive-technology pass.

## Review and checks

Independent Astra source review found and fixed a frozen invalid-contributor retry, stale submission confirmation when photo choices changed, and a permanent loading message after interrupted refresh. A follow-up source review accepted those corrections. The rendered submission lock and failed-refresh feedback were checked again.

Three focused transport/client tests pass, covering excluded-proposer restrictions, consent/reveal ordering, exact retry, partial survival after excluded withdrawal, consent reversal, strict projection parsing, source-deletion invalidation and a definitively rejected stale roster followed by a valid remaining subset. Existing SQL and renderer tests remain the authority for their respective permission and resource boundaries.

Native preview preparation passed. Actual OS download delivery, hosted services, real-device behaviour, final English copy and all-page/component review remain unverified. No feature flag, hosted schema, deployment or real-user media was changed.
