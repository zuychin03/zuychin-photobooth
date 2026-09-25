/* eslint-disable @next/next/no-img-element -- Kiosk previews use temporary local Blob URLs. */
"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toString as qrSvg } from "qrcode";
import { Camera, LockKeyhole, RotateCcw } from "lucide-react";
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
import { eventControl } from "./EventHostControls";

export function EventKioskWorkspace({ runtime, context, onReset, fixturePhoto }: { runtime: EventKioskRuntime; context: EventGuestContext; onReset(operator?: boolean): void; fixturePhoto?: () => Promise<Blob> }) {
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
    if(!photo||!consent.submission||!ids.current||delivered)return;
    let saved=record.current;
    if(!saved){const approval=await kioskPhotoApproval(photo.blob,consent,null,signal);if(signal.aborted||!alive.current)return;saved=await runtime.savePhoto({...ids.current,blob:photo.blob,approval});if(signal.aborted||!alive.current)return;record.current=saved;setAccepted(true);}
    if(saved.state==='prepared'||saved.state==='reserving'){
      const reserved=await runtime.reserve(saved,signal);if(signal.aborted||!alive.current)return;saved=reserved.record;record.current=saved;
      const link=`${location.origin}/receipt/${saved.id}?event=${context.eventId}#token=${reserved.receiptToken}`;
      const svg=await qrSvg(link,{type:'svg',margin:4,width:384,errorCorrectionLevel:'M',color:{dark:'#000000',light:'#ffffffff'}});if(signal.aborted||!alive.current)return;setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    }
    const result=await runtime.send(saved,signal);if(signal.aborted||!alive.current)return;record.current=result.record;
    if(result.state==='ready'){setDelivered(true);clearPhoto();setNotice('Your event photo is ready. Its temporary device copy has been removed.');}
    else setNotice('Your photo is waiting for the event worker. Scan your private receipt before finishing. The operator can recover the pending upload after you leave.');
  });
  return <main className="mx-auto min-h-dvh max-w-3xl px-5 py-7 sm:px-8">
    <header className="flex items-start justify-between gap-4"><div><h1 ref={heading} tabIndex={-1} className="mt-2 font-display text-3xl outline-none">{context.title}</h1></div><button className={eventControl} onClick={()=>onReset(true)} aria-label="End guest session and open operator unlock"><LockKeyhole size={18} aria-hidden/>Operator</button></header>
    {error&&<p role="alert" className="mt-5 rounded-xl bg-muted p-4 text-sm leading-relaxed">{error} Your pending photo is retained for the operator only if device saving was confirmed.</p>}
    {notice&&<p role="status" className="mt-5 text-sm leading-relaxed">{notice}</p>}
    {photo?<img src={photo.url} alt="Your finished event photo, before approval" className="mt-6 max-h-[52dvh] w-full object-contain"/>:!delivered&&<div className="relative mt-6 aspect-[3/4] max-h-[58dvh] overflow-hidden rounded-xl bg-muted"><CameraPreview videoRef={attachVideo} mirror={facing==='user'} filterCss="none" className="!object-contain"/>{count!==null&&<p role="status" className="absolute inset-0 flex items-center justify-center font-display text-8xl text-white">{count}</p>}</div>}
    {!photo&&!delivered&&<><p role="status" className="mt-4 text-sm">{busy?'Preparing your photo…':cameraError?'Camera access could not start. Check the browser permission and retry.':camera&&!cameraReady?'Waiting for camera permission…':'Start the camera when ready. Three-second timer, no flash or sound.'}</p><div className="mt-4 flex gap-3"><button className={`${eventControl} bg-accent text-accent-foreground`} disabled={busy} onClick={()=>{if(fixturePhoto){void take();return;}setCamera(true);retry();}}><Camera size={17} aria-hidden/>{fixturePhoto?'Use synthetic camera photo':cameraError?'Retry camera':'Start camera'}</button>{cameraReady&&<button className={`${eventControl} border border-border`} disabled={busy} onClick={take}>Take photo</button>}</div></>}
    {photo&&<><fieldset disabled={busy||accepted} className="mt-6 space-y-2 border-y border-border py-5"><legend className="sr-only">Your photo permissions</legend><label className="flex min-h-11 items-start gap-3 py-2"><input type="checkbox" className="mt-1 h-5 w-5 accent-accent" checked={consent.submission} onChange={e=>setConsent({...consent,submission:e.target.checked})}/><span>I approve this finished photo for private event delivery. Everyone pictured has agreed. A pending device copy is kept for the operator for up to 24 hours, or until event expiry.</span></label><label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="h-5 w-5 accent-accent" checked={consent.gallery} onChange={e=>setConsent({...consent,gallery:e.target.checked})}/>Also allow the event gallery</label><label className="flex min-h-11 items-center gap-3"><input type="checkbox" className="h-5 w-5 accent-accent" checked={consent.wall} onChange={e=>setConsent({...consent,wall:e.target.checked})}/>Also allow the live event wall</label></fieldset><div className="mt-4 flex flex-wrap gap-3"><button className={`${eventControl} bg-accent text-accent-foreground`} disabled={busy||!consent.submission} onClick={submit}>{busy?'Saving and sending…':accepted?'Check or retry this photo':'Approve and send photo'}</button>{!accepted&&<button className={`${eventControl} border border-border`} disabled={busy} onClick={()=>{clearPhoto();setConsent({submission:false,gallery:false,wall:false});setCamera(true);retry();}}><RotateCcw size={17} aria-hidden/>Retake</button>}</div></>}
    {qr&&<section className="mt-7 border-t border-border pt-5"><h2 ref={receiptHeading} tabIndex={-1} className="font-display text-2xl outline-none">Take your receipt with you</h2><p className="mt-2 text-sm leading-relaxed">Scan on your phone to view your photo and manage sharing. The link clears when you finish and is never kept in the kiosk queue.</p><img src={qr} alt="QR code for this guest’s private receipt" width={288} height={288} className="mt-4 max-w-full bg-white"/></section>}
    <div className="mt-7 border-t border-border pt-5"><button className={`${eventControl} border border-border`} onClick={()=>onReset(false)}>Finish and clear this guest</button><p className="mt-3 text-sm text-foreground/65">An idle booth resets after two minutes. Leaving or hiding this page clears the camera and guest preview immediately.</p></div>
  </main>;
}
