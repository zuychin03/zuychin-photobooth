"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";
import { useLocalRelease } from "@/components/ReleaseMode";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useBoothSession } from "@/lib/session";
import { createClient } from "@/lib/supabase/client";
import { createEventKioskRuntime, type EventKioskRuntime, type EventKioskRuntimeOptions } from "@/lib/events/kiosk-runtime";
import type { EventGuestContext } from "@/lib/events/host-contract";
import { KIOSK_LOCK_STORAGE } from "@/lib/events/kiosk-lock";
import { eventGuestError } from "@/lib/events/guest-runtime";
import { notifyKioskLock } from "./EventKioskGuard";
import { EventKioskWorkspace } from "./EventKioskWorkspace";
import { EventKioskOperator } from "./EventKioskOperator";
import { eventControl, eventInput } from "./EventHostControls";

export function EventKioskEntry({eventId,available}:{eventId:string;available:boolean}) {
  const auth=useAuth(),booth=useBoothSession();
  const [options,setOptions]=useState<EventKioskRuntimeOptions|null>();
  useEffect(()=>{let cancelled=false;queueMicrotask(()=>{if(cancelled)return;try{setOptions({appOrigin:location.origin,storageOrigin:new URL(process.env.NEXT_PUBLIC_SUPABASE_URL??'').origin,eventId});}catch{setOptions(null);}});return()=>{cancelled=true;};},[eventId]);
  const prepare=async()=>{const result=await createClient().auth.getSession();return result.data.session?.access_token??null;};
  const signOut=async()=>{const resume=await booth.suspendForSignOut();try{await auth.signOut();}finally{resume();}};
  if(available&&options===undefined)return <main className="mx-auto min-h-dvh max-w-xl px-6 py-14"><h1 className="font-display text-4xl">Preparing shared kiosk</h1><p role="status" className="mt-6">Checking device setup…</p></main>;
  return <EventKioskShell options={options??null} available={available} signedIn={Boolean(auth.user)} accountId={auth.user?.id??null} authLoading={auth.loading} accessToken={prepare} signOut={signOut}/>;
}
export function EventKioskShell({options,available,signedIn,accountId,authLoading=false,accessToken,signOut,fixturePhoto,onFixtureExit}:{options:EventKioskRuntimeOptions|null;available:boolean;signedIn:boolean;accountId?:string|null;authLoading?:boolean;accessToken():Promise<string|null>;signOut():Promise<void>;fixturePhoto?:()=>Promise<Blob>;onFixtureExit?:()=>void}) {
  const localOnly = useLocalRelease();
  const [mode,setMode]=useState<'loading'|'setup'|'ready'|'guest'|'resetting'|'operator'|'blocked'>('loading'),[runtime,setRuntime]=useState<EventKioskRuntime|null>(null),[context,setContext]=useState<EventGuestContext|null>(null),[error,setError]=useState<string|null>(null),[pin,setPin]=useState(''),[confirmPin,setConfirmPin]=useState(''),[dedicated,setDedicated]=useState(false),[busy,setBusy]=useState(false),[handoff,setHandoff]=useState(false),[setupFrozen,setSetupFrozen]=useState(false),[setupConfirmed,setSetupConfirmed]=useState(false);
  const alive=useRef(false),instance=useRef<EventKioskRuntime|null>(null),operation=useRef<AbortController|null>(null),running=useRef(false),setup=useRef<{deviceId:string;pin:string}|null>(null),guestId=useRef<string|null>(null),setupComplete=useRef(false),identity=useRef(accountId??(signedIn?"fixture-owner":null)),startButton=useRef<HTMLButtonElement>(null);
  useAppNavigationGuard(() => { if (busy || handoff || setupFrozen) { setError("Finish kiosk setup and sign-out before leaving."); return false; } return true; });
  useLayoutEffect(()=>{if(mode==='ready'&&!busy)startButton.current?.focus();},[mode,busy]);
  useLayoutEffect(()=>{identity.current=accountId??(signedIn?"fixture-owner":null);},[accountId,signedIn]);
  const refresh=useCallback(async(current:EventKioskRuntime,signal?:AbortSignal)=>{try{await current.start(signal);if(alive.current&&!signal?.aborted){setMode('ready');setError(null);}}catch(failure){if(alive.current&&!signal?.aborted){setMode((failure as {code?:string}).code==='access_denied'?'setup':'blocked');setError(eventGuestError(failure));}}},[]);
  useEffect(()=>{alive.current=true;if(authLoading||!available||!options){return()=>{alive.current=false;};}const current=createEventKioskRuntime(options),abort=new AbortController();instance.current=current;operation.current=abort;
    queueMicrotask(()=>{if(abort.signal.aborted)return;setRuntime(current);if(signedIn||handoff)setMode('setup');else void refresh(current,abort.signal);});
    return()=>{alive.current=false;abort.abort();operation.current?.abort();void current.close();instance.current=null;};
  },[options,available,authLoading,signedIn,accountId,handoff,refresh]);
  const reset=useCallback((operator=false)=>{const current=instance.current;if(!current)return;operation.current?.abort();setContext(null);setMode('resetting');guestId.current=null;setError(null);const abort=new AbortController();operation.current=abort;
    void current.reset(abort.signal).then(()=>{if(alive.current&&!abort.signal.aborted)setMode(operator?'operator':'ready');},failure=>{if(alive.current&&!abort.signal.aborted){setError(eventGuestError(failure));setMode('blocked');}});
  },[]);
  useEffect(()=>{if(mode!=='guest'&&mode!=='operator')return;let timer:ReturnType<typeof setTimeout>;const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>reset(false),120000);};const hidden=()=>{if(document.hidden)reset(false);};arm();window.addEventListener('pointerdown',arm);window.addEventListener('keydown',arm);document.addEventListener('visibilitychange',hidden);return()=>{clearTimeout(timer);window.removeEventListener('pointerdown',arm);window.removeEventListener('keydown',arm);document.removeEventListener('visibilitychange',hidden);};},[mode,reset]);
  const run=async(task:(signal:AbortSignal)=>Promise<void>)=>{if(running.current)return;running.current=true;const abort=new AbortController();operation.current=abort;setBusy(true);setError(null);try{await task(abort.signal);}catch(failure){if(alive.current&&!abort.signal.aborted)setError(eventGuestError(failure));}finally{running.current=false;if(alive.current)setBusy(false);}};
  const configure=()=>void run(async signal=>{if(!runtime||!options||!dedicated||!setup.current&&!setupComplete.current&&(pin.length!==6||pin!==confirmPin))return;
    if(!setupComplete.current){const input=setup.current??{deviceId:crypto.randomUUID(),pin};setup.current=input;setSetupFrozen(true);const owner=identity.current,token=await accessToken();if(signal.aborted||!alive.current||!owner||identity.current!==owner||!token)return;
      const session=await runtime.client.create(input.deviceId,input.pin,token,signal);if(signal.aborted||!alive.current||identity.current!==owner)return;localStorage.setItem(KIOSK_LOCK_STORAGE,`${session.eventId}.${session.deviceId}`);notifyKioskLock();setupComplete.current=true;setSetupConfirmed(true);setPin('');setConfirmPin('');}
    setHandoff(true);await signOut();setup.current=null;setupComplete.current=false;setSetupFrozen(false);setSetupConfirmed(false);setHandoff(false);
  });
  const begin=()=>void run(async signal=>{if(!runtime||identity.current)return;guestId.current??=crypto.randomUUID();const next=await runtime.begin(guestId.current,signal);if(alive.current&&!signal.aborted){setContext(next.context);setMode('guest');}});
  const exit=()=>{if(onFixtureExit){onFixtureExit();return;}localStorage.removeItem(KIOSK_LOCK_STORAGE);notifyKioskLock();location.replace('/');};
  if(!available||!options)return <main className="mx-auto max-w-xl px-6 py-16"><h1 className="font-display text-3xl">Kiosk is unavailable here</h1><p className="mt-4">This deployment has not enabled the event kiosk service. Ask the operator for help.</p></main>;
  if(mode==='guest'&&runtime&&context)return <EventKioskWorkspace runtime={runtime} context={context} onReset={reset} fixturePhoto={fixturePhoto}/>;
  if(mode==='operator'&&runtime)return <EventKioskOperator runtime={runtime} onLock={()=>reset(false)} onExit={exit}/>;
  return <main className="mx-auto min-h-dvh max-w-xl px-6 py-14"><p className="text-sm text-foreground/65">Shared event booth</p><h1 className="mt-3 font-display text-4xl">{mode==='ready'?'A fresh photo, just for you':mode==='setup'?'Set up this kiosk':'Preparing a private start'}</h1>{error&&<p role="alert" className="mt-5 rounded-xl bg-muted p-4 text-sm leading-relaxed">{error}</p>}
    {(mode==='loading'||mode==='resetting')&&<p role="status" className="mt-6">Clearing the previous guest and checking temporary storage…</p>}
    {mode==='ready'&&<><p className="mt-5 leading-relaxed">{localOnly?'New photos are paused for this release. Use Operator unlock to finish.':'Take a photo, then choose whether to share it in the gallery or on the wall.'}</p>{!localOnly&&<button ref={startButton} className={`${eventControl} mt-7 bg-accent text-accent-foreground`} disabled={busy||!runtime?.session?.enabled} onClick={begin}>{busy?'Starting…':'Start my photo'}</button>}<button className={`${eventControl} mt-5`} onClick={()=>reset(true)}>Operator unlock</button></>}
    {mode==='setup'&&(signedIn||handoff?<><p className="mt-5 text-sm leading-relaxed">Use a dedicated browser profile. Setup signs you out, hides account pages and drafts, and clears old guest access. Drafts are not deleted. This lock cannot stop someone using developer tools or the operating system.</p><label className="mt-6 block text-sm font-semibold" htmlFor="kiosk-new-pin">Six-digit operator PIN</label><input id="kiosk-new-pin" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} className={`${eventInput} mt-2`} value={pin} disabled={busy||setupFrozen} onChange={event=>setPin(event.target.value.replace(/\D/g,''))}/><label className="mt-4 block text-sm font-semibold" htmlFor="kiosk-confirm-pin">Confirm PIN</label><input id="kiosk-confirm-pin" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} className={`${eventInput} mt-2`} value={confirmPin} disabled={busy||setupFrozen} onChange={event=>setConfirmPin(event.target.value.replace(/\D/g,''))}/><label className="mt-5 flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" className="mt-1 h-5 w-5 accent-accent" checked={dedicated} disabled={busy} onChange={event=>setDedicated(event.target.checked)}/>This is a dedicated browser profile. I have closed other account tabs and will keep the operator PIN private.</label><button className={`${eventControl} mt-5 bg-accent text-accent-foreground`} disabled={busy||!dedicated||!setupFrozen&&!setupConfirmed&&(pin.length!==6||pin!==confirmPin)} onClick={configure}>{busy?'Setting up…':setupConfirmed?'Confirm account sign-out':setupFrozen?'Retry exact setup and sign out':'Set PIN, sign out and start kiosk'}</button></>:<><p className="mt-5">The event owner must set up this browser before guests can use it.</p><Link className={`${eventControl} mt-5 border border-border`} href={`/login?next=${encodeURIComponent(`/e/${options.eventId}/kiosk`)}`}>Operator sign-in</Link></>)}
    {mode==='blocked'&&<div className="mt-6 flex flex-wrap gap-3"><button className={`${eventControl} border border-border`} disabled={busy} onClick={()=>reset(false)}>Retry private reset</button><button className={eventControl} onClick={()=>setMode('operator')}>Operator unlock</button></div>}
  </main>;
}
