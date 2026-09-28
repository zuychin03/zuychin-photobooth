"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowDownToLine, FolderOpen, LoaderCircle } from "lucide-react";
import { Dropdown } from "@/components/Dropdown";
import type { CloudProjectClient } from "@/lib/projects/cloud-client";
import type { CloudDesignRecord } from "@/lib/projects/cloud-design";
import type { PhotoProject } from "@/lib/projects/model";
import { openCloudDesignCopy, type CloudDesignOpenResult } from "@/lib/projects/cloud-design-open";
import { downloadProjectBlob } from "@/lib/projects/download";
import { cloudControl, cloudError } from "./CloudControls";
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
  return <section className="border-b border-border py-6" aria-labelledby={`${id}-title`} aria-busy={busy}>
    <div className="flex flex-wrap items-start justify-between gap-5">
      <div className="max-w-xl"><h3 ref={heading} id={`${id}-title`} tabIndex={-1} className="font-display text-2xl outline-none">Open a saved design</h3><p className="mt-2 text-sm leading-relaxed text-foreground/70">Open it as a new project on this device.</p></div>
      <div className="w-full sm:w-60"><Dropdown label="Version" showLabel value={checkpoint} disabled={disabled || busy} options={[{ value: "current", label: "Latest" }, { value: "previous", label: "Previous" }]} onChange={value => { setCheckpoint(value as typeof checkpoint); setRecord(null); setChecked(false); setSavedCopy(null); setError(null); }} /></div>
    </div>
    {error && <p role="alert" className="mt-4 max-w-2xl rounded-xl bg-muted p-4 text-sm leading-relaxed">{error}</p>}
    {checked && !record && <p role="status" className="mt-4 text-sm text-foreground/70">{checkpoint === "current" ? "No design has been saved to this project yet." : "There's no previous version."}</p>}
    {record && <div className="mt-4 space-y-2 text-sm"><p className="font-medium">{record.unsupported ? "A design from a newer app" : record.snapshot.project.name}</p><p className="text-foreground/70">Version {record.revision + 1} · Saved {new Date(record.savedAt).toLocaleString("en-AU")}{!record.unsupported && ` · ${record.snapshot.bindings.length} ${record.snapshot.bindings.length === 1 ? "photo" : "photos"}`}</p>{record.unsupported && <p className="max-w-2xl leading-relaxed text-foreground/70">This design needs a newer version of the app. You can back it up as a JSON file, without photos.</p>}</div>}
    {savedCopy && <p role="status" className="mt-4 text-sm">A copy was saved to My projects.</p>}
    <div className="mt-5 flex flex-wrap gap-3">
      <button className={`${cloudControl} border border-border`} disabled={disabled || busy} onClick={() => void inspect()}>{checked ? "Check again" : "Check saved design"}</button>
      {record && (record.unsupported ? <button className={`${cloudControl} border border-border`} disabled={disabled || busy} onClick={() => void backup()}><ArrowDownToLine size={17} aria-hidden /> Back up design JSON</button> : <button className={`${cloudControl} bg-accent text-accent-foreground`} disabled={disabled || busy} onClick={() => void open()}><FolderOpen size={17} aria-hidden /> Open a copy</button>)}
      {busy && <button className={cloudControl} onClick={() => controller.current?.abort()}>Stop</button>}
    </div>
    {busy && <p role="status" className="mt-3 flex items-center gap-2 text-sm"><LoaderCircle size={16} aria-hidden className="animate-spin motion-reduce:animate-none" /> Preparing your copy…</p>}
  </section>;
}
