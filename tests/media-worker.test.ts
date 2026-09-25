import assert from "node:assert/strict";
import test from "node:test";
import {
  executeMediaJob, MediaOperationError,
  type ArchiveProvider, type ArchiveReference, type LifecycleStrip, type MediaJob, type MediaWorkerStore,
} from "../lib/server/media-worker";

const OWNER = "11111111-1111-4111-8111-111111111111";
const STRIP = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const REFERENCE: ArchiveReference = {
  publicId: `zuychin-photobooth/${OWNER}/${STRIP}`,
  url: `https://res.cloudinary.com/fixture/image/upload/zuychin-photobooth/${OWNER}/${STRIP}.png`,
};

function fixture(kind: MediaJob["kind"] = "retention_archive", archived = false) {
  let row: LifecycleStrip | null = {
    id: STRIP, owner: OWNER, storage_path: `${OWNER}/${STRIP}.png`, kept: archived, purged: false,
    cloudinary_public_id: archived ? REFERENCE.publicId : null,
    cloudinary_url: archived ? REFERENCE.url : null,
  };
  let durable: MediaJob = {
    id: "44444444-4444-4444-8444-444444444444", owner: OWNER, kind, source_type: "strip", source_id: STRIP,
    snapshot: { ...row }, checkpoint: {}, stage: "queued", lease_token: "55555555-5555-4555-8555-555555555555", attempts: 1, max_attempts: 5,
  };
  let source = true;
  let cloud = archived;
  let verified = false;
  const events: string[] = [];
  const failures = new Map<string, number>();
  const step = (name: string) => {
    events.push(name);
    const remaining = failures.get(name) ?? 0;
    if (remaining) { failures.set(name, remaining - 1); throw new Error(`fixture ${name} failed`); }
  };
  const store: MediaWorkerStore = {
    async checkpoint(_job, stage, checkpoint) {
      step(`checkpoint:${stage}`);
      durable = { ...durable, stage, checkpoint: structuredClone(checkpoint) };
    },
    async finish(_job, outcome) { step(`finish:${outcome}`); },
    async readStrip() { step("readStrip"); return row ? { ...row } : null; },
    async persistArchive(_strip, reference) {
      step("persistArchive");
      assert.ok(row);
      row = { ...row, kept: true, cloudinary_public_id: reference.publicId, cloudinary_url: reference.url };
    },
    async markArchiveVerified() { step("markArchiveVerified"); verified = true; },
    async clearArchive() {
      step("clearArchive");
      assert.ok(row);
      row = { ...row, kept: false, cloudinary_public_id: null, cloudinary_url: null };
    },
    async markPurged() { step("markPurged"); assert.ok(row); row = { ...row, purged: true }; },
    async deleteStrip() { step("deleteStrip"); row = null; },
    async cleanupPaths() { step("cleanupPaths"); return [`${OWNER}/${STRIP}.png`]; },
    async sourceExists() { step("sourceExists"); return source; },
    async download() { step("download"); if (!source) throw new Error("fixture source missing"); return new Blob(["fixture photo"], { type: "image/png" }); },
    async removeStorage() { step("removeStorage"); source = false; },
  };
  const archive: ArchiveProvider = {
    configured: () => true,
    async upload() { step("upload"); cloud = true; return { ...REFERENCE }; },
    async verify() { step("verify"); return cloud; },
    async remove() { step("removeCloud"); cloud = false; },
  };
  return {
    store, archive, events,
    fail: (operation: string, count = 1) => failures.set(operation, count),
    run: () => executeMediaJob(structuredClone(durable), store, archive),
    get job() { return structuredClone(durable); },
    set job(value: MediaJob) { durable = structuredClone(value); },
    get row() { return row ? { ...row } : null; },
    set row(value: LifecycleStrip | null) { row = value ? { ...value } : null; },
    get source() { return source; },
    set source(value: boolean) { source = value; },
    get cloud() { return cloud; },
    get verified() { return verified; },
  };
}

