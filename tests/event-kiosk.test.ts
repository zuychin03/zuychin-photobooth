import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createEventKioskClient, kioskPhotoApproval } from "../lib/events/kiosk-client";
import { EVENT_KIOSK_LIMITS, parseKioskApproval, parseKioskSession } from "../lib/events/kiosk-contract";
import { kioskAllowsPath, kioskCookieValue, kioskLock } from "../lib/events/kiosk-lock";
import { createEventKioskHandler, kioskDerive, kioskDigest, type EventKioskRequestPorts } from "../lib/server/event-kiosk-requests";
import { createEventKioskStore } from "../lib/server/event-kiosk-store";
import { verifyEventActor } from "../lib/server/event-store";
import { DEFAULT_EVENT_LOOK } from "../lib/events/host-contract";

const id=()=>crypto.randomUUID(), appOrigin="https://booth.example",storageOrigin="https://storage.example";
test("kiosk lock has no authority and blocks ordinary private routes including malformed markers",()=>{
  const event=id(),device=id(),lock=kioskLock(`${event}.${device}`)!;
  for(const path of ['/projects','/projects/cloud','/timeline','/receipt','/login','/api/events/anything','/e/other/gallery'])assert.equal(kioskAllowsPath(path,lock),false);
  assert(kioskAllowsPath(`/e/${event}/kiosk`,lock));assert(kioskAllowsPath(`/api/events/${event}/kiosk`,lock));assert(kioskAllowsPath('/_next/static/test.js',lock));
  assert.equal(kioskCookieValue('pb-kiosk-lock=a; pb-kiosk-lock=b'),'invalid');assert.equal(kioskLock('invalid')?.path,'/kiosk-locked');assert.equal(kioskLock(null),null);
});
test("kiosk approval requires exact JPEG metadata and independent affirmative submission consent",()=>{
  const valid={sha256:'a'.repeat(64),bytes:100,width:20,height:30,mime:'image/jpeg',consent:{submission:true,gallery:false,wall:true},missionId:null};
  assert.deepEqual(parseKioskApproval(valid),valid);
  for(const patch of [{mime:'image/png'},{bytes:2000001},{width:4097},{width:4096,height:4096},{consent:{submission:false,gallery:true,wall:true}},{receiptToken:'secret'}])assert.throws(()=>parseKioskApproval({...valid,...patch}));
  assert.throws(()=>parseKioskSession({version:1,eventId:id(),deviceId:id(),generation:0,guestId:null,expiresAt:new Date().toISOString(),enabled:true},id()));
});
test("real kiosk client-handler-store hides capability/PIN material and retains old registered upload generation only",async()=>{
  const eventId=id(),deviceId=id(),ownerId=id(),guestId=id(),submissionId=id(),requestId=id(),expiresAt=new Date(Date.now()+86400000).toISOString(),cookies=new Map<string,string>([['__Host-pb-event-contribute','old-guest'],['__Host-pb-event-receipt','old-receipt'],['pb-event-receipt','legacy-receipt']]);
  const env={PB_EVENTS_ENABLED:'true',PB_PUBLIC_ORIGIN:appOrigin,PB_EVENT_TRANSPORT_SECRET:'test-only-kiosk-transport-secret-long',PB_EVENT_TRUSTED_IP_HEADER:'x-real-ip',NEXT_PUBLIC_SUPABASE_URL:storageOrigin,SUPABASE_SERVICE_ROLE_KEY:'fixture-only'};
  let state={version:1,eventId,deviceId,generation:0,guestId:null as string|null,expiresAt,enabled:true},registered=false,pinHash='',tokenHash='',unlocked=false,uploads=0;
  let delivery='reserved';const receipt=()=>({submissionId,state:delivery,logicalExpiresAt:new Date(Date.now()+500000).toISOString(),eventExpiresAt:expiresAt,gallery:'private',wall:'private'});
  const store=createEventKioskStore(env,{rpc:async(name,args)=>{
    assert(!JSON.stringify(args).includes('123456'));const ok=(data:unknown)=>({data,error:null});
    if(name==='pb_event_kiosk_capabilities')return ok(EVENT_KIOSK_LIMITS);
    if(name==='pb_event_kiosk_create'){tokenHash=String(args.p_token);pinHash=String(args.p_pin);return ok(state);}
    if(args.p_token!==tokenHash)return {data:null,error:{message:'PB_EVENT_DENIED'}};
    if(name==='pb_event_kiosk_session')return ok(state);
    if(name==='pb_event_kiosk_begin'){if(args.p_generation!==state.generation)return {data:null,error:{message:'PB_EVENT_CONFLICT'}};state={...state,guestId:String(args.p_guest)};return ok(state);}
    if(name==='pb_event_kiosk_reset'){state={...state,generation:state.generation+1,guestId:null};return ok(state);}
    if(name==='pb_event_kiosk_unlock'){unlocked=args.p_pin===pinHash;return ok({allowed:unlocked,retryAfterSeconds:0,unlockedUntil:unlocked?new Date(Date.now()+60000).toISOString():null});}
    if(name==='pb_event_kiosk_operator')return unlocked?ok({deviceId,unlockedUntil:new Date(Date.now()+60000).toISOString()}):{data:null,error:{message:'PB_EVENT_DENIED'}};
    if(name==='pb_event_kiosk_reserve'){registered=true;return ok({...receipt(),deviceId,guestId,generation:0,stagingPath:`${eventId}/${submissionId}/source`,stagingHeldBytes:2000000,derivativeHeldBytes:2100000});}
    if(name==='pb_event_kiosk_job'){if(!registered||args.p_generation!==0||args.p_submission!==submissionId)return {data:null,error:{message:'PB_EVENT_DENIED'}};if(args.p_operation==='upload'){delivery='uploading';return ok({bucket:'photobooth-event-images-staging-v2',path:`${eventId}/${submissionId}/source`,generation:1,mintBefore:new Date(Date.now()+60000).toISOString(),authorisationUntil:new Date(Date.now()+7260000).toISOString(),cleanupAfter:new Date(Date.now()+7560000).toISOString(),maxBytes:2000000,overwrite:false});}if(args.p_operation==='finalise')delivery='finalising';return ok(receipt());}
    throw new Error(`Unexpected RPC ${name}`);
  }});
  const ports:EventKioskRequestPorts={kiosk:()=>store,core:()=>({rate:async()=>({allowed:true,retryAfterSeconds:0})}),authenticate:()=>verifyEventActor({getUser:async()=>({data:{user:{id:ownerId}},error:null})}),host:()=>({guestContext:async()=>({version:1,eventId,title:'Kiosk fixture',timezone:'Australia/Sydney',startsAt:new Date(Date.now()-1000).toISOString(),closesAt:new Date(Date.now()+500000).toISOString(),expiresAt,status:'open',look:{...DEFAULT_EVENT_LOOK},canReserve:true,capacityAvailable:true})}),objects:()=>({mintUpload:async a=>({signedUrl:`${storageOrigin}/storage/v1/object/upload/sign/${a.bucket}/${a.path}?token=synthetic`,expiresAt:new Date(Date.now()+7000000).toISOString()})})};
  const handler=createEventKioskHandler(ports,()=>env),transport:typeof fetch=async(input,init)=>{
    if(String(input).startsWith(storageOrigin)){uploads++;assert.equal(init?.credentials,'omit');assert.equal(new Headers(init?.headers).get('x-upsert'),'false');return new Response('{}');}
    const headers=new Headers(init?.headers);headers.set('origin',appOrigin);headers.set('x-real-ip','127.0.0.1');headers.set('cookie',[...cookies].map(([k,v])=>`${k}=${v}`).join('; '));const response=await handler(new Request(String(input),{...init,headers}),eventId);
    for(const cookie of response.headers.getSetCookie()){const [k,v]=cookie.split(';')[0].split('=');if(/Max-Age=0(?:;|$)/.test(cookie))cookies.delete(k);else cookies.set(k,v);}return response;
  };
  const client=createEventKioskClient({appOrigin,storageOrigin,eventId,fetch:transport});
  try{
    await client.capabilities();const setup=await client.create(deviceId,'123456','account-fixture');assert.equal(setup.deviceId,deviceId);assert(cookies.has('__Host-pb-kiosk-device'));assert(cookies.has('pb-kiosk-lock'));assert(![...cookies.keys()].some(k=>k.includes('receipt')||k.includes('contribute')));
    const active=await client.begin(setup,guestId);assert.equal((await client.context(active)).title,'Kiosk fixture');
    const blob=new Blob([new Uint8Array(await sharp({create:{width:20,height:30,channels:3,background:'#d57294'}}).jpeg().toBuffer())],{type:'image/jpeg'}),approval=await kioskPhotoApproval(blob,{submission:true,gallery:false,wall:false},null);
    const reserved=await client.reserve(active,{submissionId,requestId,approval});assert.match(reserved.receiptToken,/^[A-Za-z0-9_-]{43}$/);assert.equal(reserved.receipt.submissionId,submissionId);
    await client.reset(active,id());await assert.rejects(client.reserve(active,{submissionId,requestId,approval}),/access_denied/);
    await client.upload(0,submissionId,blob,approval);assert.equal(uploads,1);await client.finalise(0,submissionId);assert.equal((await client.status(0,submissionId)).state,'finalising');
    await assert.rejects(client.operator(),/access_denied/);assert.equal((await client.unlock('000000',Buffer.alloc(32,7).toString('base64url'))).allowed,false);assert.equal((await client.unlock('123456',Buffer.alloc(32,8).toString('base64url'))).allowed,true);cookies.set('__Host-pb-event-receipt','unexpected-prior-receipt');await client.exit();assert(!cookies.has('pb-kiosk-lock'));assert(!cookies.has('__Host-pb-event-receipt'));
    const derivation=kioskDerive(env.PB_EVENT_TRANSPORT_SECRET,'pin',eventId,deviceId,'123456');assert.equal(kioskDigest(derivation),pinHash);assert(!derivation.includes('123456'));
  }finally{client.close();}
});
test("closed kiosk clients fence late responses and do not start another request",async()=>{
  let finish:(value:Response)=>void=()=>{},calls=0;const client=createEventKioskClient({appOrigin,storageOrigin,eventId:id(),fetch:async()=>{calls++;return new Promise(resolve=>{finish=resolve;});}});
  const pending=client.capabilities();client.close();await assert.rejects(pending,/cancelled/);finish(Response.json(EVENT_KIOSK_LIMITS));await assert.rejects(client.capabilities(),/cancelled/);assert.equal(calls,1);
});
