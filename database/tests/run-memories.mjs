import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
const container = process.env.PB_TEST_CONTAINER ?? "pb-v2-p1-postgres";
if (!/^pb-v2-[a-z0-9-]+$/.test(container)) throw new Error("Use a task-owned pb-v2-* container");
const database = `pb_v2_memories_${Date.now()}`;
const docker = (args, input = "") => new Promise((resolve, reject) => {
  const child = spawn("docker", ["--context", "desktop-linux", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", v => { stdout += v; }); child.stderr.on("data", v => { stderr += v; }); child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end(input);
});
const sql = async (source, failure = false) => { const result = await docker(["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database], source); if (result.code && !failure) throw new Error(result.stderr); return result; };
const q = v => `'${String(v).replaceAll("'", "''")}'`, json = v => `${q(JSON.stringify(v))}::jsonb`;
const service = "SET ROLE service_role; SET request.jwt.claim.role='service_role'; ";
const call = async expression => JSON.parse((await sql(`${service} SELECT ${expression};`)).stdout.trim());
const denied = async (expression, pattern = /PB_CHALLENGE_DENIED|PB_PROJECT_DENIED|permission denied/) => { const result = await sql(`${service} SELECT ${expression};`, true); assert.notEqual(result.code, 0); assert.match(result.stderr, pattern); };
const users = Array.from({ length: 5 }, () => randomUUID()), owner = users[0];
const view = (c, actor = owner) => call(`public.pb_challenge_view(${q(actor)},${q(c.id)})`);
const manage = (c, action, actor = owner) => call(`public.pb_challenge_manage(${q(actor)},${q(c.id)},${q(action)})`);
const access = (asset, actor = owner) => `public.pb_project_asset_access(${q(actor)},${q(asset)})`;
const design = count => ({ canvas: { width: 536, height: 1600 }, requiredSources: Object.fromEntries(Array.from({ length: count }, (_, i) => ["ABCD"[i], 1])),
  slots: Array.from({ length: count }, (_, i) => ({ id: `slot-${i}`, role: "ABCD"[i], sourceIndex: 0, x: 0, y: i / count, width: 1, height: 1 / count, crop: { zoom: 1, offsetX: 0, offsetY: 0, rotation: 0, mirror: false } })),
  layers: [], decorations: [], look: { frameId: "film", filterId: "none", patternId: "none", themeId: null, sceneId: null, materialId: null }, defaults: { caption: "Fixture design", showDate: true } });
async function challenge(count = 2, policy = "all_submitted") {
  const project = randomUUID(), id = randomUUID();
  await call(`public.pb_project_create(${q(owner)},${q(project)},'friend','Challenge fixture',67108864)`);
  for (const user of users.slice(1, count)) await call(`public.pb_project_member(${q(owner)},${q(project)},${q(user)},'invite')`);
  const body = { id, design: design(count), policy, expiresAt: new Date(Date.now() + 86400000).toISOString(), members: users.slice(0, count).map((userId, i) => ({ userId, role: "ABCD"[i] })), assignments: users.slice(0, count).map((userId, slot) => ({ slot, userId, sourceIndex: 0 })) };
  const created = await call(`public.pb_challenge_create(${q(owner)},${q(project)},${json(body)})`);
  assert.deepEqual(created.design, body.design); assert.match(created.recipeHash, /^[a-f0-9]{64}$/);
  const canonical = await sql(`SELECT encode(sha256(convert_to(jsonb_build_object('design',${json(body.design)},'members',${json(body.members)},'assignments',${json(body.assignments)})::text,'UTF8')),'hex');`);
  assert.equal(created.recipeHash, canonical.stdout.trim());
  const c = { project, id, body, count, assets: [], submissions: [] };
  await denied(`public.pb_challenge_manage(${q(owner)},${q(id)},'open')`, /PB_CHALLENGE_NOT_READY/);
  for (const user of users.slice(1, count)) await manage(c, "accept", user);
  await manage(c, "open");
  for (const user of users.slice(0, count)) {
    const asset = randomUUID(), input = { id: asset, requestId: randomUUID(), kind: "photo", mime: "image/png", bytes: 100, width: 20, height: 20, sha256: "b".repeat(64), protection: { kind: "challenge", id } };
    const reserved = await call(`public.pb_project_reserve(${q(user)},${q(project)},${json(input)})`);
    await call(`public.pb_project_authorise_upload(${q(user)},${q(asset)})`);
    await sql(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-projects-v2',${q(reserved.path)},'{"size":100}');`);
    await call(`public.pb_project_enqueue_finalisation(${q(user)},${q(asset)})`);
    const job = await call("public.pb_project_claim_finalisation()"); assert.equal(job.assetId, asset);
    await call(`public.pb_project_finish_finalisation(${q(asset)},${q(job.leaseToken)},'verified',${json({ bytes: 100, width: 20, height: 20, mime: "image/png", sha256: input.sha256, decoded: true })})`);
    c.assets.push(asset); c.submissions.push({ requestId: randomUUID(), sources: [{ sourceIndex: 0, assetId: asset }] });
  }
  return c;
}
const submit = (c, i) => `public.pb_challenge_submit(${q(users[i])},${q(c.id)},${json(c.submissions[i])})`;
const created = await docker(["exec", container, "createdb", "-U", "postgres", database]); assert.equal(created.code, 0, created.stderr);
try {
  await sql(await readFile(new URL("./bootstrap.sql", import.meta.url), "utf8"));
  await sql("CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);");
  await sql((await readFile(new URL("../../supabase-setup.sql", import.meta.url), "utf8")).split("-- BEGIN PB_LIFECYCLE_V1")[0]);
  await sql(await readFile(new URL("../migrations/001_v2_lifecycle.sql", import.meta.url), "utf8"));
  await sql(await readFile(new URL("../migrations/002_v2_projects.sql", import.meta.url), "utf8"));
  const migration = await readFile(new URL("../migrations/004_v2_memories.sql", import.meta.url), "utf8"); await sql(migration); await sql(migration);
  assert.equal((await call("public.pb_challenge_capabilities()")).ready, false);
  await call("public.pb_project_configure(1073741824)");
  await sql(`INSERT INTO auth.users(id,email) VALUES ${users.map((user, i) => `(${q(user)},'member-${i}@example.invalid')`).join(",")};`);
  for (const role of ["anon", "authenticated", "service_role"]) { const result = await sql(`SET ROLE ${role}; SELECT * FROM public.pb_challenge_submissions;`, true); assert.notEqual(result.code, 0); }
  await sql(`INSERT INTO public.pb_couples(id,member_a,member_b) VALUES(${q(randomUUID())},${q(owner)},${q(users[4])});`);

  for (const count of [2, 3, 4]) {
    const c = await challenge(count);
    await denied(`public.pb_challenge_view(${q(users[4])},${q(c.id)})`);
    await denied(access(c.assets[1])); await call(access(c.assets[1], users[1]));
    assert.equal((await call(`public.pb_project_view(${q(owner)},${q(c.project)})`)).assets.length, 1);
    await denied(`public.pb_challenge_submit(${q(owner)},${q(c.id)},${json({ requestId: randomUUID(), sources: [{ sourceIndex: 0, assetId: c.assets[1] }] })})`);
    if (count === 2) {
      await call(`public.pb_project_member(${q(owner)},${q(c.project)},${q(users[2])},'invite')`);
      await call(`public.pb_project_member(${q(users[2])},${q(c.project)},${q(users[2])},'accept')`);
      await denied(`public.pb_challenge_view(${q(users[2])},${q(c.id)})`); await denied(access(c.assets[0], users[2]));
    }
    const first = await call(submit(c, 0)); assert.equal(first.status, "open"); assert.equal(first.visibleSources.length, 1);
    const before = await view(c, users[1]); assert.equal(before.visibleSources.length, 0); assert(!JSON.stringify(before).includes(c.assets[0]));
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => call(submit(c, 1 + i % (count - 1)))));
    const revealed = await view(c); assert.equal(revealed.status, "revealed"); assert.equal(revealed.visibleSources.length, count); assert(revealed.revealHash);
    for (const value of results.filter(r => r.status === "revealed")) { assert.equal(value.revealedAt, revealed.revealedAt); assert.equal(value.revealHash, revealed.revealHash); }
    await call(access(c.assets[1]));
    if (count === 4) { await call(`public.pb_project_delete(${q(users[3])},${q(c.project)},${q(c.assets[3])})`); assert.equal((await view(c)).accessLost, true); await denied(access(c.assets[1])); }
    await denied(`public.pb_challenge_submit(${q(owner)},${q(c.id)},${json({ ...c.submissions[0], requestId: randomUUID() })})`, /PB_CHALLENGE_CONFLICT/);
    await manage(c, "withdraw", users[1]); const lost = await view(c); assert.equal(lost.accessLost, true); assert.equal(lost.visibleSources.length, 1);
    await denied(access(c.assets[1])); await denied(access(c.assets[0], users[1])); await call(access(c.assets[1], users[1]));
    await denied(`public.pb_challenge_manage(${q(users[1])},${q(c.id)},'accept')`, /PB_CHALLENGE_EXPIRED/);
  }
  console.log("2/3/4-member races reveal once; owner/couple/row/opaque-projection denial, immutable submissions and permanent withdrawal gating passed.");

  const c = await challenge(3); await call(submit(c, 0)); await call(submit(c, 1)); await manage(c, "cancel");
  await denied(submit(c, 2), /PB_CHALLENGE_EXPIRED/); await denied(access(c.assets[1]));
  const propose = id => `public.pb_challenge_propose_partial(${q(owner)},${q(c.id)},${q(id)},ARRAY[${q(owner)},${q(users[1])}]::uuid[])`;
  let partial = await call(propose(randomUUID()));
  await denied(`public.pb_challenge_commit_partial(${q(owner)},${q(partial.id)},${q(partial.digest)})`, /PB_CHALLENGE_NOT_READY/);
  await denied(`public.pb_challenge_partial_consent(${q(users[1])},${q(partial.id)},${q("0".repeat(64))},true)`);
  await call(`public.pb_challenge_partial_consent(${q(owner)},${q(partial.id)},${q(partial.digest)},true)`);
  await call(`public.pb_challenge_partial_consent(${q(users[1])},${q(partial.id)},${q(partial.digest)},false)`);
  await denied(`public.pb_challenge_commit_partial(${q(owner)},${q(partial.id)},${q(partial.digest)})`, /PB_CHALLENGE_NOT_READY/);
  await denied(access(c.assets[1]));
  const oldDigest = partial.digest; partial = await call(propose(randomUUID())); assert.notEqual(partial.digest, oldDigest);
  for (const user of users.slice(0, 2)) await call(`public.pb_challenge_partial_consent(${q(user)},${q(partial.id)},${q(partial.digest)},true)`);
  await call(`public.pb_challenge_commit_partial(${q(owner)},${q(partial.id)},${q(partial.digest)})`);
  assert.equal((await view(c)).status, "cancelled"); await call(access(c.assets[1])); await denied(access(c.assets[0], users[2]));
  await call(`public.pb_challenge_partial_consent(${q(users[1])},${q(partial.id)},${q(partial.digest)},false)`); await denied(access(c.assets[1]));

  const expired = await challenge(2); await call(submit(expired, 0));
  await sql(`UPDATE public.pb_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${q(expired.id)};`);
  await denied(submit(expired, 1), /PB_CHALLENGE_EXPIRED/); assert.equal((await call("public.pb_challenge_expire(25)")).expired, 1); await denied(access(expired.assets[0], users[1]));
  const immediate = await challenge(2, "immediate"); await call(submit(immediate, 0)); await call(access(immediate.assets[0], users[1]));
  await call(`public.pb_project_member(${q(owner)},${q(immediate.project)},${q(users[1])},'revoke')`); await denied(access(immediate.assets[0], users[1]));
  await denied(`public.pb_challenge_view(${q(users[1])},${q(immediate.id)})`); assert.equal((await view(immediate)).accessLost, true);
  const racing = await challenge(2); await call(submit(racing, 0));
  const raced = await Promise.allSettled([call(submit(racing, 1)), manage(racing, "withdraw", users[1])]);
  assert.equal(raced[1].status, "fulfilled");
  if (raced[0].status === "rejected") assert.match(String(raced[0].reason), /PB_CHALLENGE_EXPIRED|PB_CHALLENGE_DENIED/);
  assert.equal((await view(racing)).accessLost, true); await denied(access(racing.assets[1])); await denied(access(racing.assets[0], users[1]));

  for (const stop of ["cancel", "expiry", "revoke", "withdraw"]) {
    const late = await challenge(2), asset = randomUUID(), actor = users[1];
    const input = { id: asset, requestId: randomUUID(), kind: "photo", mime: "image/png", bytes: 100, width: 20, height: 20, sha256: "c".repeat(64), protection: { kind: "challenge", id: late.id } };
    const pending = await call(`public.pb_project_reserve(${q(actor)},${q(late.project)},${json(input)})`);
    await call(`public.pb_project_authorise_upload(${q(actor)},${q(asset)})`);
    await sql(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-projects-v2',${q(pending.path)},'{"size":100}');`);
    await call(`public.pb_project_enqueue_finalisation(${q(actor)},${q(asset)})`);
    const job = await call("public.pb_project_claim_finalisation()"); assert.equal(job.assetId, asset);
    if (stop === "cancel") await manage(late, "cancel");
    if (stop === "withdraw") await manage(late, "withdraw", actor);
    if (stop === "expiry") await sql(`UPDATE public.pb_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${q(late.id)};`);
    if (stop === "revoke") await call(`public.pb_project_member(${q(owner)},${q(late.project)},${q(actor)},'revoke')`);
    await sql(`DELETE FROM storage.objects WHERE bucket_id='photobooth-projects-v2' AND name=${q(pending.path)};`);
    const lateWrite = await sql(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-projects-v2',${q(pending.path)},'{"size":100}');`, true);
    assert.notEqual(lateWrite.code, 0); assert.match(lateWrite.stderr, /PB_PROJECT_DENIED/);
    await denied(`public.pb_project_authorise_upload(${q(actor)},${q(asset)})`);
    const failed = await call(`public.pb_project_finish_finalisation(${q(asset)},${q(job.leaseToken)},'verified',${json({ bytes: 100, width: 20, height: 20, mime: input.mime, sha256: input.sha256, decoded: true })})`);
    assert.equal(failed.status, "failed");
    await denied(access(asset, actor));
    const charge = await sql(`SELECT status||':'||charge_released::text FROM public.pb_project_assets WHERE id=${q(asset)};`);
    assert.equal(charge.stdout.trim(), "reserved:false");
  }
  const recipeCase = await challenge(2);
  const same = await call(`public.pb_challenge_create(${q(owner)},${q(recipeCase.project)},${json(Object.fromEntries(Object.entries(recipeCase.body).reverse()))})`);
  assert.equal(same.recipeHash, (await view(recipeCase)).recipeHash);
  await denied(`public.pb_challenge_create(${q(owner)},${q(recipeCase.project)},${json({ ...recipeCase.body, design: { ...recipeCase.body.design, defaults: { caption: "Changed", showDate: true } } })})`, /PB_CHALLENGE_CONFLICT/);
  await denied(`public.pb_challenge_create(${q(owner)},${q(recipeCase.project)},${json({ ...recipeCase.body, id: randomUUID(), recipeHash: "0".repeat(64) })})`, /PB_CHALLENGE_INVALID/);
  await denied(`public.pb_challenge_create(${q(owner)},${q(recipeCase.project)},${json({ ...recipeCase.body, id: randomUUID(), assignments: [...recipeCase.body.assignments].reverse() })})`, /PB_CHALLENGE_INVALID/);
  const repeated = { ...recipeCase.body, id: randomUUID(), design: { ...recipeCase.body.design, slots: [...recipeCase.body.design.slots, { ...recipeCase.body.design.slots[0], id: "repeat" }] } };
  assert.equal((await call(`public.pb_challenge_create(${q(owner)},${q(recipeCase.project)},${json(repeated)})`)).assignments.length, 2);
  const sparse = { ...recipeCase.body, id: randomUUID(), design: { ...recipeCase.body.design, requiredSources: { A: 3, B: 4 }, slots: [{ ...recipeCase.body.design.slots[0], sourceIndex: 2, companions: [{ role: "B", sourceIndex: 3, crop: recipeCase.body.design.slots[1].crop }] }] }, assignments: [{ slot: 0, userId: owner, sourceIndex: 2 }, { slot: 1, userId: users[1], sourceIndex: 3 }] };
  assert.deepEqual((await call(`public.pb_challenge_create(${q(owner)},${q(recipeCase.project)},${json(sparse)})`)).assignments, sparse.assignments);
  await denied(`public.pb_challenge_create(${q(owner)},${q(recipeCase.project)},${json({ ...sparse, id: randomUUID(), design: { ...sparse.design, requiredSources: { A: 1, B: 1 } } })})`, /PB_CHALLENGE_INVALID/);
  const decorId = randomUUID(), decorationInput = { id: decorId, requestId: randomUUID(), kind: "decoration", mime: "image/png", bytes: 100, width: 20, height: 20, sha256: "d".repeat(64), protection: { kind: "none", id: null } };
  const decoration = { id: decorId, kind: "decoration", mime: "image/png", bytes: 100, width: 20, height: 20 };
  const decorated = { ...recipeCase.body, id: randomUUID(), design: { ...recipeCase.body.design, decorations: [decoration], layers: [{ id: "png-layer", kind: "decoration", mediaId: decorId, fit: "contain", x: 0, y: 0, width: 0.1, height: 0.1, rotation: 0 }] } };
  await denied(`public.pb_challenge_create(${q(owner)},${q(recipeCase.project)},${json(decorated)})`);
  const decorReservation = await call(`public.pb_project_reserve(${q(owner)},${q(recipeCase.project)},${json(decorationInput)})`);
  await call(`public.pb_project_authorise_upload(${q(owner)},${q(decorId)})`);
  await sql(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-projects-v2',${q(decorReservation.path)},'{"size":100}');`);
  await call(`public.pb_project_enqueue_finalisation(${q(owner)},${q(decorId)})`); const decorJob = await call("public.pb_project_claim_finalisation()"); assert.equal(decorJob.assetId, decorId);
  await call(`public.pb_project_finish_finalisation(${q(decorId)},${q(decorJob.leaseToken)},'verified',${json({ bytes: 100, width: 20, height: 20, mime: "image/png", sha256: decorationInput.sha256, decoded: true })})`);
  await call(`public.pb_challenge_create(${q(owner)},${q(recipeCase.project)},${json(decorated)})`);
  await denied(`public.pb_challenge_create(${q(owner)},${q(c.project)},${json({ ...decorated, id: randomUUID() })})`);
  await denied(`public.pb_challenge_create(${q(owner)},${q(recipeCase.project)},${json({ ...decorated, id: randomUUID(), design: { ...decorated.design, decorations: [{ ...decoration, bytes: 99 }] } })})`);
  await sql(`UPDATE public.pb_project_assets SET protection='challenge',protection_id=${q(recipeCase.id)} WHERE id=${q(decorId)};`);
  await denied(`public.pb_challenge_create(${q(owner)},${q(recipeCase.project)},${json({ ...decorated, id: randomUUID() })})`);
  const legacy = randomUUID();
  await sql(`INSERT INTO public.pb_challenges(id,project_id,initiator_id,fingerprint,recipe_hash,policy,expires_at) VALUES(${q(legacy)},${q(recipeCase.project)},${q(owner)},'{}',${q("0".repeat(64))},'all_submitted',clock_timestamp()+interval '1 day'); INSERT INTO public.pb_challenge_members VALUES(${q(legacy)},${q(owner)},'A','accepted'),(${q(legacy)},${q(users[1])},'B','accepted');`);
  assert.deepEqual(await call(`public.pb_challenge_view(${q(owner)},${q(legacy)})`), { id: legacy, projectId: recipeCase.project, unsupported: true, reason: "recipe_unavailable" });
  await denied(`public.pb_challenge_manage(${q(owner)},${q(legacy)},'open')`, /PB_CHALLENGE_UPDATE_REQUIRED/);
  for (const state of ["pending", "revealed"]) {
    const legacyPartial = randomUUID(), digest = "e".repeat(64);
    await sql(`INSERT INTO public.pb_challenge_partials(id,challenge_id,proposer_id,snapshot,digest,status,revealed_at) VALUES(${q(legacyPartial)},${q(legacy)},${q(owner)},'{"oldPrivateSnapshot":true}',${q(digest)},${q(state)},${state === "revealed" ? "clock_timestamp()" : "NULL"}); INSERT INTO public.pb_challenge_partial_members(partial_id,user_id,consent) VALUES(${q(legacyPartial)},${q(owner)},${state === "revealed" ? "true" : "NULL"});`);
    const unavailable = { id: legacyPartial, challengeId: legacy, unsupported: true, reason: "recipe_unavailable" };
    assert.deepEqual(await call(`public.pb_challenge_partial_view(${q(owner)},${q(legacyPartial)})`), unavailable);
    for (const consent of ["true", "false"]) await denied(`public.pb_challenge_partial_consent(${q(owner)},${q(legacyPartial)},${q(digest)},${consent})`, /PB_CHALLENGE_UPDATE_REQUIRED/);
    await denied(`public.pb_challenge_commit_partial(${q(owner)},${q(legacyPartial)},${q(digest)})`, /PB_CHALLENGE_UPDATE_REQUIRED/);
    assert.equal((await sql(`SELECT r.status||':'||coalesce(m.consent::text,'null') FROM public.pb_challenge_partials r JOIN public.pb_challenge_partial_members m ON m.partial_id=r.id WHERE r.id=${q(legacyPartial)};`)).stdout.trim(), `${state}:${state === "revealed" ? "true" : "null"}`);
  }
  await denied(`public.pb_challenge_propose_partial(${q(owner)},${q(legacy)},${q(randomUUID())},ARRAY[${q(owner)}]::uuid[])`, /PB_CHALLENGE_UPDATE_REQUIRED/);
  console.log("Frozen recipe hash/key-order stability, immutable retries, sparse/repeated/companion assignments, missing/foreign/protected/mismatched decorations and legacy unavailable projection passed.");
  const capped = await challenge(2);
  for (let i = 1; i < 31; i++) await call(`public.pb_challenge_create(${q(owner)},${q(capped.project)},${json({ ...capped.body, id: randomUUID() })})`);
  const additions = await Promise.all(Array.from({ length: 6 }, () => sql(`${service} SELECT public.pb_challenge_create(${q(owner)},${q(capped.project)},${json({ ...capped.body, id: randomUUID() })});`, true)));
  assert.equal(additions.filter(r => r.code === 0).length, 1);
  for (const result of additions.filter(r => r.code !== 0)) assert.match(result.stderr, /PB_CHALLENGE_CAPACITY/);
  await call(`public.pb_challenge_create(${q(owner)},${q(capped.project)},${json(capped.body)})`);
  assert.equal((await sql(`SELECT count(*) FROM public.pb_challenges WHERE project_id=${q(capped.project)};`)).stdout.trim(), "32");
  for (let i = 2; i < 19; i++) await call(propose(randomUUID()));
  const proposals = await Promise.all(Array.from({ length: 6 }, () => sql(`${service} SELECT ${propose(randomUUID())};`, true)));
  assert.equal(proposals.filter(r => r.code === 0).length, 1);
  for (const result of proposals.filter(r => r.code !== 0)) assert.match(result.stderr, /PB_CHALLENGE_CAPACITY/);
  await call(propose(partial.id));
  assert.equal((await sql(`SELECT count(*) FROM public.pb_challenge_partials WHERE challenge_id=${q(c.id)};`)).stdout.trim(), "20");
  console.log("Concurrent metadata ceilings, final-submit versus withdrawal, and protected late finalisation after cancel/expiry/revoke/withdraw passed; failed uploads retain charges.");
  await sql("CREATE POLICY fixture_permissive_storage ON storage.objects FOR SELECT TO authenticated USING(true);");
  assert.equal((await sql("SET ROLE authenticated; SELECT count(*) FROM storage.objects WHERE bucket_id='photobooth-projects-v2';")).stdout.trim(), "0");
  await sql(migration); await denied(access(c.assets[1]));
  console.log("Cancellation/expiry never reveal; stale/refused/withdrawn partial consent, exact recipient scope, immediate-policy reads, member revocation and populated rerun passed.");
  console.log("Disposable PostgreSQL metadata fixtures only. No hosted SQL, actual codec, Storage mint/upload, cache or browser API exercised.");
} finally { const result = await docker(["exec", container, "dropdb", "-U", "postgres", "--force", database]); if (result.code) throw new Error(result.stderr); }
