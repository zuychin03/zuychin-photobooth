import { EventClientError } from "./client";
import { createEventKioskClient, type EventKioskClient, type EventKioskClientOptions } from "./kiosk-client";
import { openEventKioskJournal, type EventKioskJournal, type EventKioskRecord } from "./kiosk-journal";
import type { EventKioskApproval, EventKioskSession } from "./kiosk-contract";

export interface EventKioskRuntimeOptions extends EventKioskClientOptions { databaseName?: string; indexedDB?: IDBFactory; client?: () => EventKioskClient; journal?: typeof openEventKioskJournal }
export function createEventKioskRuntime(options:EventKioskRuntimeOptions) {
  let closed=false,epoch=0,busy=false,session:EventKioskSession|null=null,journal:EventKioskJournal|null=null;
  const make=options.client??(()=>createEventKioskClient(options)),open=options.journal??openEventKioskJournal;let client=make();let resetting:Promise<EventKioskSession>|null=null;
  const check=(expected=epoch)=>{if(closed||expected!==epoch)throw new EventClientError("identity_changed");};
  const run=async<T>(task:(expected:number)=>Promise<T>)=>{check();if(busy)throw new EventClientError("busy");busy=true;const expected=epoch;try{const result=await task(expected);check(expected);return result;}finally{if(expected===epoch)busy=false;}};
  const opened=async(current:EventKioskSession)=>{const expected=epoch,owner=client,result=await open(current,{databaseName:options.databaseName,indexedDB:options.indexedDB,operator:signal=>owner.operator(signal)});try{check(expected);return result;}catch(error){await result.close();throw error;}};
  const current=()=>{check();if(!session||!journal)throw new EventClientError("not_ready");return {session,journal};};
  const deliver=async(row:EventKioskRecord,expected:number,signal?:AbortSignal)=>{
    const state=current();if(row.deviceId!==state.session.deviceId||row.eventId!==state.session.eventId)throw new EventClientError("identity_changed");
    let status=await client.status(row.generation,row.id,signal);check(expected);
    if(status.state==='ready'){await state.journal.remove(row.id,row.revision);check(expected);return {state:'ready' as const,record:null};}
    if(['deleted','expired','failed'].includes(status.state))throw new EventClientError('expired');
    if(status.state==='reserved'||status.state==='uploading'){
      await client.upload(row.generation,row.id,row.blob,row.approval,signal);check(expected);
      row=await state.journal.update(row.id,row.revision,'uploading');check(expected);
      status=await client.finalise(row.generation,row.id,signal);check(expected);
    }
    if(status.state==='ready'){await state.journal.remove(row.id,row.revision);check(expected);return {state:'ready' as const,record:null};}
    row=await state.journal.update(row.id,row.revision,'processing');check(expected);return {state:'pending' as const,record:row};
  };
  return {
    get client(){return client;},get session(){return session;},
    start(signal?:AbortSignal){return run(async expected=>{if(journal){await journal.close();journal=null;}await client.capabilities(signal);const saved=await client.session(signal);check(expected);const queued=await opened(saved);check(expected);journal=queued;session=saved;
      const reset=await client.reset(saved,crypto.randomUUID(),signal);check(expected);await queued.adopt(reset);check(expected);session=reset;return reset;});},
    begin(guestId:string,signal?:AbortSignal){return run(async expected=>{const saved=current(),next=await client.begin(saved.session,guestId,signal);check(expected);await saved.journal.adopt(next);check(expected);session=next;const context=await client.context(next,signal);check(expected);return {session:next,context};});},
    savePhoto(input:{id:string;requestId:string;blob:Blob;approval:EventKioskApproval}){return run(async expected=>{const row=await current().journal.append(input);check(expected);return row;});},
    reserve(row:EventKioskRecord,signal?:AbortSignal){return run(async expected=>{const saved=current();row=await saved.journal.loadCurrent(row.id);check(expected);if(row.generation!==saved.session.generation||row.guestId!==saved.session.guestId)throw new EventClientError('identity_changed');
      if(row.state==='prepared'){row=await saved.journal.update(row.id,row.revision,'reserving');check(expected);}
      const result=await client.reserve(saved.session,{submissionId:row.id,requestId:row.requestId,approval:row.approval},signal);check(expected);const record=await saved.journal.update(row.id,row.revision,'reserved');check(expected);return {record,receiptToken:result.receiptToken};});},
    send(row:EventKioskRecord,signal?:AbortSignal){return run(async expected=>{row=await current().journal.loadCurrent(row.id);check(expected);return deliver(row,expected,signal);});},
    operatorList(signal?:AbortSignal){return run(async expected=>{const rows=await current().journal.operatorList(signal);check(expected);return rows;});},
    recover(row:EventKioskRecord,signal?:AbortSignal){return run(async expected=>{const rows=await current().journal.operatorList(signal);check(expected);const latest=rows.find(value=>value.id===row.id);if(!latest)throw new EventClientError("conflict");const result=await deliver(latest,expected,signal);check(expected);return result;});},
    exportPending(row:EventKioskRecord,signal?:AbortSignal){return run(async expected=>{const rows=await current().journal.operatorList(signal);check(expected);const latest=rows.find(value=>value.id===row.id&&value.revision===row.revision);if(!latest)throw new EventClientError("conflict");
      if(latest.state!=='prepared'){const status=await client.status(latest.generation,latest.id,signal);check(expected);if(['deleted','expired','failed'].includes(status.state)||Date.parse(status.eventExpiresAt)<=Date.now())throw new EventClientError('expired');}
      await client.operator(signal);check(expected);if(Date.parse(latest.expiresAt)<=Date.now())throw new EventClientError('expired');return latest;});},
    remove(row:EventKioskRecord,signal?:AbortSignal){return run(async expected=>{await client.operator(signal);check(expected);await current().journal.remove(row.id,row.revision);check(expected);});},
    reset(signal?:AbortSignal){check();if(resetting)return resetting;epoch++;const expected=epoch;client.close();const old=journal;journal=null;session=null;
      resetting=(async()=>{await old?.close();check(expected);client=make();busy=false;return run(async token=>{const prior=await client.session(signal);check(token);const next=await client.reset(prior,crypto.randomUUID(),signal);check(token);const fresh=await opened(next);check(token);journal=fresh;session=next;return next;});})().finally(()=>{resetting=null;});return resetting;
    },
    async close(){if(closed)return;closed=true;epoch++;client.close();const old=journal;journal=null;session=null;await old?.close();},
  };
}
export type EventKioskRuntime = ReturnType<typeof createEventKioskRuntime>;
