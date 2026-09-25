import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { EVENT_LIMITS, type EventJob } from "../lib/events/contract";
import { processEventMaintenance, createEventMaintenanceHandler, type EventMaintenancePorts } from "../lib/server/event-maintenance";
import { EventStoreError } from "../lib/server/event-store";
import { EventObjectError } from "../lib/server/event-objects";
import { ImageFinaliseError } from "../lib/server/image-finalise";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = Date.parse("2026-09-23T00:00:00Z");
async function fixture(kind: EventJob["kind"] = "finalise") {
  const source = await sharp({ create: { width: 16, height: 12, channels: 3, background: "#db4263" } }).png().withMetadata({ orientation: 1 }).toBuffer();
  let job: EventJob = { id: uuid(1), event_id: uuid(2), submission_id: uuid(3), kind, status: "running", attempts: 1, lease_token: uuid(4), lease_until: new Date(now + 120000).toISOString(), checkpoint: {} };
  const objects = new Map<string, Uint8Array>([["source", new Uint8Array(source)]]), effects: string[] = [], finishes: string[] = [], checkpoints: Record<string, unknown>[] = [];
  const ports: EventMaintenancePorts = {
    readiness: { status: async () => ({ version: 1, ready: false, verifiedAt: null, pending: 0, maxPending: 2, heartbeatMaxAgeSeconds: 150 }), verified: async () => ({ version: 1, ready: true, verifiedAt: new Date().toISOString(), pending: 0, maxPending: 2, heartbeatMaxAgeSeconds: 150 }) },
    now: () => now,
    store: {
      capabilities: async () => ({ version: 1, ready: true, deploymentBytes: 250000000, allocatedBytes: 250000000, limits: EVENT_LIMITS }),
      sweep: async limit => { assert.equal(limit, 25); return { expired: 2 }; },
      claimJobs: async limit => { assert.equal(limit, 1); return [job]; },
      checkpointJob: async (id, lease, checkpoint) => { assert.equal(id, job.id); assert.equal(lease, job.lease_token); checkpoints.push(checkpoint); job = { ...job, checkpoint: { ...job.checkpoint, ...checkpoint } }; return job; },
      finishJob: async (_id, _lease, outcome) => { finishes.push(outcome); return { ...job, status: outcome === "retry" && job.attempts >= 8 ? "failed" : outcome, lease_token: null, lease_until: null }; },
    },
    objects: {
      download: async d => { effects.push(`read:${d.kind}`); assert.equal(d.eventId, job.event_id); assert.equal(d.submissionId, job.submission_id); return objects.has(d.kind) ? new Uint8Array(objects.get(d.kind)!) : null; },
      upload: async (d, data) => { effects.push(`write:${d.kind}`); assert.equal(d.lease, job.lease_token); assert(!objects.has(d.kind)); objects.set(d.kind, new Uint8Array(data)); },
      removeAndConfirmAbsent: async d => { effects.push(`delete:${d.kind}`); objects.delete(d.kind); return true; },
    },
  };
  return { ports, objects, source, effects, finishes, checkpoints, setJob: (patch: Partial<EventJob>) => { job = { ...job, ...patch }; } };
}

test("actual Sharp pipeline strips metadata, verifies both immutable derivatives and checkpoints before completion", async () => {
  const f = await fixture(), result = await processEventMaintenance(f.ports);
  assert.deepEqual(result, { expired: 2, job: "ready" }); assert.deepEqual(f.finishes, ["complete"]);
  assert.deepEqual(f.effects, ["read:source", "read:image", "write:image", "read:image", "read:thumbnail", "write:thumbnail", "read:thumbnail"]);
  for (const kind of ["image", "thumbnail"]) { const data = f.objects.get(kind)!, info = await sharp(data).metadata(); assert.equal(info.format, "jpeg"); assert.equal(info.exif, undefined); assert.equal(info.icc, undefined); assert(data.length <= (kind === "image" ? 2000000 : 100000)); }
  assert.equal(f.checkpoints.at(-1)?.objectsVerified, true); assert.equal(f.checkpoints.at(-1)?.decoded, true); assert.equal(f.checkpoints.at(-1)?.mime, "image/jpeg");
});

