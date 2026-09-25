import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { destroyStrip, hasCloudinary, uploadStrip, verifyStripArchive } from "../cloudinary";
import { executeMediaJob, MediaOperationError, type ArchiveProvider, type LifecycleStrip, type MediaJob, type MediaWorkerStore } from "./media-worker";
import type { CronConfig } from "./cron-auth";

const BUCKET = "photobooth-strips";
const STRIP_FIELDS = "id,owner,storage_path,kept,purged,cloudinary_public_id,cloudinary_url,layout_id";

export interface LifecycleCapabilities {
  version: 1;
  ready: boolean;
  week_start: string;
  legacy_retention_not_before: string;
}

export function lifecycleClient(config: CronConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) }) },
  });
}

async function rpc(client: SupabaseClient, name: string, args: Record<string, unknown> = {}) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new MediaOperationError("lifecycle_database_unavailable");
  return data;
}

export async function lifecycleCapabilities(client: SupabaseClient): Promise<LifecycleCapabilities> {
  const data = await rpc(client, "pb_lifecycle_capabilities");
  if (!data || data.version !== 1 || data.ready !== true || !Number.isFinite(Date.parse(data.week_start)) || !Number.isFinite(Date.parse(data.legacy_retention_not_before))) {
    throw new MediaOperationError("lifecycle_not_configured");
  }
  return data as LifecycleCapabilities;
}

export function supabaseMediaStore(client: SupabaseClient, job: MediaJob): MediaWorkerStore {
  const mutateStrip = async (strip: LifecycleStrip, values: Record<string, unknown>) => {
    if (strip.id !== job.source_id || strip.owner !== job.owner) throw new MediaOperationError("source_identity_changed", false);
    const data = await rpc(client, "pb_update_media_strip", { p_job_id: job.id, p_lease_token: job.lease_token, p_fields: values });
    if (!data) throw new MediaOperationError("strip_update_failed");
  };
  return {
    async checkpoint(job, stage, checkpoint) {
      await rpc(client, "pb_checkpoint_media_job", { p_job_id: job.id, p_lease_token: job.lease_token, p_stage: stage, p_checkpoint: checkpoint });
    },
    async finish(job, outcome, code) {
      await rpc(client, "pb_finish_media_job", { p_job_id: job.id, p_lease_token: job.lease_token, p_outcome: outcome, p_error: code ?? null, p_retry_after_seconds: Math.min(3600, 30 * 2 ** Math.min(job.attempts, 6)) });
    },
    async readStrip(id) {
      const { data, error } = await client.from("pb_strips").select(STRIP_FIELDS).eq("id", id).maybeSingle();
      if (error) throw new MediaOperationError("strip_read_failed");
      return data as LifecycleStrip | null;
    },
    persistArchive: (strip, reference) => mutateStrip(strip, { kept: true, cloudinary_public_id: reference.publicId, cloudinary_url: reference.url, archive_verified_at: null }),
    markArchiveVerified: strip => mutateStrip(strip, { archive_verified_at: new Date().toISOString() }),
    clearArchive: strip => mutateStrip(strip, { kept: false, cloudinary_public_id: null, cloudinary_url: null, archive_verified_at: null }),
    markPurged: strip => mutateStrip(strip, { purged: true }),
    async deleteStrip(id, owner) {
      if (id !== job.source_id || owner !== job.owner) throw new MediaOperationError("source_identity_changed", false);
      await rpc(client, "pb_delete_media_strip", { p_job_id: job.id, p_lease_token: job.lease_token });
    },
    async cleanupPaths(job) {
      const paths = await rpc(client, "pb_media_cleanup_paths", { p_job_id: job.id, p_lease_token: job.lease_token });
      if (!Array.isArray(paths) || paths.some(path => typeof path !== "string")) throw new MediaOperationError("invalid_cleanup_paths", false);
      return paths as string[];
    },
    async sourceExists(path) {
      const { data, error } = await client.storage.from(BUCKET).exists(path);
      if (error && "status" in error && error.status === 404) return false;
      if (error) throw new MediaOperationError("source_check_failed");
      return data;
    },
    async download(path) {
      const { data, error } = await client.storage.from(BUCKET).download(path);
      if (error || !data) throw new MediaOperationError("source_download_failed");
      return data;
    },
    async removeStorage(paths) {
      const { error } = await client.storage.from(BUCKET).remove(paths);
      if (error) throw new MediaOperationError("storage_delete_failed");
    },
  };
}

export const cloudinaryArchive: ArchiveProvider = {
  configured: hasCloudinary,
  upload: async (blob, owner, id) => uploadStrip(Buffer.from(await blob.arrayBuffer()), owner, id),
  verify: verifyStripArchive,
  remove: destroyStrip,
};

export async function processMediaJobs(client: SupabaseClient, jobId?: string) {
  const results: { id: string; outcome: "complete" | "retry" | "failed"; code?: string }[] = [];
  const worker = randomUUID();
  // Stop starting jobs after this budget; an active job keeps its own request deadlines.
  const deadline = Date.now() + 45_000;
  for (let index = 0; index < (jobId ? 1 : 5) && Date.now() < deadline; index++) {
    const jobs = await rpc(client, "pb_claim_media_jobs", { p_worker_id: worker, p_limit: 1, p_lease_seconds: 120, p_job_id: jobId ?? null }) as MediaJob[];
    if (!Array.isArray(jobs) || jobs.length > 1) throw new MediaOperationError("invalid_job_response");
    if (!jobs.length) break;
    const job = jobs[0];
    results.push({ id: job.id, ...await executeMediaJob(job, supabaseMediaStore(client, job), cloudinaryArchive) });
  }
  if (jobId && results.length === 0) {
    const { data, error } = await client.from("pb_media_jobs").select("id,status,last_error").eq("id", jobId).maybeSingle();
    if (error) throw new MediaOperationError("job_read_failed");
    if (data?.status === "complete") results.push({ id: jobId, outcome: "complete" });
    if (data?.status === "failed") results.push({ id: jobId, outcome: "failed", code: data.last_error ?? "operation_failed" });
  }
  return results;
}

export async function enqueueRetention(client: SupabaseClient, capabilities: LifecycleCapabilities): Promise<number> {
  if (!capabilities.ready) throw new MediaOperationError("lifecycle_not_configured");
  await rpc(client, "pb_enqueue_expired_uploads", { p_limit: 25 });
  const count = await rpc(client, "pb_discover_retention", { p_limit: 25 });
  if (!Number.isSafeInteger(count) || count < 0 || count > 25) throw new MediaOperationError("invalid_discovery_response");
  return count;
}
