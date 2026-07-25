Four independent, stateless utility modules under `lib/` that are imported by other parts of the app:
- `photo-dates.ts` defines the `PhotoDate` type, `Cadence` union, and CRUD helpers (`createPhotoDate`, `listPhotoDates`, `deletePhotoDate`) against the Supabase `pb_photo_dates` table via `./supabase/client`; also exports `nextOccurrence` for cadence advancement.
- `prompts.ts` holds static prompt pools per `PromptPack` (`couple|group|solo`) and a deterministic PRNG (`mulberry32`) so both peers generate identical prompt sequences from a shared seed via `rollPrompts`.
- `recap.ts` is a pure client-side image compositor: `composeRecap` builds an HTMLCanvas grid of strips with configurable scale, shadow, and header text, exposed through `loadImage` and `recapToBlob`.
- `retention.ts` implements ISO-week vault lifecycle constants and helpers (`WEEKLY_STRIP_CAP`, `weeklyResetCutoffIso`, `isRetained`, `daysUntilPurge`) depending only on `./streak` for week boundaries.

Dependency direction is one-way: these modules import from lower-level helpers (`supabase/client`, `streak`) but are not imported by each other, keeping them composable building blocks.