test("archive failures retain the original and never mark it purged", async () => {
  for (const operation of ["upload", "persistArchive", "verify", "markArchiveVerified", "checkpoint:uploaded", "checkpoint:reference_verified"]) {
    const f = fixture();
    f.fail(operation);
    assert.equal((await f.run()).outcome, "retry", operation);
    assert.equal(f.source, true, operation);
    assert.equal(f.row?.purged, false, operation);
    assert.ok(!f.events.includes("removeStorage"), operation);
    assert.ok(!f.events.includes("markPurged"), operation);
    assert.ok(!f.events.includes("finish:complete"), operation);
  }
});

test("provider verification returning false preserves Storage despite a persisted reference", async () => {
  const f = fixture();
  f.archive.verify = async () => false;
  assert.deepEqual(await f.run(), { outcome: "retry", code: "archive_not_verified" });
  assert.equal(f.row?.cloudinary_public_id, REFERENCE.publicId);
  assert.equal(f.source, true);
  assert.equal(f.verified, false);
  assert.ok(!f.events.includes("removeStorage"));
});

test("a resolved archive write that did not persist cannot authorise original deletion", async () => {
  const f = fixture();
  f.store.persistArchive = async () => {};
  assert.deepEqual(await f.run(), { outcome: "retry", code: "archive_reference_not_durable" });
  assert.equal(f.source, true);
  assert.equal(f.row?.cloudinary_public_id, null);
  assert.ok(!f.events.includes("removeStorage"));
});

test("retention deletes source only after durable provider-verified reference and then marks purged", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { outcome: "complete" });
  assert.equal(f.source, false);
  assert.equal(f.cloud, true);
  assert.equal(f.verified, true);
  assert.equal(f.row?.purged, true);
  assert.equal(f.row?.cloudinary_url, REFERENCE.url);
  const at = (event: string) => f.events.indexOf(event);
  assert.ok(at("persistArchive") < at("verify"));
  assert.ok(at("verify") < at("markArchiveVerified"));
  assert.ok(at("markArchiveVerified") < at("removeStorage"));
  assert.ok(at("removeStorage") < at("markPurged"));
  assert.equal(f.job.checkpoint.archive_verified, true);
  assert.equal(f.job.checkpoint.cloudinary_public_id, REFERENCE.publicId);
});

test("Storage failure leaves an archived strip unpurged and retry reuses its archive", async () => {
  const f = fixture();
  f.fail("removeStorage");
  assert.equal((await f.run()).outcome, "retry");
  assert.equal(f.source, true);
  assert.equal(f.row?.purged, false);
  assert.equal(f.row?.cloudinary_public_id, REFERENCE.publicId);
  assert.ok(!f.events.includes("markPurged"));
  assert.equal((await f.run()).outcome, "complete");
  assert.equal(f.row?.purged, true);
  assert.equal(f.events.filter(event => event === "upload").length, 1);
});

test("a failed purged-row update retries safely after the original was already removed", async () => {
  const f = fixture();
  f.fail("markPurged");
  assert.equal((await f.run()).outcome, "retry");
  assert.equal(f.source, false);
  assert.equal(f.cloud, true);
  assert.equal(f.row?.purged, false);
  assert.equal((await f.run()).outcome, "complete");
  assert.equal(f.row?.purged, true);
  assert.equal(f.events.filter(event => event === "upload").length, 1);
});

test("explicit delete keeps its snapshot across database deletion failure and retries", async () => {
  const f = fixture("delete", true);
  const snapshot = f.job.snapshot;
  f.fail("deleteStrip");
  assert.equal((await f.run()).outcome, "retry");
  assert.equal(f.source, false);
  assert.equal(f.cloud, false);
  assert.ok(f.row);
  assert.deepEqual(f.job.snapshot, snapshot);
  assert.equal(f.job.checkpoint.cloudinary_removed, true);
  assert.equal((await f.run()).outcome, "complete");
  assert.equal(f.row, null);
  assert.deepEqual(f.job.snapshot, snapshot);
});

