"use client";
import { useEffect, useState } from "react";
export function RelayOriginalRecovery({ originals, saved }: { originals: readonly Blob[]; saved: boolean }) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => { let live = true; const next = originals.map(blob => URL.createObjectURL(blob)); queueMicrotask(() => { if (live) setUrls(next); }); return () => { live = false; next.forEach(url => URL.revokeObjectURL(url)); }; }, [originals]);
  useEffect(() => { if (saved) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [saved]);
  return <div className="max-w-sm space-y-3 text-sm"><p>{saved ? "Your originals are saved in My projects for this account." : "Local saving has not been confirmed. Download each original before leaving this page. A download link does not confirm that your device saved the file."}</p><div className="flex flex-wrap justify-center gap-2">{urls.map((url, index) => <a key={url} className="min-h-11 rounded-full border border-border px-4 py-3" href={url} download={`relay-original-${index + 1}.${originals[index].type === "image/jpeg" ? "jpg" : originals[index].type === "image/webp" ? "webp" : "png"}`}>Original {index + 1}</a>)}</div>{saved && <a href="/projects" className="inline-block min-h-11 underline">My projects</a>}</div>;
}
