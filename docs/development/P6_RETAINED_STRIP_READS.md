# Retained legacy strip reads

`POST /api/media/strips/{id}/read` adds read-only access for the memory library and recap. It does not change the existing legacy timeline reader, archive/delete operations, weekly quota or cleanup workers. The request requires `PB_MEMORIES_ENABLED=true`, HTTPS (loopback HTTP in development only), canonical same-origin headers, bearer authentication and a strict `{operation:"resolve"}` or `{operation:"download"}` JSON body. Query parameters, caller actor/provider/path fields and missing migration capability fail closed. Responses are private, no-store and no-referrer.

Forward migration 011 depends on 001, 002 and 006. It introduces a separate retained-read capability; activity/project/challenge capability versions are unchanged. The existing P1 lifecycle configuration and immutable quota ledger must already exist. The service-only descriptor RPC binds the verified actor to the current strip owner or membership in the exact original couple recorded by that ledger. Another current pairing cannot grant historical access. Missing/deleted strips, malformed legacy paths, pending deletion and unverifiable purged originals fail without a provider request. Pending archives can still read their current active Storage original.

The small activity projection correction restores an owner's own source descriptor after unpairing only while their live strip still has active bytes or a persisted verified archive reference. It does not expose a former partner's source to a new partner or change project/challenge checks. Deleted/expired shared history after access loss retains the existing minimal projection. This does not recover absent photographs.

## Provider boundary

Active sources use the exact `photobooth-strips/{owner}/{id}.png` object with a service-authenticated, no-store Storage request. Archived sources require the persisted P1 `archive_verified_at`, exact `zuychin-photobooth/{owner}/{id}` identity and a fresh Cloudinary Admin API response matching the stored secure URL, resource type `image`, delivery type `authenticated`, PNG format, bounded bytes/dimensions and version. A stored `cloudinary_url` is an identity comparison, never a fetch authority.

The server then creates a 30-second private authenticated download request through the installed Cloudinary SDK. It accepts only the exact `https://api.cloudinary.com/v1_1/{configured-cloud}/image/download` endpoint. No Cloudinary or Storage signed URL reaches the browser, activity record, logs or browser cache. Redirects are rejected; credentials are sent only to the appropriate configured provider origin. Resolve performs a current private HEAD request; download performs GET. Actual deployed provider HEAD/download behaviour remains an activation check, and unsupported responses fail unavailable.

Cloudinary documents that `private_download_url` supports authenticated delivery and uses an authenticated API request without CDN caching. The implementation was checked against the installed SDK's signing and endpoint builder. [Cloudinary access control](https://cloudinary.com/documentation/control_access_to_media), [download API](https://cloudinary.com/documentation/image_upload_api_reference).

## Byte and lifetime bounds

The route allows two concurrent retained reads per process, holding those slots until work settles even if the caller has already cancelled. Native decode also uses the existing single occupied image-finalisation slot; late native work retains that slot. Each provider/auth/database fetch has a ten-second abort bound, and the route has a 30-second caller deadline. Request JSON is at most 8 KiB. Provider metadata is at most 64 KiB, image bodies at most 16 MiB, and each body at most 4,096 non-empty chunks. HTTP content length must agree when supplied. These limits also apply to incomplete/chunked responses.

The existing P1 original is PNG: `saveStrip` writes `{owner}/{id}.png` and archive upload is declared PNG. The new native verifier does not trust that declaration. It checks the PNG container/CRC, rejects animation or relabelled formats, fully decodes with Sharp and enforces 4,096 pixels per edge and 12 megapixels. The 16 MiB ceiling preserves P1's encoded-source limit; project uploads retain their separate 10 MiB limit. Unsupported historical formats/geometry fail honestly. The bytes are returned unchanged, with a SHA-256 digest and decoded dimensions. This digest describes the current read, not invented historical capture provenance.

Fresh authentication and an identical SQL descriptor are required after provider access/decode, before the response. Revocation, deletion or archive changes during the operation discard the pending response. No distributed transaction can recall bytes already returned to a previously authorised reader.

## Browser API

`createRetainedStripClient({appOrigin, identity, accessToken, fetch?, timeoutMs?})` returns `ownerId`, `assertActive`, `close`, `resolve(id,signal?)` and `download(id,signal?)`. Identity includes account ID and epoch. Resolve returns `{version:1,id,availability,bytesLimit}`. Download adds `{blob,sha256,width,height}`. Availability is `available`, `archive_pending` or `archived`; failure codes include `access_denied`, `source_unavailable`, `access_changed`, `unavailable`, `rate_limited`, `timeout`, `cancelled`, `account_changed` and `integrity_failed`.

The client checks current identity before/after token lookup, streaming and digest calculation. It rejects source-ID, dimensions, PNG MIME and digest mismatches; close/navigation aborts its lifetime. It keeps no persistent metadata, signed links or image cache. Callers own returned Blobs and any object URLs, must close the client on account change/unmount, and must release previews when their scope changes. Annual recap preparation should download sequentially and release each full original after producing its bounded thumbnail.

## Verification status

Focused local tests cover route/auth/shape/rate denial, exact provider origin/path, archive metadata mismatch, redirect/MIME/byte/chunk bounds, real native PNG and corrupt/JPEG/oversized input, final identity revocation, browser account changes, digest validation and occupied slots after cancellation. A generated PNG larger than 10 MiB passes the native retained verifier and browser download path while remaining rejected by the ordinary project parser/verifier. A disposable PostgreSQL harness checks service-only execution, original-couple access, re-pairing denial, retained owner activity, archive proof, deletion/purge/unavailable cases, unchanged quota and populated migration reruns. No test contacts a real provider.

Hosted migration application, real authenticated Storage/Cloudinary delivery and timeout behaviour, native browser download/recap integration and phone checks remain pending. No deployment flags, provider writes or hosted SQL were changed.
