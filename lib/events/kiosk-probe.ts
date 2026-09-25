import { kioskPhotoApproval } from "./kiosk-client";
import { openEventKioskJournal, type EventKioskJournal } from "./kiosk-journal";
import type { EventKioskSession } from "./kiosk-contract";

export async function runEventKioskProbe():Promise<{passed:number;checks:string[]}> {
  if(process.env.NODE_ENV!=='development')throw new Error('Development probe unavailable');
  const databaseName=`pb-event-kiosk-probe-${crypto.randomUUID()}`,eventId=crypto.randomUUID(),deviceId=crypto.randomUUID(),guestId=crypto.randomUUID(),handles:EventKioskJournal[]=[],checks:string[]=[];let clock=Date.now(),allowed=true;
  const initial:EventKioskSession={version:1,eventId,deviceId,guestId,generation:0,expiresAt:new Date(clock+3*86400000).toISOString(),enabled:true};
  const verify=(value:unknown,label:string)=>{if(!value)throw new Error(label);checks.push(label);};
  const denied=async(work:()=>Promise<unknown>)=>{try{await work();return false;}catch{return true;}};
  const open=async(session=initial)=>{const journal=await openEventKioskJournal(session,{databaseName,now:()=>clock,operator:async()=>{if(!allowed)throw new Error('locked');return {deviceId:session.deviceId,unlockedUntil:new Date(clock+60000).toISOString()};}});handles.push(journal);return journal;};
  const canvas=document.createElement('canvas');canvas.width=24;canvas.height=32;const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Canvas unavailable');ctx.fillStyle='#c25677';ctx.fillRect(0,0,24,32);
  try {
    const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('JPEG unavailable')),'image/jpeg',.85)),approval=await kioskPhotoApproval(blob,{submission:true,gallery:false,wall:true},null);
    const input=()=>({id:crypto.randomUUID(),requestId:crypto.randomUUID(),blob,approval});
    const a=await open(),stale=await open(),first=input(),saved=await a.append(first);verify(saved.blob.size===blob.size,'Exact approved encoded bytes are committed before the queue acknowledges saving');
    await a.close();const reopened=await open();verify((await reopened.loadCurrent(first.id)).approval.sha256===approval.sha256,'Pending photo bytes and immutable consent survive a real IndexedDB close and reopen');
    allowed=false;verify(await denied(()=>reopened.operatorList()),'Locked operators cannot enumerate previous pending photos');allowed=true;
    const next={...initial,generation:1,guestId:crypto.randomUUID()};await reopened.adopt(next);
    verify(await denied(()=>reopened.loadCurrent(first.id)),'The next guest cannot read the previous guest photo through the current-guest API');
    verify(await denied(()=>stale.append(input())),'An independent stale database connection cannot append after the guest generation changes');
    const previous=(await reopened.operatorList())[0];verify(previous.id===first.id&&previous.generation===0,'A freshly unlocked operator can recover the original immutable upload generation');
    await reopened.remove(previous.id,previous.revision);verify(await denied(()=>reopened.append(first)),'A retired record UUID cannot resurrect its deleted local photo');
    const pending=input();let release:()=>void=()=>{};const held=new Promise<void>(resolve=>{release=resolve;});class DelayedBlob extends Blob {override async arrayBuffer(){await held;return super.arrayBuffer();}}
    const late=reopened.append({...pending,blob:new DelayedBlob([blob],{type:blob.type})});const outcome=late.then(()=>false,()=>true);await reopened.adopt({...next,generation:2,guestId:crypto.randomUUID()});release();verify(await outcome,'A hash worker that finishes after handoff cannot recreate an old guest record');
    const ready=await reopened.append(input());verify(await denied(()=>reopened.update(ready.id,ready.revision+1,'processing')),'Stale revision writes reject without replacing the approved original');
    for(let n=1;n<8;n++)await reopened.append(input());verify(await denied(()=>reopened.append(input())),'Eight retained pending photos are never silently evicted for a ninth');
    clock+=86400001;const current={...next,generation:3,guestId:crypto.randomUUID()};await reopened.adopt(current);verify((await reopened.operatorList()).length===0,'Expired-only cleanup removes pending bytes before the next guest is admitted');
    const fresh=await reopened.append(input());verify(fresh.generation===3,'The same bounded queue admits a fresh guest after expired cleanup');
    const stranger=await open({...initial,deviceId:crypto.randomUUID(),guestId:crypto.randomUUID()});await stranger.append(input());verify((await reopened.operatorList()).length===1&&(await stranger.operatorList()).length===1,'Operator recovery lists are isolated by exact event-device identity');
    return {passed:checks.length,checks};
  }finally{canvas.width=canvas.height=0;await Promise.allSettled(handles.map(h=>h.close()));await new Promise<void>((resolve,reject)=>{const request=indexedDB.deleteDatabase(databaseName);request.onsuccess=()=>resolve();request.onerror=request.onblocked=()=>reject(new Error('Isolated kiosk probe cleanup failed'));});}
}
