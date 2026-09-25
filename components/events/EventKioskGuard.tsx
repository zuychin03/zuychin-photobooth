"use client";
import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { KIOSK_LOCK_STORAGE, kioskCookieValue, kioskLock } from "@/lib/events/kiosk-lock";

export function notifyKioskLock() { window.dispatchEvent(new Event("pb-kiosk-lock")); }
const KioskLockedContext = createContext(false);
export function useKioskLocked() { return useContext(KioskLockedContext); }
function readLock() {
  const cookie = kioskCookieValue(document.cookie);
  try { const saved = localStorage.getItem(KIOSK_LOCK_STORAGE); if (cookie !== null) { if(saved!==cookie) localStorage.setItem(KIOSK_LOCK_STORAGE,cookie); return kioskLock(cookie); } return kioskLock(saved); }
  catch { return kioskLock(cookie); }
}
export default function EventKioskGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname(), [ready,setReady]=useState(false),[lock,setLock]=useState<ReturnType<typeof kioskLock>>(null);
  useLayoutEffect(()=>{
    const check=()=>{ const next=readLock(); setLock(previous => previous?.path===next?.path && previous?.deviceId===next?.deviceId ? previous : next); setReady(true); if(next && location.pathname!==next.path) { document.documentElement.style.visibility="hidden"; location.replace(next.path); } else document.documentElement.style.removeProperty("visibility"); };
    const hide=()=>{document.documentElement.style.visibility="hidden";};
    const visible=()=>{if(document.hidden) hide();else check();};
    const navigation=(event:MouseEvent)=>{ const next=readLock(); if(!next)return; const link=(event.target as Element | null)?.closest?.("a[href]");if(!link)return; const target=new URL(link.getAttribute("href")!,location.href);if(target.protocol==="blob:"&&target.origin===location.origin&&link.hasAttribute("download"))return;if(target.origin!==location.origin || target.pathname!==next.path) {event.preventDefault();event.stopImmediatePropagation();} };
    check(); const timer=setInterval(check,500);
    window.addEventListener("pb-kiosk-lock",check);window.addEventListener("storage",check);window.addEventListener("pageshow",check);window.addEventListener("pagehide",hide);window.addEventListener("popstate",check);document.addEventListener("visibilitychange",visible);document.addEventListener("click",navigation,true);
    return()=>{clearInterval(timer);window.removeEventListener("pb-kiosk-lock",check);window.removeEventListener("storage",check);window.removeEventListener("pageshow",check);window.removeEventListener("pagehide",hide);window.removeEventListener("popstate",check);document.removeEventListener("visibilitychange",visible);document.removeEventListener("click",navigation,true);};
  },[]);
  const current = ready ? readLock() : lock;
  if(!ready || current && pathname!==current.path) return <main className="min-h-dvh" aria-label="Checking shared-device privacy" />;
  return <KioskLockedContext.Provider value={Boolean(current)}>{children}</KioskLockedContext.Provider>;
}
