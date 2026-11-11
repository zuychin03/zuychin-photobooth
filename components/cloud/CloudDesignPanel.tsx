"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowDownToLine, FolderOpen, LoaderCircle } from "lucide-react";
import { Dropdown } from "@/components/Dropdown";
import type { CloudProjectClient } from "@/lib/projects/cloud-client";
import type { CloudDesignRecord } from "@/lib/projects/cloud-design";
import type { PhotoProject } from "@/lib/projects/model";
import { openCloudDesignCopy, type CloudDesignOpenResult } from "@/lib/projects/cloud-design-open";
import { downloadProjectBlob } from "@/lib/projects/download";
import { cloudError } from "./CloudControls";
import type { openProjectRepository } from "@/lib/projects/storage";

interface Props {
  client: CloudProjectClient;
  projectId: string;
  disabled: boolean;
  onBusy(busy: boolean): void;
  onOpened(result: Extract<CloudDesignOpenResult, { kind: "opened" }>): Promise<void>;
  openRepository?: typeof openProjectRepository;
}

export function CloudDesignPanel({ client, projectId, disabled, onBusy, onOpened, openRepository }: Props) {
  const id = useId(), heading = useRef<HTMLHeadingElement>(null);
  const [checkpoint, setCheckpoint] = useState<"current" | "previous">("current");
  const [record, setRecord] = useState<CloudDesignRecord | null>(null), [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [savedCopy, setSavedCopy] = useState<PhotoProject | null>(null);
  const live = useRef(false), running = useRef(false), controller = useRef<AbortController | null>(null);
  const busyCallback = useRef(onBusy);
  useEffect(() => { busyCallback.current = onBusy; }, [onBusy]);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; controller.current?.abort(); if (running.current) busyCallback.current(false); };
  }, [client, projectId]);
  const run = async (work: (signal: AbortSignal) => Promise<void>) => {
    if (running.current || disabled) return;
    const abort = new AbortController(); controller.current = abort; running.current = true;
    setBusy(true); onBusy(true); setError(null);
    try { await work(abort.signal); }
    catch (failure) {
      if (live.current) {
        const code = failure && typeof failure === "object" && "code" in failure ? String(failure.code) : "";
        setRecord(null); setChecked(false);
        const messages: Record<string, string> = {
          update_required: "Saved designs aren't available on this server yet.",
          design_changed: "This saved design changed. Check it again before opening a copy.",
          missing_design: "This version isn't available anymore. Check the latest saved design.",
          source_unavailable: "One of the design's photos isn't available anymore. Check the latest saved design.",
          integrity_failed: "One of the photos didn't match the saved design. Try again later.",
          cleanup_failed: "Opening stopped, but a partial copy may be left in My projects. Check there before trying again.",
        };
        setError(code === "cleanup_failed" ? messages[code] : abort.signal.aborted ? "Opening stopped." : messages[code] ?? cloudError(failure));
      }
    } finally {
      running.current = false;
      if (live.current) { setBusy(false); onBusy(false); heading.current?.focus(); }
    }
  };
  const inspect = () => run(async signal => {
    setRecord(null); setChecked(false); setSavedCopy(null);
    await client.designCapabilities(signal);
    const next = await client.readDesign(projectId, checkpoint, signal);
    client.assertActive(signal);
    if (live.current) { setRecord(next); setChecked(true); }
  });
  const open = () => run(async signal => {
    if (!record) return;
    const result = await openCloudDesignCopy({ client, projectId, checkpoint, expectedReceipt: record, signal, openRepository });
    client.assertActive(signal);
    if (!live.current) return;
    if (result.kind === "unsupported") { setRecord(result.record); return; }
    setSavedCopy(result.project);
    await onOpened(result);
  });
  const backup = () => run(async signal => {
    if (!record?.unsupported) return;
    const fresh = await client.readDesign(projectId, checkpoint, signal);
    client.assertActive(signal);
    if (!fresh?.unsupported || fresh.requestId !== record.requestId || fresh.contentHash !== record.contentHash) throw { code: "conflict" };
    downloadProjectBlob(new Blob([fresh.rawSnapshot], { type: "application/json" }), `cloud-design-${fresh.revision + 1}.json`);
  });
  return <section className="panel p-4 sm:p-6" aria-labelledby={`${id}-title`} aria-busy={busy}>
    <div className="flex min-w-0 items-center gap-3"><span className="glyph bg-[#0ea5e9]"><FolderOpen size={18} strokeWidth={2.25} aria-hidden /></span><h3 ref={heading} id={`${id}-title`} tabIndex={-1} className="font-display text-xl leading-tight outline-none">Open a saved design</h3></div>
    <p className="mt-3 text-sm text-muted-foreground">Open it as a new project on this device.</p>
    <div className="mt-4 sm:max-w-60"><Dropdown label="Version" showLabel value={checkpoint} disabled={disabled || busy} options={[{ value: "current", label: "Latest" }, { value: "previous", label: "Previous" }]} onChange={value => { setCheckpoint(value as typeof checkpoint); setRecord(null); setChecked(false); setSavedCopy(null); setError(null); }} /></div>
    {error && <p role="alert" className="notice mt-4 border border-destructive/25 bg-destructive/8 font-bold text-destructive">{error}</p>}
    {checked && !record && <p role="status" className="mt-4 text-sm text-muted-foreground">{checkpoint === "current" ? "No design has been saved to this project yet." : "There's no previous version."}</p>}
    {record && <div className="panel-muted mt-4 space-y-1 p-4 text-sm"><p className="font-bold">{record.unsupported ? "A design from a newer app" : record.snapshot.project.name}</p><p className="text-muted-foreground">Version {record.revision + 1} · Saved {new Date(record.savedAt).toLocaleString("en-AU")}{!record.unsupported && ` · ${record.snapshot.bindings.length} ${record.snapshot.bindings.length === 1 ? "photo" : "photos"}`}</p>{record.unsupported && <p className="pt-1 text-muted-foreground">This design needs a newer version of the app. You can back it up as a JSON file, without photos.</p>}</div>}
    {savedCopy && <p role="status" className="mt-4 text-sm font-bold text-success">A copy was saved to My projects.</p>}
    <div className="mt-4 flex flex-wrap gap-2">
      <button className="btn btn-quiet min-h-10 text-sm" disabled={disabled || busy} onClick={() => void inspect()}>{checked ? "Check again" : "Check saved design"}</button>
      {record && (record.unsupported ? <button className="btn btn-quiet min-h-10 text-sm" disabled={disabled || busy} onClick={() => void backup()}><ArrowDownToLine size={17} aria-hidden /> Back up design JSON</button> : <button className="btn btn-primary min-h-10 text-sm" disabled={disabled || busy} onClick={() => void open()}><FolderOpen size={17} aria-hidden /> Open a copy</button>)}
      {busy && <button className="btn btn-plain min-h-10 text-sm" onClick={() => controller.current?.abort()}>Stop</button>}
    </div>
    {busy && <p role="status" className="mt-3 flex items-center gap-2 text-sm font-bold"><LoaderCircle size={16} aria-hidden className="animate-spin text-accent motion-reduce:animate-none" /> Preparing your copy…</p>}
  </section>;
}
