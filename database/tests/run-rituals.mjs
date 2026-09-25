import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const container = process.env.PB_TEST_CONTAINER ?? "pb-v2-p1-postgres";
if (!/^pb-v2-[a-z0-9-]+$/.test(container)) throw new Error("Use a task-owned pb-v2-* container");
const database = `pb_v2_rituals_${Date.now()}`;
const docker = (args, input = "") => new Promise((resolve, reject) => {
  const child = spawn("docker", ["--context", "desktop-linux", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", v => { stdout += v; }); child.stderr.on("data", v => { stderr += v; }); child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end(input);
});
const sql = async (source, failure = false) => { const r = await docker(["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database], source); if (r.code && !failure) throw new Error(r.stderr); return r; };
const q = value => `'${String(value).replaceAll("'", "''")}'`, json = value => `${q(JSON.stringify(value))}::jsonb`;
const service = "SET ROLE service_role; SET request.jwt.claim.role='service_role'; ";
const call = async expression => JSON.parse((await sql(`${service} SELECT ${expression};`)).stdout.trim());
const denied = async (expression, pattern = /PB_RITUAL_DENIED/) => { const r = await sql(`${service} SELECT ${expression};`, true); assert.notEqual(r.code, 0); assert.match(r.stderr, pattern); };
const [owner, guest, other] = Array.from({ length: 3 }, () => randomUUID()), couple = randomUUID(), crowded = randomUUID(), raceCouple = randomUUID(), legacy = randomUUID(), ritual = randomUUID();
const schedule = { version: 1, anchorDate: "2030-01-31", localTime: "09:00", timeZone: "Australia/Sydney", frequency: "monthly", interval: 1, invalidDate: "clamp", gap: "shift-forward", fold: "later", onceAt: null };
const proof = computedAt => ({ computedAt, occurrence: { cycle: 0, scheduledDate: "2030-01-31", localDate: "2030-01-31", localTime: "09:00", instant: "2030-01-30T22:00:00.000Z", adjustments: [] } });
const currentProof = async () => proof((await call(`public.pb_ritual_context(${q(owner)},${q(couple)},NULL)`)).now);
const save = (id, action, revision, body, next, c = couple, actor = owner, expected = "NULL", title = "Gentle photo date") => `public.pb_ritual_save(${q(actor)},${q(c)},${q(id)},${q(action)},${revision},${q(title)},${json(body)},${json(next)},${expected})`;
const action = (id, revision, kind, actor = owner, next = null, channels = null, c = couple) => `public.pb_ritual_action(${q(actor)},${q(c)},${q(id)},${revision},${q(kind)},${json(next)},${json(channels)})`;
const listing = (actor = owner, c = couple, after = null, limit = 20) => `public.pb_ritual_list(${q(actor)},${q(c)},${after ? q(after) : "NULL"},${limit})`;
const insertLegacy = (id, c = couple, actor = owner) => `INSERT INTO public.pb_photo_dates(id,couple_id,created_by,title,scheduled_at) VALUES(${q(id)},${q(c)},${q(actor)},'Legacy fixture','2030-01-01T00:00:00Z');`;
const authenticated = actor => `SET ROLE authenticated; SET request.jwt.claim.role='authenticated'; SET request.jwt.claim.sub=${q(actor)}; `;
const created = await docker(["exec", container, "createdb", "-U", "postgres", database]); assert.equal(created.code, 0, created.stderr);
try {
  await sql(await readFile(new URL("./bootstrap.sql", import.meta.url), "utf8"));
  await sql("CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);");
  await sql((await readFile(new URL("../../supabase-setup.sql", import.meta.url), "utf8")).split("-- BEGIN PB_LIFECYCLE_V1")[0]);
  for (const name of ["001_v2_lifecycle.sql", "002_v2_projects.sql"]) await sql(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  await sql(`INSERT INTO auth.users(id,email) VALUES ${[owner, guest, other].map((id, n) => `(${q(id)},'ritual-${n}@example.invalid')`).join(",")}; INSERT INTO public.pb_couples(id,member_a,member_b) VALUES ${[couple, crowded, raceCouple].map(id => `(${q(id)},${q(owner)},${q(guest)})`).join(",")}; ${insertLegacy(legacy)} ${Array.from({ length: 21 }, () => insertLegacy(randomUUID(), crowded)).join(" ")} ${Array.from({ length: 19 }, () => insertLegacy(randomUUID(), raceCouple)).join(" ")}`);
  const migration = await readFile(new URL("../migrations/009_v2_rituals.sql", import.meta.url), "utf8"); await sql(migration); await sql(migration);
  assert.deepEqual(await call("public.pb_ritual_capabilities()"), { ready: true, version: 1, maximumPerCouple: 20, pageMaximum: 20, proofSeconds: 30, deliveryVersion: 0 });
  const unchanged = (await call(listing())).items[0]; assert.equal(unchanged.legacy, true); assert.equal(unchanged.active, true); assert.equal(unchanged.schedule, null); assert.equal(unchanged.scheduledAt, "2030-01-01T00:00:00+00:00");
  const page = await call(listing(owner, crowded)); assert.equal(page.items.length, 20); assert.equal((await call(listing(owner, crowded, page.nextCursor))).items.length, 1);
  await denied(save(randomUUID(), "create", 0, schedule, await currentProof(), crowded), /PB_RITUAL_CAPACITY/);
  await call(action(page.items[0].id, 0, "delete", owner, null, null, crowded)); assert.equal((await call(listing(owner, crowded))).items.length, 20);
  assert.equal((await sql(`SELECT count(*) FROM public.pb_photo_dates WHERE id=${q(page.items[0].id)} AND ritual_deleted AND NOT active;`)).stdout.trim(), "1");
  const directForeign = await sql(`${authenticated(other)} ${insertLegacy(randomUUID(), couple, other)}`, true); assert.notEqual(directForeign.code, 0); assert.match(directForeign.stderr, /PB_RITUAL_DENIED/);
  const raceIds = [randomUUID(), randomUUID()];
  const raced = await Promise.all(raceIds.map(id => sql(`${authenticated(owner)} ${insertLegacy(id, raceCouple)}`, true)));
  assert.equal(raced.filter(r => r.code === 0).length, 1); assert.match(raced.find(r => r.code !== 0).stderr, /PB_RITUAL_CAPACITY/);
  assert.equal((await call(listing(owner, raceCouple))).items.length, 20);
  let row = await call(save(ritual, "create", 0, schedule, await currentProof())); assert.equal(row.active, false); assert.equal(row.enabled, true); assert.equal(row.revision, 0); assert.deepEqual(row.channels, { email: false, push: false });
  await sql(migration);
  assert.deepEqual(await call(save(ritual, "create", 0, schedule, proof("2000-01-01T00:00:00Z"))), row);
  await denied(save(ritual, "create", 0, { ...schedule, localTime: "10:00" }, await currentProof()), /PB_RITUAL_CONFLICT/);
  await denied(save(randomUUID(), "create", 0, schedule, proof("2000-01-01T00:00:00Z")), /PB_RITUAL_STALE_PROOF/);
  for (const bad of [{ ...schedule, frequency: "daily" }, { ...schedule, localTime: null }, { ...schedule, timeZone: "Mars/Olympus" }, { ...schedule, token: "not-allowed" }]) await denied(save(randomUUID(), "create", 0, bad, await currentProof()), /PB_RITUAL_INVALID/);
  for (const role of ["anon", "authenticated"]) { const r = await sql(`SET ROLE ${role}; SET request.jwt.claim.role='service_role'; SELECT ${listing()};`, true); assert.notEqual(r.code, 0); assert.match(r.stderr, /permission denied/); }
  await denied(listing(other));
  const hidden = await sql(`${authenticated(owner)} SELECT count(*) FROM public.pb_photo_dates WHERE id=${q(ritual)}; UPDATE public.pb_photo_dates SET active=true,ritual_version=NULL WHERE id=${q(ritual)}; DELETE FROM public.pb_photo_dates WHERE id=${q(ritual)};`); assert.equal(hidden.stdout.trim(), "0");
  const serviceWrite = await sql(`${service} UPDATE public.pb_photo_dates SET active=true WHERE id=${q(ritual)};`, true); assert.notEqual(serviceWrite.code, 0); assert.match(serviceWrite.stderr, /PB_RITUAL_DENIED/);
  const forged = await sql(`${authenticated(owner)} INSERT INTO public.pb_photo_dates(id,couple_id,created_by,title,scheduled_at,ritual_revision) VALUES(${q(randomUUID())},${q(couple)},${q(owner)},'Forged','2030-01-01',1);`, true); assert.notEqual(forged.code, 0);
  row = await call(action(ritual, 0, "channels", guest, null, { email: true, push: false })); assert.equal(row.revision, 1); assert.deepEqual(row.channels, { email: true, push: false });
  assert.deepEqual((await call(listing())).items.find(r => r.id === ritual).channels, { email: false, push: false });
  await denied(action(ritual, 1, "pause", guest)); await denied(action(ritual, 0, "pause"), /PB_RITUAL_CONFLICT/);
  const concurrent = await Promise.all(["pause", "pause"].map(kind => sql(`${service} SELECT ${action(ritual, 1, kind)};`, true))); assert.equal(concurrent.filter(r => r.code === 0).length, 1);
  const retained = (await call(listing())).items.find(r => r.id === ritual);
  if (retained) {
    assert.equal(retained.paused, true); assert.equal(retained.enabled, false);
    row = await call(action(ritual, 2, "resume", owner, await currentProof())); assert.equal(row.revision, 3); assert.equal(row.paused, false);
    const revised = { ...schedule, anchorDate: "2030-02-01", localTime: "10:00", timeZone: "UTC" }, revisedProof = { computedAt: (await currentProof()).computedAt, occurrence: { cycle: 0, scheduledDate: "2030-02-01", localDate: "2030-02-01", localTime: "10:00", instant: "2030-02-01T10:00:00.000Z", adjustments: [] } };
    row = await call(save(ritual, "edit", 3, revised, revisedProof)); assert.equal(row.revision, 4); assert.deepEqual(row.schedule, revised);
    assert.equal((await call(save(ritual, "create", 0, schedule, await currentProof()))).revision, 4);
    await call(action(ritual, 4, "delete"));
  }
  await denied(save(ritual, "create", 0, schedule, await currentProof()), /PB_RITUAL_CONFLICT/);
  await denied(save(legacy, "upgrade", 0, schedule, await currentProof(), couple, owner, q("2029-01-01")), /PB_RITUAL_CONFLICT/);
  row = await call(save(legacy, "upgrade", 0, schedule, await currentProof(), couple, owner, q("2030-01-01"))); assert.equal(row.legacy, false); assert.equal(row.active, false); assert.equal(row.revision, 1);
  await sql(`UPDATE public.pb_couples SET member_b=${q(other)} WHERE id=${q(couple)};`);
  await denied(listing(guest)); assert.equal((await call(listing(other))).items.length, 0); await denied(action(legacy, 1, "channels", other, null, { email: true, push: true }));
  await sql(`DELETE FROM public.pb_couples WHERE id=${q(couple)};`); await denied(listing());
  console.log("Ritual SQL passed: reruns, unchanged legacy rows, cap concurrency, service-only access, immutable scope/frozen recipients, direct-write fences, per-recipient consent, CAS concurrency, explicit upgrade/edit, rollback-worker exclusion and unpair denial.");
} finally { const dropped = await docker(["exec", container, "dropdb", "-U", "postgres", "--force", database]); assert.equal(dropped.code, 0, dropped.stderr); }
