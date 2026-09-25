# P8 gallery and wall browser contract

This source tranche implements audience viewing for E3 against migration 022. It does not enable event services or publish a guestbook message. Photo gallery and wall permissions remain independent of all guestbook text visibility.

## Entry and authority

The production routes are `/e/[slug]/gallery` and `/e/[slug]/wall`, using the existing event UUID as the slug. Both accept only `#token=...`. A synchronous layout effect captures the fragment and replaces the URL before any asynchronous operation. No fragment, signed URL or photo enters local storage, IndexedDB or a public cache. The pages use no-referrer/noindex metadata and dynamic rendering; the shared route headers add private/no-store. The service worker does not cache these routes.

Opening a link requires an explicit action. An existing audience cookie can be continued explicitly; a new link can explicitly replace it. Gallery and display cookies remain separate from each other and from contribution/receipt cookies. A public, non-bearer session UUID binds every subsequent request through `expectedSessionId`. Replacement of the same-event cookie invalidates the earlier client. Tokens exist only in the pending entry component and are cleared after exchange or unmount.

`createEventAudienceClient` supports capabilities, exchange, session, list, validate, report and bounded media download. All POSTs use same-origin credentials, no-store and no redirects. The client consumes the shared versioned parsers from `publication-contract.ts`; there is no second response model. The production-handler integration test exercises real client, handler and store code with synthetic RPC/provider ports and a small cookie jar.

## Freshness and resources

Gallery metadata contains at most 12 current IDs. The wall asks for three and rotates pages every 15 seconds. Permission requests start approximately every five seconds independently of thumbnail decoding. Every displayed page has a hard deadline no later than ten seconds after its permission request began, or the server-provided expiry, whichever comes first. A slow response cannot reset the deadline using its completion time.

Failed checks clear page metadata and every thumbnail URL. Offline, visibility loss, manual pause, session replacement and unmount abort work and release displayed media. Resuming requires a fresh server check before redisplay. The ten-second timer is a foreground browser execution bound; a suspended or blocked browser cannot run JavaScript, and visibility restoration reauthorises before showing photos. Rate limiting hides photos and backs off for one minute.

There is one active thumbnail download/decode pipeline, no growing task queue, and at most two in-flight client operations so permission polling can continue during media work. Thumbnails are JPEG, at most 100,000 bytes and 400 pixels on either edge. The wall retains at most three thumbnail URLs/decoded browser images; the gallery retains at most twelve. Signed URLs must match the exact configured Storage origin, private bucket, event/submission path, variant and token query. Byte reads have exact descriptor length and a 4,096-chunk ceiling. Native decode verifies dimensions and closes its bitmap. SHA-256 is verified when supplied; current legacy thumbnail descriptors may omit it honestly.

Original-image download exists only in the gallery and requires an explicit action. It is bounded to 2,000,000 bytes, 4,096 pixels per edge and 12 million pixels, with required digest/dimensions. A fresh permission/revision check follows decoding. Download object URLs are short-lived and cleared on visibility loss/unmount. A saved external copy cannot be recalled.

An aborted or timed-out native operation retains its occupied slot until it actually settles. Generation checks prevent a late response or bitmap from recreating a URL after the page was cleared.

## Reports and UI

Reports use privacy, inappropriate content or other, with optional text up to 500 characters. A frozen request UUID and payload are reused after an uncertain acknowledgement in the same open page; no unbounded report journal is introduced. The server's per-reporter/item and total event limits remain authoritative. Reporting does not automatically hide the photo. Forms, controls, status/empty/error states and gallery downloads use the existing warm neutral/rose theme, Fraunces headings, Geist controls and shared Dropdown.

## Local evidence and rehearsal

Seventeen focused audience/backend tests passed, including all four gallery/wall combinations, separate cookies, replaced-session denial, actual client-to-handler/store shapes, exact report retries, corrupt/foreign/chunk-exhaustion media, late native disposal, continued polling during slow decode, hard freshness expiry and offline/hidden clearing. Scoped ESLint and the UI detector passed. Whole TypeScript had no audience errors; a concurrently edited guestbook note type remained in flight at that check.

`/v2-lab/events/audience` is a development-only rehearsal using real client/components and synthetic permission/provider transport. It starts only after an explicit button, uses a small local JPEG, and clears its session maps and image bytes on Stop. Controls withdraw gallery grants without changing the wall, hide one wall photo, fail checks, replace the destination session, expire the event and remount. `Run native audience checks` exercises real browser JPEG decoding, separate audience sessions, all four consent combinations, timed revocation and URL release. The production route returns 404.

On 23/09/2026, the parent ran the six native audience checks successfully. Desktop gallery review and successful reporting were also exercised. A subsequent pipeline-busy regression passed with the eleven focused client/lifecycle/handler tests; original downloads now wait for thumbnail preparation. Report close and success restore focus to the original trigger, or the viewing heading when polling removed that photo. The parent is verifying that focus correction and the remaining narrow-screen flow. Real provider/cookie deployment behaviour and physical devices remain separate evidence. No hosted write, environment flag activation or publication occurred in this tranche.

Root rendered checkpoint (23/09/2026): actual gallery/wall screens at desktop1280x720 and narrow390x844, in light/dark themes. Gallery report submission and download request succeeded, with no OS saved-file claim. Gallery withdrawal cleared its grid while wall access remained separate. Wall pagination, pause clearing and explicit expired-authority refusal were observed. Corrected report-close, pause and download focus returned to the expected controls. Local fixture stopped and cleared afterwards. No permanent media cache or provider delivery was inferred from this rehearsal.
