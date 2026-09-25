import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parsePartialDetail, parsePartialList, parseChallengeUploadList } from "../../lib/memories/challenge-contract.ts";
const container = process.env.PB_TEST_CONTAINER ?? "pb-v2-p1-postgres";
if (!/^pb-v2-[a-z0-9-]+$/.test(container)) throw new Error("Use a task-owned pb-v2-* container");
const database = `pb_v2_partial_${Date.now()}`;
const docker = (args, input = "") => new Promise((resolve, reject) => {
  const child = spawn("docker", ["--context", "desktop-linux", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", v => { stdout += v; }); child.stderr.on("data", v => { stderr += v; }); child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end(input);
});
const sql = async (source, failure = false) => { const r = await docker(["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database], source); if (r.code && !failure) throw new Error(r.stderr); return r; };
const q = value => `'${String(value).replaceAll("'", "''")}'`, json = value => `${q(JSON.stringify(value))}::jsonb`, service = "SET ROLE service_role; SET request.jwt.claim.role='service_role'; ";
const call = async expression => JSON.parse((await sql(`${service} SELECT ${expression};`)).stdout.trim());
const denied = async expression => { const r = await sql(`${service} SELECT ${expression};`, true); assert.notEqual(r.code, 0); assert.match(r.stderr, /PB_CHALLENGE_DENIED|PB_PROJECT_DENIED/); };
const users = Array.from({ length: 5 }, () => randomUUID()), [owner, guest, excluded, stranger, outsider] = users;
const crop = { zoom: 1, offsetX: 0, offsetY: 0, rotation: 0, mirror: false };
const source = (role, sourceIndex = 0) => ({ role, sourceIndex, crop });
const design = { canvas: { width: 800, height: 800 }, requiredSources: { A: 1, B: 1, C: 1 },
  slots: [{ id: "together", x: 0, y: 0, width: 1, height: 0.5, ...source("C"), companions: [source("A"), source("B")], splitFallback: true }, { id: "excluded", x: 0, y: 0.5, width: 1, height: 0.5, ...source("C") }],
  layers: [{ kind: "text", id: "personal", x: 0, y: 0, width: 1, height: 0.1, rotation: 0, text: "Private caption", personal: true, font: "sans", fontSize: 0.04, colour: "#000000", align: "center" }],
  decorations: [], look: { frameId: "film", filterId: "none", patternId: "none", themeId: null, sceneId: null, materialId: null }, defaults: { caption: "Private default", showDate: false }, places: { A: { dx: 0, dy: 0, scale: 1 }, B: { dx: 0, dy: 0, scale: 1 }, C: { dx: 0, dy: 0, scale: 1 } } };
async function readyAsset(project, id, u) {
  const asset = randomUUID(), input = { id: asset, requestId: randomUUID(), kind: "photo", mime: "image/png", bytes: 100, width: 20, height: 20, sha256: "b".repeat(64), protection: { kind: "challenge", id } };
  const r = await call(`public.pb_project_reserve(${q(u)},${q(project)},${json(input)})`);
  await call(`public.pb_project_authorise_upload(${q(u)},${q(asset)})`);
  await sql(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-projects-v2',${q(r.path)},'{"size":100}');`);
  await call(`public.pb_project_enqueue_finalisation(${q(u)},${q(asset)})`);
  const job = await call("public.pb_project_claim_finalisation()"); assert.equal(job.assetId, asset);
  await call(`public.pb_project_finish_finalisation(${q(asset)},${q(job.leaseToken)},'verified',${json({ bytes: 100, width: 20, height: 20, mime: "image/png", sha256: input.sha256, decoded: true })})`);
  return asset;
}
async function fixture() {
  const project = randomUUID(), id = randomUUID();
  await call(`public.pb_project_create(${q(owner)},${q(project)},'friend','Partial fixture',67108864)`);
  for (const u of [guest, excluded, stranger]) { await call(`public.pb_project_member(${q(owner)},${q(project)},${q(u)},'invite')`); await call(`public.pb_project_member(${q(u)},${q(project)},${q(u)},'accept')`); }
  const body = { id, design, policy: "all_submitted", expiresAt: "2030-01-01T00:00:00Z", members: [owner, guest, excluded].map((userId, i) => ({ userId, role: "ABC"[i] })), assignments: [owner, guest, excluded].map((userId, slot) => ({ slot, userId, sourceIndex: 0 })) };
  await call(`public.pb_challenge_create(${q(owner)},${q(project)},${json(body)})`);
  for (const u of [owner, guest]) assert.deepEqual(await call(`public.pb_challenge_upload_list(${q(u)},${q(id)})`), { version: 1, uploads: [], nextCursor: null });
  const unopened = randomUUID(); await call(`public.pb_challenge_create(${q(owner)},${q(project)},${json({ ...body, id: unopened })})`);
  await call(`public.pb_challenge_manage(${q(owner)},${q(unopened)},'cancel')`);
  assert.deepEqual(await call(`public.pb_challenge_upload_list(${q(guest)},${q(unopened)})`), { version: 1, uploads: [], nextCursor: null });
  for (const u of [guest, excluded]) await call(`public.pb_challenge_manage(${q(u)},${q(id)},'accept')`);
  await call(`public.pb_challenge_manage(${q(owner)},${q(id)},'open')`);
  const assets = []; const extra = await readyAsset(project, id, owner);
  for (const u of [owner, guest]) {
    const asset = await readyAsset(project, id, u);
    const own = await call(`public.pb_challenge_upload_list(${q(u)},${q(id)})`); parseChallengeUploadList(own, u); assert(own.uploads.some(a => a.id === asset));
    await call(`public.pb_challenge_submit(${q(u)},${q(id)},${json({ requestId: randomUUID(), sources: [{ sourceIndex: 0, assetId: asset }] })})`); assets.push(asset);
  }
  return { id, project, assets, extra };
}
const propose = (c, included = [owner, guest], proposer = owner, id = randomUUID()) => call(`public.pb_challenge_propose_partial(${q(proposer)},${q(c.id)},${q(id)},ARRAY[${included.map(q).join(",")}]::uuid[])`);
const detailSql = (p, actor = owner, digest = p.digest) => `public.pb_challenge_partial_details(${q(actor)},${q(p.id)},${q(digest)})`;
const listingSql = (c, actor = owner, after = null, limit = 20) => `public.pb_challenge_partial_list(${q(actor)},${q(c.id)},${after ? q(after) : "NULL"},${limit})`;
const uploadsSql = (c, actor = owner, after = null, limit = 20) => `public.pb_challenge_upload_list(${q(actor)},${q(c.id)},${after ? q(after) : "NULL"},${limit})`;
const consent = (p, actor, yes = true) => call(`public.pb_challenge_partial_consent(${q(actor)},${q(p.id)},${q(p.digest)},${yes})`);
const commit = p => call(`public.pb_challenge_commit_partial(${q(owner)},${q(p.id)},${q(p.digest)})`);
const created = await docker(["exec", container, "createdb", "-U", "postgres", database]); assert.equal(created.code, 0, created.stderr);
try {
  await sql(await readFile(new URL("./bootstrap.sql", import.meta.url), "utf8"));
  await sql("CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);");
  await sql((await readFile(new URL("../../supabase-setup.sql", import.meta.url), "utf8")).split("-- BEGIN PB_LIFECYCLE_V1")[0]);
  for (const name of ["001_v2_lifecycle.sql", "002_v2_projects.sql", "004_v2_memories.sql", "007_v2_challenge_discovery.sql"]) await sql(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  const migration = await readFile(new URL("../migrations/008_v2_partial_results.sql", import.meta.url), "utf8"); await sql(migration); await sql(migration);
  const capabilities = await call("public.pb_challenge_capabilities()"); assert.equal(capabilities.partialVersion, 1); assert.equal(capabilities.discoveryVersion, 1); assert.equal(capabilities.ready, false);
  await call("public.pb_project_configure(1073741824)");
  await sql(`INSERT INTO auth.users(id,email) VALUES ${users.map((u, i) => `(${q(u)},'partial-${i}@example.invalid')`).join(",")};`);
  const c = await fixture(), p = await propose(c);
  const uploads = await call(uploadsSql(c)); parseChallengeUploadList(uploads, owner); assert.deepEqual(uploads.uploads.map(a => a.id), [c.extra, c.assets[0]].sort());
  const up1 = await call(uploadsSql(c, owner, null, 1)), up2 = await call(uploadsSql(c, owner, up1.nextCursor, 1)); parseChallengeUploadList(up1, owner, undefined, 1); parseChallengeUploadList(up2, owner, up1.nextCursor, 1); assert.equal(up2.nextCursor, null);
  assert.deepEqual([...up1.uploads, ...up2.uploads].map(a => a.id), uploads.uploads.map(a => a.id));
  await denied(uploadsSql(c, stranger)); await denied(uploadsSql(c, outsider));
  for (const limit of [0, 21, "NULL"]) { const r = await sql(`${service} SELECT ${uploadsSql(c, owner, null, limit)};`, true); assert.notEqual(r.code, 0); assert.match(r.stderr, /PB_CHALLENGE_INVALID/); }
  let detail = await call(detailSql(p)); parsePartialDetail(detail, p.id, p.digest, owner); assert.equal(detail.result, null); assert.equal(detail.actorConsent, null);
  const hidden = JSON.stringify(detail); assert(!hidden.includes(c.assets[0])); assert(!hidden.includes(c.assets[1])); assert(!hidden.includes("Private"));
  await denied(detailSql(p, excluded)); await denied(detailSql(p, stranger)); await denied(detailSql(p, outsider)); await denied(detailSql(p, owner, "a".repeat(64)));
  assert.deepEqual((await call(listingSql(c, excluded))).partials, []); await denied(listingSql(c, stranger));
  for (const role of ["anon", "authenticated"]) {
    const r = await sql(`SET ROLE ${role}; SET request.jwt.claim.role='service_role'; SELECT ${detailSql(p)};`, true); assert.notEqual(r.code, 0); assert.match(r.stderr, /permission denied/);
    const uploadDenied = await sql(`SET ROLE ${role}; SET request.jwt.claim.role='service_role'; SELECT ${uploadsSql(c)};`, true); assert.notEqual(uploadDenied.code, 0);
  }
  await consent(p, owner); detail = await call(detailSql(p)); assert.equal(detail.actorConsent, true); assert.equal(detail.result, null);
  await consent(p, guest); await Promise.all(Array.from({ length: 4 }, () => commit(p)));
  detail = await call(detailSql(p)); const parsed = parsePartialDetail(detail, p.id, p.digest, owner); assert.ok(parsed.result); assert.deepEqual(parsed.result.sources.map(s => s.assetId), c.assets);
  assert.deepEqual(Object.keys(detail.result.design.requiredSources), ["A", "B"]); assert.deepEqual(Object.keys(detail.result.design.places), ["A", "B"]);
  assert.equal(detail.result.design.slots.length, 1); assert.equal(detail.result.design.slots[0].role, "A"); assert.equal(detail.result.design.slots[0].companions[0].role, "B"); assert.equal(detail.result.design.slots[0].height, 0.5); assert.equal(detail.result.design.defaults.caption, ""); assert.deepEqual(detail.result.design.layers, []);
  const frozen = JSON.stringify(detail.result); await sql(migration); assert.equal(JSON.stringify((await call(detailSql(p))).result), frozen);
  await call(`public.pb_challenge_manage(${q(excluded)},${q(c.id)},'withdraw')`);
  assert.deepEqual((await call(uploadsSql(c))).uploads.map(a => a.id), uploads.uploads.map(a => a.id));
  assert.equal((await call(`public.pb_challenge_view(${q(owner)},${q(c.id)})`)).accessLost, true);
  assert.equal(JSON.stringify((await call(detailSql(p))).result), frozen); await call(`public.pb_project_asset_access(${q(owner)},${q(c.assets[1])})`);
  const single = await propose(c, [guest]); await consent(single, guest); await commit(single);
  assert.equal((await call(detailSql(single))).result, null);
  const singleDetail = await call(detailSql(single, guest)); parsePartialDetail(singleDetail, single.id, single.digest, guest); assert.equal(singleDetail.result.design.slots[0].role, "B"); assert(!Object.hasOwn(singleDetail.result.design.slots[0], "splitFallback"));
  const ids = [p.id, single.id]; for (let i = 0; i < 4; i++) ids.push((await propose(c)).id); ids.sort();
  const listed = []; let after = null;
  do { const page = await call(listingSql(c, owner, after, 2)); parsePartialList(page, c.id, owner, after ?? undefined, 2); listed.push(...page.partials.map(p => p.id)); assert(!JSON.stringify(page).includes(c.assets[0])); after = page.nextCursor; } while (after);
  assert.deepEqual(listed, ids);
  await consent(p, guest, false); detail = await call(detailSql(p)); assert.equal(detail.result, null); assert.equal(detail.status, "rejected"); assert.equal(detail.accessLost, true);
  await call(`public.pb_project_delete(${q(guest)},${q(c.project)},${q(c.assets[1])})`); const unavailable = await call(detailSql(single, guest)); assert.equal(unavailable.result, null); assert.equal(unavailable.accessLost, true); assert.equal(unavailable.contributors[0].status, "access_lost");
  await sql(`UPDATE public.pb_challenges SET design=NULL WHERE id=${q(c.id)};`); const legacy = await call(detailSql(p)); parsePartialDetail(legacy, p.id, p.digest, owner); assert.equal(legacy.unsupported, true); assert(!JSON.stringify(legacy).includes(p.digest));
  const legacyUploads = await sql(`${service} SELECT ${uploadsSql(c)};`, true); assert.notEqual(legacyUploads.code, 0); assert.match(legacyUploads.stderr, /PB_CHALLENGE_UPDATE_REQUIRED/);
  await call(`public.pb_project_member(${q(owner)},${q(c.project)},${q(guest)},'revoke')`); await denied(detailSql(single, guest)); await denied(listingSql(c, guest)); await denied(uploadsSql(c, guest));
  const race = await fixture(), rp = await propose(race); await consent(rp, owner); await consent(rp, guest);
  await Promise.allSettled([commit(rp), call(`public.pb_challenge_manage(${q(guest)},${q(race.id)},'withdraw')`)]);
  const lost = await call(detailSql(rp)); assert.equal(lost.result, null); assert.equal(lost.accessLost, true); await denied(detailSql(rp, guest));
  assert.equal((await call(uploadsSql(race, guest))).uploads[0].id, race.assets[1]);
  assert(!(await call(uploadsSql(race))).uploads.some(a => uploads.uploads.some(old => a.id === old.id)));
  await call(`public.pb_project_delete(${q(owner)},${q(race.project)})`); await denied(detailSql(rp)); await denied(uploadsSql(race));
  console.log("Partial result SQL passed: empty/populated reruns, service-only isolation, hidden pending sources/captions, exact digest, concurrent commit/withdraw, subset consent, excluded withdrawal, single-companion projection, pagination, source deletion, legacy and membership/project revocation.");
} finally {
  const dropped = await docker(["exec", container, "dropdb", "-U", "postgres", "--force", database]); assert.equal(dropped.code, 0, dropped.stderr);
}
