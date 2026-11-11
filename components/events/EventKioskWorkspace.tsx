/* eslint-disable @next/next/no-img-element -- Kiosk previews use temporary local Blob URLs. */
"use client";
import { useRecoveryRelease } from "@/components/ReleaseMode";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toString as qrSvg } from "qrcode";
import { Aperture, Camera, Check, LockKeyhole, RotateCcw, Send } from "lucide-react";
import { useCamera } from "@/hooks/useCamera";
import { CameraPreview } from "@/components/CameraPreview";
import { stopStream } from "@/lib/camera";
import { runCaptureSequence } from "@/lib/capture-sequence";
import { captureChallengePhoto } from "@/lib/memories/challenge-camera";
import { prepareEventGuestPhoto } from "@/lib/events/guest-photo";
import { kioskPhotoApproval } from "@/lib/events/kiosk-client";
import { eventGuestError } from "@/lib/events/guest-runtime";
import type { EventGuestContext } from "@/lib/events/host-contract";
import type { EventKioskRuntime } from "@/lib/events/kiosk-runtime";
import type { EventKioskRecord } from "@/lib/events/kiosk-journal";

export function EventKioskWorkspace({ runtime, context, onReset, fixturePhoto }: { runtime: EventKioskRuntime; context: EventGuestContext; onReset(operator?: boolean): void; fixturePhoto?: () => Promise<Blob> }) {
  const recovery = useRecoveryRelease();
  const [camera,setCamera]=useState(false),[photo,setPhoto]=useState<{blob:Blob;url:string}|null>(null),[busy,setBusy]=useState(false),[count,setCount]=useState<number|null>(null),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null),[qr,setQr]=useState<string|null>(null),[accepted,setAccepted]=useState(false),[delivered,setDelivered]=useState(false);
  const [consent,setConsent]=useState({submission:false,gallery:false,wall:false});
  const {stream:streamRef,videoRef,attachVideo,ready:cameraReady,error:cameraError,facing,retry}=useCamera(camera&&!fixturePhoto);
  const alive=useRef(false),working=useRef(false),active=useRef<AbortController|null>(null),url=useRef<string|null>(null),record=useRef<EventKioskRecord|null>(null),ids=useRef<{id:string;requestId:string}|null>(null),heading=useRef<HTMLHeadingElement>(null),receiptHeading=useRef<HTMLHeadingElement>(null),restoreFocus=useRef(false);
  useLayoutEffect(()=>{if(!busy&&restoreFocus.current){restoreFocus.current=false;(receiptHeading.current??heading.current)?.focus();}},[busy,qr]);
  const clearPhoto=()=>{if(url.current)URL.revokeObjectURL(url.current);url.current=null;setPhoto(null);};
  const stop=()=>{stopStream(streamRef.current);streamRef.current=null;if(videoRef.current)videoRef.current.srcObject=null;setCamera(false);};
  useEffect(()=>{alive.current=true;heading.current?.focus();return()=>{alive.current=false;active.current?.abort();stopStream(streamRef.current);streamRef.current=null;if(url.current)URL.revokeObjectURL(url.current);};},[streamRef]);
  const run=async(task:(signal:AbortSignal)=>Promise<void>)=>{if(working.current)return;working.current=true;const abort=new AbortController();active.current=abort;setBusy(true);setError(null);try{await task(abort.signal);}catch(failure){if(alive.current&&!abort.signal.aborted)setError(eventGuestError(failure));}finally{working.current=false;if(alive.current){restoreFocus.current=true;setBusy(false);setCount(null);}}};
  const take=()=>void run(async signal=>{
    let source:Blob|null=null;
    if(fixturePhoto)source=await fixturePhoto();
    else {const video=videoRef.current;if(!video||!cameraReady)return;await runCaptureSequence([0],3,{cancelled:()=>signal.aborted||!alive.current,pause:ms=>new Promise(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();},timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();}),countdown:value=>{if(alive.current&&!signal.aborted)setCount(value);},capture:()=>{const pending=captureChallengePhoto(video,facing==='user',0,signal);stop();return pending;},persist:async(_slot,pending)=>{source=await pending;},saved:()=>{}});}
    if(!source||signal.aborted||!alive.current)return;stop();const prepared=await prepareEventGuestPhoto(source,context,signal,new Date().toISOString());if(signal.aborted||!alive.current)return;
    clearPhoto();const next=URL.createObjectURL(prepared.blob);url.current=next;setPhoto({blob:prepared.blob,url:next});setNotice(prepared.warning);setConsent({submission:false,gallery:false,wall:false});ids.current={id:crypto.randomUUID(),requestId:crypto.randomUUID()};heading.current?.focus();
  });
  const submit=()=>void run(async signal=>{
    if(recovery||!photo||!consent.submission||!ids.current||delivered)return;
    let saved=record.current;
    if(!saved){const approval=await kioskPhotoApproval(photo.blob,consent,null,signal);if(signal.aborted||!alive.current)return;saved=await runtime.savePhoto({...ids.current,blob:photo.blob,approval});if(signal.aborted||!alive.current)return;record.current=saved;setAccepted(true);}
    if(saved.state==='prepared'||saved.state==='reserving'){
      const reserved=await runtime.reserve(saved,signal);if(signal.aborted||!alive.current)return;saved=reserved.record;record.current=saved;
      const link=`${location.origin}/receipt/${saved.id}?event=${context.eventId}#token=${reserved.receiptToken}`;
      const svg=await qrSvg(link,{type:'svg',margin:4,width:384,errorCorrectionLevel:'M',color:{dark:'#000000',light:'#ffffffff'}});if(signal.aborted||!alive.current)return;setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    }
    const result=await runtime.send(saved,signal);if(signal.aborted||!alive.current)return;record.current=result.record;
    if(result.state==='ready'){setDelivered(true);clearPhoto();setNotice('Your photo is ready.');}
    else setNotice('Your photo is still sending. Scan your receipt before you finish.');
  });
  const consentRow="flex min-h-12 cursor-pointer items-start gap-3 px-4 py-3";
  return <main className="booth-mode mx-auto flex min-h-dvh w-full max-w-3xl flex-1 flex-col gap-5 px-4 pt-4 pb-10 sm:px-8 sm:pt-6">
    {recovery && <p role="status" className="notice">New uploads are paused. The operator can still check or download photos.</p>}
    <header className="flex items-center justify-between gap-4"><h1 ref={heading} tabIndex={-1} className="min-w-0 break-words font-display text-[1.75rem] leading-tight outline-none sm:text-4xl">{context.title}</h1><button className="btn btn-glass min-h-10 shrink-0 text-sm" onClick={()=>onReset(true)} aria-label="Open operator unlock"><LockKeyhole size={16} aria-hidden/>Operator</button></header>
    {error&&<p role="alert" className="notice border border-destructive/30 bg-destructive/10">{error} Recovery is only available if this photo was saved on the device.</p>}
    {notice&&<p role="status" className="notice">{notice}</p>}
    {photo?<img src={photo.url} alt="Your photo" className="max-h-[52dvh] w-full rounded-[1.75rem] object-contain"/>:!delivered&&<div className="relative aspect-[3/4] max-h-[58dvh] w-full overflow-hidden rounded-[1.75rem] bg-black"><CameraPreview videoRef={attachVideo} mirror={facing==='user'} filterCss="none" className="!object-contain"/>{count!==null&&<p role="status" className="absolute inset-0 flex items-center justify-center font-display text-[8rem] leading-none text-white [text-shadow:0_6px_32px_rgb(0_0_0/0.55)]">{count}</p>}
      {count===null&&<div className="absolute inset-x-0 bottom-5 flex flex-wrap items-center justify-center gap-3 px-4"><button className={`btn btn-glass ${cameraReady?'min-h-11 text-sm':'min-h-14 px-7 text-lg'}`} disabled={busy} onClick={()=>{if(fixturePhoto){void take();return;}setCamera(true);retry();}}><Camera size={cameraReady?17:22} aria-hidden/>{fixturePhoto?'Use synthetic camera photo':cameraError?'Try again':'Start camera'}</button>{cameraReady&&<button className="btn btn-glass min-h-14 px-7 text-lg" disabled={busy} onClick={take}><Aperture size={22} aria-hidden/>Take photo</button>}</div>}</div>}
    {!photo&&!delivered&&<p role="status" className="text-center text-sm text-muted-foreground">{busy?'Preparing your photo…':cameraError?'Couldn\'t start the camera. Check the browser permission and try again.':camera&&!cameraReady?'Waiting for camera permission…':'Start the camera when you\'re ready. There\'s a 3-second timer.'}</p>}
    {photo&&<section className="panel p-4 sm:p-5"><fieldset disabled={busy||accepted} className="panel-muted divide-y divide-border overflow-hidden"><legend className="sr-only">Sharing</legend><label className={consentRow}><input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-accent" checked={consent.submission} onChange={e=>setConsent({...consent,submission:e.target.checked})}/><span><span className="font-bold">Send this photo to the host.</span> Everyone in it is OK with that. If saved on this device, the operator can recover a pending photo for up to 24 hours.</span></label><label className={`${consentRow} font-bold`}><input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-accent" checked={consent.gallery} onChange={e=>setConsent({...consent,gallery:e.target.checked})}/>Show it in the event gallery too</label><label className={`${consentRow} font-bold`}><input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-accent" checked={consent.wall} onChange={e=>setConsent({...consent,wall:e.target.checked})}/>Show it on the public event wall too</label></fieldset><div className="mt-4 flex flex-wrap gap-3"><button className="btn btn-primary min-h-12 px-6" disabled={recovery||busy||!consent.submission} onClick={submit}><Send size={18} aria-hidden/>{busy?'Sending…':accepted?'Check or try again':'Send photo'}</button>{!accepted&&<button className="btn btn-quiet min-h-12" disabled={busy} onClick={()=>{clearPhoto();setConsent({submission:false,gallery:false,wall:false});setCamera(true);retry();}}><RotateCcw size={17} aria-hidden/>Retake</button>}</div></section>}
    {qr&&<section className="panel flex flex-col items-center gap-3 p-5 text-center sm:p-6"><h2 ref={receiptHeading} tabIndex={-1} className="font-display text-2xl outline-none">Take your receipt with you</h2><p className="max-w-md text-sm">Scan this with your phone to see your photo and change sharing. It disappears when you finish.</p><img src={qr} alt="QR code for your receipt" width={288} height={288} className="mt-1 max-w-full rounded-2xl bg-white p-2"/></section>}
    <div className="mt-auto flex flex-col items-center gap-2 pt-2 text-center"><button className="btn btn-quiet" onClick={()=>onReset(false)}><Check size={17} aria-hidden/>Finish and clear</button><p className="max-w-md text-xs text-muted-foreground">Finishing or leaving this page clears your preview and receipt. The booth also resets after two minutes of no activity.</p></div>
  </main>;
}
