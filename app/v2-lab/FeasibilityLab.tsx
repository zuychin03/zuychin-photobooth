"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { runMediaProbe } from "@/lib/feasibility/media-probe";
import { clearReloadCheckpoint, runStorageProbe, saveReloadCheckpoint, verifyReloadCheckpoint } from "@/lib/feasibility/storage-probe";
import type { ProbeResult } from "@/lib/feasibility/types";
import { mediaResourceInventory, startHeapObservation, type HeapObservation } from "@/lib/feasibility/memory-observation";
import { runProjectStorageProbe, saveProjectReloadCheckpoint, verifyProjectReloadCheckpoint, clearProjectReloadCheckpoint, type ProjectStorageProbeResult } from "@/lib/feasibility/project-repository-probe";
import { runProjectRenderProbe } from "@/lib/feasibility/project-render-probe";
import { runTemplateProbe } from "@/lib/templates/probe";
import { runAssetBrowserProbe, runAssetCacheProbe, runTemplateRenderProbe, type AssetProbeResult } from "@/lib/assets/probe";
import { runSceneCropProbe } from "@/lib/assets/scene-probe";
import { SyntheticMotion } from "./SyntheticMotion";
import { SyntheticTogether } from "./SyntheticTogether";
import { DropdownFallbackRehearsal } from "./DropdownFallbackRehearsal";
import { RecoveryRehearsal } from "./RecoveryRehearsal";

interface Report {
  recordedAt: string;
  userAgent: string;
  viewport: string;
  secureContext: boolean;
  reportedLogicalProcessors: number;
  heap: HeapObservation;
  mediaInventory: ReturnType<typeof mediaResourceInventory>;
  results: (ProbeResult & { preview?: string })[];
}

