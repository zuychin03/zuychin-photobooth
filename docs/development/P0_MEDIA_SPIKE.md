# P0 media and print probe

The development lab calls `runMediaProbe()` from `lib/feasibility/media-probe.ts`. Run it in a visible browser tab. It uses synthetic colours only, requests no camera or microphone, uploads nothing and retains no recordings.

## Evidence produced

- Print geometry: 50.8 x 152.4 mm is 600 x 1800 pixels and 144 x 432 PDF points at 300 ppi. A 101.6 x 152.4 mm sheet is 1200 x 1800 pixels and 288 x 432 points. These are calculations, not a PDF generator or a physical print result.
- PNG fallback: encode the synthetic 1280 x 720 canvas, decode the resulting PNG and check its dimensions, MIME and a known pixel independently of motion support.
- Existing composition: render all eight current layouts with participant/shot colour fixtures and inspect each cell, split-cell halves and the frame margin. This covers basic ownership and shot placement. It does not certify cropping, effects, fonts, segmentation or visual quality.
- Motion: separately attempt advertised MP4 and WebM candidates using a two-second, 12 fps canvas stream at 1280 x 720. Decode and play each resulting Blob to completion, inspect changed pixels, and report recorder/Blob MIME, bytes, dimensions, source draw count, track-reported rate, capture elapsed time and playback end time.

`isTypeSupported` only selects a candidate; passing requires an actual encode and decode. Requested, recorder and Blob MIME types must agree, and the bytes must contain the expected MP4 file-type brand or WebM document-type header. This bounded header check rejects cross-container substitution; it is not a full container parser. An advertised candidate that fails is `fail`, not `unsupported`. API/format absence is `unsupported`. No WebM file is relabelled MP4, and no server or heavyweight encoder fallback is installed.

Recorded files can report an infinite/unknown metadata duration. The probe preserves that value and reports the media clock at playback completion separately. A passing clip must finish between 1.4 and 3 seconds, contain at least two sampled media times and change sampled colours. Source timer counts and track settings are not measured encoded fps.

Encoding, PNG decoding, recording and playback have bounded timeouts. The recorder is limited to 10 MB. Finally blocks stop tracks/recorders, clear timers, release canvases, remove the playback element and revoke object URLs. Keep the tab visible because background throttling can invalidate timing observations.

## Memory and remaining acceptance work

The lab records available JS-heap observations and an arithmetic inventory of its known RGBA8 surfaces, separately from encoded bytes. The [browser evidence](P0_BROWSER_EVIDENCE.md) identifies the desktop CPU/OS and the measured counters. Neither the inventory nor the optional, non-standard heap counter measures native/GPU or total process memory.

P0 mobile feasibility is deferred at Danny's request, with local development continuing. P2 owns import/recovery acceptance; P4 owns GIF/export integration, sustained memory and physical print size/colour; P5 owns shared-preview/cross-network device behaviour; P6/P8 own optional microphone flows. The full iPhone Safari/PWA, Android and desktop matrix remains a release requirement. Synthetic probes do not pass those checks.

The 12 Node tests in `tests/media-geometry.test.ts` cover physical dimensions, two-up fit, A4 rounding, resolution changes, invalid inputs, honest non-browser results and MIME/container mismatch rejection. Header fixtures verify the format guard only; they are not playable videos. Run them with the repository test runner. Browser results must come from the lab, not these tests.

## Primary API references

Checked 22/09/2026: [canvas captureStream](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream), [MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder), [media duration](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/duration). Browser-specific results remain authoritative for this probe.

Checked 23/09/2026: [container signatures in the MIME Sniffing Standard](https://mimesniff.spec.whatwg.org/#matching-an-audio-or-video-type-pattern).
