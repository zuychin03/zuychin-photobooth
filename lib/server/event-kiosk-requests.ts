import { createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";
import { createClient } from "@supabase/supabase-js";
import { EVENT_KIOSK_LIMITS, parseKioskApproval } from "../events/kiosk-contract";
import { KIOSK_LOCK_COOKIE } from "../events/kiosk-lock";
import { canonicalPublicOrigin, privateJson, supabaseServiceOrigin } from "./cron-auth";
import { createEventKioskStore, type EventKioskStore } from "./event-kiosk-store";
import { createEventStore, verifyEventActor, EventStoreError, type EventStore, type VerifiedEventActor } from "./event-store";
import { createEventHostStore, type EventHostStore } from "./event-host-store";
import { createEventObjects, type EventSigningObjects } from "./event-objects";
import { eventInteger, eventObject, eventSecret, eventUuid } from "./event-http-input";
import { readSmallJson, requireSameOrigin, RequestValidationError } from "./request-security";
import { isLocalRelease, localReleaseKioskAllowed } from "../release-mode";

export interface EventKioskRequestPorts {
  kiosk(env: Record<string, string | undefined>, signal: AbortSignal): EventKioskStore;
  core(env: Record<string, string | undefined>, signal: AbortSignal): Pick<EventStore, "rate">;
  host(env: Record<string, string | undefined>, signal: AbortSignal): Pick<EventHostStore, "guestContext">;
  objects(env: Record<string, string | undefined>): Pick<EventSigningObjects, "mintUpload">;
  authenticate(token: string, env: Record<string, string | undefined>, signal: AbortSignal): Promise<VerifiedEventActor>;
}
const production: EventKioskRequestPorts = {
  kiosk: (env, signal) => createEventKioskStore(env, undefined, signal), core: env => createEventStore(env), host: env => createEventHostStore(env),
  objects(env) { const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL); if (!origin || !env.SUPABASE_SERVICE_ROLE_KEY) throw new EventStoreError("unavailable",503); return createEventObjects({ origin, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY }); },
  async authenticate(token, env, signal) { const origin = supabaseServiceOrigin(env.NEXT_PUBLIC_SUPABASE_URL), key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY; if (!origin || !key) throw new EventStoreError("unavailable",503); const client = createClient(origin,key,{ auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.any([signal,AbortSignal.timeout(8000)])})} }); return verifyEventActor({ getUser:()=>client.auth.getUser(token) }); },
};
export const kioskDigest = (value: string) => createHash("sha256").update(value).digest("hex");
export function kioskDerive(secret: string, purpose: string, ...parts: string[]): string { if (secret.length < 32 || secret.length > 4096 || /\s/.test(secret)) throw new EventStoreError("unavailable",503); return createHmac("sha256",secret).update(JSON.stringify(["event-kiosk-v1",purpose,...parts])).digest("base64url"); }
const name = (kind: "device" | "operator", secure: boolean) => `${secure ? "__Host-" : ""}pb-kiosk-${kind}`;
function cookie(request: Request, kind: "device" | "operator", secure: boolean) {
  const raw = request.headers.get("cookie") ?? ""; if (raw.length>16384) throw new EventStoreError("access_denied",403);
  const parts = raw.split(";").map(v=>v.trim().split("=")).filter(v=>v[0]===name(kind,secure));
  try { if(parts.length!==1 || parts[0].length!==2) throw new Error(); return eventSecret(parts[0][1]); } catch { throw new EventStoreError("access_denied",403); }
}
function setCookie(response: Response, key: string, value: string, seconds: number, secure: boolean, httpOnly = true) { response.headers.append("Set-Cookie",`${key}=${value}; Path=/; Max-Age=${seconds}; SameSite=Strict${httpOnly ? "; HttpOnly" : ""}${secure ? "; Secure" : ""}`); }
function clearGuestCookies(response:Response,secure:boolean) {
  for(const kind of ['contribute','receipt','gallery','display']) {
    if(secure)setCookie(response,`__Host-pb-event-${kind}`,'',0,true);
    for(const path of ['/','/api/events'])response.headers.append('Set-Cookie',`pb-event-${kind}=; Path=${path}; Max-Age=0; SameSite=Strict; HttpOnly${secure?'; Secure':''}`);
  }
}
const bad = (): never => { throw new EventStoreError("invalid_request",400); };
export function createEventKioskHandler(ports: EventKioskRequestPorts = production, getEnv: () => Record<string,string|undefined> = () => process.env) {
  let occupied=0;
  return async (request: Request, eventId: string): Promise<Response> => {
    if(occupied>=4) return privateJson({error:"unavailable"},503); occupied++;
    const abort=new AbortController(), signal=AbortSignal.any([request.signal,abort.signal]), timer=setTimeout(()=>abort.abort(),30000);
    const check=()=>{if(signal.aborted) throw new EventStoreError("unavailable",503);};
    const work=(async()=>{try {
      const env=getEnv(), url=new URL(request.url), local=env.NODE_ENV==="development" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname), secure=url.protocol==="https:", secret=env.PB_EVENT_TRANSPORT_SECRET??"";
      if(env.PB_EVENTS_ENABLED!=="true" || !secure && !local || !local && !canonicalPublicOrigin(env.PB_PUBLIC_ORIGIN)) throw new EventStoreError("unavailable",503);
      if(request.method!=="POST" || url.search) return bad(); eventUuid(eventId); requireSameOrigin(request,env); kioskDerive(secret,"validate");
      const header=env.PB_EVENT_TRUSTED_IP_HEADER, ip=header && /^[a-z][a-z0-9-]{0,63}$/.test(header)?request.headers.get(header)?.trim():local?"127.0.0.1":null;
      if(!ip || !isIP(ip)) throw new EventStoreError("unavailable",503);
      const b=await readSmallJson(request); check(); if(typeof b.operation!=="string") return bad(); const operation=b.operation, shape=(...fields:string[])=>eventObject(b,["operation",...fields]);
      if(isLocalRelease(env) && !localReleaseKioskAllowed(operation)) throw new EventStoreError("unavailable",503);
      const kiosk=ports.kiosk(env,signal), core=ports.core(env,signal);
      const rate=async(key:string,scope:"read"|"write"|"redeem")=>{ const r=await core.rate(kioskDigest(kioskDerive(secret,"rate",key)),scope); check(); if(!r.allowed) throw new RequestValidationError(429,"rate_limited"); };
      await rate(`ip:${isIP(ip)===6?new URL(`http://[${ip}]`).hostname:ip}`,["session","context","status","operator","capabilities"].includes(operation)?"read":operation==="unlock"?"redeem":"write");
      const limits=await kiosk.capabilities(); check();
      if(operation==="capabilities") {shape();return privateJson(limits);}
      if(operation==="create" || operation==="revoke") {
        shape("deviceId",...(operation==="create"?["pin"]:[])); const bearer=/^Bearer ([^\s]+)$/.exec(request.headers.get("authorization")??"")?.[1]; if(!bearer) throw new EventStoreError("access_denied",401);
        const actor=await ports.authenticate(bearer,env,signal); check(); await rate(`actor:${actor.id}`,"write"); const id=eventUuid(b.deviceId);
        if(operation==="revoke") {const result=await kiosk.revoke(actor,eventId,id);check();return privateJson(result);}
        if(typeof b.pin!=="string" || !/^\d{6}$/.test(b.pin)) return bad();
        const token=kioskDerive(secret,"device",eventId,id,actor.id), pin=kioskDigest(kioskDerive(secret,"pin",eventId,id,b.pin));
        const session=await kiosk.create(actor,eventId,id,kioskDigest(token),pin);check();
        const response=privateJson(session,201);setCookie(response,name("device",secure),token,Math.min(34560000,Math.max(1,Math.ceil((Date.parse(session.expiresAt)-Date.now())/1000))),secure);
        setCookie(response,KIOSK_LOCK_COOKIE,`${eventId}.${id}`,34560000,secure,false);clearGuestCookies(response,secure);setCookie(response,name("operator",secure),"",0,secure);return response;
      }
      if(request.headers.has("authorization")) return bad(); const token=cookie(request,"device",secure), tokenHash=kioskDigest(token), session=await kiosk.session(eventId,tokenHash);check();
      await rate(`device:${session.deviceId}`,["session","context","status","operator"].includes(operation)?"read":operation==="unlock"?"redeem":"write");
      if(operation==="session") {shape();return privateJson(session);}
      if(operation==="unlock") {
        shape("pin","nonce");if(typeof b.pin!=="string" || !/^\d{6}$/.test(b.pin)) return bad();const nonce=eventSecret(b.nonce), proof=kioskDigest(kioskDerive(secret,"pin",eventId,session.deviceId,b.pin)), unlock=kioskDerive(secret,"unlock",token,nonce);
        const result=await kiosk.unlock(eventId,tokenHash,proof,kioskDigest(unlock));check();const response=privateJson(result);if(result.allowed)setCookie(response,name("operator",secure),unlock,EVENT_KIOSK_LIMITS.unlockSeconds,secure);return response;
      }
      if(operation==="operator" || operation==="exit") {
        shape();const operator=await kiosk.operator(eventId,tokenHash,kioskDigest(cookie(request,"operator",secure)));check();const response=privateJson(operator);
        if(operation==="exit") {clearGuestCookies(response,secure);setCookie(response,KIOSK_LOCK_COOKIE,"",0,secure,false);setCookie(response,name("operator",secure),"",0,secure);}return response;
      }
      if(operation==="reset") {shape("generation","requestId");const result=await kiosk.reset(eventId,tokenHash,eventInteger(b.generation,0,10000),eventUuid(b.requestId));check();const response=privateJson(result);setCookie(response,name("operator",secure),"",0,secure);return response;}
      if(operation==="begin" || operation==="context" || operation==="reserve") {
        if((request.headers.get("cookie")??"").split(";").some(v=>/^\s*sb-[^=]+-auth-token(?:\.\d+)?=/.test(v))) throw new EventStoreError("conflict",409);
        shape("generation","guestId",...(operation==="reserve"?["submissionId","requestId","approval"]:[]));const generation=eventInteger(b.generation,0,10000), guestId=eventUuid(b.guestId), contribution=kioskDerive(secret,"contribution",eventId,session.deviceId,String(generation),guestId);
        if(session.generation!==generation || operation!=="begin" && session.guestId!==guestId || !session.enabled) throw new EventStoreError("access_denied",403);
        if(operation==="begin") {const result=await kiosk.begin(eventId,tokenHash,generation,guestId,kioskDigest(contribution));check();return privateJson(result);}
        if(operation==="context") {const host=ports.host(env,signal);if(!host.guestContext) throw new EventStoreError("unavailable",503);const result=await host.guestContext(eventId,kioskDigest(contribution));check();const latest=await kiosk.session(eventId,tokenHash);check();if(latest.generation!==generation || latest.guestId!==guestId || !latest.enabled) throw new EventStoreError("access_denied",403);return privateJson(result);}
        let approval;try{approval=parseKioskApproval(b.approval);}catch{return bad();}const submissionId=eventUuid(b.submissionId),requestId=eventUuid(b.requestId),receiptToken=kioskDerive(secret,"receipt",eventId,session.deviceId,String(generation),guestId,submissionId,requestId);
        const result=await kiosk.reserve({eventId,token:tokenHash,generation,guestId,contribution:kioskDigest(contribution),submissionId,requestId,receipt:kioskDigest(receiptToken),approval});check();
        const latest=await kiosk.session(eventId,tokenHash);check();if(latest.generation!==generation || latest.guestId!==guestId || !latest.enabled) throw new EventStoreError("access_denied",403);
        return privateJson({...result,receiptToken});
      }
      if(["upload","status","finalise"].includes(operation)) {
        shape("generation","submissionId");const generation=eventInteger(b.generation,0,10000),submissionId=eventUuid(b.submissionId);
        if(operation!=="upload") {const result=await kiosk.job(eventId,tokenHash,generation,submissionId,operation as "status"|"finalise");check();return privateJson(result);}
        const authority=await kiosk.upload(eventId,tokenHash,generation,submissionId);check();const signed=await ports.objects(env).mintUpload(authority,signal);check();const latest=await kiosk.session(eventId,tokenHash);check();if(!latest.enabled || latest.deviceId!==session.deviceId) throw new EventStoreError("access_denied",403); const current=await kiosk.job(eventId,tokenHash,generation,submissionId,"status");check();if(!["reserved","uploading"].includes(current.state)) throw new EventStoreError("access_denied",403);
        return privateJson({submissionId,bucket:authority.bucket,path:authority.path,signedUrl:signed.signedUrl,expiresAt:signed.expiresAt,maxBytes:authority.maxBytes,overwrite:false});
      }
      return bad();
    }catch(error){const code=error instanceof EventStoreError?error.code:error instanceof RequestValidationError ? error.status===429?"rate_limited":error.status===403?"access_denied":error.status<500?"invalid_request":"unavailable":"unavailable",status=error instanceof EventStoreError || error instanceof RequestValidationError?error.status:503;return privateJson({error:code},status);}finally{occupied--;clearTimeout(timer);}})();
    let onAbort:(()=>void)|undefined;try{return await Promise.race([work,new Promise<Response>(resolve=>{onAbort=()=>resolve(privateJson({error:"unavailable"},503));signal.addEventListener("abort",onAbort,{once:true});if(signal.aborted)onAbort();})]);}finally{if(onAbort)signal.removeEventListener("abort",onAbort);}
  };
}