test("verified postcard JPEG remains a candidate outcome until its participants approve", async () => {
  const f = await fixture(), finish = f.ports.store.finishJob;
  f.ports.store.finishJob = async (...args) => { const job = await finish(...args); return { ...job, checkpoint: { ...job.checkpoint, postcardCandidate: true } }; };
  assert.equal((await processEventMaintenance(f.ports)).job, "candidate");
  assert.equal(f.checkpoints.at(-1)?.objectsVerified, true); assert.deepEqual(f.finishes, ["complete"]);
});

test("retry reconciles already-written bytes without overwrite after lost upload acknowledgement", async () => {
  const f = await fixture(), write = f.ports.objects.upload; let first = true;
  f.ports.objects.upload = async (d, bytes, signal) => { await write(d, bytes, signal); if (first) { first = false; throw new EventObjectError("provider_failure"); } };
  assert.equal((await processEventMaintenance(f.ports)).job, "retry"); assert(f.objects.has("image")); assert(!f.objects.has("thumbnail"));
  f.effects.length = 0; assert.equal((await processEventMaintenance(f.ports)).job, "ready"); assert(!f.effects.includes("write:image")); assert(f.effects.includes("write:thumbnail"));
});

test("mismatched immutable derivative rejects rather than overwrites or acknowledges it", async () => {
  const f = await fixture(); f.objects.set("image", new Uint8Array([1, 2, 3]));
  assert.equal((await processEventMaintenance(f.ports)).job, "failed"); assert.deepEqual(f.finishes, ["failed"]); assert(!f.effects.some(effect => effect.startsWith("write:"))); assert.deepEqual(f.objects.get("image"), new Uint8Array([1, 2, 3]));
});

test("accepted upload without a visible readback remains retryable rather than declaring invalid media", async () => {
  const f = await fixture(); f.ports.objects.upload = async () => {};
  assert.equal((await processEventMaintenance(f.ports)).job, "retry"); assert.deepEqual(f.finishes, ["retry"]); assert(!f.checkpoints.some(c => c.objectsVerified));
});

test("invalid compressed source fails without derivative effects; temporary decode or provider failures retry", async () => {
  const f = await fixture(); f.objects.set("source", new Uint8Array([137, 80, 78, 71]));
  assert.equal((await processEventMaintenance(f.ports)).job, "failed"); assert.deepEqual(f.effects, ["read:source"]);
  for (const error of [new ImageFinaliseError("image_busy"), new ImageFinaliseError("image_timeout"), new EventObjectError("provider_failure")]) {
    const next = await fixture(); next.ports.finalise = async () => { throw error; }; assert.equal((await processEventMaintenance(next.ports)).job, "retry");
  }
});

test("revocation at the next checkpoint stops before writing a derivative and retains the job", async () => {
  const f = await fixture(), checkpoint = f.ports.store.checkpointJob; let calls = 0;
  f.ports.store.checkpointJob = async (...args) => { if (++calls === 3) throw new EventStoreError("expired", 410); return checkpoint(...args); };
  assert.equal((await processEventMaintenance(f.ports)).job, "retained"); assert.deepEqual(f.effects, ["read:source", "read:image"]); assert.deepEqual(f.finishes, []);
});

test("expiry or replaced lease during external work cannot finish or perform later effects", async () => {
  const f = await fixture(); let time = now; f.ports.now = () => time;
  const read = f.ports.objects.download; f.ports.objects.download = async (...args) => { const result = await read(...args); time += 120000; return result; };
  assert.equal((await processEventMaintenance(f.ports)).job, "retained"); assert.deepEqual(f.effects, ["read:source"]); assert.deepEqual(f.finishes, []);
  const next = await fixture(), checkpoint = next.ports.store.checkpointJob;
  next.ports.store.checkpointJob = async (...args) => ({ ...await checkpoint(...args), lease_token: uuid(99) });
  assert.equal((await processEventMaintenance(next.ports)).job, "retained"); assert.deepEqual(next.effects, []);
});

