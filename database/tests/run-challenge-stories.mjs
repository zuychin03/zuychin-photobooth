import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parsePartialDetail, parseChallengeUploadList } from "../../lib/memories/challenge-contract.ts";
const container = process.env.PB_TEST_CONTAINER ?? "pb-v2-p1-postgres";
if (!/^pb-v2-[a-z0-9-]+$/.test(container)) throw new Error("Use a task-owned pb-v2-* container");
const database = `pb_v2_story_${Date.now()}`;
const docker = (args, input = "") => new Promise((resolve, reject) => {
  const child = spawn("docker", ["--context", "desktop-linux", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", v => { stdout += v; }); child.stderr.on("data", v => { stderr += v; }); child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end(input);
});
const sql = async (source, failure = false) => { const r = await docker(["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database], source); if (r.code && !failure) throw new Error(r.stderr); return r; };
const q = value => `'${String(value).replaceAll("'", "''")}'`, json = value => `${q(JSON.stringify(value))}::jsonb`, service = "SET ROLE service_role; SET request.jwt.claim.role='service_role'; ";
const call = async expression => JSON.parse((await sql(`${service} SELECT ${expression};`)).stdout.trim());
const denied = async expression => { const r = await sql(`${service} SELECT ${expression};`, true); assert.notEqual(r.code, 0); assert.match(r.stderr, /PB_CHALLENGE_DENIED|PB_PROJECT_DENIED/); };
const users = Array.from({ length: 5 }, () => randomUUID()), [owner, guest, excluded, stranger] = users;
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
const consent = (p, actor, yes = true) => call(`public.pb_challenge_partial_consent(${q(actor)},${q(p.id)},${q(p.digest)},${yes})`);
const commit = p => call(`public.pb_challenge_commit_partial(${q(owner)},${q(p.id)},${q(p.digest)})`);
const created = await docker(["exec", container, "createdb", "-U", "postgres", database]); assert.equal(created.code, 0, created.stderr);
try {
  await sql(await readFile(new URL("./bootstrap.sql", import.meta.url), "utf8"));
  await sql("CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);");
  await sql((await readFile(new URL("../../supabase-setup.sql", import.meta.url), "utf8")).split("-- BEGIN PB_LIFECYCLE_V1")[0]);
  for (const name of ["001_v2_lifecycle.sql", "002_v2_projects.sql", "004_v2_memories.sql", "007_v2_challenge_discovery.sql", "008_v2_partial_results.sql"]) await sql(await readFile(new URL('../migrations/'+name, import.meta.url), "utf8"));
  await call("public.pb_project_configure(1073741824)");
  await sql('INSERT INTO auth.users(id,email) VALUES '+users.map((u,i)=>'('+q(u)+','+q('story-'+i+'@example.invalid')+')').join(',')+';');
  const legacy = await fixture(), partial = await propose(legacy); await consent(partial,owner); await consent(partial,guest); await commit(partial);
  const before = await call(detailSql(partial));
  const fingerprint = JSON.parse((await sql('SELECT fingerprint FROM public.pb_challenges WHERE id='+q(legacy.id))).stdout.trim());
  const old = await call('public.pb_challenge_view('+q(owner)+','+q(legacy.id)+')');
  const migration = await readFile(new URL('../migrations/015_v2_challenge_stories.sql',import.meta.url),'utf8'); await sql(migration); await sql(migration);
  assert.equal((await call('public.pb_challenge_capabilities()')).storyVersion,1);
  assert.deepEqual(await call(detailSql(partial)),before);
  assert.deepEqual(await call('public.pb_challenge_create('+q(owner)+','+q(legacy.project)+','+json(fingerprint)+')'),old);
  assert.deepEqual(await call('public.pb_challenge_create('+q(owner)+','+q(legacy.project)+','+json({...fingerprint,story:null})+')'),old);
  const story={version:1,deckId:'little-hello',seed:42,relaxedSteps:[1,3]};
  const guidedDesign={...design,requiredSources:{A:3,B:4},slots:Array.from({length:4},(_,i)=>({id:'slot-'+i,x:0,y:i/4,width:1,height:0.25,...source(i%2?'B':'A',i)})),layers:[],places:{A:design.places.A,B:design.places.B}};
  const body={id:randomUUID(),design:guidedDesign,policy:'all_submitted',expiresAt:'2030-01-01T00:00:00Z',members:[{userId:owner,role:'A'},{userId:guest,role:'B'}],assignments:[{slot:0,userId:owner,sourceIndex:0},{slot:1,userId:owner,sourceIndex:2},{slot:2,userId:guest,sourceIndex:1},{slot:3,userId:guest,sourceIndex:3}],story};
  const create=b=>call('public.pb_challenge_create('+q(owner)+','+q(legacy.project)+','+json(b)+')');
  const guided=await create(body); assert.deepEqual(guided.story,story); assert.equal(guided.visibleSources.length,0); assert.deepEqual(await create(body),guided);
  for(const replay of await Promise.all(Array.from({length:4},()=>create(body)))) assert.deepEqual(replay,guided);
  const conflict=await sql(service+'SELECT public.pb_challenge_create('+q(owner)+','+q(legacy.project)+','+json({...body,story:{...story,seed:43}})+');',true); assert.match(conflict.stderr,/PB_CHALLENGE_CONFLICT/);
  for(const bad of [{...story,seed:-1},{...story,seed:4294967296},{...story,deckId:'arbitrary'},{...story,relaxedSteps:[1,1]},{...story,relaxedSteps:[3,1]},{...story,token:'secret'}]) {
    const r=await sql(service+'SELECT public.pb_challenge_create('+q(owner)+','+q(legacy.project)+','+json({...body,id:randomUUID(),story:bad})+');',true); assert.notEqual(r.code,0); assert.match(r.stderr,/PB_CHALLENGE_INVALID/);
  }
  const short={...fingerprint,id:randomUUID(),story}; const deniedShort=await sql(service+'SELECT public.pb_challenge_create('+q(owner)+','+q(legacy.project)+','+json(short)+');',true); assert.match(deniedShort.stderr,/PB_CHALLENGE_INVALID/);
  const unguided=await create({...body,id:randomUUID(),story:null}); assert.notEqual(guided.recipeHash,unguided.recipeHash); assert(!Object.hasOwn(unguided,'story'));
  await call('public.pb_challenge_manage('+q(guest)+','+q(body.id)+','+q('accept')+')'); await call('public.pb_challenge_manage('+q(owner)+','+q(body.id)+','+q('open')+')');
  const own=[]; for(const sourceIndex of [0,2]) own.push({sourceIndex,assetId:await readyAsset(legacy.project,body.id,owner)});
  await call('public.pb_challenge_submit('+q(owner)+','+q(body.id)+','+json({requestId:randomUUID(),sources:own})+')');
  const guestView=await call('public.pb_challenge_view('+q(guest)+','+q(body.id)+')'); assert.deepEqual(guestView.visibleSources,[]); assert.deepEqual(guestView.story,story);
  await denied('public.pb_project_asset_access('+q(guest)+','+q(own[0].assetId)+')');
  const p=await propose({id:body.id},[owner]); await consent(p,owner); await commit(p);
  const details=await call(detailSql(p)); parsePartialDetail(details,p.id,p.digest,owner); assert.equal(details.result.recipeHash,guided.recipeHash); assert.deepEqual(details.result.sources.map(s=>s.sourceIndex),[0,2]);
  await sql(migration); assert.deepEqual(await call(detailSql(p)),details); assert.deepEqual(await call(detailSql(partial)),before);
  for(const role of ['anon','authenticated']) { const r=await sql('SET ROLE '+role+'; SELECT public.pb_challenge_view('+q(owner)+','+q(body.id)+');',true); assert.notEqual(r.code,0); }
  await call('public.pb_project_member('+q(owner)+','+q(legacy.project)+','+q(guest)+','+q('revoke')+')'); await denied('public.pb_challenge_view('+q(guest)+','+q(body.id)+')');
  console.log('Challenge story SQL passed: legacy identity/hash/partial preservation, populated reruns, guided sparse steps, frozen hash/retry, malformed input validation, concealed source gate, guided partial read, service-only and membership revocation.');
} finally { const dropped=await docker(['exec',container,'dropdb','-U','postgres','--force',database]); assert.equal(dropped.code,0,dropped.stderr); }
