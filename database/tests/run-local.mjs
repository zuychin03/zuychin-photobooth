import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const container = process.env.PB_TEST_CONTAINER ?? "pb-v2-p1-postgres";
if (!/^pb-v2-[a-z0-9-]+$/.test(container)) throw new Error("Use a task-owned pb-v2-* container.");
const database = `pb_v2_lifecycle_${Date.now()}`;
let activeDatabase = database;
const docker = (args, input = "") => new Promise((resolve, reject) => {
  const child = spawn("docker", ["--context", "desktop-linux", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", code => resolve({ code, stdout, stderr }));
  child.stdin.end(input);
});
const sql = async (source, allowFailure = false) => {
  const result = await docker(["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", activeDatabase], source);
  if (result.code && !allowFailure) throw new Error(result.stderr);
  return result;
};
const fixture = new URL("./bootstrap.sql", import.meta.url);
const migration = new URL("../migrations/001_v2_lifecycle.sql", import.meta.url);
const baseline = new URL("../../supabase-setup.sql", import.meta.url);
const assertions = new URL("./lifecycle.test.sql", import.meta.url);
const creation = await docker(["exec", container, "createdb", "-U", "postgres", database]);
assert.equal(creation.code, 0, creation.stderr);
console.log(`Isolated PostgreSQL fixture: ${database}`);
await sql(await readFile(fixture, "utf8"));
await sql((await readFile(baseline, "utf8")).split("-- BEGIN PB_LIFECYCLE_V1")[0]);
const migrationText = await readFile(migration, "utf8");
await sql(migrationText);
await sql(migrationText);
console.log("Empty-schema application and rerun passed.");
await sql(await readFile(assertions, "utf8"));
console.log("Sequential role, quota, lifecycle and upload assertions passed.");

const owner = "11111111-1111-1111-1111-111111111111";
const partner = "22222222-2222-2222-2222-222222222222";
const couple = "33333333-3333-3333-3333-333333333333";
const ids = Array.from({ length: 24 }, () => randomUUID());
await sql(`
INSERT INTO auth.users(id,email) VALUES('${owner}','race-a@example.invalid'),('${partner}','race-b@example.invalid');
INSERT INTO public.pb_couples(id,member_a,member_b) VALUES('${couple}','${owner}','${partner}');
SELECT set_config('request.jwt.claim.role','service_role',false);
SELECT public.pb_configure_lifecycle('Australia/Sydney');
${ids.map((id, index) => `INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-strips','${index % 2 ? partner : owner}/${id}.png','{"size":16777216}');`).join("\n")}
`);
const clients = await Promise.all(ids.map((id, index) => sql(`
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub','${index % 2 ? partner : owner}',false);
INSERT INTO public.pb_strips(id,owner,couple_id,storage_path,created_at,layout_id)
VALUES('${id}','${index % 2 ? partner : owner}','${couple}','${index % 2 ? partner : owner}/${id}.png','1999-01-01','classic');
`, true)));
assert.equal(clients.filter(result => result.code === 0).length, 10);
for (const result of clients.filter(result => result.code !== 0)) assert.match(result.stderr, /PB_WEEKLY_QUOTA_EXCEEDED/);
assert.equal((await sql("SELECT count(*) || ':' || sum(charged_bytes) FROM public.pb_strip_quota_ledger;")).stdout.trim(), "10:167772160");
console.log("24 simultaneous legacy-style inserts: 10 accepted, 14 quota denials, verified charge 160 MiB.");

const recapId = randomUUID();
await sql(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-strips','${owner}/${recapId}.png','{"size":16777216}');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub','${owner}',false);
INSERT INTO public.pb_strips(id,owner,couple_id,storage_path,layout_id) VALUES('${recapId}','${owner}','${couple}','${owner}/${recapId}.png','recap');`);
assert.equal((await sql("SELECT sum(charged_bytes) FROM public.pb_strip_quota_ledger;")).stdout.trim(), "184549376");
console.log("Separate bounded recap reaches the 176 MiB combined ceiling.");

const target = (await sql(`SELECT id FROM public.pb_strips WHERE owner='${owner}' ORDER BY id LIMIT 1;`)).stdout.trim();
const requestA = randomUUID(), requestB = randomUUID();
await sql(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub','${owner}',false);
SELECT public.pb_enqueue_strip_operation('${target}','archive','${requestA}');
SELECT public.pb_enqueue_strip_operation('${target}','release','${requestB}');`);
const claims = await Promise.all(Array.from({ length: 8 }, () => sql(`SET ROLE service_role; SELECT set_config('request.jwt.claim.role','service_role',false);
SELECT id FROM public.pb_claim_media_jobs('${randomUUID()}',25,60);`)));
const claimed = claims.flatMap(result => result.stdout.split(/\r?\n/).filter(line => /^[0-9a-f-]{36}$/.test(line)));
assert.equal(claimed.length, 1);
assert.equal(new Set(claimed).size, 1);
console.log("Eight competing claimers: one active job for the shared strip source.");

const victim = (await sql(`SELECT id || ':' || owner FROM public.pb_strips WHERE id<>'${target}' AND layout_id<>'recap' ORDER BY id LIMIT 1;`)).stdout.trim().split(":");
await sql(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub','${victim[1]}',false);
DELETE FROM public.pb_strips WHERE id='${victim[0]}';`);
assert.equal((await sql("SELECT count(*) FROM public.pb_strip_quota_ledger WHERE quota_released_at IS NULL;")).stdout.trim(), "11");
const replacementIds = ids.filter((id, index) => clients[index].code !== 0);
const replacementSql = id => {
  const member = ids.indexOf(id) % 2 ? partner : owner;
  return `SET ROLE authenticated; SELECT set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub','${member}',false);
INSERT INTO public.pb_strips(id,owner,couple_id,storage_path) VALUES('${id}','${member}','${couple}','${member}/${id}.png');`;
};
assert.match((await sql(replacementSql(replacementIds[0]), true)).stderr, /PB_WEEKLY_QUOTA_EXCEEDED/);
await sql(`SELECT set_config('request.jwt.claim.role','service_role',false);
DO $$ DECLARE j public.pb_media_jobs; BEGIN
SELECT * INTO j FROM public.pb_claim_media_jobs('${randomUUID()}',1,60,(SELECT id FROM public.pb_media_jobs WHERE idempotency_key='strip-delete:${victim[0]}'));
DELETE FROM storage.objects WHERE bucket_id='photobooth-strips' AND name='${victim[1]}/${victim[0]}.png';
PERFORM public.pb_checkpoint_media_job(j.id,j.lease_token,'storage_removed','{"storage_removed":true}');
PERFORM public.pb_checkpoint_media_job(j.id,j.lease_token,'cloudinary_removed','{"cloudinary_removed":true}');
PERFORM public.pb_delete_media_strip(j.id,j.lease_token);
PERFORM public.pb_checkpoint_media_job(j.id,j.lease_token,'row_deleted','{"row_deleted":true}');
PERFORM public.pb_finish_media_job(j.id,j.lease_token,'complete');
END $$;`);
assert.equal((await sql("SELECT count(*) FROM public.pb_strip_quota_ledger WHERE quota_released_at IS NULL;")).stdout.trim(), "10");
const replacements = await Promise.all(replacementIds.map(id => sql(replacementSql(id), true)));
assert.equal(replacements.filter(result => result.code === 0).length, 1);
for (const result of replacements.filter(result => result.code !== 0)) assert.match(result.stderr, /PB_WEEKLY_QUOTA_EXCEEDED/);
const reuse = await sql(`SELECT set_config('request.jwt.claim.role','service_role',false);
INSERT INTO public.pb_strips(id,owner,couple_id,storage_path) VALUES('${victim[0]}','${victim[1]}','${couple}','${victim[1]}/${victim[0]}.png');`, true);
assert.match(reuse.stderr, /PB_STRIP_ID_ALREADY_CONSUMED/);
console.log("Direct deletion retained quota; confirmed cleanup released one slot; 14 concurrent replacements admitted exactly one; UUID reuse denied.");

await sql(migrationText);
assert.equal((await sql("SELECT count(*) FROM public.pb_strip_quota_ledger WHERE quota_released_at IS NULL;")).stdout.trim(), "11");
assert.equal((await sql("SELECT count(*) FROM public.pb_strip_quota_ledger;")).stdout.trim(), "12");
assert.equal((await sql("SELECT count(*) FROM public.pb_strips;")).stdout.trim(), "11");
console.log("Populated-schema migration rerun preserves rows, charges and jobs.");

activeDatabase = `${database}_legacy`;
const legacyCreation = await docker(["exec", container, "createdb", "-U", "postgres", activeDatabase]);
assert.equal(legacyCreation.code, 0, legacyCreation.stderr);
await sql(await readFile(fixture, "utf8"));
await sql((await readFile(baseline, "utf8")).split("-- BEGIN PB_LIFECYCLE_V1")[0]);
const legacyOwner = "99999999-9999-9999-9999-999999999999";
await sql(`INSERT INTO auth.users(id,email) VALUES('${legacyOwner}','legacy@example.invalid');
INSERT INTO public.pb_strips(id,owner,storage_path,layout_id,kept,created_at)
SELECT ('90000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,'${legacyOwner}',
'${legacyOwner}/90000000-0000-0000-0000-' || lpad(n::text,12,'0') || '.png','classic',n<=30,'2020-01-01T00:00:00Z'
FROM generate_series(1,56) AS n;`);
await sql(migrationText);
await sql(migrationText);
assert.equal((await sql("SELECT count(*) FROM public.pb_strips WHERE lifecycle_legacy AND created_at='2020-01-01T00:00:00Z';")).stdout.trim(), "56");
await sql("SELECT set_config('request.jwt.claim.role','service_role',false); SELECT public.pb_configure_lifecycle('Australia/Sydney');");
assert.equal((await sql("SELECT count(*) FROM public.pb_strip_quota_ledger WHERE legacy;")).stdout.trim(), "56");
assert.equal((await sql("SELECT set_config('request.jwt.claim.role','service_role',false); SELECT public.pb_discover_retention(25);")).stdout.trim().split(/\r?\n/).at(-1), "0");
await sql("UPDATE public.pb_lifecycle_settings SET legacy_retention_not_before='2000-01-01';");
const discover = async () => (await sql("SELECT set_config('request.jwt.claim.role','service_role',false); SELECT public.pb_discover_retention(25);")).stdout.trim().split(/\r?\n/).at(-1);
assert.equal(await discover(), "25");
await sql("UPDATE public.pb_media_jobs SET status='failed',last_error='fixture archive provider unavailable';");
assert.equal(await discover(), "25");
assert.equal(await discover(), "6");
assert.equal(await discover(), "0");
console.log("56 pre-migration rows retained and backfilled; legacy grace blocks early deletion; discovery progresses 25/25/6 despite failed first batch.");

const retentionTarget = (await sql("SELECT source_id FROM public.pb_media_jobs WHERE kind='delete' AND status='queued' ORDER BY source_id LIMIT 1;")).stdout.trim();
await sql(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub','${legacyOwner}',false);
SELECT public.pb_enqueue_strip_operation('${retentionTarget}','archive','${randomUUID()}');`);
const protectedClaim = await sql(`SET ROLE service_role; SELECT set_config('request.jwt.claim.role','service_role',false);
SELECT id FROM public.pb_claim_media_jobs('${randomUUID()}',1,60,(SELECT id FROM public.pb_media_jobs WHERE source_id='${retentionTarget}' AND kind='delete'));`);
assert.equal(protectedClaim.stdout.split(/\r?\n/).filter(line => /^[0-9a-f-]{36}$/.test(line)).length, 0);
assert.equal((await sql(`SELECT last_error FROM public.pb_media_jobs WHERE source_id='${retentionTarget}' AND kind='delete';`)).stdout.trim(), "retention_superseded");
const busyTarget = (await sql("SELECT source_id FROM public.pb_media_jobs WHERE kind='delete' AND status='queued' ORDER BY source_id DESC LIMIT 1;")).stdout.trim();
await sql(`SET ROLE service_role; SELECT set_config('request.jwt.claim.role','service_role',false);
SELECT id FROM public.pb_claim_media_jobs('${randomUUID()}',1,60,(SELECT id FROM public.pb_media_jobs WHERE source_id='${busyTarget}' AND kind='delete'));`);
const busyKeep = await sql(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub','${legacyOwner}',false);
SELECT public.pb_enqueue_strip_operation('${busyTarget}','archive','${randomUUID()}');`, true);
assert.match(busyKeep.stderr, /PB_SOURCE_BUSY/);
await sql(`UPDATE public.pb_media_jobs SET lease_until=now()-interval '1 second' WHERE source_id='${busyTarget}';`);
const staleMutation = await sql(`SET ROLE service_role; SELECT set_config('request.jwt.claim.role','service_role',false);
SELECT public.pb_update_media_strip(id,lease_token,'{"kept":true}') FROM public.pb_media_jobs WHERE source_id='${busyTarget}';`, true);
assert.match(staleMutation.stderr, /PB_STALE_LEASE/);
console.log("Retention respects newer keep intent; in-flight delete rejects a racing keep; expired leases cannot mutate strip rows.");
console.log("Local PostgreSQL checks passed. This is not hosted Storage, PostgREST or provider validation.");
