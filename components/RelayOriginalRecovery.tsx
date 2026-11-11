"use client";
import { useEffect, useState } from "react";
import { Download } from "lucide-react";
export function RelayOriginalRecovery({ originals, saved }: { originals: readonly Blob[]; saved: boolean }) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => { let live = true; const next = originals.map(blob => URL.createObjectURL(blob)); queueMicrotask(() => { if (live) setUrls(next); }); return () => { live = false; next.forEach(url => URL.revokeObjectURL(url)); }; }, [originals]);
  useEffect(() => { if (saved) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [saved]);
  return <div className="flex w-full max-w-md flex-col items-center gap-3 text-center text-sm"><p className={saved ? "text-muted-foreground" : "notice w-full font-bold"}>{saved ? "Your photos are saved in My projects." : "We couldn't confirm your photos saved on this device. Download each one before you leave, and check they actually landed in your downloads."}</p><div className="flex flex-wrap justify-center gap-2">{urls.map((url, index) => <a key={url} className="btn btn-quiet min-h-10 text-sm" href={url} download={`relay-original-${index + 1}.${originals[index].type === "image/jpeg" ? "jpg" : originals[index].type === "image/webp" ? "webp" : "png"}`}><Download size={15} aria-hidden />Photo {index + 1}</a>)}</div>{saved && <a href="/projects" className="btn btn-plain min-h-10 text-sm">My projects</a>}</div>;
}
