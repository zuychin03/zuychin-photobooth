import { parseKioskApproval } from "../events/kiosk-contract";
import { createHash } from "node:crypto";
import type { EventJob } from "../events/contract";
import { authorizeCron, privateJson, type CronConfig, type CronEnvironment } from "./cron-auth";
import { createEventStore, EventStoreError, type EventStore } from "./event-store";
import { createEventObjects, EventObjectError, type EventObjectDescriptor, type EventObjects } from "./event-objects";
import { finaliseEventImage, ImageFinaliseError, type FinalisedEventImage } from "./image-finalise";
import { createEventReadinessStore, type EventReadinessStore } from "./event-readiness-store";

export interface EventMaintenancePorts {
  store: Pick<EventStore, "capabilities" | "claimJobs" | "checkpointJob" | "finishJob" | "sweep">;
  objects: EventObjects;
  finalise?: typeof finaliseEventImage;
  now?: () => number;
  readiness?: EventReadinessStore;
}
export interface EventMaintenanceResult { expired: number | null; job: "idle" | "ready" | "candidate" | "deleted" | "retry" | "failed" | "retained" }
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const permanent = (e: unknown) => e instanceof ImageFinaliseError && ["invalid_image", "metadata_mismatch", "output_too_large"].includes(e.code)
  || e instanceof EventObjectError && ["object_too_large", "size_mismatch"].includes(e.code);
const lost = (e: unknown) => e instanceof EventStoreError && ["lease_lost", "expired", "access_denied"].includes(e.code);

export async function processEventMaintenance(ports: EventMaintenancePorts, signal?: AbortSignal): Promise<EventMaintenanceResult> {
  const { store, objects } = ports, now = ports.now ?? Date.now, finalise = ports.finalise ?? finaliseEventImage;
  let expired: number | null = null, job: EventJob | null = null, source: Uint8Array | null = null, output: FinalisedEventImage | undefined;
  const active = () => { if (signal?.aborted || !job || job.status !== "running" || !job.lease_token || !job.lease_until || !Number.isFinite(Date.parse(job.lease_until)) || Date.parse(job.lease_until) <= now()) throw new EventStoreError("lease_lost", 409); };
  const fence = async (checkpoint: Record<string, unknown> = {}) => {
    active(); const id = job!.id, lease = job!.lease_token!;
    const next = await store.checkpointJob(id, lease, checkpoint);
    if (next.id !== id || next.lease_token !== lease || next.event_id !== job!.event_id || next.submission_id !== job!.submission_id || next.kind !== job!.kind) throw new EventStoreError("lease_lost", 409);
    job = next; active();
  };
  const descriptor = (kind: EventObjectDescriptor["kind"]): EventObjectDescriptor => ({ eventId: job!.event_id, submissionId: job!.submission_id, kind });
  try {
    if (signal?.aborted) return { expired, job: "retained" };
    const capabilities = await store.capabilities();
    if (signal?.aborted || !capabilities.ready) return { expired, job: "retained" };
    try { expired = (await store.sweep(25)).expired; } catch { /* Existing queued jobs remain eligible after an uncertain sweep. */ }
    if (signal?.aborted) return { expired, job: "retained" };
    const jobs = await store.claimJobs(1); if (!jobs.length) return { expired, job: "idle" }; if (jobs.length !== 1) return { expired, job: "retained" };
    job = jobs[0]; active();
    let outcome: "complete" | "retry" | "failed" = "complete", errorCode: string | undefined;
    try {
      if (job.kind === "finalise") {
        await fence(); source = await objects.download(descriptor("source"), signal); active();
        if (!source) throw new EventObjectError("provider_failure");
        const approval = job.checkpoint.sourceApproval;
        if (approval !== undefined) {
          try { const expected = parseKioskApproval({ ...(approval as Record<string, unknown>), consent: { submission: true, gallery: false, wall: false }, missionId: null }); if (source.length !== expected.bytes || digest(source) !== expected.sha256) throw new Error("mismatch"); }
          catch { throw new ImageFinaliseError("metadata_mismatch"); }
        }
        output = await finalise(source, { signal, timeoutMs: Math.min(10000, Math.max(1, Date.parse(job.lease_until!) - now())) }); active();
        if (approval !== undefined) {
          const expected = approval as Record<string, unknown>;
          if (output.source.mime !== expected.mime || output.source.width !== expected.width || output.source.height !== expected.height || output.source.bytes !== expected.bytes || output.source.sha256 !== expected.sha256) throw new ImageFinaliseError("metadata_mismatch");
        }
        for (const kind of ["image", "thumbnail"] as const) {
          const expected = output[kind]; await fence();
          let existing = await objects.download(descriptor(kind), signal);
          try {
            active();
            if (existing === null) {
              await fence();
              await objects.upload({ ...descriptor(kind), kind, jobId: job.id, lease: job.lease_token!, leaseUntil: job.lease_until!, mime: expected.mime, bytes: expected.bytes, sha256: expected.sha256 }, expected.data, signal); active();
              await fence(); existing = await objects.download(descriptor(kind), signal); active();
            }
            if (!existing) throw new EventObjectError("provider_failure");
            if (existing.length !== expected.bytes || digest(existing) !== expected.sha256) throw new ImageFinaliseError("metadata_mismatch");
          } finally { existing?.fill(0); }
        }
        await fence({ decoded: true, objectsVerified: true, mime: output.image.mime, width: output.image.width, height: output.image.height, sha256: output.image.sha256, sourceSha256: output.source.sha256, sourceBytes: output.source.bytes, sourceWidth: output.source.width, sourceHeight: output.source.height });
      } else {
        const kinds = job.kind === "delete_staging" ? ["source"] as const : ["image", "thumbnail"] as const;
        for (const kind of kinds) { await fence(); if (!await objects.removeAndConfirmAbsent(descriptor(kind), signal)) throw new EventObjectError("provider_failure"); active(); }
        await fence({ deleted: true });
      }
    } catch (error) {
      if (signal?.aborted || lost(error)) return { expired, job: "retained" };
      active(); outcome = job.kind === "finalise" && permanent(error) ? "failed" : "retry"; errorCode = outcome === "failed" ? "invalid_image" : "provider_uncertain";
    }
    active();
    // A lost completion acknowledgement is reconciled by the durable lease, never a second outcome.
    const finished = await store.finishJob(job.id, job.lease_token!, outcome, errorCode);
    if (finished.id !== job.id || finished.kind !== job.kind || finished.event_id !== job.event_id || finished.submission_id !== job.submission_id) return { expired, job: "retained" };
    return { expired, job: finished.status === "complete" ? job.kind === "finalise" ? finished.checkpoint.postcardCandidate === true ? "candidate" : "ready" : "deleted" : finished.status === "failed" ? "failed" : finished.status === "retry" ? "retry" : "retained" };
  } catch { return { expired, job: "retained" }; }
  finally { source?.fill(0); output?.image.data.fill(0); output?.thumbnail.data.fill(0); }
}

