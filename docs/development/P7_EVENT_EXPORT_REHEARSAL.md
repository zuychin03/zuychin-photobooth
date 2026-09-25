# Event export panel rehearsal

Development route: `/v2-lab/events/export`. This mounts the production panel/client/coordinator with native JPEG decode and ZIP output against the existing in-memory export fixture. No provider or account calls occur. Twelve contributions span ten-entry and two-entry batches; the first batch includes one unavailable item. Full reload resets the fake server; the dedicated remount control preserves it. Stop clears server records, identity and fixture image bytes, while panel unmount revokes its ZIP URL and cancels work.

## Native sequence

1. Start, lose next create response, then create a snapshot. Retry its retained exact request and verify only one snapshot. Alternatively remount and refresh to discover the committed snapshot.
2. Prepare the first batch: nine photos plus an unavailable-item report. Download is real; marking saved is a separate explicit action. Release a prepared ZIP to clear dirty state.
3. Arm lost checkpoint acknowledgement before prepare or saved confirmation. Remount and open the same snapshot to inspect committed progress, then retry explicitly.
4. Open the next batch and prepare its remaining two photos. Remount preserves progress, never a prepared ZIP or proof that a file was saved.
5. Prepare a batch, revoke export access, then Download ZIP. Authority recheck must deny the download. Restore access and refresh to continue.
6. Retire a snapshot through the production confirmation. Reuse its retired slot and inspect the incremented generation. Old-generation requests remain invalid.
7. Expire the synthetic event. Reads and downloads now fail closed with server expiry; this control simulates server authority expiry, not elapsed browser wall-clock time. Stop/start gives a fresh event.
8. Inspect both themes and narrow layout, confirmation focus, status copy, Stop cleanup and navigation. No hosted or actual production export validation is implied.

## Observed desktop browser evidence, 23/09/2026

The root exercised the actual panel through this route. A lost creation response recovered one snapshot with the same ID. A lost prepared-checkpoint response survived panel remount: nine photos were prepared and one unavailable item remained explicit. Rebuilding produced a downloadable ZIP; the download action ran and the separate saved-confirmation state was exercised. This does not verify that the operating system saved or opened the file. The independent seven-check export probe also passed native JPEG decoding, hashes and ZIP structure.

The second batch contained the remaining two photos. Release removed the prepared ZIP without changing server progress. Revocation and server-enforced expiry each denied a prepared download and cleared the snapshot/media actions. Retirement required confirmation, preserved event photos and exposed an explicit reusable slot; reuse advanced its displayed version from 1 to 2. The fixture was stopped and cleared.

Desktop and 390-pixel layouts were inspected, including dark-theme keyboard focus and light-theme controls. Review corrected small ZIP sizes rounding to 0.0 MB, singular failed-item wording and stale success notices after subsequent operations. Production/provider downloads, browser wall-clock expiry and OS file delivery remain separate checks.
