# Private voice caption backend

Migration `014_v2_voice_captions.sql` is an unapplied source artefact. `PB_MEMORIES_ENABLED=true` and `PB_VOICE_CAPTIONS_ENABLED=true` are both required. Both remain disabled in the example configuration. SQL `pb_voice_configuration.deployment_bytes` starts at zero; the service-only `pb_voice_configure(bytes)` requires an explicitly partitioned provider budget before activation. Do not count project, event, legacy image and voice allocations against the same free headroom twice.

## HTTP and original-source authority

`POST /api/memories/[activityId]/voice` accepts `read`, `save`, `delete` and `download`. Mutations use immutable request UUIDs and caption revision CAS. The absent snapshot is revision zero. Requests require an authenticated bearer token, canonical same-origin HTTPS (loopback HTTP only in development), bounded JSON and the existing durable actor read/write rate gate. Responses are private/no-store, no-referrer and nosniff. No caller actor, Storage path, signed URL, duration, digest or sample metadata is accepted.

Captions are private to their author, including when attached to an accessible partner's activity. Reads, saves, Storage insertion and finalisation require the exact activity's current readable source. The authority uses the current memory projection plus the retained-strip resolver or project-asset resolver, including the challenge protection gate. Owning an inaccessible protected original does not bypass it. Original-couple rules and the retained owner's own-source exception remain unchanged. Download reauthenticates and rechecks its exact caption after provider fetch before returning any bytes.

Private erasure uses only the authenticated actor's caption key, so it remains possible after source access is lost. It exposes no other author's caption. Replaying an older delete after a later save conflicts instead of returning the later caption through that access-loss exception.

## Bounded bytes and durable replacement

The only recording is canonical RIFF/WAVE PCM16 mono at 48 kHz: 1–1,440,000 samples, at most 30 seconds and 2,880,044 bytes. The shared validator rejects extra chunks, compressed/float/multichannel formats, inconsistent lengths and other rates. The HTTP layer rejects noncanonical base64, derives SHA-256/sample metadata itself and verifies the actual stored bytes before commit. Maximum JSON body is 3,850,000 bytes; caption text is at most 2,000 UTF-16 units at the API.

Storage uses the private `photobooth-voice-captions` bucket and exact `actor/activity/generation.wav` paths. Generation is the request UUID. New bytes stage for ten minutes; the currently verified recording and text remain current until the replacement commits. Retries cannot rebind a UUID to a different payload. Storage insertion is fenced by current source authority, active reservation and exact digest metadata. Ready, deleting and expired identities reject overwrite and late writes. A duplicate upload response is never proof of success; the required read/hash/WAV proof decides whether finalisation can commit.

Per actor, at most 20 charged generations and 57,600,880 bytes include staged, current, deleting and terminal failed-cleanup recordings. There are at most 500 caption heads and 100 ordinary immutable request receipts per head. Privacy deletion remains possible at that limit (one final receipt can exceed it); no-op deletion does not grow metadata. Receipts retain hashes/status/revision, not prior private text or recording data. Text is scrubbed from staging after commit, expiry or deletion. Completed exact retries return the current snapshot without reapplying older content.

Voice-authored activities are retained through both existing memory compaction paths, including a partner's private caption. At most 500 activities per source subject can be pinned by voice across all authors, separately from 500 heads per author. A full voice pin budget rejects only the new caption, never a photo save. Empty/deleted captions stop pinning. This does not manufacture chapter labels or permit hidden media access.

## Cleanup and deadlines

The existing `/api/media/maintenance` cron gains a feature-gated voice batch. It still requires mandatory header-only CRON_SECRET/service configuration. Voice failure does not prevent legacy image work, and legacy readiness does not prevent voice cleanup from being attempted. Each batch expires at most 25 staged generations, rotates through at most 25 caption heads, and claims one cleanup object. Definitive source loss or metadata orphaning scrubs the caption and queues its bytes; unknown source/provider state preserves them.

Cleanup leases last 60 seconds, allow eight claims and retain charges after exhaustion. Release requires provider deletion, a subsequent private object 404 and SQL confirmation that no Storage object remains, under the same live lease. Stale completions and late uploads cannot release or resurrect a generation. Terminal failures need operator investigation and an explicitly reviewed retry; no automatic charge release is implied.

HTTP has a 45-second response deadline, provider requests ten seconds, and at most two occupied provider operations. A timed-out provider call keeps its slot until it actually settles. These are request/socket bounds, not a claim that a remote mutation can be cancelled. An ambiguous save must retry the same request; staged state and charges are preserved. No audio is sent to an external speech service, and no image decoder handles the WAV.

## Validation limits

Focused tests use synthetic PCM and injected transports. The disposable PostgreSQL harness covers service grants, original-couple loss, private authors, protected-owner denial, CAS/claim races, quota release, expiry, late Storage insertion, voice-only activity compaction and populated migration reruns. It does not emulate Supabase object storage. Actual private upload/read/delete behaviour, device recording/playback, provider capacity and hosted schema application remain separate activation gates.

### Paused checkpoint, 23/09/2026

The baseline disposable SQL suite and ten focused backend tests passed. Subsequent scoped ESLint and whole-project TypeScript checks passed. The final expanded SQL run passed the earlier assertions, including the missing-configuration denial and partner-only caption preservation through both activity compaction paths, then failed at `run-voice-captions.mjs:88`: the final 500-pin capacity fixture supplied an empty activity UUID, so PostgreSQL rejected the UUID before the expected capacity assertion. The disposable database was removed in `finally`.

The compaction repair retains voice-authored activity identities under the existing subject lock without inventing labels. The configuration repair rejects a missing deployment-budget row at the authoritative save RPC. These changes are preserved, but the expanded suite is not fully green: repair the final fixture and rerun it on resume, including its final populated migration rerun. No additional implementation or checks were started after this stopping boundary. The overall goal is paused; no hosted migration, provider operation or feature activation was performed.

### Resumed bounded verification, 23/09/2026

The empty UUID came from synthetic activities dated in 2099 compacting away a newly saved activity. The fixture now uses recent past dates and deliberately ages the voice-captioned activity before compaction, so retention remains a meaningful assertion. New photo creation explicitly checks that both the strip and its activity identity exist. The capacity assertions are unchanged.

The complete disposable SQL suite now passes, including missing-configuration rejection, partner-only voice retention through both compaction paths, finalise/delete and last-generation capacity races, the 500-pin limit without blocking photo creation, and the populated migration rerun. The task-owned database was removed successfully. All ten focused backend tests, whole-project TypeScript and scoped ESLint passed again. No hosted schema, provider or feature activation was performed.
