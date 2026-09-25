import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

const container = process.env.PB_TEST_CONTAINER ?? "pb-v2-p1-postgres";
if (!/^pb-v2-[a-z0-9-]+$/.test(container)) throw new Error("Task-owned local container required");
const database = `pb_v2_full_chain_${Date.now()}`;
const docker = (args, input = "") => new Promise((resolve, reject) => {
  const child = spawn("docker", ["--context", "desktop-linux", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; const timer = setTimeout(() => child.kill(), 120000);
  child.stdout.on("data", v => { stdout += v; }); child.stderr.on("data", v => { stderr += v; });
  child.on("error", error => { clearTimeout(timer); reject(error); }); child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); }); child.stdin.end(input);
});
const sql = async (source, failure = false) => { const r = await docker(["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database], source); if (r.code && !failure) throw new Error(r.stderr.slice(-7000)); return r; };
const q = v => `'${String(v).replaceAll("'", "''")}'`, j = v => `${q(JSON.stringify(v))}::jsonb`, service = "SET ROLE service_role; SET request.jwt.claim.role='service_role'; ";
const call = async expression => JSON.parse((await sql(`${service} SELECT to_jsonb(${expression});`)).stdout.trim());
const deny = async (expression, pattern = /PB_EVENT_NOT_READY/) => { const r = await sql(`${service} SELECT ${expression};`, true); assert.notEqual(r.code, 0); assert.match(r.stderr, pattern); };
const names = (await readdir(new URL("../migrations/", import.meta.url))).filter(v => /^\d{3}_.*\.sql$/.test(v)).sort();
assert.deepEqual(names.map(v => Number(v.slice(0, 3))), Array.from({ length: names.length }, (_, i) => i + 1)); assert(names.length >= 27);
const baseline = await readFile(new URL("../../supabase-setup.sql", import.meta.url), "utf8");
const lifecycle = await readFile(new URL("../migrations/001_v2_lifecycle.sql", import.meta.url), "utf8");
assert.equal(baseline.split("-- BEGIN PB_LIFECYCLE_V1")[1].split("-- END PB_LIFECYCLE_V1")[0].trim().replaceAll("\r\n", "\n"), lifecycle.trim().replaceAll("\r\n", "\n"), "The setup baseline must contain the exact reviewed001 migration");
async function applyChain(label) {
  await sql(baseline);
  for (const name of names.slice(1)) {
    try { await sql(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8")); }
    catch (error) { throw new Error(`${label}: ${name}: ${error.message}`); }
  }
  console.log(`${label}: baseline including001 plus002-${names.at(-1).slice(0, 3)} applied`);
}
const owner = randomUUID(), friend = randomUUID(), event = randomUUID(), guests = [randomUUID(), randomUUID()], hashes = ["a".repeat(64), "b".repeat(64)];
const expiry = new Date(Date.now() + 86400000).toISOString(), project = randomUUID(), challenge = randomUUID();
const design = { canvas: { width: 536, height: 1600 }, requiredSources: { A: 1, B: 1 }, slots: ["A", "B"].map((role, i) => ({ id: `slot-${i}`, role, sourceIndex: 0, x: 0, y: i / 2, width: 1, height: .5, crop: { zoom: 1, offsetX: 0, offsetY: 0, rotation: 0, mirror: false } })), layers: [], decorations: [], look: { frameId: "film", filterId: "none", patternId: "none", themeId: null, sceneId: null, materialId: null }, defaults: { caption: "Synthetic chain fixture", showDate: false } };
const ordinary = { sub: randomUUID(), request: randomUUID(), receipt: "c".repeat(64) };
const reserve = (s = ordinary) => `public.pb_event_reserve(${q(event)},${q(hashes[0])},${q(s.sub)},${q(s.request)},${q(s.receipt)},ARRAY[${q(guests[0])}]::uuid[],'{"submission":true,"gallery":false,"wall":false}')`;
const device = randomUUID(), deviceHash = "d".repeat(64), kioskGuest = randomUUID(), contribution = "e".repeat(64), kioskSub = randomUUID(), kioskRequest = randomUUID();
const approval = { sha256: "f".repeat(64), bytes: 100, width: 20, height: 30, mime: "image/jpeg", consent: { submission: true, gallery: false, wall: false }, missionId: null };
const kioskReserve = (sub = kioskSub, request = kioskRequest) => `public.pb_event_kiosk_reserve(${q(event)},${q(deviceHash)},0,${q(kioskGuest)},${q(contribution)},${q(sub)},${q(request)},${q("1".repeat(64))},${j(approval)})`;
const room = randomUUID(), capture = randomUUID(), members = [randomUUID(), randomUUID()], roomHashes = ["2".repeat(64), "3".repeat(64)], postcard = randomUUID(), postcardSub = randomUUID(), postcardRequest = randomUUID();
const postcardReserve = () => `public.pb_event_postcard_reserve(${q(event)},${q(hashes[0])},${q(guests[0])},${q(postcard)},${q(postcardRequest)},${q("4".repeat(64))})`;
const pause = (value, revision) => `public.pb_event_admission_control(${value},${revision})`;
async function finalise(sub, hash, proof = {}) {
  await call(`public.pb_event_authorise_upload(${q(event)},${q(hash)},${q(sub)})`);
  await sql(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-event-images-staging-v2',${q(`${event}/${sub}/source`)},'{"size":100}');`);
  await call(`public.pb_event_enqueue_finalise(${q(event)},${q(hash)},${q(sub)})`);
  const [job] = await call("public.pb_event_claim_jobs(1)"); assert.equal(job.submission_id, sub);
  await sql(`${service} INSERT INTO storage.objects(bucket_id,name,metadata,user_metadata) VALUES('photobooth-events-v2',${q(`${event}/${sub}/image`)},'{"size":100}',${j({ eventJobId: job.id, eventLease: job.lease_token })}),('photobooth-events-v2',${q(`${event}/${sub}/thumbnail`)},'{"size":20}',${j({ eventJobId: job.id, eventLease: job.lease_token })});`);
  await call(`public.pb_event_checkpoint_job(${q(job.id)},${q(job.lease_token)},${j({ decoded: true, objectsVerified: true, mime: "image/jpeg", width: 20, height: 30, sha256: "5".repeat(64), ...proof })})`);
  await call(`public.pb_event_finish_job(${q(job.id)},${q(job.lease_token)},'complete')`);
}
async function boundaryChecks() {
  for (const [fn, marker] of [["pb_project_capabilities", "apiVersion"], ["pb_challenge_capabilities", "storyVersion"], ["pb_challenge_capabilities", "partialVersion"], ["pb_ritual_capabilities", "deliveryVersion"], ["pb_event_publication_capabilities", "publicationVersion"], ["pb_event_kiosk_capabilities", "version"], ["pb_event_postcard_capabilities", "version"], ["pb_event_own_consent_capabilities", "version"]]) assert.equal((await call(`public.${fn}()`))[marker], 1, fn);
  assert.equal((await call("public.pb_project_design_capabilities()")).exportSettingsVersion, 1);
  for (const role of ["anon", "authenticated"]) {
    const r = await sql(`SET ROLE ${role}; SET request.jwt.claim.role='${role}'; SELECT public.pb_event_admission_control(true,0);`, true); assert.notEqual(r.code, 0); assert.match(r.stderr, /permission denied/);
  }
  const missing = await sql(`BEGIN; DELETE FROM public.pb_event_worker_health; ${service} SELECT public.pb_event_admission_control(true,0); COMMIT;`, true);
  assert.notEqual(missing.code, 0); assert.match(missing.stderr, /PB_EVENT_NOT_READY/);
  const exposed = await sql("SELECT proname FROM pg_proc p WHERE pronamespace='public'::regnamespace AND proname LIKE 'pb_%before%' AND has_function_privilege('service_role',p.oid,'EXECUTE');");
  assert.equal(exposed.stdout.trim(), "", "Internal previous-generation functions must remain unavailable to service callers");
  const buckets = await sql("SELECT id FROM storage.buckets WHERE public OR file_size_limit IS NULL OR allowed_mime_types IS NULL;"); assert.equal(buckets.stdout.trim(), "");
}
assert.equal((await docker(["exec", container, "createdb", "-U", "postgres", database])).code, 0);
try {
  await sql(await readFile(new URL("./bootstrap.sql", import.meta.url), "utf8"));
  await sql("ALTER TABLE auth.users ADD COLUMN email_confirmed_at timestamptz; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); ALTER TABLE storage.objects ADD COLUMN user_metadata jsonb;");
  await applyChain("Fresh"); await boundaryChecks();
  await sql(`INSERT INTO auth.users(id,email,email_confirmed_at) VALUES(${q(owner)},'chain-owner@example.invalid',now()),(${q(friend)},'chain-friend@example.invalid',now());`);
  await call("public.pb_configure_lifecycle('Australia/Sydney')"); await call("public.pb_project_configure(268435456)"); await call("public.pb_event_configure(500000000)");
  await call(`public.pb_project_create(${q(owner)},${q(project)},'friend','Chain project',67108864)`);
  await call(`public.pb_project_member(${q(owner)},${q(project)},${q(friend)},'invite')`);
  const challengeBody = { id: challenge, design, policy: "all_submitted", expiresAt: expiry, members: [owner, friend].map((userId, i) => ({ userId, role: "AB"[i] })), assignments: [owner, friend].map((userId, slot) => ({ slot, userId, sourceIndex: 0 })) };
  await call(`public.pb_challenge_create(${q(owner)},${q(project)},${j(challengeBody)})`); await call(`public.pb_challenge_manage(${q(friend)},${q(challenge)},'accept')`); await call(`public.pb_challenge_manage(${q(owner)},${q(challenge)},'open')`);
  const frozenChallenge = await call(`public.pb_challenge_view(${q(owner)},${q(challenge)})`);
  const eventBody = { title: "Full chain fixture", timezone: "Australia/Sydney", startsAt: new Date(Date.now() - 60000).toISOString(), closesAt: new Date(Date.now() + 3600000).toISOString(), expiresAt: expiry, maxGuests: 25, maxContributions: 100, maxBytes: 250000000 };
  await call(`public.pb_event_create(${q(owner)},${q(event)},${j(eventBody)})`); await call(`public.pb_event_manage(${q(owner)},${q(event)},'open','{}')`); await call(`public.pb_event_manage(${q(owner)},${q(event)},'invite',${j({ hash: "6".repeat(64), expiresAt: expiry })})`);
  for (let i = 0; i < 2; i++) await call(`public.pb_event_redeem(${q(event)},${q("6".repeat(64))},${q(guests[i])},${q(hashes[i])})`);
  await call("public.pb_event_worker_verified()"); await call(reserve()); await finalise(ordinary.sub, hashes[0]);
  await call(`public.pb_event_kiosk_create(${q(owner)},${q(event)},${q(device)},${q(deviceHash)},${q("7".repeat(64))})`); await call(`public.pb_event_kiosk_begin(${q(event)},${q(deviceHash)},0,${q(kioskGuest)},${q(contribution)})`);
  await call(kioskReserve()); await finalise(kioskSub, contribution, { sourceSha256: approval.sha256, sourceBytes: approval.bytes, sourceWidth: approval.width, sourceHeight: approval.height });
  await call(`public.pb_room_create(${q(room)},${q(members[0])},'ZXCVB2',${q(roomHashes[0])},'Alex',${q("8".repeat(64))})`);
  await sql(`INSERT INTO public.pb_room_members(id,room_id,role,display_name,status,expires_at) VALUES(${q(members[1])},${q(room)},'B','Bao','admitted',now()+interval '2 hours'); INSERT INTO public.pb_room_capabilities VALUES(${q(roomHashes[1])},${q(room)},${q(members[1])},'member',now()+interval '2 hours',false); INSERT INTO public.pb_room_captures(id,room_id,proposal,member_ids,state) VALUES(${q(capture)},${q(room)},${j({ recipeHash: "9".repeat(64), shotIds: ["photo1"] })},ARRAY[${members.map(q).join(",")}]::uuid[],'committed');`);
  for (let i = 0; i < 2; i++) {
    const ticket = String(i + 10).repeat(32);
    await call(`public.pb_event_postcard_ticket(${q(event)},${q(hashes[i])},${q(guests[i])},${q(postcard)},${q(randomUUID())},${q(ticket)})`);
    await call(`public.pb_event_postcard_attach(${q(event)},${q(ticket)},${q(postcard)},${q(postcardSub)},${j({ kind: "room", id: room, captureId: capture })},${j(design)},NULL,${q(roomHashes[i])})`);
  }
  for (let i = 0; i < 2; i++) { const v = await call(`public.pb_event_postcard_view(${q(event)},${q(hashes[i])},${q(guests[i])},${q(postcard)})`); await call(`public.pb_event_postcard_consent(${q(event)},${q(hashes[i])},${q(guests[i])},${q(postcard)},${v.revision},'{"submission":true,"gallery":false,"wall":false}')`); }
  const uncertain = ["a2", "a3"].map(hex => ({ sub: randomUUID(), request: randomUUID(), receipt: hex.repeat(32) }));
  for (const item of uncertain) await call(reserve(item));
  await call(`public.pb_event_authorise_upload(${q(event)},${q(hashes[0])},${q(uncertain[1].sub)})`);
  const beforePauseIntents = (await sql(`SELECT jsonb_agg(to_jsonb(u) ORDER BY submission_id)::text FROM public.pb_event_upload_intents u WHERE submission_id IN(${uncertain.map(v => q(v.sub)).join(",")});`)).stdout.trim();
  assert.deepEqual(await call(pause(true, 0)), { version: 1, paused: true, revision: 1 });
  assert.equal((await call("public.pb_event_worker_verified()")).ready, false);
  await deny(reserve({ sub: randomUUID(), request: randomUUID(), receipt: "0".repeat(64) }));
  await deny(kioskReserve(randomUUID(), randomUUID())); await deny(postcardReserve());
  await deny(`public.pb_event_authorise_upload(${q(event)},${q(hashes[0])},${q(ordinary.sub)})`);
  for (const item of uncertain) {
    assert.equal((await call(reserve(item))).submissionId, item.sub);
    await deny(`public.pb_event_authorise_upload(${q(event)},${q(hashes[0])},${q(item.sub)})`);
    assert.equal(Number((await sql(`SELECT count(*) FROM public.pb_event_submissions WHERE event_id=${q(event)} AND request_id=${q(item.request)};`)).stdout.trim()), 1);
  }
  assert.equal((await sql(`SELECT jsonb_agg(to_jsonb(u) ORDER BY submission_id)::text FROM public.pb_event_upload_intents u WHERE submission_id IN(${uncertain.map(v => q(v.sub)).join(",")});`)).stdout.trim(), beforePauseIntents, "Lost reserve or mint acknowledgement may replay identity but cannot mint another generation while paused");
  for (const item of uncertain) await call(`public.pb_event_consent(${q(event)},${q(hashes[0])},${q(item.sub)},'{"submission":false,"gallery":false,"wall":false}')`);
  assert.equal((await call(reserve())).submissionId, ordinary.sub); assert.equal((await call(kioskReserve())).submissionId, kioskSub);
  assert.equal((await call(`public.pb_event_receipt(${q(event)},${q(ordinary.receipt)},${q(ordinary.sub)})`)).state, "ready");
  const snapshot = (await sql(`SELECT jsonb_agg(to_jsonb(s) ORDER BY id)::text FROM public.pb_event_submissions s;`)).stdout.trim();
  await applyChain("Populated rerun"); await boundaryChecks();
  assert.equal((await sql(`SELECT jsonb_agg(to_jsonb(s) ORDER BY id)::text FROM public.pb_event_submissions s;`)).stdout.trim(), snapshot);
  assert.equal((await call(`public.pb_challenge_view(${q(owner)},${q(challenge)})`)).recipeHash, frozenChallenge.recipeHash);
  assert.deepEqual(await call("public.pb_event_admission_control()"), { version: 1, paused: true, revision: 1 });
  assert.equal((await call("public.pb_event_worker_verified()")).ready, false); await deny(postcardReserve());
  await deny(pause(false, 0), /PB_EVENT_CONFLICT/); await call(pause(false, 1)); await call(postcardReserve());
  await call(`public.pb_event_authorise_upload(${q(event)},${q(hashes[0])},${q(postcardSub)})`);
  await sql(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-event-images-staging-v2',${q(`${event}/${postcardSub}/source`)},'{"size":100}');`);
  await call(pause(true, 2)); await call(postcardReserve());
  await call(`public.pb_event_enqueue_finalise(${q(event)},${q(hashes[0])},${q(postcardSub)})`);
  const [pending] = await call("public.pb_event_claim_jobs(1)"); assert.equal(pending.submission_id, postcardSub);
  await sql(`${service} INSERT INTO storage.objects(bucket_id,name,metadata,user_metadata) VALUES('photobooth-events-v2',${q(`${event}/${postcardSub}/image`)},'{"size":100}',${j({ eventJobId: pending.id, eventLease: pending.lease_token })}),('photobooth-events-v2',${q(`${event}/${postcardSub}/thumbnail`)},'{"size":20}',${j({ eventJobId: pending.id, eventLease: pending.lease_token })});`);
  await call(`public.pb_event_checkpoint_job(${q(pending.id)},${q(pending.lease_token)},${j({ decoded: true, objectsVerified: true, mime: "image/jpeg", width: 20, height: 30, sha256: "5".repeat(64) })})`);
  await call(`public.pb_event_finish_job(${q(pending.id)},${q(pending.lease_token)},'complete')`);
  for (let i = 0; i < 2; i++) await call(`public.pb_event_postcard_approve(${q(event)},${q(hashes[i])},${q(guests[i])},${q(postcard)},${q("5".repeat(64))})`);
  await call("public.pb_event_sweep(25)"); await call("public.pb_event_worker_verified()");
  assert.equal((await call("public.pb_event_worker_status()")).ready, false);
  assert.equal((await call(`public.pb_event_receipt(${q(event)},${q("4".repeat(64))},${q(postcardSub)})`)).state, "ready");
  const publication = await call(`public.pb_event_publication_list(${q(owner)},${q(event)},NULL,12)`), entry = publication.entries.find(v => v.submissionId === ordinary.sub);
  await call(`public.pb_event_publication_remove(${q(owner)},${q(event)},${q(ordinary.sub)},${entry.revision})`);
  const cleanup = (await call("public.pb_event_claim_jobs(10)")).find(job => job.submission_id === ordinary.sub && job.kind === "delete_delivery"); assert(cleanup, "The paused worker must claim the retained delivery cleanup");
  await call(`public.pb_event_checkpoint_job(${q(cleanup.id)},${q(cleanup.lease_token)},'{"deleted":true}')`);
  await deny(`public.pb_event_finish_job(${q(cleanup.id)},${q(cleanup.lease_token)},'complete')`);
  assert.equal(Number((await sql(`SELECT derivative_held_bytes FROM public.pb_event_submissions WHERE id=${q(ordinary.sub)};`)).stdout.trim()), 120);
  await sql(`DELETE FROM storage.objects WHERE bucket_id='photobooth-events-v2' AND name IN(${q(`${event}/${ordinary.sub}/image`)},${q(`${event}/${ordinary.sub}/thumbnail`)});`);
  await call(`public.pb_event_finish_job(${q(cleanup.id)},${q(cleanup.lease_token)},'complete')`);
  assert.equal(Number((await sql(`SELECT derivative_held_bytes FROM public.pb_event_submissions WHERE id=${q(ordinary.sub)};`)).stdout.trim()), 0);
  await call(pause(false, 3));
  const blocking = sql(`SET application_name='pb-chain-pause'; BEGIN; ${service} SELECT ${pause(true, 4)}; SELECT pg_sleep(10); COMMIT;`);
  let locked = false;
  for (let i = 0; i < 10; i++) { if ((await sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='pb-chain-pause' AND wait_event='PgSleep';")).stdout.trim() === "1") { locked = true; break; } }
  assert(locked, "Pause transaction must hold the admission lock before racing a reservation");
  const racing = sql(`SET application_name='pb-chain-reserve'; ${service} SELECT ${reserve({ sub: randomUUID(), request: randomUUID(), receipt: "0".repeat(64) })};`, true);
  let waiting = false;
  for (let i = 0; i < 10; i++) { if ((await sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='pb-chain-reserve' AND wait_event_type='Lock';")).stdout.trim() === "1") { waiting = true; break; } }
  assert(waiting, "A concurrent reservation must wait on the operator pause before checking admission");
  const refused = await racing; assert.notEqual(refused.code, 0); assert.match(refused.stderr, /PB_EVENT_NOT_READY/); await blocking;
  assert.deepEqual(await call("public.pb_event_admission_control()"), { version: 1, paused: true, revision: 5 });
  await call("public.pb_event_worker_verified()"); assert.equal((await call("public.pb_event_worker_status()")).ready, false);
  console.log(`Full001-${names.at(-1).slice(0, 3)} passed: fresh/populated chain, final capabilities/grants/private buckets, frozen challenge, ordinary+kiosk completion, durable pause/replay/mint denial, paused postcard completion and verified cleanup, concurrent pause/reservation fencing.`);
} finally { const r = await docker(["exec", container, "dropdb", "--force", "-U", "postgres", database]); if (r.code) throw new Error(r.stderr); }
