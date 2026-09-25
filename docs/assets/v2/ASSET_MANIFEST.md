# V2 generated asset library

Created 22/09/2026 with the built-in imagegen tool. **24 selected assets: 18 scene backdrops and 6 material textures.** All 24 are integrated into V2 through the curated picker and versioned WebP delivery files. This document preserves generation-time inspection; implementation and rendered evidence are recorded in [P3 evidence](../../development/P3_EVIDENCE.md).

[Open the visual catalogue](catalogue.html) to filter categories, compare landscape/portrait/square crops and inspect individual images. [Machine-readable file index](asset-index.json) includes actual dimensions, sizes, SHA-256 hashes, focal points and provenance links. The catalogue opens as a local HTML file without a server.

## Generation policy

Danny explicitly authorised generating as many assets and variants as needed; imagegen credits are not a constraint. This 24-asset library is a reviewed starting collection, not a maximum. During implementation, generate additional scene-specific, occasion-specific or crop-specific variants whenever coverage or composition needs them. Preserve selected originals and record exact prompts. Avoid substituting placeholders or reusing an unsuitable crop merely to save generations. App performance and selection clarity still matter: optimise delivery files and lazy-load packs.

## Together scenes

| Asset | Intended use | Actual dimensions |
| --- | --- | --- |
| [Rooftop Blue Hour](scenes/rooftop-blue-hour-v2.png) | Remote evening dates; warm city ambience | 1536 x 1024 |
| [Rainy Café](scenes/rainy-cafe-v2.png) | Cosy dates; rainy-window portraits | 1536 x 1024 |
| [Coastal Picnic](scenes/coastal-picnic-v2.png) | Summer memories; bright seaside portraits | 1536 x 1024 |
| [Lantern Courtyard](scenes/lantern-courtyard-v2.png) | Lantern-lit evenings; warm cultural setting without branding | 1536 x 1024 |
| [Snowy Cabin](scenes/snowy-cabin-v2.png) | Winter dates; travel-inspired keepsakes | 1536 x 1024 |
| [Spring Blossom](scenes/spring-blossom-v2.png) | Spring sessions; anniversary recreations | 1536 x 1024 |

## Creative studio scenes

| Asset | Intended use | Actual dimensions |
| --- | --- | --- |
| [Paper Moon Studio](scenes/paper-moon-studio-v2.png) | Dreamy paper-set portraits | 1536 x 1024 |
| [Porcelain Sculpture Studio](scenes/porcelain-sculpture-studio-v2.png) | Neutral editorial portraits and monochrome-friendly layouts | 1536 x 1024 |
| [Lilac Origami](scenes/lilac-origami-v2.png) | Dimensional paper portraits; playful geometry | 1536 x 1024 |
| [Liquid Chrome](scenes/liquid-chrome-v2.png) | Fashion-inspired portraits; chrome/rose styling | 1536 x 1024 |
| [Film Noir Lobby](scenes/film-noir-lobby-v2.png) | Cinematic monochrome strips | 1536 x 1024 |
| [Candy Cloud Studio](scenes/candy-cloud-studio-v2.png) | Soft playful portraits; tactile pastel styling | 1536 x 1024 |

## Event scenes

| Asset | Intended use | Actual dimensions |
| --- | --- | --- |
| [Celebration Garden](scenes/celebration-garden-v2.png) | Garden parties; anniversaries | 1536 x 1024 |
| [Birthday Confetti](scenes/birthday-confetti-v2.png) | Birthdays; cheerful pastel events | 1536 x 1024 |
| [Midnight Disco](scenes/midnight-disco-v2.png) | Evening parties; motion-strip backgrounds | 1536 x 1024 |
| [Graduation Atelier](scenes/graduation-atelier-v2.png) | Graduations; restrained formal celebrations | 1536 x 1024 |
| [Winter Celebration](scenes/winter-celebration-v2.png) | Seasonal gatherings; warm evergreen styling | 1536 x 1024 |
| [Summer Festival](scenes/summer-festival-v2.png) | Daylight outdoor parties; summer missions | 1536 x 1024 |

## Frame and keepsake materials

| Asset | Intended use | Actual dimensions |
| --- | --- | --- |
| [Ivory cotton paper](materials/ivory-cotton-paper-v2.png) | Neutral borders and printable cards; dark captions | 1254 x 1254 |
| [Rose washi paper](materials/rose-washi-paper-v2.png) | Romantic tactile frames; dark captions | 1254 x 1254 |
| [Indigo bookcloth](materials/indigo-bookcloth-v2.png) | Memory-book covers and dark borders; light captions | 1254 x 1254 |
| [Champagne brushed metal](materials/champagne-brushed-metal-v2.png) | Celebration accents and borders; dark captions | 1254 x 1254 |
| [Charcoal photo paper](materials/charcoal-photo-paper-v2.png) | Film-style borders; light captions | 1254 x 1254 |
| [Pearl iridescent film](materials/pearl-iridescent-film-v2.png) | Creative borders and covers; dark captions | 1254 x 1254 |

## Inspection and integration

All selected outputs were visually inspected at generation and reviewed together in the catalogue. All 24 copies match their tool-generated originals by SHA-256. The 18 scenes are 1536 x 1024; the six material textures are 1254 x 1254 (the actual returned size, despite a preferred 1024 square in their prompts). One summer-festival refinement softened central background detail. Earlier variants were not selected into the library.

Scene review found no visible people, text or brand marks. Scenes reserve central space for later cutouts and put most strong decoration at the edges. The portrait crop naturally removes peripheral detail: the cafe/cabin lose some architectural context, and sculptural/balloon/lantern details can disappear. Offer a visible crop choice and generate a dedicated portrait variant where a theme loses its identity. Final layouts and real-person hair-edge, lighting and segmentation tests remain part of P3/P5. A flat background cannot supply foreground occlusion or relight a person.

Materials are opaque crop-to-fill surfaces, not transparent overlays or verified seamless tiles. Scale fine cloth/foil grain carefully to avoid moire, check caption contrast at actual output size, and do not repeat obvious texture seams. Metallic and pearlescent appearance is baked into the raster, not a promise of a metallic physical print.

The selected PNG sources total 58.55 MB. Keep them as originals. P3 must create measured, visually checked delivery derivatives and thumbnails, preload the selected backdrop before countdown, cache only requested packs and retain the six procedural scenes as loading/offline fallbacks. Never place the whole original library in the initial app bundle or mandatory service-worker precache.

Use scene images for Together backgrounds, picker thumbnails and optional wall backgrounds. Use materials as clipped frame fills or keepsake covers. Render names, dates, prompts, photo windows, frame geometry, QR codes and safety margins in code. Preserve the existing Code Z vector logo and Fluent sticker library. No user photographs were supplied to generation.

## Exact prompts and provenance

Each JSON record includes the exact prompt, generated source path, selected repository file, inspection notes, actual dimensions, byte size and hash. Original generation identifiers in the first batch retain their initial v1 suffix; selected filenames and product naming use V2.

- [Initial three scenes](initial-scenes-generation.json)
- [Five additional Together scenes](remote-scenes-generation.json)
- [Five additional studio scenes](studio-scenes-generation.json)
- [Five additional event scenes and refinement history](event-scenes-generation.json)
- [Six material textures](materials-generation.json)

The prompts request original fictional environments/materials without third-party branding. Provenance is recorded; it is not a guarantee of exclusive rights or legal clearance.
