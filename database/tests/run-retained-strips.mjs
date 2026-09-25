import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
const container = process.env.PB_TEST_CONTAINER ?? "pb-v2-p1-postgres";
if (!/^pb-v2-[a-z0-9-]+$/.test(container)) throw new Error("Use a task-owned test container");
const database = `pb_v2_retained_${Date.now()}`;
const docker = (args, input = "") => new Promise((resolve, reject) => {
  const child = spawn("docker", ["--context", "desktop-linux", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; }); child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end(input);
});
const sql = async (source, failure = false) => { const result = await docker(["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database], source); if (result.code && !failure) throw new Error(result.stderr); return result; };
const q = value => `'${String(value).replaceAll("'", "''")}'`, service = "SET ROLE service_role; SET request.jwt.claim.role='service_role'; ";
const call = async expression => JSON.parse((await sql(`${service} SELECT ${expression};`)).stdout.trim());
const denied = async (expression, pattern = /PB_RETAINED_DENIED|PB_RETAINED_UNAVAILABLE/) => { const result = await sql(`${service} SELECT ${expression};`, true); assert.notEqual(result.code, 0); assert.match(result.stderr, pattern); };
const owner = randomUUID(), partner = randomUUID(), newcomer = randomUUID(), couple = randomUUID(), nextCouple = randomUUID();
const source = randomUUID(), purged = randomUUID(), unknown = randomUUID(), deleted = randomUUID(), pendingDelete = randomUUID(), malformed = randomUUID();
const resolve = (actor, id) => `public.pb_retained_strip_read(${q(actor)},${q(id)})`;
const listing = actor => call(`public.pb_memory_list(${q(actor)},NULL,50)`);
const created = await docker(["exec", container, "createdb", "-U", "postgres", database]); assert.equal(created.code, 0, created.stderr);
try {
  await sql(await readFile(new URL("./bootstrap.sql", import.meta.url), "utf8"));
  await sql("CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); ALTER TABLE storage.objects ADD COLUMN user_metadata jsonb;");
  await sql((await readFile(new URL("../../supabase-setup.sql", import.meta.url), "utf8")).split("-- BEGIN PB_LIFECYCLE_V1")[0]);
  await sql(`INSERT INTO auth.users(id,email) VALUES(${q(owner)},'owner@example.invalid'),(${q(partner)},'partner@example.invalid'),(${q(newcomer)},'new@example.invalid'); INSERT INTO pb_couples(id,member_a,member_b) VALUES(${q(couple)},${q(owner)},${q(partner)});`);
  for (const id of [source, purged, unknown, deleted, pendingDelete, malformed]) await sql(`INSERT INTO pb_strips(id,owner,couple_id,storage_path,created_at) VALUES(${q(id)},${q(owner)},${q(couple)},${q(id === malformed ? "unsupported-historical-path" : `${owner}/${id}.png`)},'2020-01-01T00:00:00Z');`);
  for (const name of ["001_v2_lifecycle.sql", "002_v2_projects.sql", "003_v2_rooms.sql", "004_v2_memories.sql", "005_v2_events.sql", "006_v2_activity.sql"]) await sql(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  const migration = await readFile(new URL("../migrations/011_v2_retained_strip_reads.sql", import.meta.url), "utf8"); await sql(migration); await sql(migration);
  assert.equal((await call("public.pb_retained_strip_capabilities()")).ready, false); await call("public.pb_configure_lifecycle('UTC')");
  await call("public.pb_memory_backfill(25)");
  for (const role of ["anon", "authenticated"]) { const result = await sql(`SET ROLE ${role}; SET request.jwt.claim.role='service_role'; SELECT ${resolve(owner, source)};`, true); assert.notEqual(result.code, 0); assert.match(result.stderr, /permission denied/); }
  assert.equal((await call("public.pb_retained_strip_capabilities()")).version, 1);
  assert.equal((await call(resolve(owner, source))).storagePath, `${owner}/${source}.png`); assert.equal((await call(resolve(partner, source))).availability, "available"); await denied(resolve(newcomer, source)); await denied(resolve(owner, randomUUID())); await denied(resolve(owner, malformed));
  await sql(`UPDATE pb_strips SET kept=true WHERE id=${q(source)};`); assert.equal((await call(resolve(owner, source))).availability, "archive_pending");
  const publicId = `zuychin-photobooth/${owner}/${source}`, url = `https://res.cloudinary.com/fixture/image/authenticated/v1/${publicId}.png`;
  await sql(`UPDATE pb_strips SET purged=true,cloudinary_public_id=${q(publicId)},cloudinary_url=${q(url)} WHERE id=${q(source)};`); await denied(resolve(owner, source));
  await sql(`UPDATE pb_strips SET archive_verified_at=clock_timestamp() WHERE id=${q(source)};`); const archived = await call(resolve(owner, source)); assert.equal(archived.availability, "archived"); assert.equal(archived.archive.publicId, publicId);
  await sql(`UPDATE pb_strips SET purged=true WHERE id=${q(purged)}; UPDATE pb_strips SET purged=true,cloudinary_public_id='unproven' WHERE id=${q(unknown)}; DELETE FROM pb_strips WHERE id=${q(deleted)}; INSERT INTO pb_media_jobs(kind,source_type,source_id,owner,idempotency_key,snapshot) VALUES('delete','strip',${q(pendingDelete)},${q(owner)},'fixture-delete','{}');`);
  for (const id of [purged, unknown, deleted, pendingDelete]) await denied(resolve(owner, id));
  const charges = (await sql(`SELECT count(*),sum(charged_bytes) FROM pb_strip_quota_ledger;`)).stdout.trim();
  await sql(`DELETE FROM pb_couples WHERE id=${q(couple)}; INSERT INTO pb_couples(id,member_a,member_b) VALUES(${q(nextCouple)},${q(owner)},${q(newcomer)});`);
  await denied(resolve(partner, source)); await denied(resolve(newcomer, source)); assert.equal((await call(resolve(owner, source))).availability, "archived");
  const own = (await listing(owner)).items, retained = own.find(row => row.sourceId === source); assert.equal(retained.availability, "archived"); assert.equal(retained.scopeId, couple);
  assert.equal(own.filter(row => row.availability === "access_lost").length, 3); assert.equal((await listing(newcomer)).items.length, 0); assert.equal((await listing(partner)).items.length, 0);
  assert.equal((await sql(`SELECT count(*),sum(charged_bytes) FROM pb_strip_quota_ledger;`)).stdout.trim(), charges);
  await sql(`UPDATE pb_strips SET cloudinary_public_id='zuychin-photobooth/foreign/foreign' WHERE id=${q(source)};`); await denied(resolve(owner, source));
  await sql(migration);
  console.log("Retained strip SQL passed: service-only access, original-couple/owner permissions, no re-pair inheritance, verified archive gate, malformed/deleted/pending denial, owner activity recovery, unchanged quota and populated rerun.");
} finally { const dropped = await docker(["exec", container, "dropdb", "-U", "postgres", "--force", database]); assert.equal(dropped.code, 0, dropped.stderr); }
