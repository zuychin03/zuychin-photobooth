# Event publication host review

Local checkpoint, 23/09/2026. The real moderation client, host workspace, private thumbnail client, custom Dropdown and QR encoder were exercised at `/v2-lab/events/host` against temporary synthetic transport. No hosted event, account or provider was changed.

The host runtime now closes moderation with the same account identity and lifetime as its other event clients. Publication is checked independently of P7 worker availability. Owners and active moderators review current per-surface consent and publication states. Only owners can issue gallery or display links. Links retain authority in the fragment; local QR encoding never contacts a QR service.

## Native walkthrough

- Four ready synthetic photos covered neither destination, gallery only, wall only and both. Approval was disabled where contributor permission was absent. Inline private JPEG review used one disposable URL.
- A gallery approval committed with a lost response. Its exact retry returned the current approved entry without creating another approval. Only the gallery state changed.
- Withdrawal after loading the both-consent photo made its old approval fail with a conflict. Explicit dismissal and refresh showed gallery private while wall remained awaiting approval. Renewed gallery consent returned to awaiting approval.
- Hiding a gallery photo retained its private receipt and other destination. Removing a separate photo returned deleted, removed preview availability and disabled further publication actions.
- A host report accepted multiline input after whitespace normalisation. Refresh after component remount recovered the saved report. Marking it reviewed changed only report status to resolved.
- Gallery and wall links used distinct fragment-only paths and QR labels. Revoking the gallery link removed its local link and QR. The wall QR rendered at 390 x 844 with a white quiet zone, visible keyboard focus and no horizontal overflow.
- Revoking the synthetic account removed the entire host workspace, private notes and audience links.

Dark desktop moderation and light narrow link controls were inspected. The shared confirmation keeps its safe Keep working action focused. Request completion, report entry and preview focus were corrected during review; final focus confirmation remains part of the P9 pass. These checks do not demonstrate OS download delivery, physical QR scanning, hosted Storage, deployed access controls or real-device behaviour.

## Guestbook host checkpoint

The owner selected two optional poses before the first contribution, saved with a lost acknowledgement, and retried the exact settings successfully. Accepted contributions locked mission choices. Twenty-six seeded private notes plus four earlier contribution rows paged as 25 then five; the withdrawn first message disappeared on refresh. The narrow note layout and local-date display were inspected. Successful settings/page operations returned focus to the guestbook section heading. Guestbook content was not added to gallery or wall projections.

The final host follow-up confirmed moderation load focuses its section, private preview opens with review focus, and closing it restores the exact Review photo button after a targeted correction. Audience-link confirmation focused Keep working; successful synthetic link creation focused the disclosed link. Revoking the synthetic account immediately removed the entire host workspace and link/QR without needing another refresh. The rehearsal was stopped and cleared. The final focus correction passed scoped lint, TypeScript, native verification and the production build.