test("delete recovers from row-deletion checkpoint failure using its durable snapshot", async () => {
  const f = fixture("delete", true);
  f.fail("checkpoint:row_deleted");
  assert.equal((await f.run()).outcome, "retry");
  assert.equal(f.row, null);
  assert.equal(f.job.snapshot.cloudinary_public_id, REFERENCE.publicId);
  assert.equal((await f.run()).outcome, "complete");
  assert.equal(f.row, null);
});

test("cloud deletion failure preserves the database reference and prevents completion", async () => {
  for (const kind of ["delete", "release"] as const) {
    const f = fixture(kind, true);
    f.fail("removeCloud");
    assert.equal((await f.run()).outcome, "retry");
    assert.equal(f.cloud, true);
    assert.equal(f.row?.cloudinary_public_id, REFERENCE.publicId);
    assert.ok(!f.events.includes("deleteStrip"));
    assert.ok(!f.events.includes("clearArchive"));
    assert.ok(!f.events.includes("finish:complete"));
    assert.equal((await f.run()).outcome, "complete");
    assert.equal(f.cloud, false);
  }
});

test("release refuses the last copy when purged or when the source object is absent", async () => {
  for (const purged of [true, false]) {
    const f = fixture("release", true);
    f.row = { ...f.row!, purged };
    f.source = false;
    assert.deepEqual(await f.run(), { outcome: "failed", code: "archive_is_only_copy" });
    assert.equal(f.cloud, true);
    assert.equal(f.row?.cloudinary_public_id, REFERENCE.publicId);
    assert.ok(!f.events.includes("removeCloud"));
    assert.ok(!f.events.includes("clearArchive"));
  }
});

test("cross-owner snapshots and changed live identities cannot remove any objects", async () => {
  for (const change of ["snapshot", "live", "archive"] as const) {
    const f = fixture("delete", true);
    if (change === "snapshot") f.job = { ...f.job, snapshot: { ...f.job.snapshot, storage_path: `${OTHER}/${STRIP}.png` } };
    if (change === "live") f.row = { ...f.row!, owner: OTHER, storage_path: `${OTHER}/${STRIP}.png` };
    if (change === "archive") f.row = { ...f.row!, cloudinary_public_id: `zuychin-photobooth/${OTHER}/${STRIP}` };
    assert.equal((await f.run()).outcome, "failed");
    assert.equal(f.source, true);
    assert.equal(f.cloud, true);
    assert.ok(!f.events.includes("removeStorage"));
    assert.ok(!f.events.includes("removeCloud"));
    assert.ok(!f.events.includes("deleteStrip"));
  }
});

test("cleanup rejects cross-owner, traversal and oversized path batches", async () => {
  for (const paths of [[`${OTHER}/${STRIP}.png`], [`${OWNER}/../${OTHER}/image.png`], [`${OWNER}/sub\\image.png`], Array.from({ length: 9 }, (_, i) => `${OWNER}/${i}.png`)]) {
    const f = fixture("upload_cleanup");
    f.store.cleanupPaths = async () => paths;
    assert.deepEqual(await f.run(), { outcome: "failed", code: "invalid_cleanup_paths" });
    assert.equal(f.source, true);
    assert.ok(!f.events.includes("removeStorage"));
  }
});

test("a stale lease checkpoint aborts before provider or Storage work", async () => {
  for (const kind of ["archive", "retention_archive", "release", "delete", "relay_cleanup", "upload_cleanup"] as const) {
    const f = fixture(kind, true);
    f.store.checkpoint = async () => { throw new MediaOperationError("lease_lost", false); };
    assert.deepEqual(await f.run(), { outcome: "failed", code: "lease_lost" });
    assert.equal(f.source, true);
    assert.equal(f.cloud, true);
    assert.deepEqual(f.events, ["finish:failed"]);
  }
});