export default function FeasibilityLab() {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const projectResult = (result: ProjectStorageProbeResult): ProbeResult => ({ id: result.name, status: result.passed ? "pass" : "fail", detail: result.detail });
  const assetResult = (result: AssetProbeResult): ProbeResult & { preview?: string } => ({ id: result.name, status: result.passed ? "pass" : "fail", detail: result.detail, preview: result.preview });
  async function roomProbe(members?: 2 | 4): Promise<ProbeResult[]> {
    if (process.env.NODE_ENV !== "development") throw new Error("Room probes are available only in development.");
    if (!globalThis.indexedDB || (members && typeof RTCPeerConnection === "undefined")) return [{ id: "room-native-support", status: "unsupported", detail: "This browser does not provide the native storage or peer connection APIs required for this check." }];
    if (members) {
      const result = await (await import("@/lib/rtc/probe")).runRoomMeshProbe(members);
      return result.passed.map((detail, index) => ({ id: `room-mesh-${result.members}-${index + 1}`, status: "pass", detail: `${detail}. Local synthetic run: ${result.elapsedMs} ms. This does not verify cross-network or TURN connectivity.` }));
    }
    const result = await (await import("@/lib/rtc/transfer-store")).runRoomTransferJournalProbe();
    return result.checks.map((detail, index) => ({ id: `room-transfer-journal-${index + 1}`, status: "pass", detail }));
  }
  async function run(action: () => Promise<ProbeResult | ProbeResult[]>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    const finishHeap = startHeapObservation();
    let results: ProbeResult[];
    try {
      const result = await action();
      results = Array.isArray(result) ? result : [result];
    } catch (error) {
      results = [{ id: "probe", status: "fail", detail: error instanceof Error ? error.message : String(error) }];
    }
    const heap = finishHeap();
    setReport({ recordedAt: new Date().toISOString(), userAgent: navigator.userAgent, viewport: `${innerWidth} x ${innerHeight}`, secureContext: isSecureContext, reportedLogicalProcessors: navigator.hardwareConcurrency, heap, mediaInventory: mediaResourceInventory(), results });
    setBusy(false);
    running.current = false;
  }
  const button = "rounded-lg border border-border bg-card px-4 py-3 text-sm font-medium disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10 sm:py-16">
      <Link href="/" className="text-sm text-accent underline underline-offset-4">Back to Photobooth</Link>
      <p className="mt-10 text-sm font-medium uppercase tracking-widest text-muted-foreground">V2 development lab</p>
      <h1 className="mt-3 font-display text-4xl sm:text-5xl">Prove the foundations.</h1>
      <p className="mt-5 max-w-2xl leading-relaxed text-muted-foreground">Synthetic fixtures check local recovery, real canvas output and short video encoding in this browser. This page is available only in development. It uses no camera, microphone, account or cloud uploads.</p>
      <section className="mt-10 border-y border-border py-7" aria-labelledby="probes-heading">
        <h2 id="probes-heading" className="text-lg font-semibold">Browser probes</h2>
        <p className="mt-2 text-sm text-muted-foreground">Keep this tab visible during the media probe. Run on each target device; a resized desktop window is not a mobile-device test.</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <button className={button} disabled={busy} onClick={() => void run(runStorageProbe)}>Run storage probe</button>
          <button className={button} disabled={busy} onClick={() => void run(runMediaProbe)}>Run media and print probe</button>
          <button className={button} disabled={busy} onClick={() => void run(async () => {
            const result = await (await import("@/lib/feasibility/weekly-recap-probe")).runWeeklyRecapProbe();
            return result.checks.map(check => ({ id: check.name, status: check.passed ? "pass" as const : "fail" as const, detail: check.detail }));
          })}>Run weekly recap checks</button>
          <button className={button} disabled={busy} onClick={() => void run(async () => (await import("@/lib/exports/motion")).runMotionProbe())}>Run motion export checks</button>
          <button className={button} disabled={busy} onClick={() => void run(async () => (await import("@/lib/feasibility/export-probe")).runExportCompositionProbe())}>Run export composition checks</button>
          <button className={button} disabled={busy} onClick={() => void run(async () => (await runProjectStorageProbe()).map(projectResult))}>Run project repository checks</button>
          <button className={button} disabled={busy} onClick={() => void run(async () => (await runProjectRenderProbe()).map(projectResult))}>Run project render checks</button>
          <button className={button} disabled={busy} onClick={() => void run(async () => (await runTemplateProbe()).map(assetResult))}>Run template shelf checks</button>
          <button className={button} disabled={busy} onClick={() => void run(async () => (await runAssetBrowserProbe()).map(assetResult))}>Run asset decoder checks</button>
          <button className={button} disabled={busy} onClick={() => void run(async () => (await runTemplateRenderProbe()).map(assetResult))}>Run template and material render checks</button>
          <button className={button} disabled={busy} onClick={() => void run(async () => (await runSceneCropProbe()).map(assetResult))}>Inspect generated scene crops</button>
          <button className={button} disabled={busy} onClick={() => void run(async () => (await runAssetCacheProbe()).map(assetResult))}>Run controlled offline pack check</button>
          {process.env.NODE_ENV === "development" && <>
            <button className={button} disabled={busy} onClick={() => void run(async () => {
              const result = await (await import("@/lib/memories/challenge-camera-probe")).runChallengeCameraOriginalsProbe();
              return result.checks.map((detail, index) => ({ id: `challenge-camera-originals-${index + 1}`, status: "pass" as const, detail }));
            })}>Run challenge camera originals checks</button>
            <button className={button} disabled={busy} onClick={() => void run(async () => {
              const result = await (await import("@/lib/memories/challenge-drafts-probe")).runChallengeDraftsProbe();
              return result.checks.map((detail, index) => ({ id: `challenge-request-recovery-${index + 1}`, status: "pass" as const, detail }));
            })}>Run challenge request recovery checks</button>
            <button className={button} disabled={busy} onClick={() => void run(async () => {
              const result = await (await import("@/lib/projects/cloud-design-save-probe")).runCloudDesignSaveProbe();
              return result.checks.map((detail, index) => ({ id: `cloud-design-recovery-${index + 1}`, status: "pass" as const, detail }));
            })}>Run cloud design recovery checks</button>
            <button className={button} disabled={busy} onClick={() => void run(() => roomProbe())}>Run room transfer journal checks</button>
            <button className={button} disabled={busy} onClick={() => void run(() => roomProbe(2))}>Run 2-peer local room mesh</button>
            <button className={button} disabled={busy} onClick={() => void run(() => roomProbe(4))}>Run 4-peer local room mesh</button>
            <button className={button} disabled={busy} onClick={() => void run(async () => {
              if (process.env.NODE_ENV !== "development") throw new Error("Development only");
              const result = await (await import("@/lib/rtc/workspace-probe")).runRoomWorkspaceProbe();
              return result.checks.map((detail, index) => ({ id: `room-workspace-${index + 1}`, status: "pass" as const, detail }));
            })}>Run room workspace checks</button>
            <button className={button} disabled={busy} onClick={() => void run(async () => (await import("@/lib/feasibility/shared-preview-probe")).runSharedPreviewProbe())}>Run shared Together preview checks</button>
            <button className={button} disabled={busy} onClick={() => void run(async () => {
              const result = await (await import("@/lib/rtc/cleanup-probe")).runRoomCleanupProbe();
              return result.checks.map((detail, index) => ({ id: `room-cleanup-${index + 1}`, status: "pass" as const, detail }));
            })}>Run room account cleanup checks</button>
          </>}
        </div>
      </section>
      <SyntheticMotion />
      {process.env.NODE_ENV === "development" && <SyntheticTogether />}
      <section className="border-b border-border py-7" aria-labelledby="reload-heading">
        <h2 id="reload-heading" className="text-lg font-semibold">Recovery across a page reload</h2>
        <p className="mt-2 text-sm text-muted-foreground">Save the synthetic checkpoint, reload, then verify. Clearing removes only this lab&apos;s checkpoint.</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <button className={button} disabled={busy} onClick={() => void run(saveReloadCheckpoint)}>1. Save checkpoint</button>
          <button className={button} disabled={busy} onClick={() => location.reload()}>2. Reload page</button>
          <button className={button} disabled={busy} onClick={() => void run(verifyReloadCheckpoint)}>3. Verify checkpoint</button>
          <button className={button} disabled={busy} onClick={() => void run(clearReloadCheckpoint)}>Clear checkpoint</button>
        </div>
      </section>
      <section className="border-b border-border py-7" aria-labelledby="project-reload-heading">
        <h2 id="project-reload-heading" className="text-lg font-semibold">P2 project recovery</h2>
        <p className="mt-2 text-sm text-muted-foreground">These checks use the production project repository with a separate synthetic database.</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <button className={button} disabled={busy} onClick={() => void run(async () => projectResult(await saveProjectReloadCheckpoint()))}>Save project checkpoint</button>
          <button className={button} disabled={busy} onClick={() => location.reload()}>Reload for project check</button>
          <button className={button} disabled={busy} onClick={() => void run(async () => projectResult(await verifyProjectReloadCheckpoint()))}>Verify project checkpoint</button>
          <button className={button} disabled={busy} onClick={() => void run(async () => projectResult(await clearProjectReloadCheckpoint()))}>Clear project checkpoint</button>
        </div>
      </section>
      <section className="mt-8" aria-labelledby="results-heading" aria-busy={busy}>
        <h2 id="results-heading" className="text-lg font-semibold">Results</h2>
        <p role="status" className="mt-2 text-sm text-muted-foreground">{busy ? "Probe running. Controls will return when it finishes." : report ? `${report.results.filter(r => r.status === "pass").length} passed, ${report.results.filter(r => r.status === "fail").length} failed, ${report.results.filter(r => r.status === "unsupported").length} unsupported.` : "Choose a probe to collect evidence."}</p>
        {report && <>
          <ul className="mt-5 divide-y divide-border">
            {report.results.map((r, index) => <li key={`${r.id}-${index}`} className="py-4">
              <p className="font-medium"><span className="mr-3 font-mono text-xs uppercase">{r.status}</span>{r.id}</p>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{r.detail}</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {r.preview && <img src={r.preview} alt={`${r.id} synthetic render`} className="mt-3 max-h-80 max-w-full" />}
            </li>)}
          </ul>
          <details className="mt-5 rounded-lg border border-border p-4" open>
            <summary className="cursor-pointer text-sm font-medium">Evidence JSON</summary>
            <pre className="mt-4 max-h-[36rem] overflow-auto whitespace-pre-wrap break-all text-xs leading-relaxed" data-testid="probe-report">{JSON.stringify({ ...report, results: report.results.map(({ preview: _preview, ...result }) => { void _preview; return result; }) }, null, 2)}</pre>
          </details>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Memory values are diagnostic only. The non-standard heap counter can be unavailable or inaccurate and excludes native/GPU allocations. The surface inventory is arithmetic, not measured total memory.</p>
        </>}
      </section>
      <DropdownFallbackRehearsal />
      <RecoveryRehearsal />
      <p className="mt-10 text-sm leading-relaxed text-muted-foreground">P0 evidence does not prove physical printing, real-camera quality, mobile performance, cross-network rooms, hosted permissions or disk-full recovery. Those checks remain explicit in the V2 development record.</p>
    </main>
  );
}
