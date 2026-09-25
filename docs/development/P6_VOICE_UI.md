# Voice caption browser evidence

Recorded 23/09/2026 using Chromium 153 on Windows. `/v2-lab/voice/pcm` uses the production caption component, AudioWorklet and IndexedDB with a synthetic tone and in-memory service. No microphone, real account or hosted upload was used. Its server resets on reload, so workspace recovery and native database probes do not establish hosted durability.

Nine native draft checks passed: cross-handle WAV/text recovery, stale local revision refusal, preservation of a recovered draft's original remote revision, exact frozen save retry, pending immutability, durable delete identity, exact-account removal, preservation of another account and the 20-draft limit.

The visible workflow recorded canonical PCM, kept its local draft, saved text/audio, recovered a lost acknowledgement and loaded the saved audio. A simulated newer server edit left the recovered old draft unchanged; Save correctly conflicted. Discard locked competing actions and focused Keep editing; Escape restored the trigger. Explicit discard refreshed the newer caption. Delete also locked controls and recovered a deliberately lost acknowledgement through the same request. Revoking access cleared private text and disabled mutation controls. Desktop and 390 x 844 dark layouts were inspected with no horizontal overflow.

## Playback isolation

The initial recorded WAV loaded with readyState 4 and duration 22.197333 seconds. Clicking the native Play control through the automation accessibility API crashed the embedded browser tab. The same accessibility action reproduced a tab crash on an isolated, canonical one-second WAV with no recording, journal or service code.

In that isolated fixture, an explicit application Play button reached `playing` and `ended` at 1.000 seconds without a media error. A fresh tab's ordinary pointer click on the native Play control also reached `ended` at 1.000 seconds, readyState 4 and no error. Finally, the actual caption component recorded 7.808 seconds through AudioWorklet; a pointer click played it to completion, with currentTime and duration both 7.808, ended true and no media error. These observations identify a reproducible automation interaction limitation; they do not establish its underlying browser cause or physical speaker output. Production playback controls and format were unchanged.

The synthetic caption fixture was reset after review. Hardware microphone permission/denial, physical audio quality, OS download delivery, phone/browser-installed behaviour, authenticated MemoryHub integration and final all-page review remain pending.
