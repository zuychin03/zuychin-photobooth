# P3 curated asset delivery

23/09/2026. This implements the C5 asset pipeline from the approved [V2 plan](../../V2_PLAN.md). The 24 selected imagegen PNG originals and generation records under [docs/assets/v2](../assets/v2/ASSET_MANIFEST.md) remain unchanged. No user photographs or new generated variants are involved.

## Reproduction and delivery bounds

Run `node scripts/prepare-v2-assets.mjs` from the repository. It verifies every source hash, byte length and dimensions against `asset-index.json`, then writes delivery files, `lib/assets/manifest.json` and the service worker's public `pack-index.js`. The checked local encoder is installed Sharp 0.34.5. Encoding is sequential with one libvips worker. Delivery URLs contain the first 12 SHA-256 characters; reruns preserve older files so an open older build can still request its exact assets. A separately planned deployment cleanup may remove obsolete delivery generations after the rollback window, never during activation.

Scenes retain their 1536 × 1024 pixels. Materials resize from 1254 × 1254 to 1024 × 1024. WebP quality is 86 for scenes and 90 for material grain, with effort 6 and high-quality chroma subsampling. Thumbnails fit within 320 × 320 at quality 76. Images are sRGB with no added metadata; no crop is baked into a delivery original. These are conservative implementation choices, not phone-performance measurements. [Sharp WebP options](https://sharp.pixelplumbing.com/api-output/#webp)

| Measured output | Bytes |
| --- | ---: |
| 24 original PNG files, unchanged | 58,547,417 |
| 24 full WebP delivery files | 4,917,760 |
| 24 WebP thumbnails | 192,498 |
| Full delivery plus thumbnails | 5,110,258 |
| Largest full file | 548,304 |
| Largest thumbnail | 22,784 |

Full files must remain at most 1 MiB each; thumbnails at most 64 KiB each. The script fails if either bound is exceeded. The registry validates path, filename hash suffix, dimensions, byte limit, category, focal point, provenance, version and procedural fallback. IDs match the source index. Only same-origin `/scenes/v2/` and `/materials/v2/` delivery paths are allowed, with no recipe-controlled URL, traversal, query or script.

The generator overrides nine scenes to focal point `[0.75, 0.5]`: Paper Moon Studio, Porcelain Sculpture Studio, Lantern Courtyard, Lilac Origami, Liquid Chrome, Film Noir Lobby, Graduation Atelier, Winter Celebration and Birthday Confetti. Native portrait review identified their central crops as losing the distinctive edge objects. Local centre/left/right crop comparisons confirmed the right crop retains the moon, ceramics, lanterns, folded paper, chrome sculpture, sconce, navy curtain/laurel, festive greenery and balloons respectively, with open centre or lower-centre face space. The adjusted 3:4 source rectangle is `(768, 0, 768, 1024)` instead of `(384, 0, 768, 1024)`. The 3:2 rectangle remains the entire `(0, 0, 1536, 1024)` image, and delivery hashes/bytes remain identical. This changes renderer metadata only, not original or delivery image pixels. The other nine scene focal points remain as supplied; dedicated portrait generations were unnecessary for these corrections.

## Shared runtime contract

`lib/assets/registry.ts` exports `CURATED_ASSETS`, `SCENE_ASSETS`, `MATERIAL_ASSETS`, `ASSET_PACK_VERSION`, `getCuratedAsset(id)` and `getAssetCrop(asset, destinationWidth, destinationHeight)`. Categories are `together`, `create`, `events` and `material`. Each asset contains full/thumbnail delivery descriptors, `[x,y]` normalised focal point, `cover` crop rule, source provenance and `{sceneId, colour}` fallback. `captionTone` is a light/dark starting point for material captions, not a tested universal contrast guarantee.

`createAssetLoader()` in `lib/assets/loader.ts` is lazy. `preload(id, variant = 'full')` returns either a ready `{asset,image,width,height,release}` handle or a fallback `{asset,fallback,reason}` result. Unknown IDs reject. The caller preloads selected resources before capture/export, chooses the named procedural scene or solid material fallback on failure, and releases old handles after their last draw. `dispose()` cancels pending requests and releases live resources. No project photos or canvas output are persisted by this loader.

The loader accepts at most four live handles, two concurrent requests/native decodes and eight queued requests. Requests/queue waits time out after ten seconds. Reads stop at the exact declared encoded byte length; SHA-256, WebP header dimensions and decoded dimensions must match. Fetch omits credentials and forbids redirects. A timed-out native decode retains its decode slot until settlement and closes any late bitmap, preventing repeated timeouts from starting unlimited native allocations. The HTMLImageElement fallback revokes its object URL and drops its image source on release. A stalled native decoder cannot be forcibly aborted by JavaScript. Four largest scene handles represent about 24 MiB of decoded RGBA, with up to two native decode allocations in flight; these arithmetic bounds do not prove browser peak memory or phone readiness.

## Cache and privacy boundaries

The service worker does not precache any curated images. It caches only requested registered images, or an explicitly requested named category, in `pb-assets-2.0.0`, bounded to 48 entries and 8 MiB. Writes check exact size and SHA-256. Oldest inserted entries can be evicted when the bound is reached; caching is best effort and not durable project storage.

Messages accept `{type:'PB_CACHE_ASSET_PACK'|'PB_CLEAR_ASSET_PACK',category:'together'|'create'|'events'|'material'|'all'}` from a same-origin client. An optional transferred MessagePort receives `{ok:true,version,files}` or `{ok:false,error}`. Pack downloads are sequential, with one active pack operation and a ten-second limit per image. Clearing increments a generation fence so an older in-flight download cannot repopulate the cleared cache. Failed cache writes are reported as failures by the explicit pack action; normal online image loading still works if Cache Storage fails.

Public HTML shells are limited to exact query-free `/`, `/booth`, `/customize` and `/projects`; these routes contain the public prerendered shell, not server-rendered user content. Only successful, nonredirect HTML without private/no-store response directives is saved. Every new route is excluded by default. Timeline, login, rooms, relay, events, receipts, auth and API responses are never page-cached. Cross-origin, query/hash-bearing and Authorization-bearing requests are not intercepted. Other navigations use the network with only the generic offline page as their failure fallback.

Activation removes **only older generic `pb-pages-*` caches**, because the previous worker could have saved private navigation snapshots. Prior static build caches and asset packs remain so open builds and the approved rollback build keep their assets. IndexedDB is untouched. Offline public navigation depends on having visited and cached the shell and required build assets; this does not promise offline cloud actions or new account authentication.

## Picker and browser probes

`VisualPackPicker` accepts selected scene/material IDs, their two change callbacks and `disabled`. It includes six existing procedural scenes, the 24 curated images, category browsing and validated favourites. Thumbnails load lazily; selecting a tile opens a focused full-image preview, and only Apply changes the project. Closing releases decoded resources. Material removal is explicit. Favourites contain catalogue IDs only and remain usable in memory when localStorage is unavailable.

Offline category controls use `requestAssetPack(action, category)` from `lib/assets/cache.ts`. They report an unavailable worker, storage/network failure or a one-minute client timeout honestly; a timed-out worker may still be downloading, and clearing cancels its cache generation. These controls never upload project data.

The room's existing scene picker now shows delivery thumbnails, and `LiveScenePainter` borrows a verified selected image from the resource hook for focal-cropped painting. The hook owns image release; the painter fences late segmentation and releases its own work canvases when stopped. A local shutter waits for scene preloading. A remotely timed capture plan arriving before the local image is ready uses an explicitly labelled procedural preview fallback for that round, without delaying the synchronised plan or changing room signalling. Original photos remain independent; the finished strip can use the image once available. This is local asset integration, not P5 multi-person preview or cross-network acceptance.

The solo booth preloads selected scene/material resources and hides layout buttons while a template defines the photo slots. A new round derives its required photo count from the current template while retaining timer, style, camera, mirror and fill-light settings. The captured round's count stays frozen. A new project receives the template and its PNG decorations but no previous photos. Fresh project identity checks prevent an intervening navigation/account change from applying the template to an unrelated project.

`lib/assets/probe.ts` exports three optional browser probes. `runAssetBrowserProbe()` exercises native bitmap decode, explicit close and unavailable/corrupt asset fallbacks. `runAssetCacheProbe()` tests a previously empty category, clears only that new category and checks existing cached images survive; it refuses to clear an already populated test category. `runTemplateRenderProbe()` compares eight legacy/template renders using labelled synthetic sources, compares complete Together groups and missing-cutout fallbacks for all eight layouts, and checks solid caption backing for six materials across eight layouts. It returns transient preview data URLs for visual review and releases its canvases/bitmaps. These probes are callable evidence tools, not automatic production checks, and have not been counted as browser passes merely because their code exists.

## Evidence and remaining acceptance

- Thirteen focused Node tests pass: actual bytes/hashes/dimensions for 24 sources and 48 outputs; invalid registry paths/versions/bounds; focal crops across eight aspect ratios and the nine portrait overrides; loader integrity failures, timeout capacity, release and decoded-size mismatch; isolated service-worker cache policy, legacy page purge, static retention, explicit pack caching and corruption rejection.
- Two preference tests cover catalogue-only favourites, deduplication, malformed/future records and unavailable storage. Twelve additional project/template tests cover all eight layout mappings, crops/filters, refreshed template appearance, schema-one migration, future raw manifests, exact decoration/role binding, capture-setting preservation, fresh-round count derivation, template undo/redo, Together group placements and atomic fallback when a cutout is missing. These are local data/geometry/draw-call tests, not canvas pixel results.
- Three live-painter tests cover the verified image's focal crop, wrong-image procedural fallback, and a late segmentation result after stop. They use injected canvases/segmentation and do not prove the MediaPipe runtime or camera-device behaviour.
- The service worker tests execute its real JavaScript against an in-memory Cache Storage/client fixture. They do not establish browser installation, offline navigation, HTTP cache behaviour or deployed cache headers.
- A contact sheet of all 24 decoded full WebP deliveries was visually inspected locally. Central scene space and material identities remain intact at catalogue size; no additional portrait variant was justified by this pass. Source generation inspection remains recorded in the original manifest.
- Integrated mobile/desktop previews across all eight layouts, real-person cutout crops, material caption contrast, actual browser decoder/SW behaviour and phone memory are separate acceptance evidence. A contact sheet and arithmetic crop tests do not pass those gates. Root owns the current composition/UI browser pass; phone measurements remain deferred by the user's earlier sequencing decision.

The materials are opaque crop-to-fill images, not seamless tiles or transparent overlays. Their metallic/pearlescent effects are baked into pixels. Extreme portrait crops can omit distinguishing edge decoration; the UI should preview the complete result before applying and permit a different crop/theme when identity is lost.
