import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const container = process.env.PB_TEST_CONTAINER ?? "pb-v2-p1-postgres";
if (!/^pb-v2-[a-z0-9-]+$/.test(container)) throw new Error("Use a task-owned test container");
const database = `pb_v2_memory_browse_${Date.now()}`;
const docker = (args, input = "") => new Promise((resolve, reject) => {
  const child = spawn("docker", ["--context", "desktop-linux", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", value => { stdout += value; }); child.stderr.on("data", value => { stderr += value; }); child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end(input);
});
const sql = async (source, failure = false) => { const result = await docker(["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database], source); if (result.code && !failure) throw new Error(result.stderr); return result; };
const q = value => `'${String(value).replaceAll("'", "''")}'`;
const service = "SET ROLE service_role; SET request.jwt.claim.role='service_role'; ";
const call = async expression => JSON.parse((await sql(`${service} SELECT ${expression};`)).stdout.trim());
const denied = async source => { const result = await sql(source, true); assert.notEqual(result.code, 0); assert.match(result.stderr, /PB_MEMORY_DENIED|PB_MEMORY_INVALID|permission denied/); };
const owner = randomUUID(), partner = randomUUID(), outsider = randomUUID(), couple = randomUUID(), chapter = randomUUID();
const times = ["2025-12-31T12:59:59.999999Z", "2025-12-31T13:00:00Z", "2026-01-01T00:00:00.123455Z", "2026-01-01T00:00:00.123456Z", "2026-01-01T00:00:00.123456Z", "2026-12-31T13:00:00Z"];
const strips = times.map(() => randomUUID());
const browse = (actor, after = null, filter = null, limit = 2) => `public.pb_memory_browse(${q(actor)},'2025-12-31T13:00:00Z','2026-12-31T13:00:00Z',${filter ? q(filter) : "NULL"},${after ? q(after.occurredAt) : "NULL"},${after ? q(after.id) : "NULL"},${limit})`;
const created = await docker(["exec", container, "createdb", "-U", "postgres", database]); if (created.code) throw new Error(created.stderr);
try {
  await sql(await readFile(new URL("./bootstrap.sql", import.meta.url), "utf8"));
  await sql("CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); ALTER TABLE storage.objects ADD COLUMN user_metadata jsonb;");
  await sql((await readFile(new URL("../../supabase-setup.sql", import.meta.url), "utf8")).split("-- BEGIN PB_LIFECYCLE_V1")[0]);
  await sql(`INSERT INTO auth.users(id,email) VALUES(${q(owner)},'owner@example.invalid'),(${q(partner)},'partner@example.invalid'),(${q(outsider)},'other@example.invalid'); INSERT INTO pb_couples(id,member_a,member_b) VALUES(${q(couple)},${q(owner)},${q(partner)});`);
  for (const [index, strip] of strips.entries()) await sql(`INSERT INTO pb_strips(id,owner,couple_id,storage_path,created_at) VALUES(${q(strip)},${q(owner)},${q(couple)},${q(`${owner}/${strip}.png`)},${q(times[index])});`);
  for (const name of ["001_v2_lifecycle.sql", "002_v2_projects.sql", "003_v2_rooms.sql", "004_v2_memories.sql", "005_v2_events.sql", "006_v2_activity.sql", "011_v2_retained_strip_reads.sql"]) await sql(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  const migration = await readFile(new URL("../migrations/013_v2_memory_browse.sql", import.meta.url), "utf8"); await sql(migration); await sql(migration);
  await call("public.pb_memory_backfill(25)");
  assert.equal((await call("public.pb_memory_browse_capabilities()")).version, 1);
  for (const role of ["anon", "authenticated"]) await denied(`SET ROLE ${role}; SET request.jwt.claim.role='service_role'; SELECT ${browse(owner)};`);
  await denied(`${service} SELECT public.pb_memory_browse(${q(owner)},now(),now()+interval '2 years');`);
  await denied(`${service} SELECT public.pb_memory_browse(${q(owner)},'2026-01-01','2027-01-01',NULL,NULL,${q(randomUUID())});`);
  const first = await call(browse(owner)), second = await call(browse(owner, first.nextCursor));
  assert.equal(first.items.length, 2); assert.equal(second.items.length, 2); assert.equal(second.nextCursor, null);
  assert.equal(first.items[0].occurredAt, "2026-01-01T00:00:00.123456+00:00"); assert.equal(first.items[1].occurredAt, first.items[0].occurredAt); assert(first.items[0].id > first.items[1].id);
  assert.equal(second.items[0].occurredAt, "2026-01-01T00:00:00.123455+00:00"); assert.equal(second.items[1].sourceId, strips[1]);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 4);
  assert.equal((await call(browse(partner, null, null, 50))).items.length, 4); assert.equal((await call(browse(outsider))).items.length, 0);
  await call(`public.pb_memory_chapter_put(${q(owner)},${q(chapter)},-1,'Our first day')`);
  await call(`public.pb_memory_annotate(${q(owner)},${q(first.items[0].id)},0,${q(chapter)},'New year')`);
  const labelled = await call(browse(owner, null, chapter)); assert.equal(labelled.items.length, 1); assert.equal(labelled.items[0].occasion, "New year");
  await denied(`${service} SELECT ${browse(partner, null, chapter)};`);
  assert.equal((await call(browse(partner))).items[0].occasion, undefined);
  await sql(`DELETE FROM pb_couples WHERE id=${q(couple)}; INSERT INTO pb_couples(id,member_a,member_b) VALUES(gen_random_uuid(),${q(owner)},${q(outsider)});`);
  assert.equal((await call(browse(partner))).items.length, 0); assert.equal((await call(browse(outsider))).items.length, 0); assert.equal((await call(browse(owner, null, null, 50))).items.length, 4);
  await sql(`UPDATE pb_strips SET purged=true WHERE id=${q(strips[2])};`);
  const lost = (await call(browse(owner, null, null, 50))).items.find(item => item.occurredAt === "2026-01-01T00:00:00.123455+00:00"); assert.equal(lost.availability, "access_lost"); assert.equal(lost.sourceId, undefined);
  await sql(migration); assert.equal((await call(browse(owner, null, chapter))).items.length, 1);
  console.log("Memory browse SQL passed: service-only access, civil-year boundaries, microsecond/tie pagination, personal chapters, unpair/re-pair privacy, minimal lost records and populated rerun.");
} finally {
  const removed = await docker(["exec", container, "dropdb", "-U", "postgres", "--force", database]); if (removed.code) throw new Error(removed.stderr);
}
