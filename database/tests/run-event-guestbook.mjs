import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const container = process.env.PB_TEST_CONTAINER ?? "pb-v2-p1-postgres";
if (!/^pb-v2-[a-z0-9-]+$/.test(container)) throw new Error("Use a task-owned pb-v2-* container");
const database = `pb_v2_event_guestbook_${Date.now()}`;
const docker = (args, input = "") => new Promise((resolve, reject) => {
  const child = spawn("docker", ["--context", "desktop-linux", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", value => { stdout += value; }); child.stderr.on("data", value => { stderr += value; }); child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end(input);
});
const sql = async (source, failure = false) => { const result = await docker(["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database], source); if (result.code && !failure) throw new Error(result.stderr); return result; };
const q = value => `'${String(value).replaceAll("'", "''")}'`, json = value => `${q(JSON.stringify(value))}::jsonb`;
const service = "SET ROLE service_role; SET request.jwt.claim.role='service_role'; ";
const call = async expression => JSON.parse((await sql(`${service} SELECT to_jsonb(${expression});`)).stdout.trim() || "null");
const denied = async (source, expected = /PB_EVENT_DENIED|permission denied/) => { const result = await sql(source, true); assert.notEqual(result.code, 0); assert.match(result.stderr, expected); };
const owner=randomUUID(), other=randomUUID(), event=randomUUID(), guest=randomUUID(), second=randomUUID(), submission=randomUUID(), request=randomUUID(), token='a'.repeat(64), receipt='b'.repeat(64);
const made=await docker(["exec",container,"createdb","-U","postgres",database]); assert.equal(made.code,0,made.stderr);
try {
 await sql(await readFile(new URL("./bootstrap.sql",import.meta.url),"utf8"));
 await sql("CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); ALTER TABLE storage.objects ADD COLUMN user_metadata jsonb;");
 await sql((await readFile(new URL("../../supabase-setup.sql",import.meta.url),"utf8")).split("-- BEGIN PB_LIFECYCLE_V1")[0]);
 for(const name of ["001_v2_lifecycle.sql","003_v2_rooms.sql","005_v2_events.sql","016_v2_event_transport.sql","017_v2_event_host_settings.sql","018_v2_event_exports.sql","019_v2_event_worker_readiness.sql","023_v2_event_guestbook.sql","023_v2_event_guestbook.sql"]) await sql(await readFile(new URL(`../migrations/${name}`,import.meta.url),"utf8"));
 await sql(`INSERT INTO auth.users(id,email) VALUES(${q(owner)},'owner@example.invalid'),(${q(other)},'other@example.invalid');`);
 await call('public.pb_event_configure(1000000000)');
 const body={title:'Guestbook',timezone:'Australia/Sydney',startsAt:new Date(Date.now()-60000).toISOString(),closesAt:new Date(Date.now()+3600000).toISOString(),expiresAt:new Date(Date.now()+7200000).toISOString(),maxGuests:25,maxContributions:100,maxBytes:41000000};
 await call(`public.pb_event_create(${q(owner)},${q(event)},${json(body)})`); await call(`public.pb_event_manage(${q(owner)},${q(event)},'open','{}')`);
 await sql(`INSERT INTO public.pb_event_guests(id,event_id) VALUES(${q(guest)},${q(event)}),(${q(second)},${q(event)}); INSERT INTO public.pb_event_tokens(hash,event_id,guest_id,kind,expires_at) VALUES(${q(token)},${q(event)},${q(guest)},'contribute',${q(body.closesAt)});`);
 const mission=await call(`public.pb_event_missions_host(${q(owner)},${q(event)},0,ARRAY['same-energy-1'],${q(body.closesAt)})`); assert.equal(mission.revision,1);
 const reserve=`public.pb_event_reserve_mission(${q(event)},${q(token)},${q(guest)},${q(submission)},${q(request)},${q(receipt)},'{{"submission":true,"gallery":false,"wall":false}}'::jsonb,'same-energy-1')`.replace('{{','{').replace('}}','}');
 await denied(`${service} SELECT ${reserve};`,/PB_EVENT_NOT_READY/); await call('public.pb_event_worker_verified()'); await call(reserve); await call(reserve);
 const read=()=>call(`public.pb_event_guestbook_read(${q(event)},${q(token)},'contribute',${q(submission)},${q(guest)})`);
 assert.equal((await read()).mission.label,'Everyone picks their version of a calm face.'); assert.equal((await read()).missionCompleted,false);
 await denied(`${service} SELECT public.pb_event_missions_host(${q(owner)},${q(event)},1,ARRAY['same-energy-2'],${q(body.closesAt)});`,/PB_EVENT_CONFLICT/);
 await denied(`${service} SELECT public.pb_event_guestbook_read(${q(event)},${q(token)},'contribute',${q(submission)},${q(second)});`);
 await denied(`${service} SELECT public.pb_event_guestbook_host(${q(other)},${q(event)});`);
 const save=(rid,rev,message)=>call(`public.pb_event_guestbook_save(${q(event)},${q(token)},${q(guest)},${q(submission)},${q(rid)},${rev},${q(message)},'Guest')`);
 const firstId=randomUUID(); await save(firstId,0,'Hello'); await save(randomUUID(),1,'Updated'); const retry=await save(firstId,0,'Hello'); assert.equal(retry.acceptedRevision,1); assert.equal(retry.current.revision,2); assert.equal(retry.current.message,'Updated');
 const exportId=randomUUID(); await call(`public.pb_event_export_create(${q(owner)},${q(event)},${q(exportId)})`);
 const note=()=>call(`public.pb_event_export_guestbook(${q(owner)},${q(event)},${q(exportId)},0,0)`);
 assert.equal((await note()).note.message,'Updated'); await save(randomUUID(),2,'Later'); assert.equal((await note()).status,'unavailable');
 await call(`public.pb_event_guestbook_withdraw(${q(event)},${q(receipt)},'receipt',${q(submission)})`); assert.equal((await read()).withdrawn,true); assert.equal((await read()).message,'');
 const old=await save(firstId,0,'Hello'); assert.equal(old.current.withdrawn,true); assert.equal(old.acceptedRevision,1);
 let rev=(await read()).revision; for(let i=3;i<32;i++){ const result=await save(randomUUID(),rev,'Bounded'); rev=result.current.revision; }
 await denied(`${service} SELECT public.pb_event_guestbook_save(${q(event)},${q(token)},${q(guest)},${q(submission)},${q(randomUUID())},${rev},'Extra','Guest');`,/PB_EVENT_CAPACITY/);
 await call(`public.pb_event_guestbook_withdraw(${q(event)},${q(token)},'contribute',${q(submission)},${q(guest)})`); assert.equal((await read()).withdrawn,true);
 await sql(`UPDATE public.pb_event_submissions SET state='ready' WHERE id=${q(submission)};`); assert.equal((await read()).missionCompleted,true);
 await sql(`UPDATE public.pb_event_submissions SET state='deleted' WHERE id=${q(submission)};`); assert.equal((await note()).status,'unavailable');
 await denied("SET ROLE authenticated; SELECT * FROM public.pb_event_guestbook;");
 console.log('023 passed: mission reserve019 gate, immutable label, author/owner isolation, later-revision retry receipt, withdrawal and bounded receipts, snapshot text fence.');
}finally{const dropped=await docker(["exec",container,"dropdb","-U","postgres","--if-exists","--force",database]);if(dropped.code)throw new Error(dropped.stderr);}