test("cleanup requires every exact object absent and cannot release on provider uncertainty", async () => {
  for (const kind of ["delete_delivery", "delete_staging"] as const) {
    const f = await fixture(kind); assert.equal((await processEventMaintenance(f.ports)).job, "deleted"); assert.equal(f.checkpoints.at(-1)?.deleted, true);
    assert.deepEqual(f.effects, kind === "delete_staging" ? ["delete:source"] : ["delete:image", "delete:thumbnail"]);
  }
  const f = await fixture("delete_delivery"); f.ports.objects.removeAndConfirmAbsent = async () => false;
  assert.equal((await processEventMaintenance(f.ports)).job, "retry"); assert(!f.checkpoints.some(c => c.deleted)); assert.deepEqual(f.finishes, ["retry"]);
  f.setJob({ attempts: 8 }); assert.equal((await processEventMaintenance(f.ports)).job, "failed");
});

test("ambiguous completion is not downgraded or replayed during the same pass", async () => {
  const f = await fixture(); let finishes = 0; f.ports.store.finishJob = async () => { finishes++; throw new Error("lost response"); };
  assert.equal((await processEventMaintenance(f.ports)).job, "retained"); assert.equal(finishes, 1);
});

test("closed or unavailable schema produces no claim or provider work", async () => {
  const f = await fixture(); const abort = new AbortController(); abort.abort();
  assert.deepEqual(await processEventMaintenance(f.ports, abort.signal), { expired: null, job: "retained" });
  f.ports.store.capabilities = async () => ({ version: 1, ready: false, deploymentBytes: 0, allocatedBytes: 0, limits: EVENT_LIMITS });
  assert.deepEqual(await processEventMaintenance(f.ports), { expired: null, job: "retained" }); assert.deepEqual(f.effects, []);
});

test("cancellation during the schema probe stops before even the bounded sweep", async () => {
  const f = await fixture(), abort = new AbortController(); let swept = false;
  const capabilities = f.ports.store.capabilities;
  f.ports.store.capabilities = async () => { abort.abort(); return capabilities(); };
  f.ports.store.sweep = async () => { swept = true; return { expired: 0 }; };
  assert.equal((await processEventMaintenance(f.ports, abort.signal)).job, "retained"); assert.equal(swept, false); assert.deepEqual(f.effects, []);
});

