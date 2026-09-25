import test from 'node:test';
import assert from 'node:assert/strict';
import {createEventKioskRuntime} from '../lib/events/kiosk-runtime';
import type {EventKioskClient} from '../lib/events/kiosk-client';
import type {EventKioskJournal,EventKioskRecord} from '../lib/events/kiosk-journal';
import type {EventKioskSession} from '../lib/events/kiosk-contract';
const id=()=>crypto.randomUUID();
function fixture(){
 const session:EventKioskSession={version:1,eventId:id(),deviceId:id(),guestId:id(),generation:0,expiresAt:new Date(Date.now()+86400000).toISOString(),enabled:true};
 let row:EventKioskRecord={version:1,id:id(),eventId:session.eventId,deviceId:session.deviceId,guestId:session.guestId!,generation:0,requestId:id(),revision:0,createdAt:new Date().toISOString(),expiresAt:session.expiresAt,approval:{sha256:'a'.repeat(64),bytes:3,width:1,height:1,mime:'image/jpeg',consent:{submission:true,gallery:false,wall:false},missionId:null},state:'prepared',blob:new Blob(['abc'],{type:'image/jpeg'})};
 let status='reserved',failReserve=false,unlocked=true,closeDrain=Promise.resolve();const events:string[]=[];
 const journal={close:async()=>{events.push('close-journal');await closeDrain;},adopt:async(next:EventKioskSession)=>{Object.assign(session,next);row={...row,generation:next.generation};},loadCurrent:async()=>row,update:async(_id:string,revision:number,state:EventKioskRecord['state'])=>{assert.equal(row.revision,revision);events.push(state);row={...row,state,revision:revision+1};return row;},operatorList:async()=>{if(!unlocked)throw new Error('access_denied');return [row];},remove:async()=>{events.push('remove');}} as unknown as EventKioskJournal;
 const client={close:()=>events.push('close-client'),capabilities:async()=>({}),session:async()=>session,reset:async()=>({...session,generation:session.generation+1}),operator:async()=>{if(!unlocked)throw new Error('access_denied');return {deviceId:session.deviceId,unlockedUntil:new Date(Date.now()+60000).toISOString()};},reserve:async()=>{events.push('reserve-network');if(failReserve)throw new Error('unavailable');return {receiptToken:'token'};},status:async()=>{events.push('status');if(status==='denied')throw new Error('access_denied');return {submissionId:row.id,state:status,eventExpiresAt:session.expiresAt};},upload:async()=>{events.push('upload');},finalise:async()=>({state:'finalising'})} as unknown as EventKioskClient;
 const runtime=createEventKioskRuntime({appOrigin:'https://booth.example',storageOrigin:'https://storage.example',eventId:session.eventId,client:()=>client,journal:async()=>journal});
 return {runtime,events,get row(){return row;},setStatus:(v:string)=>{status=v;},setFailReserve:(v:boolean)=>{failReserve=v;},setUnlocked:(v:boolean)=>{unlocked=v;},setDrain:(v:Promise<void>)=>{closeDrain=v;}};
}
test('kiosk persists dispatched reservation state before network and exact retry keeps original IDs',async()=>{
 const f=fixture();await f.runtime.start();f.setFailReserve(true);await assert.rejects(f.runtime.reserve(f.row),/unavailable/);assert.equal(f.row.state,'reserving');assert(f.events.indexOf('reserving')<f.events.indexOf('reserve-network'));const first=f.row;f.setFailReserve(false);const result=await f.runtime.reserve(first);assert.equal(result.record.id,first.id);assert.equal(result.record.requestId,first.requestId);assert.equal(result.record.state,'reserved');await f.runtime.close();
});
test('kiosk local export requires fresh operator authority and dispatched job status',async()=>{
 const f=fixture();await f.runtime.start();assert.equal((await f.runtime.exportPending(f.row)).id,f.row.id);assert(!f.events.includes('status'));
 f.setFailReserve(true);await assert.rejects(f.runtime.reserve(f.row));for(const status of ['deleted','expired','failed','denied']){f.setStatus(status);await assert.rejects(f.runtime.exportPending(f.row));}
 f.setStatus('reserved');assert.equal((await f.runtime.exportPending(f.row)).id,f.row.id);f.setUnlocked(false);await assert.rejects(f.runtime.exportPending(f.row),/access_denied/);await f.runtime.close();
});
test('concurrent kiosk resets share a drain and cannot open a new generation before old writes settle',async()=>{
 const f=fixture();await f.runtime.start();let release:()=>void=()=>{};f.setDrain(new Promise(resolve=>{release=resolve;}));const before=f.events.length,one=f.runtime.reset(),two=f.runtime.reset();assert.equal(one,two);await Promise.resolve();assert.deepEqual(f.events.slice(before),['close-client','close-journal']);release();const state=await one;assert.equal(state.generation,2);await f.runtime.close();
});
test('verified ready kiosk delivery removes the temporary copy but uncertain verification retains it',async()=>{
 const f=fixture();await f.runtime.start();await f.runtime.reserve(f.row);f.setStatus('finalising');assert.equal((await f.runtime.send(f.row)).state,'pending');assert(!f.events.includes('remove'));f.setStatus('ready');assert.equal((await f.runtime.send(f.row)).state,'ready');assert(f.events.includes('remove'));await f.runtime.close();
});
