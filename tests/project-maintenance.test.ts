import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { PROJECT_BUCKET, type ProjectCleanupClaim, type ProjectFinalisationClaim, type ProjectFinalisationOutcome, type ProjectFinalisationStatus } from "../lib/projects/cloud-contract";
import { createProjectMaintenanceHandler, processProjectMaintenance, type ProjectMaintenancePorts } from "../lib/server/project-maintenance";
import { ImageFinaliseError } from "../lib/server/image-finalise";
import { ProjectObjectError } from "../lib/server/project-objects";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = Date.parse("2026-09-23T00:00:00Z"), until = new Date(now + 120_000).toISOString();
async function fixture() {
  const image = await sharp({ create: { width: 8, height: 6, channels: 3, background: "#de3456" } }).png().toBuffer();
  const claim: ProjectFinalisationClaim = { id: uuid(3), assetId: uuid(3), projectId: uuid(1), ownerId: uuid(2), requestId: uuid(4), kind: "photo", mime: "image/png", bytes: image.length, width: 8, height: 6, sha256: createHash("sha256").update(image).digest("hex"), protection: { kind: "none", id: null }, bucket: PROJECT_BUCKET, path: `${uuid(1)}/${uuid(2)}/${uuid(3)}`, reservedUntil: until, leaseToken: uuid(5), leaseUntil: until, attempts: 1 };
  const clean: ProjectCleanupClaim = { assetId: uuid(6), bucket: PROJECT_BUCKET, path: `${uuid(1)}/${uuid(2)}/${uuid(6)}`, leaseToken: uuid(7), leaseUntil: until, attempts: 1 };
  const finished: ProjectFinalisationOutcome[] = [], deleted: boolean[] = [], requested: string[] = [];
  const status = (outcome: ProjectFinalisationOutcome): ProjectFinalisationStatus => ({ assetId: claim.assetId, status: outcome.kind === "verified" ? "complete" : outcome.kind === "retry" ? "retry" : "failed", assetStatus: outcome.kind === "verified" ? "ready" : "reserved", failure: outcome.kind === "reject" ? "invalid_image" : null, attempts: 1, reservedUntil: until });
  const ports: ProjectMaintenancePorts = {
    now: () => now,
    store: { sweep: async limit => { assert.equal(limit, 25); return { expired: 2 }; }, claim: async () => claim, finish: async (value, outcome) => { assert.equal(value.leaseToken, claim.leaseToken); finished.push(outcome); return status(outcome); }, claimCleanup: async () => clean, finishCleanup: async (value, absent) => { assert.equal(value.leaseToken, clean.leaseToken); deleted.push(absent); return { complete: absent }; } },
    objects: { download: async value => { assert.equal(value.bytes, image.length); requested.push(value.path); return new Uint8Array(image); }, removeAndConfirmAbsent: async value => { requested.push(value.path); return true; } },
  };
  return { ports, claim, clean, image, finished, deleted, requested, status };
}

test("maintenance decodes actual immutable bytes and confirms deletion before releasing a reservation", async () => {
  const f = await fixture(), result = await processProjectMaintenance(f.ports);
  assert.deepEqual(result, { expired: 2, finalisation: "ready", cleanup: "complete" });
  assert.equal(f.finished.length, 1); assert.equal(f.finished[0].kind, "verified");
  if (f.finished[0].kind === "verified") assert.deepEqual(f.finished[0].verified, { mime: "image/png", bytes: f.image.length, width: 8, height: 6, sha256: f.claim.sha256, decoded: true });
  assert.deepEqual(f.deleted, [true]); assert.equal(f.requested.length, 2);
});

test("invalid images and oversized objects reject, while transient native/provider failures retry", async () => {
  for (const [error, expected] of [[new ImageFinaliseError("invalid_image"), "reject"], [new ImageFinaliseError("metadata_mismatch"), "reject"], [new ProjectObjectError("object_too_large"), "reject"], [new ImageFinaliseError("image_busy"), "retry"], [new ImageFinaliseError("image_timeout"), "retry"], [new ProjectObjectError("provider_failure"), "retry"]] as const) {
    const f = await fixture(); f.ports.objects.download = async () => { throw error; };
    await processProjectMaintenance(f.ports); assert.equal(f.finished[0].kind, expected);
  }
});

test("a valid image header with invalid compressed data never receives a decoded assertion", async () => {
  const f = await fixture(), damaged = Buffer.from(f.image); damaged[Math.floor(damaged.length / 2)] ^= 1;
  f.claim.sha256 = createHash("sha256").update(damaged).digest("hex");
  f.ports.objects.download = async () => new Uint8Array(damaged);
  const result = await processProjectMaintenance(f.ports);
  assert.equal(result.finalisation, "failed"); assert.deepEqual(f.finished, [{ kind: "reject" }]);
});

