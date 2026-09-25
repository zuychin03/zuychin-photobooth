import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createEventPostcardStore } from "../../lib/server/event-postcard-store.ts";
import { validateTemplateDesign } from "../../lib/templates/model.ts";
const container = process.env.PB_TEST_CONTAINER ?? "pb-v2-p1-postgres", database = `pb_v2_postcards_${Date.now()}`;
if (!/^pb-v2-[a-z0-9-]+$/.test(container)) throw new Error("Task-owned container required");
const docker = (args, input = "") => new Promise((resolve, reject) => { const child = spawn("docker", ["--context", "desktop-linux", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); let stdout = "", stderr = ""; child.stdout.on("data", v => { stdout += v; }); child.stderr.on("data", v => { stderr += v; }); child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end(input); });
const sql = async (input, failure = false) => { const r = await docker(["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database], input); if (r.code && !failure) throw new Error(r.stderr); return r; };
const q = v => `'${String(v).replaceAll("'", "''")}'`, j = v => `${q(JSON.stringify(v))}::jsonb`, service = "SET ROLE service_role; SET request.jwt.claim.role='service_role'; ";
const call = async v => JSON.parse((await sql(`${service} SELECT ${v};`)).stdout.trim());
const store=createEventPostcardStore({rpc:async(name,args={})=>{ const values=Object.entries(args).map(([key,value])=>`${key}=>${value===null?'NULL':typeof value==='object'?j(value):typeof value==='number'?value:q(value)}`);try{return {data:await call(`public.${name}(${values.join(',')})`),error:null};}catch(error){return {data:null,error:{message:error.message}};} }});
const denied = async (v, pattern = /PB_EVENT_DENIED|PB_EVENT_CONFLICT|permission denied/) => { const r = await sql(`${service} SELECT ${v};`, true); assert.notEqual(r.code, 0); assert.match(r.stderr, pattern); };
const owner=randomUUID(),event=randomUUID(),room=randomUUID(),capture=randomUUID(),members=[randomUUID(),randomUUID()],guests=[randomUUID(),randomUUID()],guestHashes=['a'.repeat(64),'b'.repeat(64)],roomHashes=['c'.repeat(64),'d'.repeat(64)],tickets=['e'.repeat(64),'f'.repeat(64)],postcard=randomUUID(),submission=randomUUID();
const design=validateTemplateDesign({canvas:{width:536,height:1600},requiredSources:{A:1,B:1},slots:['A','B'].map((role,i)=>({id:`slot-${i}`,role,sourceIndex:0,x:0,y:i/2,width:1,height:.5,crop:{zoom:1,offsetX:0,offsetY:0,rotation:0,mirror:false}})),layers:[],decorations:[],look:{frameId:'film',filterId:'none',patternId:'none',themeId:null,sceneId:null,materialId:null},defaults:{caption:'Synthetic',showDate:false}});
const source={kind:'room',id:room,captureId:capture}, view=i=>call(`public.pb_event_postcard_view(${q(event)},${q(guestHashes[i])},${q(guests[i])},${q(postcard)})`);
const migration=await readFile(new URL('../migrations/025_v2_event_postcards.sql',import.meta.url),'utf8');
assert.equal((await docker(['exec',container,'createdb','-U','postgres',database])).code,0);
try {
 await sql(await readFile(new URL('./bootstrap.sql',import.meta.url),'utf8')); await sql('CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); ALTER TABLE storage.objects ADD COLUMN user_metadata jsonb;');
 await sql((await readFile(new URL('../../supabase-setup.sql',import.meta.url),'utf8')).split('-- BEGIN PB_LIFECYCLE_V1')[0]);
 for(const file of ['001_v2_lifecycle.sql','002_v2_projects.sql','003_v2_rooms.sql','004_v2_memories.sql','005_v2_events.sql','008_v2_partial_results.sql','016_v2_event_transport.sql','017_v2_event_host_settings.sql','018_v2_event_exports.sql','019_v2_event_worker_readiness.sql','020_v2_event_review.sql','022_v2_event_publication.sql']) await sql(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
 await sql(migration); await sql(migration); await sql(await readFile(new URL('../migrations/026_v2_event_own_consent.sql',import.meta.url),'utf8'));
 await sql(`INSERT INTO auth.users VALUES(${q(owner)},'owner@example.invalid');`); await call('public.pb_event_configure(250000000)'); const now=Date.now(), expiry=new Date(now+86400000).toISOString();
 await call(`public.pb_event_create(${q(owner)},${q(event)},${j({title:'Postcard fixture',timezone:'Australia/Sydney',startsAt:new Date(now-60000).toISOString(),closesAt:new Date(now+3600000).toISOString(),expiresAt:expiry,maxGuests:25,maxContributions:100,maxBytes:250000000})})`); await call(`public.pb_event_manage(${q(owner)},${q(event)},'open','{}')`);
 await call(`public.pb_event_manage(${q(owner)},${q(event)},'invite',${j({hash:'9'.repeat(64),expiresAt:expiry})})`);
 for(let i=0;i<2;i++) await call(`public.pb_event_redeem(${q(event)},${q('9'.repeat(64))},${q(guests[i])},${q(guestHashes[i])})`);
 await call(`public.pb_room_create(${q(room)},${q(members[0])},'ABCDE2',${q(roomHashes[0])},'Alex',${q('8'.repeat(64))})`);
 await sql(`INSERT INTO public.pb_room_members(id,room_id,role,display_name,status,expires_at) VALUES(${q(members[1])},${q(room)},'B','Bao','admitted',clock_timestamp()+interval '2 hours'); INSERT INTO public.pb_room_capabilities VALUES(${q(roomHashes[1])},${q(room)},${q(members[1])},'member',clock_timestamp()+interval '2 hours',false); INSERT INTO public.pb_room_captures(id,room_id,proposal,member_ids,state) VALUES(${q(capture)},${q(room)},${j({recipeHash:'7'.repeat(64),shotIds:['photo1']})},ARRAY[${members.map(q).join(',')}]::uuid[],'committed');`);
 for(let i=0;i<2;i++) {
  await call(`public.pb_event_postcard_ticket(${q(event)},${q(guestHashes[i])},${q(guests[i])},${q(postcard)},${q(randomUUID())},${q(tickets[i])})`);
  const v=await call(`public.pb_event_postcard_attach(${q(event)},${q(tickets[i])},${q(postcard)},${q(submission)},${j(source)},${j(design)},NULL,${q(roomHashes[i])})`); assert.equal(v.selfPrincipalId,members[i]); assert.equal(v.canSubmit,i===0);
 }
 const discover=await call(`public.pb_event_postcard_proposal(${q(postcard)},${j(source)},NULL,${q(roomHashes[1])})`); assert.equal(discover.eventId,event); assert.equal(discover.proposal.submissionId,submission);
 await denied(`public.pb_event_postcard_proposal(${q(postcard)},${j(source)},NULL,${q('0'.repeat(64))})`,/PB_ROOM_DENIED/);
 await denied(`public.pb_event_reserve(${q(event)},${q(guestHashes[0])},${q(submission)},${q(randomUUID())},${q('1'.repeat(64))},ARRAY[${q(guests[0])}]::uuid[],'{"submission":true,"gallery":true,"wall":true}')`);
 await denied(`public.pb_event_reserve_before_postcard(${q(event)},${q(guestHashes[0])},${q(submission)},${q(randomUUID())},${q('1'.repeat(64))},ARRAY[${q(guests[0])}]::uuid[],'{"submission":true,"gallery":true,"wall":true}')`,/permission denied/);
 const reserve=`public.pb_event_postcard_reserve(${q(event)},${q(guestHashes[0])},${q(guests[0])},${q(postcard)},${q(randomUUID())},${q('6'.repeat(64))})`;
 await denied(reserve); for(let i=0;i<2;i++){const v=await view(i);await call(`public.pb_event_postcard_consent(${q(event)},${q(guestHashes[i])},${q(guests[i])},${q(postcard)},${v.revision},'{"submission":true,"gallery":true,"wall":false}')`);}
 await call('public.pb_event_worker_verified()'); await call(reserve); assert.equal((await view(0)).state,'reserved');
 await call(`public.pb_event_authorise_upload(${q(event)},${q(guestHashes[0])},${q(submission)})`); await sql(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-event-images-staging-v2',${q(`${event}/${submission}/source`)},'{"size":100}');`); await call(`public.pb_event_enqueue_finalise(${q(event)},${q(guestHashes[0])},${q(submission)})`);
 const [job]=await call('public.pb_event_claim_jobs(1)');
 await sql(`${service} INSERT INTO storage.objects(bucket_id,name,metadata,user_metadata) VALUES('photobooth-events-v2',${q(`${event}/${submission}/image`)},'{"size":100}',${j({eventJobId:job.id,eventLease:job.lease_token})}),('photobooth-events-v2',${q(`${event}/${submission}/thumbnail`)},'{"size":20}',${j({eventJobId:job.id,eventLease:job.lease_token})});`);
 await call(`public.pb_event_checkpoint_job(${q(job.id)},${q(job.lease_token)},${j({decoded:true,objectsVerified:true,mime:'image/jpeg',width:40,height:30,sha256:'5'.repeat(64)})})`); await call(`public.pb_event_finish_job(${q(job.id)},${q(job.lease_token)},'complete')`);
 assert.equal((await store.view(event,guestHashes[0],guests[0],postcard)).state,'candidate'); assert.equal((await store.candidate(event,guestHashes[1],guests[1],postcard)).sha256,'5'.repeat(64)); assert.equal((await view(0)).state,'candidate'); assert.equal((await call(reserve)).state,'finalising'); assert.equal((await sql(`SELECT checkpoint->>'postcardCandidate' FROM public.pb_event_jobs WHERE id=${q(job.id)};`)).stdout.trim(),'true'); assert.equal((await call(`public.pb_event_receipt(${q(event)},${q('6'.repeat(64))},${q(submission)})`)).state,'finalising');
 await denied(`public.pb_event_read_access(${q(event)},${q('6'.repeat(64))},${q(submission)},'receipt')`);
 await denied(`public.pb_event_postcard_approve(${q(event)},${q(guestHashes[0])},${q(guests[0])},${q(postcard)},${q('0'.repeat(64))})`);
 for(let i=0;i<2;i++) await call(`public.pb_event_postcard_approve(${q(event)},${q(guestHashes[i])},${q(guests[i])},${q(postcard)},${q('5'.repeat(64))})`);
 assert.equal((await view(0)).state,'ready');
 await sql(`UPDATE public.pb_event_submissions SET logical_expires_at=clock_timestamp()-interval '1 second' WHERE id=${q(submission)};`);assert.equal((await store.candidate(event,guestHashes[1],guests[1],postcard)).sha256,'5'.repeat(64));
 const before=await view(0), own=await call(`public.pb_event_own_consent(${q(event)},${q(guestHashes[0])},${q(guests[0])},${q(submission)})`);
 await call(`public.pb_event_own_consent(${q(event)},${q(guestHashes[0])},${q(guests[0])},${q(submission)},${own.revision},false,false)`);
 const reduced=await view(0); assert.equal(reduced.selfConsent.gallery,false); assert(reduced.revision>before.revision);
 await denied(`public.pb_event_postcard_consent(${q(event)},${q(guestHashes[0])},${q(guests[0])},${q(postcard)},${before.revision},'{"submission":true,"gallery":true,"wall":false}')`);
 await sql(`UPDATE public.pb_rooms SET status='ended' WHERE id=${q(room)}; DELETE FROM public.pb_rooms WHERE id=${q(room)};`); assert.equal((await view(0)).state,'ready');
 await call(`public.pb_event_postcard_consent(${q(event)},${q(guestHashes[1])},${q(guests[1])},${q(postcard)},0,'{"submission":false,"gallery":false,"wall":false}')`); assert.equal((await view(0)).state,'revoked');
 assert.equal((await sql(`SELECT state||':'||staging_held_bytes||':'||derivative_held_bytes FROM public.pb_event_submissions WHERE id=${q(submission)};`)).stdout.trim(),'deleted:2000000:120');

 const users=[owner,randomUUID(),randomUUID()];
 await sql(`INSERT INTO auth.users(id,email) VALUES(${q(users[1])},'friend@example.invalid'),(${q(users[2])},'third@example.invalid');`);
 await call('public.pb_project_configure(1073741824)');
 async function challenge(count=2) {
  const project=randomUUID(),id=randomUUID(),d=validateTemplateDesign({...design,requiredSources:Object.fromEntries(Array.from({length:count},(_,i)=>['ABC'[i],1])),slots:Array.from({length:count},(_,i)=>({...design.slots[0],id:`slot-${i}`,role:'ABC'[i],y:i/count,height:1/count}))});
  await call(`public.pb_project_create(${q(owner)},${q(project)},'friend','Postcard source',67108864)`);
  for(const user of users.slice(1,count)) await call(`public.pb_project_member(${q(owner)},${q(project)},${q(user)},'invite')`);
  await call(`public.pb_challenge_create(${q(owner)},${q(project)},${j({id,design:d,policy:'all_submitted',expiresAt:expiry,members:users.slice(0,count).map((userId,i)=>({userId,role:'ABC'[i]})),assignments:users.slice(0,count).map((userId,i)=>({slot:i,userId,sourceIndex:0}))})})`);
  for(const user of users.slice(1,count)) await call(`public.pb_challenge_manage(${q(user)},${q(id)},'accept')`);
  await call(`public.pb_challenge_manage(${q(owner)},${q(id)},'open')`); const submissions=[];
  for(const user of users.slice(0,count)) {
   const asset=randomUUID(),input={id:asset,requestId:randomUUID(),kind:'photo',mime:'image/png',bytes:100,width:20,height:20,sha256:'b'.repeat(64),protection:{kind:'challenge',id}};
   const reserved=await call(`public.pb_project_reserve(${q(user)},${q(project)},${j(input)})`);
   await call(`public.pb_project_authorise_upload(${q(user)},${q(asset)})`); await sql(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-projects-v2',${q(reserved.path)},'{"size":100}');`);
   await call(`public.pb_project_enqueue_finalisation(${q(user)},${q(asset)})`); const job=await call('public.pb_project_claim_finalisation()');
   await call(`public.pb_project_finish_finalisation(${q(asset)},${q(job.leaseToken)},'verified',${j({bytes:100,width:20,height:20,mime:'image/png',sha256:input.sha256,decoded:true})})`);
   submissions.push(`public.pb_challenge_submit(${q(user)},${q(id)},${j({requestId:randomUUID(),sources:[{sourceIndex:0,assetId:asset}]})})`);
  }
  return {project,id,design:d,submissions};
 }
 async function bindSource(source,d=design) {
  const id=randomUUID(),submissionId=randomUUID();
  for(let i=0;i<2;i++) {
   await call(`public.pb_event_postcard_ticket(${q(event)},${q(guestHashes[i])},${q(guests[i])},${q(id)},${q(randomUUID())},${q(tickets[i])})`);
   await call(`public.pb_event_postcard_attach(${q(event)},${q(tickets[i])},${q(id)},${q(submissionId)},${j(source)},${j(d)},${q(users[i])},NULL)`);
  }
  const current=i=>call(`public.pb_event_postcard_view(${q(event)},${q(guestHashes[i])},${q(guests[i])},${q(id)})`);
  for(let i=0;i<2;i++){const v=await current(i);await call(`public.pb_event_postcard_consent(${q(event)},${q(guestHashes[i])},${q(guests[i])},${q(id)},${v.revision},'{"submission":true,"gallery":true,"wall":false}')`);}
  return {id,submissionId,current};
 }
 async function candidateFor(p) {
  await call('public.pb_event_worker_verified()');await call(`public.pb_event_postcard_reserve(${q(event)},${q(guestHashes[0])},${q(guests[0])},${q(p.id)},${q(randomUUID())},${q(randomUUID().replaceAll('-','').repeat(2))})`);
  await call(`public.pb_event_authorise_upload(${q(event)},${q(guestHashes[0])},${q(p.submissionId)})`);await sql(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-event-images-staging-v2',${q(`${event}/${p.submissionId}/source`)},'{"size":100}');`);
  await call(`public.pb_event_enqueue_finalise(${q(event)},${q(guestHashes[0])},${q(p.submissionId)})`);const jobs=await call('public.pb_event_claim_jobs(1)'),job=jobs[0];assert.equal(job.submission_id,p.submissionId);
  await sql(`${service} INSERT INTO storage.objects(bucket_id,name,metadata,user_metadata) VALUES('photobooth-events-v2',${q(`${event}/${p.submissionId}/image`)},'{"size":100}',${j({eventJobId:job.id,eventLease:job.lease_token})}),('photobooth-events-v2',${q(`${event}/${p.submissionId}/thumbnail`)},'{"size":20}',${j({eventJobId:job.id,eventLease:job.lease_token})});`);
  await call(`public.pb_event_checkpoint_job(${q(job.id)},${q(job.lease_token)},${j({decoded:true,objectsVerified:true,mime:'image/jpeg',width:40,height:30,sha256:'5'.repeat(64)})})`);
  await call(`public.pb_event_finish_job(${q(job.id)},${q(job.lease_token)},'complete')`);assert.equal((await p.current(0)).state,'candidate');return job;
 }
 const c=await challenge(),cs={kind:'challenge',id:c.id};
 await denied(`public.pb_event_postcard_source(${j(cs)},${j(c.design)},${q(owner)},NULL)`,/permission denied/);
 const hiddenId=randomUUID();await call(`public.pb_event_postcard_ticket(${q(event)},${q(guestHashes[0])},${q(guests[0])},${q(hiddenId)},${q(randomUUID())},${q(tickets[0])})`);
 await denied(`public.pb_event_postcard_attach(${q(event)},${q(tickets[0])},${q(hiddenId)},${q(randomUUID())},${j(cs)},${j(c.design)},${q(owner)},NULL)`);
 for(const submit of c.submissions)await call(submit);const full=await bindSource(cs,c.design);await candidateFor(full);
 await call(`public.pb_event_postcard_approve(${q(event)},${q(guestHashes[0])},${q(guests[0])},${q(full.id)},${q('5'.repeat(64))})`);
 const race=await Promise.all([sql(`${service} SELECT public.pb_event_postcard_approve(${q(event)},${q(guestHashes[1])},${q(guests[1])},${q(full.id)},${q('5'.repeat(64))});`,true),sql(`${service} SELECT public.pb_challenge_manage(${q(users[1])},${q(c.id)},'withdraw');`,true)]);
 assert.equal(race[1].code,0,race[1].stderr);assert.equal((await full.current(0)).state,'revoked');await denied(`public.pb_event_postcard_candidate(${q(event)},${q(guestHashes[0])},${q(guests[0])},${q(full.id)})`);
 const partialChallenge=await challenge(3);await call(partialChallenge.submissions[0]);await call(partialChallenge.submissions[1]);await call(`public.pb_challenge_manage(${q(owner)},${q(partialChallenge.id)},'cancel')`);
 const part=await call(`public.pb_challenge_propose_partial(${q(owner)},${q(partialChallenge.id)},${q(randomUUID())},ARRAY[${users.slice(0,2).map(q).join(',')}]::uuid[])`);
 for(const user of users.slice(0,2))await call(`public.pb_challenge_partial_consent(${q(user)},${q(part.id)},${q(part.digest)},true)`);
 await call(`public.pb_challenge_commit_partial(${q(owner)},${q(part.id)},${q(part.digest)})`);
 const partial=await bindSource({kind:'partial',id:part.id});await candidateFor(partial);
 await sql(`UPDATE public.pb_event_submissions SET logical_expires_at=clock_timestamp()-interval '1 second' WHERE id=${q(partial.submissionId)};`);
 await denied(`public.pb_event_postcard_approve(${q(event)},${q(guestHashes[0])},${q(guests[0])},${q(partial.id)},${q('5'.repeat(64))})`);
 const late=await sql(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('photobooth-event-images-staging-v2',${q(`${event}/${partial.submissionId}/source`)},'{"size":100}') ON CONFLICT(bucket_id,name) DO UPDATE SET metadata=EXCLUDED.metadata;`,true);assert.notEqual(late.code,0);assert.match(late.stderr,/PB_EVENT_DENIED|PB_EVENT_EXPIRED/);
 // Fill only the disposable fixture to exercise the actual locked admission boundary.
 await sql(`INSERT INTO public.pb_event_postcards(id,event_id,submission_id,initiator_guest,source,proof,design,design_hash,expires_at) SELECT gen_random_uuid(),${q(event)},gen_random_uuid(),${q(guests[0])},'{"kind":"room","id":"${randomUUID()}"}', '{}',${j(design)},${q('1'.repeat(64))},clock_timestamp()+interval '1 hour' FROM generate_series(1,99-(SELECT count(*)::integer FROM public.pb_event_postcards WHERE event_id=${q(event)}));`);
 const capIds=[randomUUID(),randomUUID()];for(let i=0;i<2;i++)await call(`public.pb_event_postcard_ticket(${q(event)},${q(guestHashes[i])},${q(guests[i])},${q(capIds[i])},${q(randomUUID())},${q(tickets[i])})`);
 const caps=await Promise.all(capIds.map((id,i)=>sql(`${service} SELECT public.pb_event_postcard_attach(${q(event)},${q(tickets[i])},${q(id)},${q(randomUUID())},${j({kind:'partial',id:part.id})},${j(design)},${q(users[i])},NULL);`,true)));
 assert.equal(caps.filter(v=>v.code===0).length,1);assert.match(caps.find(v=>v.code!==0).stderr,/PB_EVENT_CAPACITY/);
 console.log('Challenge concealment, full-source withdrawal versus final approval, contributor-only partial binding, expired candidate denial and concurrent draft cap passed.');
 await sql(migration); for(const role of ['anon','authenticated','service_role']) {const r=await sql(`SET ROLE ${role}; SELECT * FROM public.pb_event_postcards;`,true);assert.notEqual(r.code,0);}
 console.log('Postcard SQL passed: bound room principals, unanimous pre-staging scope, exact candidate approval, private pending reads, ordinary room expiry independence, later withdrawal, retained cleanup charges and populated rerun.');
} finally {const result=await docker(['exec',container,'dropdb','-U','postgres','--if-exists','--force',database]);if(result.code)throw new Error(result.stderr);}
