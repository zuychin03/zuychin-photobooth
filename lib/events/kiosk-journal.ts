import { kioskPhotoApproval } from "./kiosk-client";
import { EventClientError } from "./client";
import { EVENT_KIOSK_LIMITS, kioskUuid, parseKioskApproval, type EventKioskApproval, type EventKioskSession } from "./kiosk-contract";

export interface EventKioskRecord { version: 1; id: string; eventId: string; deviceId: string; generation: number; guestId: string; requestId: string; revision: number; createdAt: string; expiresAt: string; approval: EventKioskApproval; state: "prepared" | "reserving" | "reserved" | "uploading" | "processing" | "failed"; blob: Blob }
interface Scope { deviceId: string; eventId: string; generation: number; guestId: string | null; expiresAt: string; retired: string[] }
export interface EventKioskJournalOptions { databaseName?: string; indexedDB?: IDBFactory; now?: () => number; operator(signal?: AbortSignal): Promise<{ deviceId: string; unlockedUntil: string }> }
const fail=(code:string):never=>{throw new EventClientError(code);};
const read=<T>(request:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
const complete=(tx:IDBTransaction)=>new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error??new EventClientError("journal_unavailable"));});
function cleanRecord(value:EventKioskRecord):EventKioskRecord {
  if(!value || value.version!==1 || ![value.id,value.eventId,value.deviceId,value.guestId,value.requestId].every(kioskUuid) || !Number.isInteger(value.generation)||value.generation<0||value.generation>10000||!Number.isInteger(value.revision)||value.revision<0||!Number.isFinite(Date.parse(value.createdAt))||!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)>Date.parse(value.createdAt)+86400000||!['prepared','reserving','reserved','uploading','processing','failed'].includes(value.state)||!(value.blob instanceof Blob)) return fail("journal_unavailable");
  const approval=parseKioskApproval(value.approval);if(value.blob.size!==approval.bytes||value.blob.type!==approval.mime)return fail("journal_unavailable");
  return {version:1,id:value.id,eventId:value.eventId,deviceId:value.deviceId,generation:value.generation,guestId:value.guestId,requestId:value.requestId,revision:value.revision,createdAt:value.createdAt,expiresAt:value.expiresAt,approval,state:value.state,blob:value.blob};
}
export async function openEventKioskJournal(session:EventKioskSession,options:EventKioskJournalOptions) {
  const factory=options.indexedDB??globalThis.indexedDB,now=options.now??Date.now;if(!factory||!kioskUuid(session.deviceId)||!kioskUuid(session.eventId))return fail("journal_unavailable");
  const request=factory.open(options.databaseName??"pb-event-kiosk-queue",1);let rejected=false;
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{const timer=setTimeout(()=>{rejected=true;reject(new EventClientError("journal_blocked"));},5000);request.onblocked=()=>{rejected=true;clearTimeout(timer);reject(new EventClientError("journal_blocked"));};request.onupgradeneeded=()=>{const value=request.result;if(!value.objectStoreNames.contains("records"))value.createObjectStore("records",{keyPath:"id"});if(!value.objectStoreNames.contains("scopes"))value.createObjectStore("scopes",{keyPath:"deviceId"});};request.onsuccess=()=>{clearTimeout(timer);if(rejected)request.result.close();else resolve(request.result);};request.onerror=()=>{clearTimeout(timer);reject(new EventClientError("journal_unavailable"));};});
  let closed=false,epoch=0,current={...session};const transactions=new Set<IDBTransaction>(),drains=new Set<Promise<unknown>>();
  const check=(expected=epoch)=>{if(closed||expected!==epoch)return fail("identity_changed");};
  async function transaction<T>(mode:IDBTransactionMode,fn:(records:IDBObjectStore,scopes:IDBObjectStore,expected:number)=>Promise<T>):Promise<T> {
    check();const expected=epoch,tx=db.transaction(["records","scopes"],mode),done=complete(tx);transactions.add(tx);drains.add(done);void done.catch(()=>{});
    try{const result=await fn(tx.objectStore("records"),tx.objectStore("scopes"),expected);check(expected);await done;check(expected);return result;}
    catch(error){try{tx.abort();}catch{}await done.catch(()=>{});throw error;}
    finally{transactions.delete(tx);drains.delete(done);}
  }
  async function cleanup(records:IDBObjectStore,scopes:IDBObjectStore) {
    const all=await read(records.getAll()) as EventKioskRecord[],contexts=await read(scopes.getAll()) as Scope[];if(all.length>8||contexts.length>8)return fail("journal_unavailable");
    for(const s of contexts)if(!Array.isArray(s.retired)||s.retired.length>100||!s.retired.every(kioskUuid))return fail("journal_unavailable");
    for(const r of all) {cleanRecord(r);if(Date.parse(r.expiresAt)<=now()){records.delete(r.id);const owner=contexts.find(s=>s.deviceId===r.deviceId);if(owner&&!owner.retired.includes(r.id)){if(owner.retired.length>=100)return fail("queue_capacity");owner.retired.push(r.id);scopes.put(owner);}}}
    for(const s of contexts)if(Date.parse(s.expiresAt)<=now())scopes.delete(s.deviceId);
  }
  async function scope(scopes:IDBObjectStore,expected:number) { const saved=await read(scopes.get(current.deviceId)) as Scope|undefined;check(expected);if(!saved||saved.eventId!==current.eventId||saved.generation!==current.generation||saved.guestId!==current.guestId)return fail("identity_changed");return saved; }
  const close=async()=>{if(!closed){closed=true;epoch++;for(const tx of transactions){try{tx.abort();}catch{}}db.close();}await Promise.allSettled([...drains]);};
  db.onversionchange=()=>{void close();};
  try {await transaction("readwrite",async(records,scopes)=>{await cleanup(records,scopes);const prior=await read(scopes.get(session.deviceId)) as Scope|undefined;
    if(prior && (prior.eventId!==session.eventId || prior.generation>session.generation || prior.generation===session.generation && prior.guestId!==null && prior.guestId!==session.guestId))return fail("identity_changed");
    if(!prior&&(await read(scopes.count()))>=8)return fail("queue_capacity");scopes.put({deviceId:session.deviceId,eventId:session.eventId,generation:session.generation,guestId:session.guestId,expiresAt:session.expiresAt,retired:prior?.retired??[]} satisfies Scope);
  });}catch(error){await close();throw error;}
  return {
    async adopt(next:EventKioskSession) {check();if(next.deviceId!==current.deviceId||next.eventId!==current.eventId||next.generation<current.generation)return fail("identity_changed");epoch++;for(const tx of transactions){try{tx.abort();}catch{}}await Promise.allSettled([...drains]);check();
      await transaction("readwrite",async(records,scopes)=>{await cleanup(records,scopes);const saved=await read(scopes.get(next.deviceId)) as Scope|undefined;if(saved && (saved.generation>next.generation||saved.generation===next.generation&&saved.guestId!==null&&saved.guestId!==next.guestId))return fail("identity_changed");scopes.put({deviceId:next.deviceId,eventId:next.eventId,generation:next.generation,guestId:next.guestId,expiresAt:next.expiresAt,retired:saved?.retired??[]} satisfies Scope);});current={...next};
    },
    async append(input:{id:string;requestId:string;approval:EventKioskApproval;blob:Blob}) {
      check();const epochBefore=epoch;if(!current.guestId)return fail("identity_changed");const approved=parseKioskApproval(input.approval),actual=await kioskPhotoApproval(input.blob,approved.consent,approved.missionId);check(epochBefore);if(JSON.stringify(actual)!==JSON.stringify(approved))return fail("image_mismatch");const createdAt=new Date(now()).toISOString(),expiresAt=new Date(Math.min(now()+86400000,Date.parse(current.expiresAt))).toISOString();if(Date.parse(expiresAt)<=now())return fail("queue_expired");
      const candidate=cleanRecord({version:1,id:input.id,requestId:input.requestId,eventId:current.eventId,deviceId:current.deviceId,generation:current.generation,guestId:current.guestId,revision:0,createdAt,expiresAt,approval:approved,blob:input.blob,state:"prepared"});
      return transaction("readwrite",async(records,scopes,expected)=>{await cleanup(records,scopes);const context=await scope(scopes,expected);if(context.generation!==candidate.generation||context.guestId!==candidate.guestId)return fail("identity_changed");if(context.retired.includes(candidate.id))return fail("conflict");if(context.retired.length>=100)return fail("queue_capacity");const old=await read(records.get(candidate.id)) as EventKioskRecord|undefined;if(old){const r=cleanRecord(old);if(r.deviceId!==candidate.deviceId||r.generation!==candidate.generation||r.requestId!==candidate.requestId||JSON.stringify(r.approval)!==JSON.stringify(approved))return fail("conflict");return r;}
        const all=await read(records.getAll()) as EventKioskRecord[];if(context.retired.length+all.filter(row=>row.deviceId===candidate.deviceId).length>=100||all.length>=8||all.reduce((n,r)=>n+cleanRecord(r).blob.size,0)+candidate.blob.size>EVENT_KIOSK_LIMITS.queueBytes)return fail("queue_capacity");records.add(candidate);return candidate;
      });
    },
    async loadCurrent(id:string) {return transaction("readonly",async(records,scopes,expected)=>{await scope(scopes,expected);const value=await read(records.get(id)) as EventKioskRecord|undefined;if(!value)return fail("conflict");const row=cleanRecord(value);if(row.deviceId!==current.deviceId||row.eventId!==current.eventId||row.generation!==current.generation||row.guestId!==current.guestId)return fail("access_denied");if(Date.parse(row.expiresAt)<=now())return fail("queue_expired");return row;});},
    async update(id:string,revision:number,state:EventKioskRecord["state"]) {return transaction("readwrite",async(records,scopes,expected)=>{await scope(scopes,expected);const value=await read(records.get(id)) as EventKioskRecord|undefined;if(!value)return fail("conflict");const row=cleanRecord(value);if(row.deviceId!==current.deviceId||row.eventId!==current.eventId||row.revision!==revision)return fail("conflict");if(Date.parse(row.expiresAt)<=now())return fail("queue_expired");const next=cleanRecord({...row,revision:revision+1,state});records.put(next);return next;});},
    async remove(id:string,revision:number) {return transaction("readwrite",async(records,scopes,expected)=>{const context=await scope(scopes,expected);const value=await read(records.get(id)) as EventKioskRecord|undefined;if(!value)return;if(value.deviceId!==current.deviceId||value.eventId!==current.eventId||value.revision!==revision)return fail("conflict");if(!context.retired.includes(id)){if(context.retired.length>=100)return fail("queue_capacity");context.retired.push(id);scopes.put(context);}records.delete(id);});},
    async operatorList(signal?:AbortSignal) {check();const expected=epoch,before=await options.operator(signal);check(expected);if(signal?.aborted||before.deviceId!==current.deviceId||Date.parse(before.unlockedUntil)<=now())return fail("access_denied");
      const rows=await transaction("readwrite",async(records,scopes)=>{await cleanup(records,scopes);return (await read(records.getAll()) as EventKioskRecord[]).filter(row=>row.deviceId===current.deviceId&&row.eventId===current.eventId).map(cleanRecord);});
      const after=await options.operator(signal);check(expected);if(signal?.aborted||after.deviceId!==current.deviceId||Date.parse(after.unlockedUntil)<=now())return fail("access_denied");return rows;
    },
    close,
  };
}
export type EventKioskJournal = Awaited<ReturnType<typeof openEventKioskJournal>>;
