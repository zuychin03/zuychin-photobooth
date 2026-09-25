import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
const container = process.env.PB_TEST_CONTAINER ?? "pb-v2-p1-postgres";
if (!/^pb-v2-[a-z0-9-]+$/.test(container)) throw new Error("Use a task-owned pb-v2-* container");
const database = `pb_v2_projects_${Date.now()}`;
const docker = (args, input = "") => new Promise((resolve, reject) => {
  const child = spawn("docker", ["--context", "desktop-linux", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", value => { stdout += value; }); child.stderr.on("data", value => { stderr += value; }); child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end(input);
});
const sql = async (source, failure = false) => {
  const result = await docker(["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database], source);
  if (result.code && !failure) throw new Error(result.stderr); return result;
};
const q = value => `'${String(value).replaceAll("'", "''")}'`, json = value => `${q(JSON.stringify(value))}::jsonb`;
const service = "SET ROLE service_role; SET request.jwt.claim.role='service_role'; ";
const call = async expression => JSON.parse((await sql(`${service} SELECT ${expression};`)).stdout.trim());
const denied = async (source, expected = /PB_PROJECT_DENIED|permission denied/) => { const result = await sql(source, true); assert.notEqual(result.code, 0); assert.match(result.stderr, expected); };
const owner = randomUUID(), guest = randomUUID(), foreign = randomUUID(), project = randomUUID();
const body = () => ({ id: randomUUID(), requestId: randomUUID(), kind: "photo", mime: "image/png", bytes: 100, width: 20, height: 20, sha256: "a".repeat(64), protection: { kind: "none", id: null } });
const reserve = (input, actor = owner) => call(`public.pb_project_reserve(${q(actor)},${q(project)},${json(input)})`);
const create = (id = project, bytes = 52428800) => `public.pb_project_create(${q(owner)},${q(id)},'friend','Fixture scope',${bytes})`;
const member = (action, actor = owner, user = guest) => call(`public.pb_project_member(${q(actor)},${q(project)},${q(user)},${q(action)})`);
const creation = await docker(["exec", container, "createdb", "-U", "postgres", database]); assert.equal(creation.code, 0, creation.stderr);
try {
  await sql(await readFile(new URL("./bootstrap.sql", import.meta.url), "utf8"));
  await sql("CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);");
  const migration = await readFile(new URL("../migrations/002_v2_projects.sql", import.meta.url), "utf8"); await sql(migration); await sql(migration);
  await sql((await readFile(new URL("../../supabase-setup.sql", import.meta.url), "utf8")).split("-- BEGIN PB_LIFECYCLE_V1")[0]);
  await sql(await readFile(new URL("../migrations/001_v2_lifecycle.sql", import.meta.url), "utf8")); await sql(migration);
  assert.equal((await call("public.pb_project_capabilities()")).ready, false);
  await sql(`INSERT INTO auth.users(id,email) VALUES(${q(owner)},'owner@example.invalid'),(${q(guest)},'guest@example.invalid'),(${q(foreign)},'foreign@example.invalid');`);
  await denied(`${service} SELECT ${create()};`, /PB_PROJECT_NOT_READY/);
  await sql("DELETE FROM public.pb_project_configuration;");
  await denied(`${service} SELECT ${create()};`, /PB_PROJECT_NOT_READY/);
  await sql("INSERT INTO public.pb_project_configuration(singleton) VALUES(true);");
  await call("public.pb_project_configure(104857600)"); const created = await call(create()); assert.deepEqual(await call(create()), created);
  await sql(`INSERT INTO public.pb_couples(id,member_a,member_b) VALUES(${q(randomUUID())},${q(owner)},${q(foreign)});`);
  await denied(`${service} SELECT public.pb_project_view(${q(foreign)},${q(project)});`);
  for (const role of ["anon", "authenticated", "service_role"]) await denied(`SET ROLE ${role}; SELECT * FROM public.pb_project_assets;`);
  await denied("SET ROLE authenticated; SELECT public.pb_project_configure(1);");
  await denied(`${service} SELECT public.pb_project_member(${q(foreign)},${q(project)},${q(foreign)},'invite');`);
  await member("invite"); await assert.rejects(reserve(body(), guest), /PB_PROJECT_DENIED/); await member("accept", guest);
  const a = body(), saved = await reserve(a, guest); assert.deepEqual(await reserve(a, guest), saved);
  await assert.rejects(reserve({ ...a, bytes: 99 }, guest), /PB_PROJECT_CONFLICT/);
  await assert.rejects(reserve({ ...body(), protection: { kind: "challenge", id: randomUUID() } }), /PB_PROJECT_PROTECTED/);
  await assert.rejects(reserve({ ...body(), protection: { kind: "unknown", id: null } }), /PB_PROJECT_PROTECTED/);
  const upload = await call(`public.pb_project_authorise_upload(${q(guest)},${q(a.id)})`); assert.equal(upload.overwrite, false);
  assert.equal(Date.parse(upload.uploadUntil) - Date.parse(upload.mintBefore), 7200000);
  await sql(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-projects-v2',${q(saved.path)},'{"size":100}');`);
  const verified = { bytes: a.bytes, width: a.width, height: a.height, mime: a.mime, sha256: a.sha256, decoded: true };
  await denied(`${service} SELECT public.pb_project_finalise(${q(guest)},${q(a.id)},${json(verified)});`);
  await call(`public.pb_project_enqueue_finalisation(${q(guest)},${q(a.id)})`);
  const firstClaim = await call("public.pb_project_claim_finalisation()"); assert.equal(firstClaim.assetId, a.id);
  await denied(`${service} SELECT public.pb_project_finish_finalisation(${q(a.id)},${q(firstClaim.leaseToken)},'verified',${json({ ...verified, sha256: "b".repeat(64) })});`, /PB_PROJECT_INVALID/);
  await call(`public.pb_project_finish_finalisation(${q(a.id)},${q(firstClaim.leaseToken)},'verified',${json(verified)})`);
  await call(`public.pb_project_asset_access(${q(owner)},${q(a.id)})`);
  await denied(`UPDATE storage.objects SET metadata='{"size":99}' WHERE name=${q(saved.path)};`);
  await sql("CREATE POLICY fixture_permissive_storage ON storage.objects FOR ALL TO authenticated USING(true) WITH CHECK(true);");
  assert.equal((await sql("SET ROLE authenticated; SELECT count(*) FROM storage.objects WHERE bucket_id='photobooth-projects-v2';")).stdout.trim(), "0");
  await sql(`UPDATE public.pb_project_assets SET protection='challenge',protection_id=${q(randomUUID())} WHERE id=${q(a.id)};`);
  await denied(`${service} SELECT public.pb_project_asset_access(${q(owner)},${q(a.id)});`);
  assert.equal((await call(`public.pb_project_view(${q(owner)},${q(project)})`)).assets.length, 0);
  await call(`public.pb_project_asset_access(${q(guest)},${q(a.id)})`);
  await member("revoke"); await denied(`${service} SELECT public.pb_project_asset_access(${q(guest)},${q(a.id)});`);
  await assert.rejects(member("accept", guest), /PB_PROJECT_DENIED/); await assert.rejects(member("invite"), /PB_PROJECT_CONFLICT/);
  console.log("Empty/rerun migration, default-disabled quotas, invitation acceptance/revocation, protected author-only access and restrictive Storage policy passed.");

  const races = await Promise.all(Array.from({ length: 12 }, () => sql(`${service} SELECT public.pb_project_reserve(${q(owner)},${q(project)},${json(body())});`, true)));
  assert.equal(races.filter(r => !r.code).length, 4); for (const r of races.filter(r => r.code)) assert.match(r.stderr, /PB_PROJECT_CAPACITY/);
  assert.equal((await sql(`SELECT sum(held_bytes) FROM public.pb_project_assets WHERE project_id=${q(project)} AND NOT charge_released;`)).stdout.trim(), "41943140");
  const allocationRace = await Promise.all(Array.from({ length: 8 }, () => sql(`${service} SELECT ${create(randomUUID(), 52428800)};`, true)));
  assert.equal(allocationRace.filter(r => !r.code).length, 1);
  const deletion = await call(`public.pb_project_delete(${q(owner)},${q(project)})`); assert.equal(deletion.pending, true);
  assert.deepEqual(await call("public.pb_project_claim_cleanup()"), {});
  await sql(`UPDATE public.pb_project_assets SET cleanup_after=clock_timestamp()-interval '1 second' WHERE id=${q(a.id)}; UPDATE public.pb_project_cleanup SET available_at=clock_timestamp()-interval '1 second' WHERE asset_id=${q(a.id)};`);
  const jobs = await Promise.all(Array.from({ length: 8 }, () => call("public.pb_project_claim_cleanup()"))); const claimed = jobs.filter(j => j.asset_id); assert.equal(claimed.length, 1); const job = claimed[0];
  await denied(`${service} SELECT public.pb_project_finish_cleanup(${q(a.id)},${q(randomUUID())},true);`, /PB_PROJECT_LEASE/);
  await denied(`${service} SELECT public.pb_project_finish_cleanup(${q(a.id)},${q(job.lease_token)},true);`, /PB_PROJECT_NOT_READY/);
  await sql(`DELETE FROM storage.objects WHERE name=${q(saved.path)};`);
  await call(`public.pb_project_finish_cleanup(${q(a.id)},${q(job.lease_token)},true)`);
  assert.equal((await sql(`SELECT sum(held_bytes) FROM public.pb_project_assets WHERE project_id=${q(project)} AND NOT charge_released;`)).stdout.trim(), "41943040");
  assert.equal((await sql(`SELECT allocation_released FROM public.pb_projects WHERE id=${q(project)};`)).stdout.trim(), "f");
  await denied(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-projects-v2',${q(saved.path)},'{"size":100}');`);
  await sql(`UPDATE public.pb_project_assets SET cleanup_after=clock_timestamp()-interval '1 second' WHERE project_id=${q(project)}; UPDATE public.pb_project_cleanup SET available_at=clock_timestamp()-interval '1 second' WHERE status<>'complete';`);
  for (let index = 0; index < 4; index++) {
    const cleanup = await call("public.pb_project_claim_cleanup()"); assert(cleanup.asset_id);
    await call(`public.pb_project_finish_cleanup(${q(cleanup.asset_id)},${q(cleanup.lease_token)},true)`);
  }
  assert.equal((await sql(`SELECT allocation_released FROM public.pb_projects WHERE id=${q(project)};`)).stdout.trim(), "t");
  const replacement = randomUUID(); await call(create(replacement));
  const expiring = body(); await call(`public.pb_project_reserve(${q(owner)},${q(replacement)},${json(expiring)})`);
  await sql(`UPDATE public.pb_project_assets SET reserved_until=clock_timestamp()-interval '1 second' WHERE id=${q(expiring.id)};`);
  assert.equal((await call("public.pb_project_sweep(25)")).expired, 1);
  await denied(`${service} SELECT public.pb_project_authorise_upload(${q(owner)},${q(expiring.id)});`);
  assert.equal((await sql(`SELECT held_bytes||':'||charge_released FROM public.pb_project_assets WHERE id=${q(expiring.id)};`)).stdout.trim(), "10485760:false");
  await sql(`UPDATE public.pb_project_assets SET cleanup_after=clock_timestamp()-interval '1 second' WHERE id=${q(expiring.id)}; UPDATE public.pb_project_cleanup SET available_at=clock_timestamp()-interval '1 second' WHERE asset_id=${q(expiring.id)};`);
  for (let attempt = 1; attempt <= 8; attempt++) {
    const failed = await call("public.pb_project_claim_cleanup()"); assert.equal(failed.asset_id, expiring.id); assert.equal(failed.attempts, attempt);
    await call(`public.pb_project_finish_cleanup(${q(failed.asset_id)},${q(failed.lease_token)},${attempt % 2 ? "false" : "NULL"})`);
    await sql(`UPDATE public.pb_project_cleanup SET available_at=clock_timestamp()-interval '1 second' WHERE asset_id=${q(expiring.id)};`);
  }
  assert.deepEqual(await call("public.pb_project_claim_cleanup()"), {});
  assert.equal((await sql(`SELECT status||':'||attempts||':'||confirmed_absent FROM public.pb_project_cleanup WHERE asset_id=${q(expiring.id)};`)).stdout.trim(), "failed:8:false");
  assert.equal((await sql(`SELECT held_bytes||':'||charge_released FROM public.pb_project_assets WHERE id=${q(expiring.id)};`)).stdout.trim(), "10485760:false");
  await sql(`UPDATE public.pb_project_cleanup SET status='running',lease_token=${q(randomUUID())},lease_until=clock_timestamp()+interval '60 seconds' WHERE asset_id=${q(expiring.id)};`);
  assert.deepEqual(await call("public.pb_project_claim_cleanup()"), {});
  assert.equal((await sql(`SELECT status FROM public.pb_project_cleanup WHERE asset_id=${q(expiring.id)};`)).stdout.trim(), "running");
  await sql(`UPDATE public.pb_project_cleanup SET lease_until=clock_timestamp()-interval '1 second' WHERE asset_id=${q(expiring.id)};`);
  assert.deepEqual(await call("public.pb_project_claim_cleanup()"), {});
  assert.equal((await sql(`SELECT status FROM public.pb_project_cleanup WHERE asset_id=${q(expiring.id)};`)).stdout.trim(), "failed");
  await call("public.pb_project_configure(536870912)");
  const finalProject = randomUUID(); await call(create(finalProject));
  const pendingUpload = async (actor = owner) => {
    const input = body();
    const reserved = await call(`public.pb_project_reserve(${q(actor)},${q(finalProject)},${json(input)})`);
    await call(`public.pb_project_authorise_upload(${q(actor)},${q(input.id)})`);
    await sql(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-projects-v2',${q(reserved.path)},'{"size":100}');`);
    return { ...input, path: reserved.path, verified: { bytes: input.bytes, width: input.width, height: input.height, mime: input.mime, sha256: input.sha256, decoded: true } };
  };
  const enqueue = (asset, actor = owner) => call(`public.pb_project_enqueue_finalisation(${q(actor)},${q(asset.id)})`);
  const finish = (claim, outcome, verified = null) => call(`public.pb_project_finish_finalisation(${q(claim.assetId)},${q(claim.leaseToken)},${q(outcome)},${verified ? json(verified) : "NULL"})`);
  const one = await pendingUpload();
  await denied(`${service} SELECT public.pb_project_enqueue_finalisation(${q(foreign)},${q(one.id)});`);
  const enqueued = await Promise.all(Array.from({ length: 8 }, () => enqueue(one))); assert(enqueued.every(j => j.status === "queued"));
  const finalClaims = await Promise.all(Array.from({ length: 8 }, () => call("public.pb_project_claim_finalisation()")));
  const first = finalClaims.filter(j => j.assetId); assert.equal(first.length, 1); const old = first[0];
  assert.equal(old.path, one.path); assert.equal(old.ownerId, owner); assert.equal(old.sha256, one.sha256); assert(Date.parse(old.leaseUntil) <= Date.parse(old.reservedUntil));
  await denied(`UPDATE storage.objects SET metadata='{"size":99}' WHERE name=${q(one.path)};`);
  await sql(`UPDATE public.pb_project_finalisations SET lease_until=clock_timestamp()-interval '1 second' WHERE asset_id=${q(one.id)};`);
  const next = await call("public.pb_project_claim_finalisation()"); assert.notEqual(next.leaseToken, old.leaseToken); assert.equal(next.attempts, 2);
  await assert.rejects(finish(old, "verified", one.verified), /PB_PROJECT_LEASE/);
  assert.equal((await finish(next, "retry")).status, "retry");
  assert.equal((await sql(`SELECT held_bytes FROM public.pb_project_assets WHERE id=${q(one.id)};`)).stdout.trim(), "10485760");
  await sql(`UPDATE public.pb_project_finalisations SET available_at=clock_timestamp()-interval '1 second' WHERE asset_id=${q(one.id)};`);
  const third = await call("public.pb_project_claim_finalisation()");
  assert.equal((await finish(third, "verified", one.verified)).status, "complete");
  assert.equal((await enqueue(one)).status, "complete"); await assert.rejects(finish(third, "verified", one.verified), /PB_PROJECT_LEASE/);
  assert.equal((await sql(`SELECT held_bytes||':'||charge_released FROM public.pb_project_assets WHERE id=${q(one.id)};`)).stdout.trim(), "100:false");
  await denied(`UPDATE storage.objects SET metadata='{"size":100}' WHERE name=${q(one.path)};`);
  const exhausted = await pendingUpload(); await enqueue(exhausted);
  for (let attempt = 1; attempt <= 8; attempt++) {
    const claim = await call("public.pb_project_claim_finalisation()"); assert.equal(claim.attempts, attempt);
    if (attempt < 8) { await finish(claim, "retry"); await sql(`UPDATE public.pb_project_finalisations SET available_at=clock_timestamp()-interval '1 second' WHERE asset_id=${q(exhausted.id)};`); }
    else { assert.deepEqual(await call("public.pb_project_claim_finalisation()"), {}); await sql(`UPDATE public.pb_project_finalisations SET lease_until=clock_timestamp()-interval '1 second' WHERE asset_id=${q(exhausted.id)};`); }
  }
  assert.deepEqual(await call("public.pb_project_claim_finalisation()"), {}); assert.equal((await enqueue(exhausted)).status, "failed");
  assert.equal((await sql(`SELECT status||':'||attempts||':'||failure FROM public.pb_project_finalisations WHERE asset_id=${q(exhausted.id)};`)).stdout.trim(), "failed:8:attempts_exhausted");
  assert.equal((await sql(`SELECT held_bytes||':'||charge_released FROM public.pb_project_assets WHERE id=${q(exhausted.id)};`)).stdout.trim(), "10485760:false");
  const deadline = await pendingUpload(); await enqueue(deadline); const deadlineClaim = await call("public.pb_project_claim_finalisation()");
  await sql(`UPDATE public.pb_project_assets SET reserved_until=clock_timestamp()-interval '1 second' WHERE id=${q(deadline.id)};`);
  assert.equal((await finish(deadlineClaim, "verified", deadline.verified)).failure, "deadline"); await assert.rejects(enqueue(deadline), /PB_PROJECT_EXPIRED/);
  const rejected = await pendingUpload(); await enqueue(rejected); const rejectClaim = await call("public.pb_project_claim_finalisation()"); assert.equal((await finish(rejectClaim, "reject")).failure, "invalid_image");
  await call(`public.pb_project_member(${q(owner)},${q(finalProject)},${q(guest)},'invite')`); await call(`public.pb_project_member(${q(guest)},${q(finalProject)},${q(guest)},'accept')`);
  const revoked = await pendingUpload(guest); await enqueue(revoked, guest); const revokedClaim = await call("public.pb_project_claim_finalisation()");
  await call(`public.pb_project_member(${q(owner)},${q(finalProject)},${q(guest)},'revoke')`);
  assert.equal((await finish(revokedClaim, "verified", revoked.verified)).failure, "access_lost");
  await denied(`${service} SELECT public.pb_project_finalisation_status(${q(guest)},${q(revoked.id)});`);
  await denied(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-projects-v2',${q(revoked.path)},'{"size":100}');`);
  for (const role of ["anon", "authenticated", "service_role"]) await denied(`SET ROLE ${role}; SELECT * FROM public.pb_project_finalisations;`);
  console.log("Finalisation enqueue/claim concurrency, stale leases, immutable pending/ready objects, verified commit, deadline/revocation rejection and eight-attempt retained-charge failure passed.");
  assert.equal((await call("public.pb_project_capabilities()")).apiVersion, 1);
  for (const role of ["anon", "authenticated", "service_role"]) await denied(`SET ROLE ${role}; SELECT * FROM public.pb_project_rates;`);
  for (const role of ["anon", "authenticated"]) {
    await denied(`SET ROLE ${role}; SELECT public.pb_project_rate(${q(owner)},'read');`);
    await denied(`SET ROLE ${role}; SELECT public.pb_project_list(${q(owner)});`);
  }
  await denied(`${service} SELECT public.pb_project_rate(${q(randomUUID())},'read');`);
  await denied(`${service} SELECT public.pb_project_rate(${q(owner)},'unknown');`, /PB_PROJECT_INVALID/);
  assert.equal((await call(`public.pb_project_rate(${q(owner)},'upload')`)).allowed, true);
  // A fixed future window makes the concurrency boundary independent of the wall-clock minute.
  await sql(`UPDATE public.pb_project_rates SET minute_start=clock_timestamp()+interval '2 minutes',upload_count=10 WHERE actor_id=${q(owner)};`);
  const rates = await Promise.all(Array.from({ length: 8 }, () => call(`public.pb_project_rate(${q(owner)},'upload')`)));
  assert.equal(rates.filter(result => result.allowed).length, 2);
  assert(rates.filter(result => !result.allowed).every(result => result.retryAfterSeconds >= 1 && result.retryAfterSeconds <= 60));
  for (const operation of ["read", "write"]) assert.equal((await call(`public.pb_project_rate(${q(owner)},${q(operation)})`)).allowed, true);
  assert.equal((await call(`public.pb_project_rate(${q(guest)},'upload')`)).allowed, true);
  assert.equal((await sql(`SELECT read_count||':'||write_count||':'||upload_count FROM public.pb_project_rates WHERE actor_id=${q(owner)};`)).stdout.trim(), "1:1:12");
  await sql(`UPDATE public.pb_project_rates SET read_count=120,write_count=30 WHERE actor_id=${q(owner)};`);
  for (const operation of ["read", "write", "upload"]) assert.equal((await call(`public.pb_project_rate(${q(owner)},${q(operation)})`)).allowed, false);
  await sql(`UPDATE public.pb_project_rates SET minute_start=clock_timestamp()-interval '2 minutes' WHERE actor_id=${q(owner)};`);
  assert.equal((await call(`public.pb_project_rate(${q(owner)},'read')`)).allowed, true);
  assert.equal((await sql(`SELECT read_count||':'||write_count||':'||upload_count FROM public.pb_project_rates WHERE actor_id=${q(owner)};`)).stdout.trim(), "1:0:0");
  assert.equal((await sql("SELECT count(*) FROM public.pb_project_rates;")).stdout.trim(), "2");

  const inviter = randomUUID(), invitee = randomUUID(), outsider = randomUUID(), discoveries = Array.from({ length: 4 }, () => randomUUID()).sort();
  await sql(`INSERT INTO auth.users(id,email) VALUES(${q(inviter)},'inviter@example.invalid'),(${q(invitee)},'invitee@example.invalid'),(${q(outsider)},'outsider@example.invalid');`);
  await call("public.pb_project_configure(1073741824)");
  for (const id of discoveries) {
    await call(`public.pb_project_create(${q(inviter)},${q(id)},'friend','Discovery',10485760)`);
    await call(`public.pb_project_member(${q(inviter)},${q(id)},${q(invitee)},'invite')`);
  }
  await call(`public.pb_project_member(${q(invitee)},${q(discoveries[1])},${q(invitee)},'accept')`);
  await call(`public.pb_project_member(${q(inviter)},${q(discoveries[2])},${q(invitee)},'revoke')`);
  await call(`public.pb_project_delete(${q(inviter)},${q(discoveries[3])})`);
  await sql(`INSERT INTO public.pb_couples(id,member_a,member_b) VALUES(${q(randomUUID())},${q(inviter)},${q(outsider)});`);
  const firstPage = await call(`public.pb_project_list(${q(invitee)},NULL,1)`);
  assert.deepEqual(firstPage.projects.map(item => item.id), [discoveries[0]]); assert.equal(firstPage.nextCursor, discoveries[0]);
  assert.equal(firstPage.projects[0].membership, "invited");
  assert.deepEqual(Object.keys(firstPage.projects[0]).sort(), ["createdAt", "id", "kind", "membership", "ownerId", "title"].sort());
  await denied(`${service} SELECT public.pb_project_view(${q(invitee)},${q(discoveries[0])});`);
  const nextPage = await call(`public.pb_project_list(${q(invitee)},${q(firstPage.nextCursor)},1)`);
  assert.deepEqual(nextPage.projects.map(item => item.id), [discoveries[1]]); assert.equal(nextPage.projects[0].membership, "accepted"); assert.equal(nextPage.nextCursor, null);
  assert.deepEqual(await call(`public.pb_project_list(${q(outsider)})`), { projects: [], nextCursor: null });
  assert.equal((await call(`public.pb_project_list(${q(inviter)})`)).projects.length, 3);
  await denied(`${service} SELECT public.pb_project_list(${q(invitee)},NULL,51);`, /PB_PROJECT_INVALID/);
  await denied(`${service} SELECT public.pb_project_list(NULL);`);
  console.log("Durable rate concurrency/independent scopes/reset and minimal invitation/accepted keyset discovery with revocation, deletion and no couple inheritance passed.");
  await sql(migration);
  console.log("Concurrent 12-reservation and 8-allocation limits, 8-worker exclusive lease, confirmed deletion accounting, late upload rejection and populated rerun passed.");
  console.log("Local PostgreSQL metadata fixtures only; no hosted SQL, Storage API, signed-token mint, native codec or signed URL exercised.");
} finally {
  const result = await docker(["exec", container, "dropdb", "-U", "postgres", "--force", database]); if (result.code) throw new Error(result.stderr);
}
