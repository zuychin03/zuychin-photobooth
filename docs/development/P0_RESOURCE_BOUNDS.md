# P0 resource boundary

Added 23/09/2026 in `lib/projects/resource-bounds.ts`. This is a versioned resource inventory fragment for the future project/import boundary. It is not the full `PhotoProject` schema, an importer, an image decoder, a persistence adapter or a change to the existing capture/editor paths. P2 must integrate it before claiming these limits are enforced for users.

## Contract

`parseResourceManifest(json, builtinStickerIds?)` checks the UTF-8 size before JSON parsing, then calls `validateResourceManifest(value, builtinStickerIds?)`. Validation returns a detached, frozen fragment or throws `ResourceValidationError` with a field path. Unknown fields and unsupported resource versions fail explicitly; the caller must preserve unsupported input for future-version read-only/export handling rather than deleting or rewriting it.

The fragment contains only:

- `version: 1` and `mode: "solo" | "shared"`, describing participant count rather than capture technique or visibility.
- `participants`: stable local participant IDs and one to four distinct photo source IDs each. Solo requires one participant, shared requires two to four. Each declared photo belongs to exactly one participant. These IDs do not encode transient RTC roles or grant access.
- `media`: local IDs, photo/decoration kind, MIME, encoded bytes and orientation-normalised decoded width/height declarations.
- `slots`: ordered local IDs and one to four source IDs per slot. Sources may be reused across slots; a shared cell can reference multiple participants. All references must resolve.
- `textLayers`: local IDs and plain text. Newlines, tabs, literal angle brackets and Vietnamese/other Unicode text are supported; non-text control characters are rejected. Text is never HTML, even if it resembles markup. Render with canvas text or escaped framework text, never HTML injection. Displaying a URL as text does not authorise fetching it.
- `stickerLayers`: local IDs and either a declared PNG decoration ID or a built-in sticker ID from the application's trusted allowlist. The default built-in allowlist is empty. An allowlist must never come from the imported document itself.

Media, participant and layer identifiers use 1–64 ASCII letters, digits, underscores or hyphens, beginning with a letter or digit. URLs, data/blob URLs, filesystem paths and markup cannot be asset identifiers. Layer IDs are unique across slots, text and stickers. Unknown `url`, `html` or other fields are rejected rather than retained.

All required inventory arrays are present, including empty text/sticker arrays. This contract describes a complete resource declaration, not every editing state. P2 can keep incomplete drafts and missing-resource state outside this fragment and validate a complete inventory before rendering/export. Crops, slot rectangles, transforms, typography, themes, colours, scope, capture timestamps and undo are deliberately left to their future schemas. The resource fragment must not be mistaken for validation of those other fields.

## Provisional limits

Limits use binary MiB (1,048,576 bytes) and MiPixels (1,048,576 pixels).

| Resource | Limit |
| --- | --- |
| JSON fragment | 64 KiB of UTF-8 |
| Participants | 1 solo; 2–4 shared |
| Unique photo sources | 1–4 per participant, at most 16 total |
| Photo slots | 1–16, each referencing 1–4 sources |
| Text layers | 0–16, at most 500 Unicode code points each |
| Sticker layers | 0–32 |
| Files | 1–24 total, including at most 8 PNG decorations |
| Photo formats | JPEG, PNG, WebP declarations only |
| Decoration format | PNG only |
| Encoded photo | 1 byte–10 MiB each |
| Encoded decoration | 1 byte–4 MiB each |
| Total encoded files | 64 MiB |
| Decoded photo | Each edge at most 4096 px; area at most 12 MiPixels |
| Decoded decoration | Each edge at most 2048 px; area at most 4 MiPixels |
| Total declared decoded area | 48 MiPixels across photos and decorations |

All byte counts and dimensions must be positive safe integers. Strings, fractions, infinity and NaN are rejected without coercion. Aggregate budgets apply even if each individual file fits. GIF, AVIF, HEIC/HEIF, SVG, HTML, audio and video are outside this still-resource version; accepting them requires a separate reviewed decode/capability path. WebP/PNG MIME declarations do not distinguish static from animated files, so an importer must inspect/reject animation or normalise a deliberately chosen still before constructing this inventory.

These are conservative initial engineering limits, not measured browser capacities or permanent product restrictions. They allow a 4032 × 3024 photo, sixteen 1920 × 1080 photos without decorations, and reuse of four originals across sixteen slots. A 4096 × 4096 photo exceeds the area budget even though both edges individually fit. Multiple maximal photos may exceed the aggregate budget.

## Memory interpretation and integration gates

At four RGBA bytes per pixel, one maximal photo represents 48 MiB of raw pixels, one maximal decoration represents 16 MiB, and the aggregate decoded area represents 192 MiB. Adding the 64 MiB encoded allowance gives 256 MiB before any output canvas, second buffer, segmentation mask, GPU texture, browser/codec overhead or application state. This calculation is not a safe simultaneous-allocation target. Built-in sticker assets are outside the imported-file budget and require their own bounded trusted catalogue/cache.

P2 should decode at most one large source at a time initially, retain encoded originals and promptly close/release decoded resources. Even a source plus its intermediate copy can consume 96 MiB, before the output. Destination/export canvas dimensions need a separate finite allocation budget; this fragment does not validate output geometry. Device measurements may require lower limits or an explicit downsampling workflow before P2/P4 acceptance.

Declarations and MIME labels are untrusted metadata. `assertEncodedMediaMatches(blob, declaration)` compares an actual Blob's size and MIME to its validated declaration; it does not inspect signatures or prove that bytes form an image. `assertDecodedImageDimensions(width, height, declaration)` rejects actual dimensions that differ from the validated, orientation-normalised declaration; the caller must close the decoded image in a `finally` block, including when this check fails.

Neither a small file nor a bounded header proves safe decoding. The future importer must inspect actual type, dimensions, orientation and animation before allocating where possible, reject malformed/unsupported input, bound decoder concurrency/time/memory, and recheck actual output dimensions. A hostile compressed image can still consume resources before a post-decode check. Archive extraction needs independent compressed/expanded byte and entry-count limits before this parser receives JSON or Blobs. No decompression-bomb resistance or safe decoder is claimed by this P0 fragment.

The caller also needs to bind every referenced ID to the intended local Blob or trusted catalogue asset, surface missing assets, enforce owner/scope permissions, and freeze source requirements when capture starts. This fragment checks cross-reference consistency; it does not grant network access, perform synchronised capture or authorise a participant.

## Verification

`tests/resource-bounds.test.ts` covers maximum valid inventories, exclusive source ownership, dangling references, individual and aggregate image/byte budgets, Unicode text limits, sticker allowlists, URL/markup rejection, malformed JSON, unknown versions, accessor/sparse-array rejection, detached outputs and actual Blob/dimension comparisons. These unit checks do not establish device memory capacity, image-decoder safety or integration with production capture/import.