test("lease loss immediately before source removal leaves both copies intact", async () => {
  const f = fixture("retention_archive", true);
  const checkpoint = f.store.checkpoint;
  let verifiedCheckpoints = 0;
  f.store.checkpoint = async (job, stage, state) => {
    if (stage === "reference_verified" && ++verifiedCheckpoints === 2) throw new MediaOperationError("lease_lost", false);
    await checkpoint(job, stage, state);
  };
  assert.deepEqual(await f.run(), { outcome: "failed", code: "lease_lost" });
  assert.equal(f.source, true);
  assert.equal(f.cloud, true);
  assert.ok(!f.events.includes("removeStorage"));
});

test("manual keep persists a verified archive while retaining the active source", async () => {
  const f = fixture("archive");
  assert.deepEqual(await f.run(), { outcome: "complete" });
  assert.equal(f.source, true);
  assert.equal(f.cloud, true);
  assert.equal(f.verified, true);
  assert.equal(f.row?.kept, true);
  assert.equal(f.row?.purged, false);
  assert.ok(!f.events.includes("removeStorage"));
});

test("archive reference persistence failure leaves a durable uploaded-asset checkpoint for retry", async () => {
  const f = fixture();
  f.fail("persistArchive");
  assert.equal((await f.run()).outcome, "retry");
  assert.equal(f.cloud, true);
  assert.equal(f.source, true);
  assert.equal(f.row?.cloudinary_public_id, null);
  assert.equal(f.job.checkpoint.cloudinary_public_id, REFERENCE.publicId);
  assert.equal(f.job.checkpoint.cloudinary_url, REFERENCE.url);
  assert.equal((await f.run()).outcome, "complete");
  assert.equal(f.row?.cloudinary_public_id, REFERENCE.publicId);
  assert.equal(f.row?.purged, true);
});

test("invalid provider references cannot cause source deletion", async () => {
  for (const reference of [
    { ...REFERENCE, publicId: `zuychin-photobooth/${OTHER}/${STRIP}` },
    { ...REFERENCE, url: "http://res.cloudinary.com/fixture/image.png" },
    { ...REFERENCE, url: "https://user:password@res.cloudinary.com/fixture/image.png" },
    { ...REFERENCE, url: "not-a-url" },
  ]) {
    const f = fixture();
    f.archive.upload = async () => reference;
    assert.deepEqual(await f.run(), { outcome: "failed", code: "invalid_archive_reference" });
    assert.equal(f.source, true);
    assert.ok(!f.events.includes("removeStorage"));
  }
});

test("archive outage and exhausted retries preserve originals for operator recovery", async () => {
  const f = fixture();
  f.archive.configured = () => false;
  f.job = { ...f.job, attempts: 5, max_attempts: 5 };
  assert.deepEqual(await f.run(), { outcome: "failed", code: "archive_unavailable" });
  assert.equal(f.source, true);
  assert.equal(f.row?.purged, false);
  assert.ok(!f.events.includes("download"));
  assert.ok(!f.events.includes("removeStorage"));
});

test("provider verification receives the persisted URL and rejects a mismatched asset URL", async () => {
  const f = fixture("retention_archive", true);
  const foreignUrl = "https://res.cloudinary.com/fixture/image/upload/unrelated.png";
  f.row = { ...f.row!, cloudinary_url: foreignUrl };
  let inspected: string[] | undefined;
  f.archive.verify = async (publicId, url) => {
    inspected = [publicId, url];
    return publicId === REFERENCE.publicId && url === REFERENCE.url;
  };
  assert.deepEqual(await f.run(), { outcome: "retry", code: "archive_not_verified" });
  assert.deepEqual(inspected, [REFERENCE.publicId, foreignUrl]);
  assert.equal(f.source, true);
  assert.equal(f.cloud, true);
  assert.equal(f.verified, false);
  assert.ok(!f.events.includes("removeStorage"));
});