async function productionPorts(config: CronConfig, env: CronEnvironment): Promise<EventMaintenancePorts> {
  return { store: createEventStore(env), objects: createEventObjects({ origin: config.supabaseUrl, serviceRoleKey: config.serviceRoleKey }), readiness: createEventReadinessStore(env) };
}
export function createEventMaintenanceHandler(makePorts = productionPorts, getEnv: () => CronEnvironment = () => process.env, timeoutMs = 90000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90000) throw new Error("Invalid event maintenance deadline");
  let running = false;
  return async (request: Request): Promise<Response> => {
    const env = getEnv();
    if (env.PB_EVENTS_ENABLED !== "true") return privateJson({ error: "Event maintenance is unavailable" }, 503);
    if (request.method !== "GET" || new URL(request.url).search) return privateJson({ error: "Invalid maintenance request" }, 400);
    const auth = authorizeCron(request, env); if (!auth.ok) return auth.response;
    if (running) return privateJson({ error: "Event maintenance is already running" }, 409); running = true;
    const abort = new AbortController(), signal = AbortSignal.any([request.signal, abort.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Response>(resolve => { timer = setTimeout(() => { abort.abort(); resolve(privateJson({ error: "Event maintenance is still settling; queued work is preserved" }, 503)); }, timeoutMs); });
    const work = (async () => {
      try {
        const ports = await makePorts(auth.config, env);
        if (!ports.readiness) throw new EventStoreError("unavailable", 503);
        await ports.readiness.status();
        const result = await processEventMaintenance(ports, signal);
        if (signal.aborted || result.expired === null || ["retry", "retained", "failed"].includes(result.job)) return privateJson(result, 503);
        const health = await ports.readiness.verified();
        if (signal.aborted || !health.ready && health.admissionPaused !== true) return privateJson({ ...result, workerReady: false }, 503);
        return privateJson({ ...result, workerReady: true });
      } catch { return privateJson({ error: "Event maintenance is unavailable; queued work is preserved" }, 503); }
      finally { clearTimeout(timer); running = false; }
    })();
    return Promise.race([work, timeout]);
  };
}
