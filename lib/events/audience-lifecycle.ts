import { EventClientError } from "./client";
import type { EventAudienceClient } from "./audience-client";
import { EVENT_PUBLICATION_LIMITS, type EventAudiencePage } from "./publication-contract";

export interface EventAudienceImage { submissionId: string; revision: number; url: string }
export interface EventAudienceState { phase: "loading" | "ready" | "paused" | "error"; page: EventAudiencePage | null; images: EventAudienceImage[]; error: string | null; freshnessUntil: number; hasPrevious: boolean; mediaBusy: boolean }
export interface EventAudienceLifecyclePorts {
  now(): number; schedule(callback: () => void, milliseconds: number): unknown; cancel(handle: unknown): void;
  createUrl(blob: Blob): string; revokeUrl(url: string): void;
}
const defaults: EventAudienceLifecyclePorts = { now: Date.now, schedule: (callback, ms) => setTimeout(callback, ms), cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), createUrl: blob => URL.createObjectURL(blob), revokeUrl: url => URL.revokeObjectURL(url) };
export function createEventAudienceLifecycle(client: Pick<EventAudienceClient, "destination" | "list" | "download" | "assertActive">, changed: (state: EventAudienceState) => void, ports: EventAudienceLifecyclePorts = defaults) {
  let rotationEnabled = true;
  let state: EventAudienceState = { phase: "loading", page: null, images: [], error: null, freshnessUntil: 0, hasPrevious: false, mediaBusy: false }, closed = false, paused = true, generation = 0, active: AbortController | null = null, mediaActive: AbortController | null = null, poll: unknown, expiry: unknown, after: string | undefined, lastAdvance = ports.now();
  const emit = () => { if (!closed) changed({ ...state, images: [...state.images] }); };
  const clear = (phase: EventAudienceState["phase"], error: string | null) => { for (const image of state.images) ports.revokeUrl(image.url); state = { phase, error, page: null, images: [], freshnessUntil: 0, hasPrevious: after !== undefined, mediaBusy: mediaActive !== null }; ports.cancel(expiry); emit(); };
  const cancel = () => { generation++; active?.abort(); mediaActive?.abort(); ports.cancel(poll); ports.cancel(expiry); };
  async function loadImages() {
    if (closed || paused || mediaActive || !state.page) return;
    const abort = new AbortController(), epoch = generation; mediaActive = abort; state.mediaBusy = true; emit();
    try {
      while (state.page && !closed && !paused && epoch === generation) {
        const entry = state.page.entries.find(item => !state.images.some(image => image.submissionId === item.submissionId && image.revision === item.revision)); if (!entry) break;
        const blob = await client.download(entry, "thumbnail", abort.signal); client.assertActive(abort.signal);
        if (closed || paused || epoch !== generation) return;
        if (ports.now() >= state.freshnessUntil) throw new EventClientError("stale");
        if (state.page?.entries.some(item => item.submissionId === entry.submissionId && item.revision === entry.revision)) { state.images.push({ submissionId: entry.submissionId, revision: entry.revision, url: ports.createUrl(blob) }); emit(); }
      }
    } catch (error) {
      if (!closed && !paused && epoch === generation) { cancel(); clear("error", error instanceof EventClientError ? error.code : "unavailable"); poll = ports.schedule(() => void refresh(), state.error === "rate_limited" ? 60000 : EVENT_PUBLICATION_LIMITS.pollMs); }
    } finally { if (mediaActive === abort) { mediaActive = null; state.mediaBusy = false; emit(); } }
  }
  async function refresh() {
    if (closed || paused || active) return;
    const abort = new AbortController(), epoch = generation, started = ports.now(); active = abort; ports.cancel(poll);
    const check = () => { client.assertActive(abort.signal); if (closed || paused || epoch !== generation) throw new EventClientError("cancelled"); if (ports.now() >= started + EVENT_PUBLICATION_LIMITS.freshnessMs) throw new EventClientError("stale"); };
    try {
      if (client.destination === "wall" && rotationEnabled && state.page && started - lastAdvance >= 15000) { after = state.page.nextCursor ?? undefined; lastAdvance = started; }
      const page = await client.list(after, client.destination === "wall" ? 3 : 12, abort.signal); check();
      const until = Math.min(started + EVENT_PUBLICATION_LIMITS.freshnessMs, Date.parse(page.expiresAt)); if (until <= ports.now()) throw new EventClientError("expired");
      const kept = state.images.filter(image => page.entries.some(entry => entry.submissionId === image.submissionId && entry.revision === image.revision));
      for (const image of state.images) if (!kept.includes(image)) ports.revokeUrl(image.url);
      state = { phase: "ready", page, images: kept, error: null, freshnessUntil: until, hasPrevious: after !== undefined, mediaBusy: mediaActive !== null }; ports.cancel(expiry);
      expiry = ports.schedule(() => { cancel(); clear("error", "stale"); if (!paused && !closed) poll = ports.schedule(() => void refresh(), 0); }, until - ports.now()); emit();
      void loadImages();
    } catch (error) {
      if (!closed && !paused && epoch === generation) { cancel(); clear("error", error instanceof EventClientError ? error.code : "unavailable"); }
    } finally {
      if (active === abort) active = null;
      if (!closed && !paused) { ports.cancel(poll); poll = ports.schedule(() => void refresh(), state.error === "rate_limited" ? 60000 : Math.max(0, started + EVENT_PUBLICATION_LIMITS.pollMs - ports.now())); }
    }
  }
  return {
    setRotationEnabled(enabled: boolean) { rotationEnabled = enabled; lastAdvance = ports.now(); },
    start() { if (closed) return; paused = false; void refresh(); },
    retry() { if (!closed && !active) { paused = false; void refresh(); } },
    next() { if (closed || active || !state.page?.nextCursor) return; after = state.page.nextCursor; lastAdvance = ports.now(); cancel(); clear("loading", null); void refresh(); },
    first() { if (closed || active) return; after = undefined; lastAdvance = ports.now(); cancel(); clear("loading", null); void refresh(); },
    pause(reason = "hidden") { if (closed) return; paused = true; cancel(); clear("paused", reason); },
    close() { if (closed) return; paused = true; cancel(); clear("paused", null); closed = true; },
    getState() { return { ...state, images: [...state.images] }; },
  };
}
export type EventAudienceLifecycle = ReturnType<typeof createEventAudienceLifecycle>;
