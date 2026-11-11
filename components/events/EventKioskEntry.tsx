"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";
import { useLocalRelease, useRecoveryRelease } from "@/components/ReleaseMode";
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
import { Camera, LoaderCircle, LockKeyhole } from "lucide-react";

export function EventKioskEntry({eventId,available}:{eventId:string;available:boolean}) {
  const auth=useAuth(),booth=useBoothSession();
  const [options,setOptions]=useState<EventKioskRuntimeOptions|null>();
  useEffect(()=>{let cancelled=false;queueMicrotask(()=>{if(cancelled)return;try{setOptions({appOrigin:location.origin,storageOrigin:new URL(process.env.NEXT_PUBLIC_SUPABASE_URL??'').origin,eventId});}catch{setOptions(null);}});return()=>{cancelled=true;};},[eventId]);
  const prepare=async()=>{const result=await createClient().auth.getSession();return result.data.session?.access_token??null;};
  const signOut=async()=>{const resume=await booth.suspendForSignOut();try{await auth.signOut();}finally{resume();}};
  if(available&&options===undefined)return <main className="booth-mode mx-auto flex min-h-dvh w-full max-w-xl flex-1 flex-col gap-6 px-4 pt-10 pb-10 sm:px-8 sm:pt-14"><h1 className="font-display text-[2.125rem] leading-[1.12] sm:text-5xl">Setting up the kiosk</h1><p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" aria-hidden />Checking this device…</p></main>;
  return <EventKioskShell options={options??null} available={available} signedIn={Boolean(auth.user)} accountId={auth.user?.id??null} authLoading={auth.loading} accessToken={prepare} signOut={signOut}/>;
}
export function EventKioskShell({options,available,signedIn,accountId,authLoading=false,accessToken,signOut,fixturePhoto,onFixtureExit}:{options:EventKioskRuntimeOptions|null;available:boolean;signedIn:boolean;accountId?:string|null;authLoading?:boolean;accessToken():Promise<string|null>;signOut():Promise<void>;fixturePhoto?:()=>Promise<Blob>;onFixtureExit?:()=>void}) {
  const localOnly = useLocalRelease(), recovery = useRecoveryRelease();
  const [mode,setMode]=useState<'loading'|'setup'|'ready'|'guest'|'resetting'|'operator'|'blocked'>('loading'),[runtime,setRuntime]=useState<EventKioskRuntime|null>(null),[context,setContext]=useState<EventGuestContext|null>(null),[error,setError]=useState<string|null>(null),[pin,setPin]=useState(''),[confirmPin,setConfirmPin]=useState(''),[dedicated,setDedicated]=useState(false),[busy,setBusy]=useState(false),[handoff,setHandoff]=useState(false),[setupFrozen,setSetupFrozen]=useState(false),[setupConfirmed,setSetupConfirmed]=useState(false);
  const alive=useRef(false),instance=useRef<EventKioskRuntime|null>(null),operation=useRef<AbortController|null>(null),running=useRef(false),setup=useRef<{deviceId:string;pin:string}|null>(null),guestId=useRef<string|null>(null),setupComplete=useRef(false),identity=useRef(accountId??(signedIn?"fixture-owner":null)),startButton=useRef<HTMLButtonElement>(null);
  useAppNavigationGuard(() => { if (busy || handoff || setupFrozen) { setError("Finish setting up the kiosk before you leave."); return false; } return true; });
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
  const begin=()=>void run(async signal=>{if(recovery||!runtime||identity.current)return;guestId.current??=crypto.randomUUID();const next=await runtime.begin(guestId.current,signal);if(alive.current&&!signal.aborted){setContext(next.context);setMode('guest');}});
  const exit=()=>{if(onFixtureExit){onFixtureExit();return;}localStorage.removeItem(KIOSK_LOCK_STORAGE);notifyKioskLock();location.replace('/');};
  const shell="booth-mode mx-auto flex min-h-dvh w-full max-w-xl flex-1 flex-col gap-6 px-4 pt-10 pb-10 sm:px-8 sm:pt-14";
  const pinField="field mt-1.5 text-center text-2xl font-black tracking-[0.5em]";
  if(!available||!options)return <main className={shell}><h1 className="font-display text-3xl">The kiosk isn&apos;t available here</h1><p className="text-muted-foreground">Ask the event host for help.</p></main>;
  if(mode==='guest'&&runtime&&context)return <EventKioskWorkspace runtime={runtime} context={context} onReset={reset} fixturePhoto={fixturePhoto}/>;
  if(mode==='operator'&&runtime)return <EventKioskOperator runtime={runtime} onLock={()=>reset(false)} onExit={exit}/>;
  return <main className={shell}><h1 className="page-head font-display text-[2.125rem] leading-[1.12] sm:text-5xl">{mode==='ready'?'Ready for your photo':mode==='setup'?'Set up this kiosk':'Getting ready…'}</h1>{error&&<p role="alert" className="notice border border-destructive/30 bg-destructive/10">{error}</p>}
    {(mode==='loading'||mode==='resetting')&&<p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" aria-hidden />Clearing the last guest&apos;s photo…</p>}
    {mode==='ready'&&<div className="page-body flex flex-col items-stretch gap-4">{(localOnly || recovery)&&<p className="notice">New photos are paused. Use Operator unlock to finish.</p>}{!localOnly&&!recovery&&<button ref={startButton} className="btn btn-primary min-h-20 rounded-[1.75rem] text-xl" disabled={busy||!runtime?.session?.enabled} onClick={begin}><Camera size={26} strokeWidth={2.25} aria-hidden />{busy?'Starting…':'Start my photo'}</button>}<button className="btn btn-plain self-center text-sm" onClick={()=>reset(true)}><LockKeyhole size={16} aria-hidden />Operator unlock</button></div>}
    {mode==='setup'&&(signedIn||handoff?<section className="page-body panel flex flex-col gap-4 p-5 sm:p-6"><p className="text-sm">Use a browser profile just for the kiosk. Setup signs you out and hides your account pages and drafts without deleting them. It can&apos;t stop someone with developer tools.</p><div className="grid gap-4 sm:grid-cols-2"><div><label className="block text-sm font-bold" htmlFor="kiosk-new-pin">6-digit PIN</label><input id="kiosk-new-pin" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} className={pinField} value={pin} disabled={busy||setupFrozen} onChange={event=>setPin(event.target.value.replace(/\D/g,''))}/></div><div><label className="block text-sm font-bold" htmlFor="kiosk-confirm-pin">Confirm PIN</label><input id="kiosk-confirm-pin" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} className={pinField} value={confirmPin} disabled={busy||setupFrozen} onChange={event=>setConfirmPin(event.target.value.replace(/\D/g,''))}/></div></div><label className="panel-muted flex min-h-12 cursor-pointer items-start gap-3 px-4 py-3 text-sm"><input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-accent" checked={dedicated} disabled={busy} onChange={event=>setDedicated(event.target.checked)}/>This browser profile is just for the kiosk, my other tabs are closed, and I&apos;ll keep the PIN private.</label><button className="btn btn-primary self-start" disabled={recovery||busy||!dedicated||!setupFrozen&&!setupConfirmed&&(pin.length!==6||pin!==confirmPin)} onClick={configure}>{busy?'Setting up…':setupConfirmed?'Sign out':setupFrozen?'Try again':'Save PIN and start kiosk'}</button></section>:<section className="page-body panel flex flex-col items-start gap-4 p-5 sm:p-6"><p>The event owner needs to set up this browser first.</p><Link className="btn btn-primary" href={`/login?next=${encodeURIComponent(`/e/${options.eventId}/kiosk`)}`}>Sign in</Link></section>)}
    {mode==='blocked'&&<div className="flex flex-wrap gap-3"><button className="btn btn-primary" disabled={busy} onClick={()=>reset(false)}>Try again</button><button className="btn btn-quiet" onClick={()=>setMode('operator')}><LockKeyhole size={16} aria-hidden />Operator unlock</button></div>}
  </main>;
}
