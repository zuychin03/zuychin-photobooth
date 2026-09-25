import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const container = process.env.PB_TEST_CONTAINER ?? "pb-v2-p1-postgres";
if (!/^pb-v2-[a-z0-9-]+$/.test(container)) throw new Error("Use a task-owned container");
const database = `pb_v2_event_readiness_${Date.now()}`;
const docker = (args, input = "") => new Promise((resolve, reject) => {
  const child = spawn("docker", ["--context", "desktop-linux", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", v => { stdout += v; }); child.stderr.on("data", v => { stderr += v; }); child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end(input);
});
const sql = async (source, failure = false) => { const r = await docker(["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database], source); if (r.code && !failure) throw new Error(r.stderr); return r; };
const q = v => `'${String(v).replaceAll("'", "''")}'`, j = v => `${q(JSON.stringify(v))}::jsonb`, service = "SET ROLE service_role; SET request.jwt.claim.role='service_role'; ";
const call = async exp => JSON.parse((await sql(`${service} SELECT ${exp};`)).stdout.trim());
const deny = async (exp, pattern = /PB_EVENT_NOT_READY/) => { const r = await sql(exp, true); assert.notEqual(r.code, 0); assert.match(r.stderr, pattern); };
const owner = randomUUID(), events = [randomUUID(), randomUUID()], guests = [], now = Date.now();
const body = { title: "Worker readiness fixture", timezone: "Australia/Sydney", startsAt: new Date(now - 60000).toISOString(), closesAt: new Date(now + 86400000).toISOString(), expiresAt: new Date(now + 7 * 86400000).toISOString(), maxGuests: 25, maxContributions: 100, maxBytes: 100000000 };
const migration = () => readFile(new URL("../migrations/019_v2_event_worker_readiness.sql", import.meta.url), "utf8");
const reserve = g => `public.pb_event_reserve(${q(g.event)},${q(g.token)},${q(g.sub)},${q(g.request)},${q(g.receipt)},ARRAY[${q(g.id)}::uuid],'{"submission":true,"gallery":false,"wall":false}')`;
assert.equal((await docker(["exec", container, "createdb", "-U", "postgres", database])).code, 0);
try {
  await sql(await readFile(new URL("./bootstrap.sql", import.meta.url), "utf8"));
  await sql("CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); ALTER TABLE storage.objects ADD COLUMN user_metadata jsonb;");
  await sql((await readFile(new URL("../../supabase-setup.sql", import.meta.url), "utf8")).split("-- BEGIN PB_LIFECYCLE_V1")[0]);
  for (const name of ["001_v2_lifecycle.sql", "003_v2_rooms.sql", "005_v2_events.sql", "016_v2_event_transport.sql", "017_v2_event_host_settings.sql"]) await sql(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  await sql(await migration()); await sql(await migration());
  await sql(`INSERT INTO auth.users(id,email) VALUES(${q(owner)},'readiness@example.invalid');`);
  await call("public.pb_event_configure(1000000000)");
  for (const [n, event] of events.entries()) {
    await call(`public.pb_event_create(${q(owner)},${q(event)},${j(body)})`); await call(`public.pb_event_manage(${q(owner)},${q(event)},'open','{}')`);
    const invite = String(n + 1).repeat(64); await call(`public.pb_event_manage(${q(owner)},${q(event)},'invite',${j({ hash: invite, expiresAt: body.closesAt })})`);
    for (let i = 0; i < 3; i++) { const g = { event, id: randomUUID(), token: String(3 + n * 3 + i).repeat(64), receipt: (10 + n * 3 + i).toString(16).repeat(64), sub: randomUUID(), request: randomUUID() }; await call(`public.pb_event_redeem(${q(event)},${q(invite)},${q(g.id)},${q(g.token)})`); guests.push(g); }
  }
  assert.equal((await call("public.pb_event_worker_status()")).ready, false);
  await deny(`${service} SELECT ${reserve(guests[0])};`);
  for (const role of ["anon", "authenticated", "service_role"]) await deny(`SET ROLE ${role}; SELECT * FROM public.pb_event_worker_health;`, /permission denied/);
  await deny("SET ROLE authenticated; SET request.jwt.claim.role='authenticated'; SELECT public.pb_event_worker_verified();", /permission denied/);
  await deny(`${service} SELECT public.pb_event_reserve_before_worker_gate(${q(events[0])},${q(guests[0].token)},NULL,NULL,NULL,NULL,NULL);`, /permission denied/);
  assert.equal((await call("public.pb_event_worker_verified()")).ready, true);
  const races = await Promise.all(guests.map(g => sql(`${service} SELECT ${reserve(g)};`, true)));
  assert.equal(races.filter(r => r.code === 0).length, 2); for (const r of races.filter(r => r.code)) assert.match(r.stderr, /PB_EVENT_NOT_READY/);
  const accepted = guests.filter((_, i) => races[i].code === 0), rejected = guests.find((_, i) => races[i].code !== 0);
  assert.equal((await call("public.pb_event_worker_status()")).pending, 2);
  const a = accepted[0]; await call(`public.pb_event_authorise_upload(${q(a.event)},${q(a.token)},${q(a.sub)})`);
  const sameEventOther = guests.find(g => g.event === a.event && g.id !== a.id), foreignEvent = guests.find(g => g.event !== a.event);
  await deny(`${service} SELECT public.pb_event_authorise_upload(${q(a.event)},${q(sameEventOther.token)},${q(a.sub)});`, /PB_EVENT_DENIED/);
  await deny(`${service} SELECT public.pb_event_enqueue_finalise(${q(foreignEvent.event)},${q(foreignEvent.token)},${q(a.sub)});`, /PB_EVENT_DENIED/);
  await sql("UPDATE public.pb_event_worker_health SET verified_at=clock_timestamp()-interval '151 seconds';");
  assert.equal((await call(reserve(a))).submissionId, a.sub);
  await deny(`${service} SELECT ${reserve({ ...a, sub: randomUUID() })};`, /PB_EVENT_CONFLICT/);
  await deny(`${service} SELECT public.pb_event_authorise_upload(${q(a.event)},${q(a.token)},${q(a.sub)});`);
  await call(`public.pb_event_enqueue_finalise(${q(a.event)},${q(a.token)},${q(a.sub)})`);
  assert.equal((await call(`public.pb_event_receipt(${q(a.event)},${q(a.receipt)},${q(a.sub)})`)).state, "finalising");
  const cleanupSub = randomUUID();
  await sql(`INSERT INTO public.pb_event_submissions(id,event_id,guest_id,request_id,request_fingerprint,state,logical_expires_at,promised_expires_at,staging_path,delivery_path,thumbnail_path) VALUES(${q(cleanupSub)},${q(a.event)},${q(a.id)},gen_random_uuid(),'{}','deleted',clock_timestamp(),clock_timestamp(),${q(`${a.event}/${cleanupSub}/source`)},${q(`${a.event}/${cleanupSub}/image`)},${q(`${a.event}/${cleanupSub}/thumbnail`)}); INSERT INTO public.pb_event_jobs(event_id,submission_id,kind,available_at) VALUES(${q(a.event)},${q(cleanupSub)},'delete_delivery',clock_timestamp()-interval '1 day');`);
  const [finalise] = await call("public.pb_event_claim_jobs(1)"); assert.equal(finalise.kind, "finalise"); assert.equal(finalise.submission_id, a.sub);
  await sql(`INSERT INTO public.pb_event_jobs(event_id,submission_id,kind,available_at) VALUES(${q(a.event)},${q(a.sub)},'delete_delivery',clock_timestamp()-interval '1 day');`);
  const claims = await Promise.all([call("public.pb_event_claim_jobs(1)"), call("public.pb_event_claim_jobs(1)")]);
  const jobs = claims.flat(); assert.equal(jobs.length, 1); assert.equal(jobs[0].submission_id, cleanupSub);
  await deny(`${service} SELECT public.pb_event_checkpoint_job(${q(finalise.id)},${q(randomUUID())},'{}');`, /PB_EVENT_LEASE/);
  await call(`public.pb_event_checkpoint_job(${q(finalise.id)},${q(finalise.lease_token)},'{}')`);
  await call(`public.pb_event_manage(${q(owner)},${q(a.event)},'pause','{}')`);
  await call(`public.pb_event_checkpoint_job(${q(finalise.id)},${q(finalise.lease_token)},'{}')`);
  await sql(`UPDATE public.pb_event_submissions SET logical_expires_at=clock_timestamp()-interval '1 second' WHERE id=${q(a.sub)};`);
  await deny(`${service} SELECT public.pb_event_checkpoint_job(${q(finalise.id)},${q(finalise.lease_token)},'{}');`, /PB_EVENT_EXPIRED/);
  await sql("DELETE FROM public.pb_event_worker_health;"); await deny(`${service} SELECT public.pb_event_worker_verified();`); await deny(`${service} SELECT ${reserve(rejected)};`);
  await sql(await migration()); assert.equal((await call("public.pb_event_worker_status()")).ready, false);
  await call("public.pb_event_worker_verified()"); await call("public.pb_event_sweep(25)");
  assert.equal((await call("public.pb_event_worker_status()")).pending, 1);
  console.log("019 passed: empty/populated rerun, absent/stale/missing-row denial, six-way cross-event two-slot race, exact accepted retry, enqueue/read recovery, priority claims, lease isolation and unchanged expiry.");
} finally { const r = await docker(["exec", container, "dropdb", "--force", "-U", "postgres", database]); if (r.code) throw new Error(r.stderr); }
