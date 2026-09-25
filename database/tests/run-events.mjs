import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const container = process.env.PB_TEST_CONTAINER ?? "pb-v2-p1-postgres";
if (!/^pb-v2-[a-z0-9-]+$/.test(container)) throw new Error("Use a task-owned pb-v2-* container");
const database = `pb_v2_events_${Date.now()}`;
const docker = (args, input = "") => new Promise((resolve, reject) => {
  const child = spawn("docker", ["--context", "desktop-linux", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", value => { stdout += value; }); child.stderr.on("data", value => { stderr += value; }); child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end(input);
});
const sql = async (source, failure = false) => {
  const result = await docker(["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database], source);
  if (result.code && !failure) throw new Error(result.stderr); return result;
};
const q = value => `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${q(JSON.stringify(value))}::jsonb`;
const service = "SET ROLE service_role; SET request.jwt.claim.role='service_role'; ";
const call = async expression => JSON.parse((await sql(`${service} SELECT ${expression};`)).stdout.trim());
const denied = async (source, expected = /PB_EVENT_DENIED|permission denied/) => { const result = await sql(source, true); assert.notEqual(result.code, 0); assert.match(result.stderr, expected); };
const owner = randomUUID(), moderator = randomUUID(), foreign = randomUUID(), event = randomUUID(), otherEvent = randomUUID(), guest = randomUUID(), otherGuest = randomUUID();
const token = "a".repeat(64), otherToken = "b".repeat(64), invite = "c".repeat(64), readHash = "d".repeat(64);
const now = Date.now(), body = { title: "Disposable event", timezone: "Australia/Sydney", startsAt: new Date(now - 60000).toISOString(), closesAt: new Date(now + 86400000).toISOString(), expiresAt: new Date(now + 7 * 86400000).toISOString(), maxGuests: 25, maxContributions: 100, maxBytes: 20_500_000 };
const manage = (action, args = {}, actor = owner, id = event) => call(`public.pb_event_manage(${q(actor)},${q(id)},${q(action)},${json(args)})`);
const reservations = [];
const reserve = async (contributors = [guest], choices = { submission: true, gallery: true, wall: false }) => {
  const id = randomUUID(), request = randomUUID(), receipt = id.replaceAll("-", "").repeat(2);
  const expression = `public.pb_event_reserve(${q(event)},${q(token)},${q(id)},${q(request)},${q(receipt)},ARRAY[${contributors.map(q)}]::uuid[],${json(choices)})`;
  const result = await call(expression); const value = { id, request, receipt, expression, result }; reservations.push(value); return value;
};
const creation = await docker(["exec", container, "createdb", "-U", "postgres", database]); assert.equal(creation.code, 0, creation.stderr);
try {
  await sql(await readFile(new URL("./bootstrap.sql", import.meta.url), "utf8"));
  await sql("CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);");
  await sql("ALTER TABLE storage.objects ADD COLUMN user_metadata jsonb;");
  await sql((await readFile(new URL("../../supabase-setup.sql", import.meta.url), "utf8")).split("-- BEGIN PB_LIFECYCLE_V1")[0]);
  await sql(await readFile(new URL("../migrations/001_v2_lifecycle.sql", import.meta.url), "utf8"));
  await sql(await readFile(new URL("../migrations/003_v2_rooms.sql", import.meta.url), "utf8"));
  const migration = await readFile(new URL("../migrations/005_v2_events.sql", import.meta.url), "utf8"); await sql(migration); await sql(migration);
  assert.equal((await call("public.pb_event_capabilities()")).ready, false);
  await sql(`INSERT INTO auth.users(id,email) VALUES(${q(owner)},'owner@example.invalid'),(${q(moderator)},'mod@example.invalid'),(${q(foreign)},'foreign@example.invalid');`);
  await denied(`${service} SELECT public.pb_event_create(${q(owner)},${q(event)},${json(body)});`, /PB_EVENT_NOT_READY/);
  await call("public.pb_event_configure(100000000)"); await call(`public.pb_event_create(${q(owner)},${q(event)},${json(body)})`);
  await call(`public.pb_event_create(${q(owner)},${q(event)},${json(body)})`);
  await denied(`${service} SELECT public.pb_event_create(${q(owner)},${q(event)},${json({ ...body, title: "Changed request" })});`, /PB_EVENT_CONFLICT/);
  await manage("update", { ...body, title: "Edited event title" });
  assert.equal((await call(`public.pb_event_create(${q(owner)},${q(event)},${json({ ...body, startsAt: body.startsAt.replace("Z", "+00:00") })})`)).title, "Edited event title");
  await call(`public.pb_event_create(${q(foreign)},${q(otherEvent)},${json({ ...body, maxBytes: 4_100_000 })})`);
  for (const role of ["anon", "authenticated", "service_role"]) await denied(`SET ROLE ${role}; SELECT * FROM public.pb_event_submissions;`);
  await denied("SET ROLE authenticated; SET request.jwt.claim.role='authenticated'; SELECT public.pb_event_configure(1);");
  await denied(`${service} SELECT public.pb_event_manage(${q(foreign)},${q(event)},'open','{}');`);
  await manage("invite_moderator", { userId: moderator }); await manage("accept_moderator", {}, moderator);
  await denied(`${service} SELECT public.pb_event_manage(${q(moderator)},${q(event)},'delete','{}');`);
  await manage("open"); await manage("invite", { hash: invite, expiresAt: body.closesAt });
  await call(`public.pb_event_redeem(${q(event)},${q(invite)},${q(guest)},${q(token)})`); await call(`public.pb_event_redeem(${q(event)},${q(invite)},${q(otherGuest)},${q(otherToken)})`);
  await manage("rotate_invite", { hash: "f".repeat(64), expiresAt: body.closesAt });
  await denied(`${service} SELECT public.pb_event_redeem(${q(event)},${q(invite)},${q(randomUUID())},${q("1".repeat(64))});`);
  await call("public.pb_event_configure(28700000)");
  const eventRaces = await Promise.all(Array.from({ length: 8 }, () => sql(`${service} SELECT public.pb_event_create(${q(owner)},${q(randomUUID())},${json({ ...body, maxBytes: 4_100_000 })});`, true)));
  assert.equal(eventRaces.filter(result => result.code === 0).length, 1); for (const result of eventRaces.filter(result => result.code)) assert.match(result.stderr, /PB_EVENT_CAPACITY/);
  console.log("Rerunnable P1/P5/P7 schema, disabled-by-default budget, direct-role denial and moderator boundaries passed.");

  const first = await reserve([guest, otherGuest]), second = await reserve();
  assert.equal(first.result.state, "reserved"); assert.equal(first.result.stagingHeldBytes + first.result.derivativeHeldBytes, 4_100_000);
  assert.deepEqual(await call(first.expression), first.result);
  await denied(`${service} SELECT ${first.expression.replace('"gallery":true', '"gallery":false')};`, /PB_EVENT_CONFLICT/);
  await denied(`${service} SELECT public.pb_event_receipt(${q(event)},${q(first.receipt)},${q(second.id)});`);
  await denied(`${service} SELECT public.pb_event_receipt(${q(otherEvent)},${q(first.receipt)},${q(first.id)});`);
  await denied(`${service} SELECT public.pb_event_read_access(${q(event)},${q(token)},${q(first.id)},'receipt');`);
  await denied(`${service} SELECT public.pb_event_manage(${q(owner)},${q(event)},'update',${json({ ...body, expiresAt: new Date(now + 86400000).toISOString() })});`, /PB_EVENT_CONFLICT/);
  await denied(`${service} SELECT public.pb_event_authorise_upload(${q(event)},${q(token)},${q(first.id)});`);
  await call(`public.pb_event_consent(${q(event)},${q(otherToken)},${q(first.id)},${json({ submission: true, gallery: false, wall: false })})`);
  const upload = await call(`public.pb_event_authorise_upload(${q(event)},${q(token)},${q(first.id)})`);
  assert.equal(upload.overwrite, false); assert.equal(upload.maxBytes, 2_000_000); assert.equal(Date.parse(upload.authorisationUntil) - Date.parse(upload.mintBefore), 7_200_000); assert.equal(Date.parse(upload.cleanupAfter) - Date.parse(upload.authorisationUntil), 300_000);
  const queued = await call(`public.pb_event_enqueue_finalise(${q(event)},${q(token)},${q(first.id)})`); assert.equal(queued.state, "finalising"); assert.equal(queued.lease_token, undefined);
  const claimers = await Promise.all(Array.from({ length: 8 }, () => call("public.pb_event_claim_jobs(1)"))), jobs = claimers.flat(); assert.equal(jobs.length, 1); const job = jobs[0];
  await denied(`${service} SELECT public.pb_event_checkpoint_job(${q(job.id)},${q(randomUUID())},'{}');`, /PB_EVENT_LEASE/);
  await denied(`${service} SELECT public.pb_event_finish_job(${q(job.id)},${q(job.lease_token)},'complete');`, /PB_EVENT_NOT_READY/);
  const previousLease = job.lease_token;
  await sql(`UPDATE public.pb_event_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${q(job.id)};`);
  Object.assign(job, (await call("public.pb_event_claim_jobs(1)"))[0]); assert.notEqual(job.lease_token, previousLease);
  const putImage = (lease = job.lease_token) => `INSERT INTO storage.objects(bucket_id,name,metadata,user_metadata) VALUES('photobooth-events-v2',${q(`${event}/${first.id}/image`)},'{"size":1900000}',${json({ eventJobId: job.id, eventLease: lease })});`;
  await denied(putImage(previousLease));
  await denied(putImage(randomUUID()));
  await sql(putImage());
  await sql(`INSERT INTO storage.objects(bucket_id,name,metadata,user_metadata) VALUES('photobooth-events-v2',${q(`${event}/${first.id}/thumbnail`)},'{"size":50000}',${json({ eventJobId: job.id, eventLease: job.lease_token })});`);
  await sql("CREATE POLICY event_fixture_permissive ON storage.objects FOR SELECT TO authenticated USING(true);");
  assert.equal((await sql("SET ROLE authenticated; SELECT count(*) FROM storage.objects WHERE bucket_id='photobooth-events-v2';")).stdout.trim(), "0");
  await call(`public.pb_event_checkpoint_job(${q(job.id)},${q(job.lease_token)},${json({ decoded: true, objectsVerified: true, sha256: "e".repeat(64), mime: "image/jpeg", width: 1000, height: 1000 })})`);
  await call(`public.pb_event_finish_job(${q(job.id)},${q(job.lease_token)},'complete')`);
  await denied(`UPDATE storage.objects SET metadata='{"size":1}' WHERE bucket_id='photobooth-events-v2';`);
  assert.equal((await call(`public.pb_event_receipt(${q(event)},${q(first.receipt)},${q(first.id)})`)).state, "ready");
  assert.equal((await call(`public.pb_event_read_access(${q(event)},${q(first.receipt)},${q(first.id)},'receipt')`)).maxAgeSeconds, 300);
  await denied(`${service} SELECT public.pb_event_manage(${q(owner)},${q(event)},'publication',${json({ submissionId: first.id, destination: "gallery", state: "approved" })});`);
  await call(`public.pb_event_consent(${q(event)},${q(otherToken)},${q(first.id)},${json({ submission: true, gallery: true, wall: false })})`);
  await manage("publication", { submissionId: first.id, destination: "gallery", state: "approved" }, moderator);
  await manage("issue_read_token", { kind: "gallery", hash: readHash, expiresAt: body.expiresAt });
  await call(`public.pb_event_read_access(${q(event)},${q(readHash)},${q(first.id)},'gallery')`);
  await call(`public.pb_event_consent(${q(event)},${q(otherToken)},${q(first.id)},${json({ submission: true, gallery: false, wall: false })})`);
  await denied(`${service} SELECT public.pb_event_read_access(${q(event)},${q(readHash)},${q(first.id)},'gallery');`);
  await call(`public.pb_event_read_access(${q(event)},${q(first.receipt)},${q(first.id)},'receipt')`);
  console.log("Receipt-per-session isolation, immutable retention, issuance fence, independent contributor grants and 8-claimer lease race passed.");

  const races = await Promise.all(Array.from({ length: 12 }, () => {
    const id = randomUUID(); return sql(`${service} SELECT public.pb_event_reserve(${q(event)},${q(token)},${q(id)},${q(randomUUID())},${q(id.replaceAll("-", "").repeat(2))},ARRAY[${q(guest)}]::uuid[],'{"submission":true,"gallery":false,"wall":false}');`, true);
  })); assert.equal(races.filter(result => result.code === 0).length, 3); for (const failure of races.filter(result => result.code)) assert.match(failure.stderr, /PB_EVENT_CAPACITY/);
  const usage = await call(`public.pb_event_dashboard(${q(owner)},${q(event)})`); assert.equal(usage.usage.count, 5); assert.equal(usage.usage.bytes, 20_350_000);
  await manage("close"); await call(`public.pb_event_authorise_upload(${q(event)},${q(token)},${q(second.id)})`);
  await assert.rejects(reserve(), /PB_EVENT_EXPIRED/);
  await manage("remove_submission", { submissionId: first.id });
  await denied(putImage());
  const pending = await call(`public.pb_event_dashboard(${q(owner)},${q(event)})`); assert.equal(pending.usage.bytes, usage.usage.bytes); assert.equal(pending.usage.count, 5);
  const deletion = (await call("public.pb_event_claim_jobs(10)")).find(item => item.kind === "delete_delivery"); assert(deletion);
  await call(`public.pb_event_checkpoint_job(${q(deletion.id)},${q(deletion.lease_token)},'{"deleted":true}')`);
  await denied(`${service} SELECT public.pb_event_finish_job(${q(deletion.id)},${q(deletion.lease_token)},'complete');`, /PB_EVENT_NOT_READY/);
  await sql(`DELETE FROM storage.objects WHERE bucket_id='photobooth-events-v2' AND name IN(${q(`${event}/${first.id}/image`)},${q(`${event}/${first.id}/thumbnail`)});`);
  await call(`public.pb_event_finish_job(${q(deletion.id)},${q(deletion.lease_token)},'complete')`);
  assert.equal((await call(`public.pb_event_dashboard(${q(owner)},${q(event)})`)).usage.bytes, usage.usage.bytes - 1_950_000);
  await denied(putImage());
  assert(!(await call("public.pb_event_claim_jobs(10)")).some(item => item.kind === "delete_staging" && item.submission_id === first.id));
  await manage("revoke_guest", { guestId: guest }); await denied(`${service} SELECT public.pb_event_authorise_upload(${q(event)},${q(token)},${q(second.id)});`);
  await sql(migration);
  assert.equal((await call(`public.pb_event_dashboard(${q(owner)},${q(event)})`)).usage.bytes, usage.usage.bytes - 1_950_000);
  console.log("12 concurrent reservations admit exactly 3 remaining slots; closure grace, emergency revoke, deletion-confirmed bytes and populated rerun passed.");
  for (let pass = 0; pass < 6; pass++) {
    const pendingJobs = await call("public.pb_event_claim_jobs(10)");
    if (!pendingJobs.length) break;
    for (const item of pendingJobs) { await call(`public.pb_event_checkpoint_job(${q(item.id)},${q(item.lease_token)},'{"deleted":true}')`); await call(`public.pb_event_finish_job(${q(item.id)},${q(item.lease_token)},'complete')`); }
  }
  const staged = (await call(`public.pb_event_dashboard(${q(owner)},${q(event)})`)).usage; assert.equal(staged.bytes, 4_000_000); assert.equal(staged.count, 2);
  await sql(`UPDATE public.pb_event_upload_intents SET authorisation_until=clock_timestamp()-interval '301 seconds',cleanup_after=clock_timestamp()-interval '1 second' WHERE submission_id IN(${q(first.id)},${q(second.id)}); UPDATE public.pb_event_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE event_id=${q(event)} AND kind='delete_staging'; INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-event-images-staging-v2',${q(first.result.stagingPath)},'{"size":2000000}');`);
  const cleanupJobs = await call("public.pb_event_claim_jobs(10)"); assert.equal(cleanupJobs.length, 2);
  for (const item of cleanupJobs) {
    await call(`public.pb_event_checkpoint_job(${q(item.id)},${q(item.lease_token)},'{"deleted":true}')`);
    if (item.submission_id === first.id) {
      await denied(`${service} SELECT public.pb_event_finish_job(${q(item.id)},${q(item.lease_token)},'complete');`, /PB_EVENT_NOT_READY/);
      await sql(`DELETE FROM storage.objects WHERE bucket_id='photobooth-event-images-staging-v2' AND name=${q(first.result.stagingPath)};`);
    }
    await call(`public.pb_event_finish_job(${q(item.id)},${q(item.lease_token)},'complete')`);
  }
  const cleared = (await call(`public.pb_event_dashboard(${q(owner)},${q(event)})`)).usage; assert.equal(cleared.bytes, 0); assert.equal(cleared.count, 0);
  await sql(`UPDATE public.pb_events SET starts_at=starts_at-interval '8 days',contribution_closes_at=contribution_closes_at-interval '8 days',expires_at=expires_at-interval '8 days' WHERE id=${q(event)};`);
  await call("public.pb_event_sweep(25)"); assert.equal((await call("public.pb_event_capabilities()")).allocatedBytes, 8_200_000);
  await denied(`${service} SELECT public.pb_event_manage(${q(owner)},${q(event)},'update',${json(body)});`, /PB_EVENT_EXPIRED/);
  console.log("8 concurrent event allocations admit one; expiry plus confirmed cleanup releases the deployment allocation once, without resurrecting expired events.");
  console.log("Storage rows are metadata fixtures. No Storage upload API, token mint, codec, signed URL or hosted service was exercised.");
} finally {
  const result = await docker(["exec", container, "dropdb", "-U", "postgres", "--force", database]); if (result.code) throw new Error(`Fixture database cleanup failed: ${result.stderr}`);
}
