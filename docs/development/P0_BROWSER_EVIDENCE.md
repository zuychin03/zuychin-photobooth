# P0 local browser evidence

Observed 23/09/2026, Australia/Sydney, using the Codex in-app Chromium browser on Windows. Test URL: `http://127.0.0.1:3005/v2-lab`. Node `25.6.0`, Next.js `16.2.10`. This is a synthetic desktop run, not an iPhone, Android, real-camera or physical-print result.

Browser-reported user agent:

```text
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36
```

The report recorded a 1280 x 720 viewport and a secure context. Actual encoded frame rate was not profiled. The browser log inspection returned no warnings or errors after the probes. The lab was visually inspected with its results visible.

## Hardware and memory follow-through

Observed locally on 23/09/2026 through Node's operating-system API: Windows build `10.0.26200`, x64, AMD Ryzen 9 6900HX with Radeon Graphics, 16 logical processors, about 15 GiB OS-reported total memory. This identifies the desktop test environment, not a mobile performance class.

The updated media probe ran at `2026-09-22T14:19:45.523Z` and again passed all 13 checks. The browser reported 16 available logical processors. Its diagnostic `performance.memory` counter produced 85 samples at a requested 100 ms interval: first used JS heap 17,387,875 bytes, last 17,417,247 bytes, highest sampled 17,936,410 bytes. This is neither the process peak nor proof of leak freedom. Native/GPU memory was not measured; the counter is non-standard and may be inaccurate or unavailable. No product decision relies on it. See [MDN's counter limitations](https://developer.mozilla.org/en-US/docs/Web/API/Performance/memory) and [processor reporting limits](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/hardwareConcurrency).

The probe now includes an explicit RGBA8 resource inventory. One 1280 x 720 surface is 3,686,400 bytes. The simultaneously referenced synthetic layout canvases account for 14,529,280 bytes at the largest layout. One source plus one decoded PNG/video surface and a sample pixel account for 7,372,804 bytes. These calculations exclude codec internals, extra GPU/browser surfaces, Blob copies and delayed collection, so they are not upper bounds on total memory.

The recording loop retains no array of raw frames. Retaining 24 raw 720p frames would alone require 88,473,600 bytes, before encoder/output overhead. P4 must keep encoded chunks bounded, process frames sequentially and release decoded resources. The ten-MiB encoded limit does not establish a memory ceiling. Phone and sustained-session profiling remain pending; Danny explicitly deferred phone tests while local development continues, as recorded in [P0 decisions](P0_DECISIONS.md).

## IndexedDB

Storage run recorded at `2026-09-22T14:05:53.174Z`: three passes, zero failures, zero unsupported checks.

| Probe | Observed result |
| --- | --- |
| Close/reopen | Manifest and 364-byte PNG recovered with matching source hash. |
| Transaction abort | Deliberately aborted replacement left both prior manifest and PNG unchanged. This is not actual disk exhaustion. |
| Additive upgrade | Version 2 added a capture-time index while retaining existing manifest and media. |

Reload sequence:

1. Saved synthetic checkpoint at `2026-09-22T14:06:02.632Z`.
2. Verification in the same document correctly returned failure at `14:06:12.373Z`, explaining that a page reload was required.
3. Clicked the page's reload control; the previous report disappeared.
4. Verification at `14:06:29.362Z` passed, recovering the original capture timestamp, manifest and 364-byte PNG from the prior document.

Recovered PNG SHA-256: `294b9bcba0462b0b1705598e49ab69d682920b2c3e91fc77882292559f2a8610`.

## Canvas, print geometry and media

Run recorded at `2026-09-22T14:06:55.344Z`: thirteen passes, zero failures, zero unsupported checks. The tab was visible during recording and playback. All content was generated colour fixtures; no user media or camera/microphone stream was used.

| Existing layout | Rendered dimensions | Participant/shot pixel samples checked |
| --- | --- | --- |
| Classic strip | 536 x 1522 | 4 |
| 2x2 grid | 1034 x 926 | 4 |
| Tall three | 536 x 1304 | 3 |
| Taking turns | 536 x 1522 | 4 |
| Side by side | 536 x 1522 | 8 |
| Twin strips | 1034 x 1522 | 8 |
| Trio | 1532 x 1522 | 12 |
| Quad | 2030 x 1184 | 12 |

Each layout also passed its frame-margin pixel and output-dimension check. These samples prove basic raster placement, not complete visual fidelity, crop quality, fonts, decoration or segmentation.

PNG fallback: `image/png`, 20,893 bytes, 1280 x 720, decoded sample `230,58,100,255` matched the source independently of recording.

| Recording measurement | MP4 | WebM |
| --- | --- | --- |
| Requested MIME | `video/mp4;codecs=avc1.42E01E` | `video/webm;codecs=vp8` |
| Recorder and Blob MIME | `video/mp4;codecs=avc1.42001f` | `video/webm;codecs=vp8` |
| File bytes | 47,084 | 17,628 |
| Requested / track-reported rate | 12 / 12 fps | 12 / 12 fps |
| Source frames drawn | 24 | 24 |
| Capture elapsed | 2,006 ms | 2,002 ms |
| Decoded dimensions | 1280 x 720 | 1280 x 720 |
| Metadata duration / playback end | 1.954 / 1.954 seconds | 1.912 / 1.912 seconds |
| Decoded time samples | 39 | 39 |
| Distinct quantised pixel colours | 2 | 4 |

Both files passed MIME/container guards and played to completion with changing decoded pixels. Source draw counts and reported track rate do not establish encoded output fps. No import from another device or cross-device playback was tested.

The two print checks calculated 600 x 1800 pixels for 50.8 x 152.4 mm, and 1200 x 1800 for 101.6 x 152.4 mm at 300 ppi. No PDF or physical page was generated by P0.

## Build and route restriction

`npm run build` passed. A temporary production server on loopback port 3015 returned:

| Route | HTTP result |
| --- | --- |
| `/` | 200 |
| `/booth` | 200 |
| `/v2-lab` | 404 |

The production probe process was stopped after these requests. The development server remains available on port 3005. These HTTP checks establish route availability/restriction, not full production user-flow acceptance.

The build emitted an existing workspace-root warning because another lockfile is present above this repository. Compilation, type analysis and prerendering completed successfully. No framework configuration or external lockfile was changed to suppress it.
