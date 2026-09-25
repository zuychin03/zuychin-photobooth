import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { computeRitualProof, parseRitualRow } from "../../lib/memories/ritual-contract.ts";

const container = process.env.PB_TEST_CONTAINER ?? "pb-v2-p1-postgres";
if (!/^pb-v2-[a-z0-9-]+$/.test(container)) throw new Error("Use a task-owned pb-v2-* container");
const database = `pb_v2_ritual_delivery_${Date.now()}`;
const docker = (args, input = "") => new Promise((resolve, reject) => {
  const child = spawn("docker", ["--context", "desktop-linux", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", v => { stdout += v; }); child.stderr.on("data", v => { stderr += v; }); child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end(input);
});
const sql = async (source, failure = false) => { const r = await docker(["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database], source); if (r.code && !failure) throw new Error(r.stderr); return r; };
const q = value => `'${String(value).replaceAll("'", "''")}'`, json = value => `${q(JSON.stringify(value))}::jsonb`;
const service = "SET ROLE service_role; SET request.jwt.claim.role='service_role'; ";
const call = async expression => JSON.parse((await sql(`${service} SELECT coalesce(to_jsonb(${expression}),'null'::jsonb);`)).stdout.trim());
const denied = async expression => { const r = await sql(`${service} SELECT ${expression};`, true); assert.notEqual(r.code, 0); assert.match(r.stderr, /PB_RITUAL_FENCE|PB_RITUAL_UNCERTAIN|PB_RITUAL_DENIED/); };
const [owner, guest] = [randomUUID(), randomUUID()], couple = randomUUID(), secondCouple = randomUUID(), runToken = randomUUID(), pushId = randomUUID(), hash = "a".repeat(64);
const context = async (id, c = couple) => call(`public.pb_ritual_context(${q(owner)},${q(c)},${q(id)})`);
const action = async (id, revision, kind, actor = owner, channels = null, proof = null, c = couple) => call(`public.pb_ritual_action(${q(actor)},${q(c)},${q(id)},${revision},${q(kind)},${json(proof)},${json(channels)})`);
const claim = async token => call(`public.pb_ritual_claim(${q(runToken)},${q(token)})`);
const beginSql = (o, target = o.targets[0], digest = hash) => `public.pb_ritual_dispatch(${q(o.id)},${q(o.token)},${q(target.recipientId)},${q(target.channel)},${q(digest)})`;
const recordSql = (o, target = o.targets[0], outcome = "sent") => `public.pb_ritual_record(${q(o.id)},${q(o.token)},${q(target.recipientId)},${q(target.channel)},${q(outcome)})`;
const fail = async (o, uncertain = false) => call(`public.pb_ritual_fail(${q(o.id)},${q(o.token)},${uncertain})`);
const finish = async o => { const c = await call(`public.pb_ritual_finish_context(${q(o.id)},${q(o.token)})`); return call(`public.pb_ritual_finish(${q(o.id)},${q(o.token)},${json(computeRitualProof(c.schedule, c.now))})`); };
const retry = async o => sql(`UPDATE public.pb_ritual_occurrences SET retry_at=clock_timestamp()-interval '1 second',lease_until=clock_timestamp()-interval '1 second' WHERE id=${q(o.id)};`);
async function due({ email = true, push = false, partner = false, recurring = false, c = couple } = {}) {
  const now = (await call(`public.pb_ritual_context(${q(owner)},${q(c)},NULL)`)).now, id = randomUUID(), future = new Date(Date.parse(now) + 86400000).toISOString();
  const schedule = { version: 1, anchorDate: future.slice(0, 10), localTime: future.slice(11, 16), timeZone: "UTC", frequency: recurring ? "weekly" : "once", interval: 1, invalidDate: "clamp", gap: "shift-forward", fold: "later", onceAt: recurring ? null : future };
  await call(`public.pb_ritual_save(${q(owner)},${q(c)},${q(id)},'create',0,'Synthetic reminder',${json(schedule)},${json(computeRitualProof(schedule, now))},NULL)`);
  let revision = 0;
  if (email || push) { await action(id, revision++, "channels", owner, { email, push }, null, c); }
  if (partner) { await action(id, revision++, "channels", guest, { email: true, push: false }, null, c); }
  const past = new Date(Date.parse(now) - 60000).toISOString(), pastSchedule = { ...schedule, anchorDate: past.slice(0, 10), localTime: past.slice(11, 16), onceAt: recurring ? null : past };
  const occurrence = { cycle: 0, scheduledDate: past.slice(0, 10), localDate: past.slice(0, 10), localTime: past.slice(11, 16), instant: past, adjustments: [] };
  await sql(`${service} BEGIN; SELECT set_config('pb.ritual_write','on',true); UPDATE public.pb_photo_dates SET scheduled_at=${q(past)},ritual_schedule=${json(pastSchedule)},ritual_next=${json(occurrence)} WHERE id=${q(id)}; COMMIT;`);
  return { id, revision, past };
}
const created = await docker(["exec", container, "createdb", "-U", "postgres", database]); assert.equal(created.code, 0, created.stderr);
try {
  await sql(await readFile(new URL("./bootstrap.sql", import.meta.url), "utf8"));
  await sql("CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);");
  await sql((await readFile(new URL("../../supabase-setup.sql", import.meta.url), "utf8")).split("-- BEGIN PB_LIFECYCLE_V1")[0]);
  for (const name of ["001_v2_lifecycle.sql", "002_v2_projects.sql", "009_v2_rituals.sql"]) await sql(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  const migration = await readFile(new URL("../migrations/010_v2_ritual_delivery.sql", import.meta.url), "utf8"); await sql(migration); await sql(migration);
  assert.equal((await call("public.pb_ritual_capabilities()")).deliveryVersion, 1);
  await sql(`INSERT INTO auth.users(id,email) VALUES(${q(owner)},'owner@example.invalid'),(${q(guest)},'guest@example.invalid'); INSERT INTO public.pb_couples(id,member_a,member_b) VALUES(${q(couple)},${q(owner)},${q(guest)}),(${q(secondCouple)},${q(owner)},${q(guest)}); INSERT INTO public.pb_push_subscriptions(id,owner,endpoint,p256dh,auth) VALUES(${q(pushId)},${q(owner)},'https://fcm.googleapis.com/synthetic','fixture-key','fixture-auth');`);
  assert.equal(await call(`public.pb_acquire_job_lease('reminders',${q(runToken)},900)`), true);
  for (const role of ["anon", "authenticated"]) { const r = await sql(`SET ROLE ${role}; SET request.jwt.claim.role='service_role'; SELECT public.pb_ritual_claim(${q(runToken)},${q(randomUUID())});`, true); assert.notEqual(r.code, 0); assert.match(r.stderr, /permission denied/); }
  const direct = await sql("SET ROLE authenticated; SELECT * FROM public.pb_ritual_targets;", true); assert.notEqual(direct.code, 0);

  const first = await due({ partner: true }), claims = await Promise.all([claim(randomUUID()), claim(randomUUID())]); assert.equal(claims.filter(Boolean).length, 1); const o = claims.find(Boolean); assert.equal(o.targets.length, 2); assert(o.targets.every(t => t.channel === "email"));
  for (const target of o.targets) { assert.equal(await call(beginSql(o, target)), "send"); assert.equal(await call(recordSql(o, target)), true); assert.equal(await call(recordSql(o, target)), true); }
  await call(`public.pb_record_reminder_delivery(${q(first.id)},${q(o.scheduledAt)},'email')`);
  assert.equal((await sql(`SELECT count(*) FROM public.pb_reminder_deliveries WHERE date_id=${q(first.id)};`)).stdout.trim(), "3");
  assert.equal(await finish(o), true); const completed = parseRitualRow((await context(first.id)).row); assert.equal(completed.enabled, false); assert.equal(completed.active, false); assert.equal(completed.delivery.status, "idle"); await denied(recordSql(o)); assert.equal(await claim(randomUUID()), null);

  const retryDate = await due({ recurring: true }); let r = await claim(randomUUID()); assert.equal(await call(beginSql(r)), "send"); assert.equal(await fail(r), "retrying"); assert.equal((await context(retryDate.id)).row.scheduledAt, r.scheduledAt);
  await retry(r); const old = r; r = await claim(randomUUID()); assert.equal(r.id, old.id); assert.notEqual(r.token, old.token); await denied(beginSql(old)); assert.equal(await call(beginSql(r)), "send"); await call(recordSql(r)); await finish(r); assert(Date.parse((await context(retryDate.id)).row.scheduledAt) > Date.now());

  const paused = await due(); const p = await claim(randomUUID());
  const pauseRace = await Promise.all([sql(`${service} SELECT ${beginSql(p)};`, true), action(paused.id, paused.revision, "pause")]); assert.equal(pauseRace[1].paused, true); await denied(recordSql(p)); assert.equal((await context(paused.id)).row.scheduledAt, p.scheduledAt);
  const beforeResume = await context(paused.id); await action(paused.id, beforeResume.row.revision, "resume", owner, null, computeRitualProof(beforeResume.row.schedule, beforeResume.now)); assert.equal((await context(paused.id)).row.enabled, false);

  const limited = await due(); let bounded;
  for (let attempt = 1; attempt <= 5; attempt++) { bounded = await claim(randomUUID()); assert.equal(bounded.dateId, limited.id); assert.equal(await fail(bounded), attempt === 5 ? "failed" : "retrying"); if (attempt < 5) await retry(bounded); }
  const failed = parseRitualRow((await context(limited.id)).row); assert.equal(failed.enabled, false); assert.equal(failed.delivery.status, "failed"); assert.equal(failed.delivery.attempts, 5); assert.equal(failed.scheduledAt, new Date(limited.past).toISOString()); assert.equal(await claim(randomUUID()), null);

  const ambiguousFinal = await due(); let lastEmail;
  for (let attempt = 1; attempt <= 5; attempt++) { lastEmail = await claim(randomUUID()); assert.equal(lastEmail.dateId, ambiguousFinal.id); assert.equal(await call(beginSql(lastEmail)), "send"); assert.equal(await fail(lastEmail), attempt === 5 ? "uncertain" : "retrying"); if (attempt < 5) await retry(lastEmail); }
  assert.equal((await context(ambiguousFinal.id)).row.delivery.status, "uncertain"); assert.equal((await context(ambiguousFinal.id)).row.scheduledAt, lastEmail.scheduledAt); await denied(recordSql(lastEmail));

  const exhausted = await due(); let abandoned;
  for (let attempt = 1; attempt <= 5; attempt++) { abandoned = await claim(randomUUID()); if (attempt < 5) await fail(abandoned); else await call(beginSql(abandoned)); await retry(abandoned); }
  const terminalClaim = await claim(randomUUID()); assert.equal(terminalClaim.dateId, exhausted.id); assert.equal(terminalClaim.terminal, true); assert.deepEqual(terminalClaim.targets, []); assert.equal((await context(exhausted.id)).row.delivery.status, "uncertain"); assert.equal(await claim(randomUUID()), null);

  const pushDate = await due({ email: false, push: true }); const push = await claim(randomUUID()); assert.equal(await call(beginSql(push)), "send"); await retry(push); const pushRetry = await claim(randomUUID()); assert.equal(await call(beginSql(pushRetry)), "uncertain"); assert.equal(await fail(pushRetry, true), "uncertain"); assert.equal(parseRitualRow((await context(pushDate.id)).row).delivery.status, "uncertain"); await denied(recordSql(push));

  const oldEmail = await due(); const email = await claim(randomUUID()); await call(beginSql(email)); await sql(`UPDATE public.pb_ritual_targets SET first_started_at=clock_timestamp()-interval '24 hours' WHERE occurrence_id=${q(email.id)};`); assert.equal(await fail(email), "uncertain"); assert.equal((await context(oldEmail.id)).row.enabled, false);

  const changed = await due(); const changedClaim = await claim(randomUUID()); await call(beginSql(changedClaim)); await action(changed.id, changed.revision, "channels", owner, { email: false, push: false });
  const changedRow = parseRitualRow((await context(changed.id)).row); assert.equal(changedRow.enabled, false); assert.equal(changedRow.delivery.status, "uncertain"); await denied(recordSql(changedClaim)); assert.equal(await claim(randomUUID()), null);
  assert.equal((await sql(`SELECT uncertain FROM public.pb_ritual_occurrences WHERE id=${q(changedClaim.id)};`)).stdout.trim(), "t");

  const disappeared = await due({ email: false, push: true }); const lostPush = await claim(randomUUID()); assert.equal(await call(beginSql(lostPush)), "send"); await retry(lostPush);
  await sql(`DELETE FROM public.pb_push_subscriptions WHERE id=${q(pushId)};`); const lostRetry = await claim(randomUUID()); assert.equal(await call(beginSql(lostRetry)), "uncertain"); assert.equal(await fail(lostRetry, true), "uncertain"); assert.equal((await context(disappeared.id)).row.delivery.status, "uncertain");
  await sql(`INSERT INTO public.pb_push_subscriptions(id,owner,endpoint,p256dh,auth) VALUES(${q(pushId)},${q(owner)},'https://fcm.googleapis.com/synthetic','fixture-key','fixture-auth');`);
  const goneDate = await due({ email: false, push: true }); const gone = await claim(randomUUID()); await sql(`DELETE FROM public.pb_push_subscriptions WHERE id=${q(pushId)};`); assert.equal(await call(beginSql(gone)), "gone"); await finish(gone); assert.equal((await context(goneDate.id)).row.enabled, false);
  const empty = await due({ email: false }); const noTargets = await claim(randomUUID()); assert.equal(noTargets.dateId, empty.id); assert.deepEqual(noTargets.targets, []); await finish(noTargets);

  const unpaired = await due({ c: secondCouple }); const u = await claim(randomUUID()); await call(beginSql(u)); await sql(`DELETE FROM public.pb_couples WHERE id=${q(secondCouple)};`); await denied(recordSql(u)); assert.equal(await fail(u), "stale"); assert.equal((await sql(`SELECT count(*) FROM public.pb_ritual_occurrences WHERE date_id=${q(unpaired.id)};`)).stdout.trim(), "0");

  const compactDate = await due({ email: false }); const compact = await claim(randomUUID()); await finish(compact);
  await sql(`INSERT INTO public.pb_ritual_occurrences(date_id,revision,cycle,scheduled_at,status,terminal_at) SELECT ${q(compactDate.id)},1000+n,0,timestamptz '1970-01-01 UTC'+n*interval '1 month','completed',clock_timestamp()-interval '1 day'-n*interval '1 second' FROM generate_series(0,299) n;
    INSERT INTO public.pb_ritual_targets(occurrence_id,recipient_id,channel,target,state) SELECT id,${q(owner)},'email','{"email":"fixture@example.invalid"}','delivered' FROM public.pb_ritual_occurrences WHERE date_id=${q(compactDate.id)} AND revision>=1000;
    INSERT INTO public.pb_reminder_deliveries(date_id,scheduled_at,channel,ritual_revision,recipient_id,occurrence_id) SELECT date_id,scheduled_at,'email',revision,${q(owner)},id FROM public.pb_ritual_occurrences WHERE date_id=${q(compactDate.id)} AND revision>=1000;
    SELECT public.pb_ritual_compact(${q(compactDate.id)});`);
  assert.equal((await sql(`SELECT count(*) FROM public.pb_ritual_occurrences WHERE date_id=${q(compactDate.id)};`)).stdout.trim(), "100");
  assert.equal((await sql(`SELECT count(*) FROM public.pb_ritual_months WHERE date_id=${q(compactDate.id)};`)).stdout.trim(), "121");
  assert.equal((await sql(`SELECT sum(completed) FROM public.pb_ritual_months WHERE date_id=${q(compactDate.id)};`)).stdout.trim(), "201");
  assert.equal((await sql(`SELECT count(*) FROM public.pb_reminder_deliveries WHERE date_id=${q(compactDate.id)};`)).stdout.trim(), "99");
  assert.equal(await claim(randomUUID()), null); await denied(recordSql(compact, { recipientId: owner, channel: "email" })); await sql(migration);
  console.log("Ritual delivery SQL passed: concurrent exclusive claims, recipient-isolated checkpoints, stale leases, pause/send race, retry acknowledgement, five-attempt terminal, push/email uncertainty, changed consent, unpair, 100-occurrence/121-counter compaction, no cursor replay and populated reruns.");
} finally { const dropped = await docker(["exec", container, "dropdb", "-U", "postgres", "--force", database]); assert.equal(dropped.code, 0, dropped.stderr); }