test("expired leases never start provider work or assert completion", async () => {
  const f = await fixture(); f.ports.now = () => now + 120_000;
  const result = await processProjectMaintenance(f.ports);
  assert.equal(result.finalisation, "retained"); assert.equal(result.cleanup, "retained");
  assert.deepEqual(f.requested, []); assert.deepEqual(f.finished, []); assert.deepEqual(f.deleted, []);
});

test("expiry during download and deletion retains charges instead of finishing a stale lease", async () => {
  const f = await fixture(); let clock = now; f.ports.now = () => clock;
  f.ports.objects.download = async () => { clock += 120_000; return new Uint8Array(f.image); };
  f.ports.objects.removeAndConfirmAbsent = async () => { clock += 120_000; return true; };
  const result = await processProjectMaintenance(f.ports);
  assert.equal(result.finalisation, "retained"); assert.equal(result.cleanup, "retained");
  assert.deepEqual(f.finished, []); assert.deepEqual(f.deleted, []);
});

test("provider uncertainty and still-present objects cannot be treated as confirmed absence", async () => {
  for (const throws of [false, true]) {
    const f = await fixture(); f.ports.store.claim = async () => null;
    f.ports.objects.removeAndConfirmAbsent = async () => { if (throws) throw new Error("provider unavailable"); return false; };
    const result = await processProjectMaintenance(f.ports);
    assert.equal(result.cleanup, "retry"); assert.deepEqual(f.deleted, [false]);
  }
});

test("lost finish acknowledgement is not retried or downgraded in the same worker run", async () => {
  const f = await fixture(); let calls = 0;
  f.ports.store.finish = async () => { calls++; throw new Error("acknowledgement lost"); };
  const result = await processProjectMaintenance(f.ports);
  assert.equal(result.finalisation, "retained"); assert.equal(calls, 1);
});

test("the eighth failed cleanup is reported as terminal and remains charged", async () => {
  const f = await fixture(); f.clean.attempts = 8;
  f.ports.store.claim = async () => null;
  f.ports.objects.removeAndConfirmAbsent = async () => false;
  const result = await processProjectMaintenance(f.ports);
  assert.equal(result.cleanup, "failed"); assert.deepEqual(f.deleted, [false]);
});

test("a membership or challenge race reported by the final transaction cannot become ready", async () => {
  const f = await fixture(); f.ports.store.finish = async () => ({ ...f.status({ kind: "reject" }), failure: "access_lost" });
  assert.equal((await processProjectMaintenance(f.ports)).finalisation, "failed");
});

test("aborted maintenance performs no provider, sweep or claim work", async () => {
  const f = await fixture(); let calls = 0;
  f.ports.store.sweep = async () => { calls++; return { expired: 0 }; };
  f.ports.store.claim = async () => { calls++; return f.claim; };
  const abort = new AbortController(); abort.abort();
  assert.deepEqual(await processProjectMaintenance(f.ports, abort.signal), { expired: null, finalisation: "retained", cleanup: "retained" });
  assert.equal(calls, 0); assert.deepEqual(f.requested, []);
});

test("maintenance authenticates by header, stays disabled by default and returns no capabilities", async () => {
  const f = await fixture(), env = { PB_CLOUD_PROJECTS_ENABLED: "true", NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key", CRON_SECRET: "test-secret" };
  let calls = 0; const make = async () => { calls++; return f.ports; };
  const handler = createProjectMaintenanceHandler(make, () => env);
  assert.equal((await handler(new Request("https://app.test/api/projects/maintenance"))).status, 401);
  assert.equal((await handler(new Request("https://app.test/api/projects/maintenance?secret=test-secret", { headers: { Authorization: "Bearer test-secret" } }))).status, 401);
  assert.equal(calls, 0);
  const response = await handler(new Request("https://app.test/api/projects/maintenance", { headers: { Authorization: "Bearer test-secret" } }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.text(); assert(!body.includes("service-key") && !body.includes("test-secret") && !body.includes(f.claim.path) && !body.includes(f.claim.leaseToken));
  const disabled = createProjectMaintenanceHandler(make, () => ({ ...env, PB_CLOUD_PROJECTS_ENABLED: "false" }));
  assert.equal((await disabled(new Request("https://app.test/api/projects/maintenance"))).status, 503);
  assert.equal(calls, 1);
});

test("overlapping invocations share no second set of in-process image allocations", async () => {
  const f = await fixture(); let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const handler = createProjectMaintenanceHandler(async () => { await wait; return f.ports; }, () => ({ PB_CLOUD_PROJECTS_ENABLED: "true", NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "key", CRON_SECRET: "test-secret" }));
  const request = () => new Request("https://app.test/api/projects/maintenance", { headers: { Authorization: "Bearer test-secret" } });
  const running = handler(request());
  assert.equal((await handler(request())).status, 409); release(); assert.equal((await running).status, 200);
});
