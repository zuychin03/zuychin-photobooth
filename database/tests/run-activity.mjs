import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
const container = process.env.PB_TEST_CONTAINER ?? "pb-v2-p1-postgres";
if (!/^pb-v2-[a-z0-9-]+$/.test(container)) throw new Error("Use a task-owned pb-v2-* container");
const database = `pb_v2_activity_${Date.now()}`;
const archiveOnly = process.env.PB_TEST_ACTIVITY_ARCHIVE_ONLY === "true";
const docker = (args, input = "") => new Promise((resolve, reject) => {
  const child = spawn("docker", ["--context", "desktop-linux", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", v => { stdout += v; }); child.stderr.on("data", v => { stderr += v; }); child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end(input);
});
const sql = async (source, failure = false) => { const result = await docker(["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database], source); if (result.code && !failure) throw new Error(result.stderr); return result; };
const q = value => `'${String(value).replaceAll("'", "''")}'`, json = value => `${q(JSON.stringify(value))}::jsonb`;
const service = "SET ROLE service_role; SET request.jwt.claim.role='service_role'; ";
const call = async expression => JSON.parse((await sql(`${service} SELECT ${expression};`)).stdout.trim());
const denied = async (source, pattern = /PB_MEMORY_DENIED|permission denied/) => { const result = await sql(source, true); assert.notEqual(result.code, 0); assert.match(result.stderr, pattern); };
const owner = randomUUID(), guest = randomUUID(), other = randomUUID(), couple = randomUUID(), legacy = randomUUID(), project = randomUUID();
const listing = actor => call(`public.pb_memory_list(${q(actor)},NULL,50)`);
const afterPrevious = (actor, id) => {
  const hex = (BigInt(`0x${id.replaceAll("-", "")}`) - 1n).toString(16).padStart(32, "0"), prior = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  return call(`public.pb_memory_list(${q(actor)},${q(prior)},1)`);
};
const total = async (actor, year) => (await call(`public.pb_memory_summary(${q(actor)},${year})`)).months.reduce((sum, m) => sum + m.total, 0);
const created = await docker(["exec", container, "createdb", "-U", "postgres", database]); assert.equal(created.code, 0, created.stderr);
try {
  await sql(await readFile(new URL("./bootstrap.sql", import.meta.url), "utf8"));
  await sql("CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); ALTER TABLE storage.objects ADD COLUMN user_metadata jsonb;");
  await sql((await readFile(new URL("../../supabase-setup.sql", import.meta.url), "utf8")).split("-- BEGIN PB_LIFECYCLE_V1")[0]);
  await sql(`INSERT INTO auth.users(id,email) VALUES(${q(owner)},'owner@example.invalid'),(${q(guest)},'guest@example.invalid'),(${q(other)},'other@example.invalid'); INSERT INTO pb_couples(id,member_a,member_b) VALUES(${q(couple)},${q(owner)},${q(guest)}); INSERT INTO pb_strips(id,owner,couple_id,storage_path,created_at) VALUES(${q(legacy)},${q(owner)},${q(couple)},'legacy','2020-01-01T00:00:00Z'); INSERT INTO pb_strips(owner,couple_id,storage_path,created_at) SELECT ${q(owner)},${q(couple)},'historical-'||n,'2020-02-01T00:00:00Z'::timestamptz+n*interval '1 second' FROM generate_series(1,${archiveOnly ? 0 : 2100}) n;`);
  for (const name of ["001_v2_lifecycle.sql", "002_v2_projects.sql", "003_v2_rooms.sql", "004_v2_memories.sql", "005_v2_events.sql"]) await sql(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  const migration = await readFile(new URL("../migrations/006_v2_activity.sql", import.meta.url), "utf8"); await sql(migration); await sql(migration);
  if (archiveOnly) {
    await call("pb_memory_backfill(25)");
    await sql(`UPDATE pb_strips SET purged=true,cloudinary_public_id='unverified-history' WHERE id=${q(legacy)};`); assert.equal((await listing(owner)).items[0].availability, "unknown");
    await sql(`UPDATE pb_strips SET archive_verified_at=clock_timestamp() WHERE id=${q(legacy)};`); assert.equal((await listing(owner)).items[0].availability, "archived");
    await sql(`UPDATE pb_strips SET archive_verified_at=NULL,cloudinary_public_id=NULL WHERE id=${q(legacy)};`); assert.equal((await listing(owner)).items[0].availability, "expired");
    assert.equal(await total(owner, 2020), 1); console.log("Historical archive reference stays unknown until verified; archive/expiry transitions preserve counts.");
  } else {
  assert.equal((await call("public.pb_memory_capabilities()")).version, 1);
  for (const role of ["anon", "authenticated", "service_role"]) await denied(`SET ROLE ${role}; SELECT * FROM pb_memory_activity;`);
  await denied(`SET ROLE authenticated; SELECT pb_memory_list(${q(owner)});`);
  await denied(`${service} SELECT pb_memory_record(${q(owner)},'strip',${q(randomUUID())},'personal',NULL,now(),'saved_at','available');`);
  await sql(`UPDATE pb_strips SET activity_recorded_at=NULL WHERE id=${q(legacy)};`);
  const activity = (await listing(owner)).items[0], chapter = randomUUID(); assert.equal(activity.occurredAt, "2020-01-01T00:00:00+00:00");
  await call(`pb_memory_chapter_put(${q(owner)},${q(chapter)},-1,'Personal chapter')`);
  await call(`pb_memory_annotate(${q(owner)},${q(activity.id)},0,${q(chapter)},'Private occasion')`);
  const shared = (await listing(guest)).items[0]; assert.equal(shared.occasion, undefined); assert.equal(shared.chapterId, undefined);
  await denied(`${service} SELECT pb_memory_annotate(${q(guest)},${q(activity.id)},1,NULL,'Forged');`);
  await denied(`${service} SELECT pb_memory_chapter_delete(${q(owner)},${q(chapter)},0);`, /PB_MEMORY_NOT_EMPTY/);
  let processed; do { processed = (await call("pb_memory_backfill(100)")).processed; } while (processed);
  assert.equal(await total(owner, 2020), 2101); assert.equal(await total(guest, 2020), 0);
  assert.equal((await sql(`SELECT count(*) FROM pb_memory_activity WHERE subject_id=${q(owner)};`)).stdout.trim(), "2001");
  assert.equal((await sql(`SELECT occasion FROM pb_memory_activity WHERE id=${q(activity.id)};`)).stdout.trim(), "Private occasion");
  await sql(`UPDATE pb_strips SET activity_recorded_at=NULL WHERE owner=${q(owner)};`); assert.equal(await total(owner, 2020), 2101);
  assert.equal((await call("pb_memory_backfill(100)")).processed, 0);
  await sql(migration); assert.equal(await total(owner, 2020), 2101);
  console.log("Empty/populated/rerun, bounded backfill, compaction counts and authored metadata preservation passed.");

  const races = await Promise.all(Array.from({ length: 8 }, (_, i) => sql(`${service} SELECT pb_memory_chapter_put(${q(owner)},${q(chapter)},0,'Edit ${i}');`, true)));
  assert.equal(races.filter(r => !r.code).length, 1); for (const r of races.filter(r => r.code)) assert.match(r.stderr, /PB_MEMORY_CONFLICT/);
  await call("pb_configure_lifecycle('Australia/Sydney')");
  const fresh = randomUUID(); await sql(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-strips',${q(`${owner}/${fresh}.png`)},'{"size":100}'); SET ROLE authenticated; SET request.jwt.claim.sub=${q(owner)}; SET request.jwt.claim.role='authenticated'; INSERT INTO pb_strips(id,owner,couple_id,storage_path,activity_recorded_at) VALUES(${q(fresh)},${q(owner)},${q(couple)},${q(`${owner}/${fresh}.png`)},'1900-01-01');`);
  const freshActivity = JSON.parse((await sql(`SELECT pb_memory_projection(a,${q(owner)}) FROM pb_memory_activity a WHERE source_id=${q(fresh)};`)).stdout.trim()); assert.notEqual(freshActivity.occurredAt.slice(0,4), "1900");
  await denied(`SET ROLE authenticated; SET request.jwt.claim.sub=${q(owner)}; UPDATE pb_strips SET activity_recorded_at=NULL WHERE id=${q(fresh)};`);
  await sql(`UPDATE pb_strips SET purged=true WHERE id=${q(legacy)};`); assert.equal(JSON.parse((await sql(`SELECT pb_memory_projection(a,${q(owner)}) FROM pb_memory_activity a WHERE id=${q(activity.id)};`)).stdout.trim()).availability, "expired");
  await sql(`DELETE FROM pb_strips WHERE id=${q(legacy)};`); assert.equal(await total(owner, 2020), 2101);
  await sql(`DELETE FROM pb_couples WHERE id=${q(couple)}; INSERT INTO pb_couples(id,member_a,member_b) VALUES(${q(randomUUID())},${q(owner)},${q(other)});`);
  assert.equal((await listing(guest)).items.length, 0); assert.equal((await listing(other)).items.length, 0);
  const lost = (await listing(owner)).items; assert(lost.every(a => a.availability === "access_lost" && !Object.hasOwn(a, "sourceId") && !Object.hasOwn(a, "scopeId")));
  console.log("CAS race, immutable direct-write marker, delete/purge retention and original-couple/re-pair isolation passed.");

  await sql(`SET request.jwt.claim.role='service_role'; DO $$ DECLARE r record; BEGIN FOR r IN SELECT id,revision FROM public.pb_memory_activity WHERE subject_id=${q(owner)} AND occasion IS NULL ORDER BY id LIMIT 498 LOOP PERFORM public.pb_memory_annotate(${q(owner)},r.id,r.revision,NULL,'Pinned'); END LOOP; END $$;`);
  const targets = JSON.parse((await sql(`SELECT jsonb_agg(id) FROM (SELECT id FROM pb_memory_activity WHERE subject_id=${q(owner)} AND occasion IS NULL ORDER BY id LIMIT 8) s;`)).stdout.trim());
  const annotationRace = await Promise.all(targets.map(target => sql(`${service} SELECT pb_memory_annotate(${q(owner)},${q(target)},0,NULL,'Last pin');`, true)));
  assert.equal(annotationRace.filter(r => !r.code).length, 1); for (const r of annotationRace.filter(r => r.code)) assert.match(r.stderr, /PB_MEMORY_CAPACITY/);
  await sql(`${service} DO $$ BEGIN FOR n IN 1..98 LOOP PERFORM public.pb_memory_chapter_put(${q(owner)},gen_random_uuid(),-1,'Chapter'); END LOOP; END $$;`);
  const chapterRace = await Promise.all(Array.from({ length: 8 }, () => sql(`${service} SELECT pb_memory_chapter_put(${q(owner)},${q(randomUUID())},-1,'Last chapter');`, true)));
  assert.equal(chapterRace.filter(r => !r.code).length, 1); for (const r of chapterRace.filter(r => r.code)) assert.match(r.stderr, /PB_MEMORY_CAPACITY/);
  const saveRace = await Promise.all(Array.from({ length: 8 }, () => {
    const strip = randomUUID(), path = `${owner}/${strip}.png`;
    return sql(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-strips',${q(path)},'{"size":100}'); SET ROLE authenticated; SET request.jwt.claim.sub=${q(owner)}; SET request.jwt.claim.role='authenticated'; INSERT INTO pb_strips(id,owner,couple_id,storage_path) VALUES(${q(strip)},${q(owner)},(SELECT id FROM pb_couples WHERE member_a=${q(owner)}),${q(path)});`, true);
  }));
  assert.equal(saveRace.filter(r => !r.code).length, 8, saveRace.map(r => r.stderr).join("\n"));
  assert.equal((await sql(`SELECT count(*) FROM pb_memory_activity WHERE subject_id=${q(owner)} AND (occasion IS NOT NULL OR chapter_id IS NOT NULL);`)).stdout.trim(), "500");
  console.log("Concurrent 500-annotation and 100-chapter ceilings preserve existing authored metadata.");

  await call("pb_project_configure(67108864)"); await call(`pb_project_create(${q(owner)},${q(project)},'friend','Activity fixture',67108864)`);
  await call(`pb_project_member(${q(owner)},${q(project)},${q(guest)},'invite')`); await call(`pb_project_member(${q(guest)},${q(project)},${q(guest)},'accept')`);
  const asset = randomUUID(), input = { id: asset, requestId: randomUUID(), kind: "photo", mime: "image/png", bytes: 100, width: 20, height: 20, sha256: "a".repeat(64), protection: { kind: "none", id: null } };
  const reserved = await call(`pb_project_reserve(${q(guest)},${q(project)},${json(input)})`); await call(`pb_project_authorise_upload(${q(guest)},${q(asset)})`);
  await sql(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-projects-v2',${q(reserved.path)},'{"size":100}');`);
  await call(`pb_project_enqueue_finalisation(${q(guest)},${q(asset)})`); const lease = await call("pb_project_claim_finalisation()");
  await call(`pb_project_finish_finalisation(${q(asset)},${q(lease.leaseToken)},'verified',${json({ mime: input.mime, bytes: 100, width: 20, height: 20, sha256: input.sha256, decoded: true })})`);
  const ownAssetActivity = (await listing(guest)).items.find(a => a.sourceId === asset); assert.equal(ownAssetActivity.provenance, "verified_at");
  assert.equal((await afterPrevious(owner, ownAssetActivity.id)).items.filter(a => a.sourceId === asset).length, 1);
  const challenge = randomUUID(); await sql(`INSERT INTO pb_challenges(id,project_id,initiator_id,fingerprint,recipe_hash,policy,status,expires_at) VALUES(${q(challenge)},${q(project)},${q(owner)},'{}',repeat('a',64),'all_submitted','open',now()+interval '1 day'); UPDATE pb_project_assets SET protection='challenge',protection_id=${q(challenge)} WHERE id=${q(asset)};`);
  assert.equal((await afterPrevious(owner, ownAssetActivity.id)).items.filter(a => a.sourceId === asset).length, 0); assert.equal((await listing(guest)).items.filter(a => a.sourceId === asset).length, 1);
  await call(`pb_project_member(${q(owner)},${q(project)},${q(guest)},'revoke')`);
  const revoked = (await listing(guest)).items.find(a => a.id === ownAssetActivity.id); assert.equal(revoked.availability, "access_lost"); assert.equal(revoked.sourceId, undefined);
  const year = new Date().getUTCFullYear(), before = await total(guest, year); await sql(`UPDATE pb_project_assets SET activity_recorded_at=NULL,status='deleted' WHERE id=${q(asset)};`); assert.equal(await total(guest, year), before);
  await sql(migration); assert.equal(await total(guest, year), before);
  console.log("Real finalisation hook, protected-original omission, membership loss and count retention passed.");
  }
} finally {
  const result = await docker(["exec", container, "dropdb", "-U", "postgres", "--force", database]); if (result.code) throw new Error(result.stderr);
}
