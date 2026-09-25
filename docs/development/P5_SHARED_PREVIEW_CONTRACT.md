# P5 shared live preview

Recorded 23/09/2026. `lib/shared-preview.ts` supplies the new all-person Together renderer. It does not modify legacy room rendering, the RTC engine, source images or the compositor.

## Integration

Construct `SharedPreviewPainter(targetCanvas, { onStatus })`, then call `start(config)`. `update(config)` replaces borrowed inputs and invalidates pending paints. Config contains:

- `inputs`: up to four `{role, video, mirror}` records, using roles A to D.
- `intendedRoles` and `localRole`: the exact current roster, separate from videos that have arrived.
- `scene`, optional matching `sceneAsset` and optional `materialAsset`: caller-owned scene definitions and ready curated handles.
- `places`: the same per-role `{dx, dy, scale}` used by composition.
- `aspectRatio`: 0.5 to 2, default 3:2. The target's longest edge stays at most 640 pixels.

Call `stop()` to clear the target and stop scheduling. Call and, when useful, await `dispose()` on unmount. Disposal settles after any outstanding model construction or inference closes. The caller retains ownership of video elements, stream tracks, the target canvas and asset handles. The renderer never stops tracks or releases borrowed assets. Keep asset handles alive until the corresponding config has been replaced; the generation fence prevents an old asynchronous frame from drawing them after replacement.

`renderFrame()` is available for controlled native probes. `retryTogether()` explicitly retries after degradation. Root owns the React adapter and accessible labels for `SharedPreviewStatus`.

`createSharedStillCutouts(inputs, {signal})` supports explicit post-capture Together rendering without playing video. Inputs are up to 16 caller-owned canvases keyed by source ID. Await disposal of the live painter first. The helper shares its allocation/inference slot and rejects `preview_busy` rather than queueing another model. One local model processes the batch sequentially into at-most-640-edge snapshots, with an 8 MiPixel aggregate ceiling and four-second cumulative processing target. It returns caller-owned cutout canvases only if the entire batch succeeds; failure/cancellation releases all partial outputs. It always closes the model and mask, and never modifies borrowed originals. The consumer releases returned canvases after compositor output and fences late results against project/recipe changes.

## Rendering and fallback

All intended roles must have ready, nonzero video frames before Together can be shown. Missing peers produce a clearly labelled local-only original view when local video is present, otherwise available original tiles or a waiting state. A segmentation failure never produces a partly assembled Together image. For four roles, a failed capability trial preserves all four original tiles.

Mirror is explicit per input. Raw local video may need mirroring; remote video should only be mirrored when its declared source convention requires it. The snapshot is mirrored once before inference, so the resulting mask and colour pixels agree. CSS mirroring of the preview element is not a substitute for this contract.

Roles draw in A/B/C/D order. Person height is `cellHeight * (roleCount > 2 ? 0.8 : 0.92) * scale`, width preserves source aspect, horizontal centre is `cellWidth * ((index + 1) / (roleCount + 1) + dx)`, and bottom is `cellHeight * (1 + dy)`. This matches `compose.ts`. Scene art uses `getAssetCrop`; missing art retains the scene's procedural fallback. Material is an underlying surface when no scene is active, consistent with material being outside scene/photo cells in the compositor. It is never painted over faces. This preview represents a shared photo cell, not the final strip's frame, caption or material border.

Status modes are `warming`, `together`, `originals`, `local-only`, `waiting` and `stopped`, with displayed/missing roles and a bounded fallback reason. `fps` is a conservative scheduling estimate, not a measured frame-delivery guarantee. `inferenceMs` includes the sequential snapshot, inference and masking work for the latest attempted group frame, excluding initial model construction.

## Work and lifecycle bounds

The dedicated MediaPipe IMAGE segmenter loads lazily only after a Together scene and all expected videos are available. It uses the existing local `/mediapipe/wasm` and `/models/selfie_segmenter.tflite`, tries GPU then CPU construction, and closes every mask result. It does not use the legacy shared VIDEO instance or competing timestamp sequences.

A module-wide slot permits one construction/inference frame at a time across renderer instances. The slot remains occupied until native work settles after cancellation. No pending-frame queue accumulates. A frame schedules its successor only after completion, with at least 125 ms delay, so output cannot exceed eight updates per second. Four owned role snapshots, one mask and one staging canvas are bounded to a 640-pixel longest edge. Warmup and slower operation use 320-pixel snapshots.

Four-person mode first measures two sequential people. A trial over 100 ms falls back to four original tiles. Group work exceeding 500 ms stops further inference for that attempt and degrades to originals until explicit retry. Other measured costs reduce the schedule and source size. These are conservative implementation thresholds, not phone capability findings.

Stop, replacement and disposal increment the generation before any late callback can repaint or report a completed Together view. Late construction closes its resulting model; late inference releases owned canvases after settling. Native inference is synchronous and cannot be pre-empted mid-call, so a blocked browser/GPU can exceed the desired deadline before fallback runs. The slot bounds accumulation, not native execution time. Models, camera flows and phone heat/memory remain acceptance measurements.

## Evidence

Eight focused tests pass for compositor geometry, dimension bounds, lazy plain/missing-peer fallback, per-stream mirroring, no inference queue, adaptive two/four-person behaviour, late model closure, generation-fenced paint and bounded still-batch disposal. Tests use injected canvas/model fixtures; they do not prove segmentation quality or native rendering. TypeScript, lint and root native-browser validation are tracked separately. No hosted data, camera access or borrowed user data is used by these tests.

The development-only lab now exposes `runSharedPreviewProbe()` and `SyntheticTogether`. The fixture draws labelled coloured silhouettes into canvas streams, starts in original tiles and loads the actual local model only after an explicit Together action. Two/four-source checks observe native model work, bounded output, paused/missing-peer fallback and disposal. Silhouette masks do not establish human edge quality. Root records actual execution and visual observations separately from this implemented probe.

Root's first native desktop run on 23/09/2026 passed six lifecycle/fallback checks, but both source counts fell back to originals: initial two-source work was 4,501.4 ms and the four-source two-person trial was 329.1 ms. These are fallback observations, not proof of Together drawing. The probe now performs one explicit retry with the retained model and unchanged limits after slow fallback, reports initial/warm measurements separately, and emits a distinct Together-rendered result. First inference may include native compilation costs; this is an inference to test, not a reason to relax the bounds. The synthetic video fixture's initial playback deadlock was fixed by starting its bounded canvas repaint interval before awaiting video playback.
