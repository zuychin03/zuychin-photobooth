import {createEventKioskClient} from './kiosk-client';
import {EVENT_KIOSK_LIMITS,type EventKioskSession,type EventKioskApproval} from './kiosk-contract';
import {DEFAULT_EVENT_LOOK} from './host-contract';
import {openEventKioskJournal,type EventKioskJournal} from './kiosk-journal';
import type {EventKioskRuntimeOptions} from './kiosk-runtime';
interface Job {id:string;requestId:string;generation:number;guestId:string;approval:EventKioskApproval;state:string;uploaded:boolean;logicalExpiresAt:string}
export async function createEventKioskFixture(input:{appOrigin:string;photo?:Blob;databaseName?:string;indexedDB?:IDBFactory}) {
 if(process.env.NODE_ENV==='production')throw new Error('Development rehearsal unavailable');
 const databaseName=input.databaseName??`pb-event-kiosk-fixture-${crypto.randomUUID()}`,eventId=crypto.randomUUID(),deviceId=crypto.randomUUID(),storageOrigin='https://kiosk-storage.invalid',expiresAt=new Date(Date.now()+86400000).toISOString();
 let state:EventKioskSession={version:1,eventId,deviceId,guestId:null,generation:0,expiresAt,enabled:true},closed=false,lostReserve=false,failUpload=false,unlockedUntil=0,pinAttempts=0;
 const handles=new Set<EventKioskJournal>(),clients=new Set<ReturnType<typeof createEventKioskClient>>(),jobs=new Map<string,Job>(),resets=new Map<string,EventKioskSession>();
 let photo=input.photo;
 if(!photo){const canvas=document.createElement('canvas');canvas.width=480;canvas.height=640;try{const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Canvas unavailable');ctx.fillStyle='#e8d1c4';ctx.fillRect(0,0,480,640);ctx.fillStyle='#a34b68';ctx.beginPath();ctx.arc(240,210,90,0,Math.PI*2);ctx.fill();ctx.fillRect(130,320,220,260);photo=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('JPEG unavailable')),'image/jpeg',.9));}finally{canvas.width=canvas.height=0;}}
 const snapshot=()=>({...state}),reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store'}}),deny=(code='access_denied')=>reply({error:code},code==='conflict'?409:403);
 const receipt=(job:Job)=>({submissionId:job.id,state:job.state,logicalExpiresAt:job.logicalExpiresAt,eventExpiresAt:expiresAt,gallery:job.approval.consent.gallery?'awaiting_approval':'private',wall:job.approval.consent.wall?'awaiting_approval':'private'});
 const transport:typeof fetch=async(url,init)=>{
  if(closed||init?.signal?.aborted)throw new DOMException('Aborted','AbortError');
  const address=new URL(String(url));
  if(address.origin===storageOrigin){if(failUpload)return reply({error:'fixture_upload_unavailable'},503);const job=[...jobs.values()].find(row=>address.pathname===`/storage/v1/object/upload/sign/photobooth-event-images-staging-v2/${eventId}/${row.id}/source`);if(!job||!state.enabled)return deny();if(job.uploaded)return reply({},409);job.uploaded=true;return reply({});}
  if(address.origin!==input.appOrigin||address.pathname!==`/api/events/${eventId}/kiosk`)return deny();
  const body=JSON.parse(String(init?.body??'{}')) as Record<string,unknown>,operation=String(body.operation);
  if(operation==='capabilities')return reply(EVENT_KIOSK_LIMITS);
  if(operation==='session')return reply(snapshot());
  if(operation==='unlock'){if(pinAttempts>=5)return reply({allowed:false,retryAfterSeconds:900,unlockedUntil:null});if(body.pin!=='123456'){pinAttempts++;return reply({allowed:false,retryAfterSeconds:0,unlockedUntil:null});}pinAttempts=0;unlockedUntil=Date.now()+60000;return reply({allowed:true,retryAfterSeconds:0,unlockedUntil:new Date(unlockedUntil).toISOString()});}
  if(operation==='operator'||operation==='exit'){if(unlockedUntil<=Date.now())return deny();if(operation==='exit'){const until=new Date(unlockedUntil).toISOString();unlockedUntil=0;return reply({deviceId,unlockedUntil:until});}return reply({deviceId,unlockedUntil:new Date(unlockedUntil).toISOString()});}
  if(!state.enabled)return deny();
  if(operation==='reset'){const key=String(body.requestId),prior=resets.get(key);if(prior)return reply(prior);if(body.generation!==state.generation)return deny('conflict');state={...state,generation:state.generation+1,guestId:null};unlockedUntil=0;resets.set(key,snapshot());return reply(snapshot());}
  if(['begin','context','reserve'].includes(operation)&&body.generation!==state.generation)return deny();
  if(operation==='begin'){if(state.guestId&&state.guestId!==body.guestId)return deny('conflict');state={...state,guestId:String(body.guestId)};unlockedUntil=0;return reply(snapshot());}
  if(['context','reserve'].includes(operation)&&body.guestId!==state.guestId)return deny();
  if(operation==='context')return reply({version:1,eventId,title:'Synthetic garden celebration',timezone:'Australia/Sydney',startsAt:new Date(Date.now()-3600000).toISOString(),closesAt:new Date(Date.now()+3600000).toISOString(),expiresAt,status:'open',look:{...DEFAULT_EVENT_LOOK,caption:'A shared celebration'},capacityAvailable:true,canReserve:true});
  if(operation==='reserve'){
   const id=String(body.submissionId),prior=jobs.get(id),approval=body.approval as EventKioskApproval;
   if(prior&&(prior.requestId!==body.requestId||prior.guestId!==body.guestId||JSON.stringify(prior.approval)!==JSON.stringify(approval)))return deny('conflict');
   const job=prior??{id,requestId:String(body.requestId),generation:state.generation,guestId:state.guestId!,approval,state:'reserved',uploaded:false,logicalExpiresAt:new Date(Date.now()+600000).toISOString()};jobs.set(id,job);
   if(lostReserve){lostReserve=false;throw new TypeError('Synthetic lost reservation acknowledgement');}
   return reply({...receipt(job),deviceId,guestId:job.guestId,generation:job.generation,stagingPath:`${eventId}/${id}/source`,stagingHeldBytes:2000000,derivativeHeldBytes:2100000,receiptToken:'A'.repeat(43)});
  }
  const job=jobs.get(String(body.submissionId));if(!job||job.generation!==body.generation)return deny();
  if(operation==='status')return reply(receipt(job));
  if(operation==='upload'){if(!['reserved','uploading'].includes(job.state)||Date.parse(job.logicalExpiresAt)<=Date.now())return deny('expired');job.state='uploading';return reply({submissionId:job.id,bucket:'photobooth-event-images-staging-v2',path:`${eventId}/${job.id}/source`,signedUrl:`${storageOrigin}/storage/v1/object/upload/sign/photobooth-event-images-staging-v2/${eventId}/${job.id}/source?token=synthetic`,expiresAt:new Date(Date.now()+7000000).toISOString(),maxBytes:2000000,overwrite:false});}
  if(operation==='finalise'){if(!job.uploaded)return deny('not_ready');job.state='finalising';return reply(receipt(job));}
  return deny('invalid_request');
 };
 const options:EventKioskRuntimeOptions={appOrigin:input.appOrigin,storageOrigin,eventId,databaseName,indexedDB:input.indexedDB,fetch:transport,client:()=>{const client=createEventKioskClient({...options,fetch:transport});clients.add(client);return client;},journal:async(session,configuration)=>{const journal=await openEventKioskJournal(session,configuration);if(closed){await journal.close();throw new Error('Fixture stopped');}handles.add(journal);return journal;}};
 return {eventId,databaseName,options,photo:async()=>photo!,loseNextReservation(){lostReserve=true;},setUploadFailure(value:boolean){failUpload=value;},completePending(){for(const job of jobs.values())if(job.uploaded&&job.state==='finalising')job.state='ready';},revoke(){state={...state,enabled:false};},withdrawPending(){for(const job of jobs.values())job.state='deleted';},snapshot(){return {session:snapshot(),jobs:[...jobs.values()].map(({id,generation,state,uploaded})=>({id,generation,state,uploaded}))};},async close(){if(closed)return;closed=true;for(const client of clients)client.close();await Promise.allSettled([...handles].map(handle=>handle.close()));if(input.indexedDB||typeof indexedDB!=='undefined')await new Promise<void>((resolve,reject)=>{const request=(input.indexedDB??indexedDB).deleteDatabase(databaseName);request.onsuccess=()=>resolve();request.onerror=request.onblocked=()=>reject(new Error('Isolated kiosk database could not be cleared'));});}};
}
export type EventKioskFixture=Awaited<ReturnType<typeof createEventKioskFixture>>;