test("maintenance HTTP stays private, header-authenticated, disabled by default and retains busy until late work settles", async () => {
  const f = await fixture(), env = { PB_EVENTS_ENABLED: "true", CRON_SECRET: "synthetic-cron", NEXT_PUBLIC_SUPABASE_URL: "https://storage.example", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service" };
  const request = (authorization = "Bearer synthetic-cron", suffix = "") => new Request(`https://app.test/api/events/maintenance${suffix}`, { headers: { authorization } });
  let invoked = 0; const make = async () => { invoked++; return f.ports; };
  assert.equal((await createEventMaintenanceHandler(make, () => ({ ...env, PB_EVENTS_ENABLED: "false" }))(request())).status, 503); assert.equal(invoked, 0);
  const handler = createEventMaintenanceHandler(make, () => env);
  assert.equal((await handler(request(""))).status, 401); assert.equal((await handler(request(undefined, "?secret=synthetic-cron"))).status, 400); assert.equal(invoked, 0);
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  f.ports.objects.download = async () => { await pending; return new Uint8Array(f.source); };
  const bounded = createEventMaintenanceHandler(make, () => env, 5), first = await bounded(request());
  assert.equal(first.status, 503); assert.equal(first.headers.get("cache-control"), "private, no-store");
  assert.equal((await bounded(request())).status, 409); release(); await new Promise(resolve => setTimeout(resolve, 1));
  f.ports.store.claimJobs = async () => []; assert.equal((await bounded(request())).status, 200); assert.deepEqual(f.finishes, []);
});

test("only a verified sweep and acknowledged successful pass refresh worker readiness", async () => {
  const env = { PB_EVENTS_ENABLED: "true", CRON_SECRET: "synthetic-cron", NEXT_PUBLIC_SUPABASE_URL: "https://storage.example", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service" };
  for (const mode of ["idle", "ready", "uncertain", "sweep-failed", "provider-failed"] as const) {
    const f = await fixture(); let verified = 0;
    const mark = f.ports.readiness!.verified; f.ports.readiness!.verified = async () => { verified++; return mark(); };
    if (mode === "idle") f.ports.store.claimJobs = async () => [];
    if (mode === "uncertain") f.ports.store.finishJob = async () => { throw new Error("lost acknowledgement"); };
    if (mode === "sweep-failed") f.ports.store.sweep = async () => { throw new Error("uncertain sweep"); };
    if (mode === "provider-failed") f.ports.objects.download = async () => { throw new EventObjectError("provider_failure"); };
    const response = await createEventMaintenanceHandler(async () => f.ports, () => env)(new Request("https://app.test/api/events/maintenance", { headers: { authorization: "Bearer synthetic-cron" } }));
    assert.equal(verified, ["idle", "ready"].includes(mode) ? 1 : 0); assert.equal(response.status, verified ? 200 : 503);
  }
});

test("admission pause preserves successful cleanup and heartbeat without reopening submissions", async () => {
  const f = await fixture("delete_delivery"); let verified = 0;
  const health = { version: 1 as const, ready: false, verifiedAt: new Date().toISOString(), pending: 1, maxPending: 2 as const, heartbeatMaxAgeSeconds: 150 as const, admissionPaused: true };
  f.ports.readiness = { status: async () => health, verified: async () => { verified++; return health; } };
  const env = { PB_EVENTS_ENABLED: "true", CRON_SECRET: "synthetic-cron", NEXT_PUBLIC_SUPABASE_URL: "https://storage.example", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service" };
  const response = await createEventMaintenanceHandler(async () => f.ports, () => env)(new Request("https://app.test/api/events/maintenance", { headers: { authorization: "Bearer synthetic-cron" } }));
  assert.equal(response.status, 200); assert.equal(verified, 1);
  assert.deepEqual(await response.json(), { expired: 2, job: "deleted", workerReady: true });
  assert.equal(health.ready, false); assert.equal(health.admissionPaused, true);
  assert(f.effects.includes("delete:image")); assert.deepEqual(f.finishes, ["complete"]);
});



test("kiosk source approval rejects changed bytes or geometry before derivative writes", async () => {
  const photo = new Uint8Array(await sharp({ create: { width: 20, height: 30, channels: 3, background: "#a94968" } }).jpeg().toBuffer());
  const approval = { sha256: createHash("sha256").update(photo).digest("hex"), bytes: photo.length, width: 20, height: 30, mime: "image/jpeg" };
  for (const change of [{ sha256: "a".repeat(64) }, { width: 21 }, { mime: "image/png" }]) {
    const f = await fixture(); f.objects.set("source", photo); f.setJob({ checkpoint: { sourceApproval: { ...approval, ...change } } });
    assert.equal((await processEventMaintenance(f.ports)).job, "failed"); assert(!f.effects.some(value => value.startsWith("write:")));
  }
  const f = await fixture(); f.objects.set("source", photo); f.setJob({ checkpoint: { sourceApproval: approval } });
  assert.equal((await processEventMaintenance(f.ports)).job, "ready");
  assert.equal(f.checkpoints.at(-1)?.sourceSha256, approval.sha256); assert.equal(f.checkpoints.at(-1)?.sourceWidth, 20); assert.equal(f.checkpoints.at(-1)?.sourceHeight, 30);
});
