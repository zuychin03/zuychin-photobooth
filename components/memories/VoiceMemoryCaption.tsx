"use client";

import { HelpTooltip } from "@/components/HelpTooltip";

import { useEffect, useId, useRef, useState } from "react";
import { cloudControl, cloudInput } from "@/components/cloud/CloudControls";
import type { VoiceClient } from "@/lib/memories/voice-client";
import type { VoiceCaptionSnapshot } from "@/lib/memories/voice-contract";
import { voiceDraftRequest, type VoiceDraft, type VoiceDraftJournal } from "@/lib/memories/voice-drafts";
import { createPcmVoiceRecorder, type PcmVoiceState } from "@/lib/memories/voice-pcm-recorder";
import { PCM_VOICE } from "@/lib/memories/voice-wav";

function message(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? error.code : "";
  if (code === "conflict") return "This caption changed elsewhere. Download your draft, then discard it and refresh before editing.";
  if (code === "account_changed" || code === "access_denied" || code === "access_changed") return "Your access changed. Reopen your own memories before continuing.";
  if (code === "source_unavailable") return "This memory is no longer available. Your saved draft has not been sent.";
  if (code === "quota_exceeded" || code === "capacity") return "Caption storage is full. Delete an older caption and retry after cleanup finishes.";
  if (code === "journal_readonly") return "This draft needs a newer app. It has not been overwritten.";
  return "The caption could not be saved or loaded. Your recovery draft is kept on this device when available. Retry after checking your connection.";
}
function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function VoiceMemoryCaption({ activityId, client, journal, onDirtyChange, onBusyChange, acquire, synthetic = false, locked = false }: { activityId: string; client: VoiceClient; journal: VoiceDraftJournal; onDirtyChange?(dirty: boolean): void; onBusyChange?(busy: boolean): void; acquire?(): Promise<MediaStream>; synthetic?: boolean; locked?: boolean }) {
  const id = useId(), alive = useRef(true), task = useRef<AbortController | null>(null), recorder = useRef<ReturnType<typeof createPcmVoiceRecorder> | null>(null);
  const [snapshot, setSnapshot] = useState<VoiceCaptionSnapshot | null>(null), [draft, setDraft] = useState<VoiceDraft | null>(null);
  const [text, setText] = useState(""), [blob, setBlob] = useState<Blob | null>(null), [audioChange, setAudioChange] = useState<"keep" | "remove" | "replace">("keep");
  const [busy, setBusy] = useState(true), [error, setError] = useState(""), [note, setNote] = useState(""), [recording, setRecording] = useState<PcmVoiceState>("idle"), [seconds, setSeconds] = useState(0), [preview, setPreview] = useState("");
  const [lost, setLost] = useState(false), [confirmation, setConfirmation] = useState<{ kind: "delete" | "discard" | "refresh"; revision: number } | null>(null);
  const keepButton = useRef<HTMLButtonElement>(null), invokedBy = useRef<HTMLButtonElement | null>(null), heading = useRef<HTMLHeadingElement>(null);
  const previewRef = useRef("");
  const suspended = useRef(false), player = useRef<HTMLAudioElement>(null);
  const clearPreview = () => { if (previewRef.current) URL.revokeObjectURL(previewRef.current); previewRef.current = ""; setPreview(""); };
  const showPreview = (audio: Blob) => { clearPreview(); previewRef.current = URL.createObjectURL(audio); setPreview(previewRef.current); };
  const active = (signal?: AbortSignal) => { client.assertActive(signal); journal.assertActive(); if (!alive.current || suspended.current) throw new Error("cancelled"); };
  const dirty = Boolean(snapshot && !lost && (text !== (draft?.text ?? snapshot.text) || audioChange !== (draft?.audio ?? "keep") || blob !== (draft?.blob ?? null)));
  useEffect(() => { onDirtyChange?.(dirty || recording !== "idle"); }, [dirty, recording, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy || recording !== "idle" || confirmation !== null); }, [busy, recording, confirmation, onBusyChange]);
  useEffect(() => { if (confirmation) { player.current?.pause(); keepButton.current?.focus(); } }, [confirmation]);
  useEffect(() => { if (locked) player.current?.pause(); }, [locked]);
  function restoreFocus() { requestAnimationFrame(() => { if (!alive.current) return; const target = invokedBy.current; if (target?.isConnected && !target.disabled) target.focus(); else heading.current?.focus(); }); }
  function ask(kind: "delete" | "discard" | "refresh", trigger: HTMLButtonElement) { invokedBy.current = trigger; setConfirmation({ kind, revision: snapshot?.revision ?? 0 }); }
  function cancelConfirmation() { setConfirmation(null); restoreFocus(); }
  const loseAccess = () => { recorder.current?.cancel(); clearPreview(); setText(""); setBlob(null); setDraft(null); setSnapshot(null); setLost(true); setBusy(false); setNote(""); setError("Your access changed. Reopen your own memories before continuing."); };
  const failed = (failure: unknown) => {
    const code = failure && typeof failure === "object" && "code" in failure ? failure.code : "";
    if (["account_changed", "access_denied", "access_changed", "source_unavailable"].includes(String(code))) loseAccess();
    setError(message(failure));
  };
  async function load(signal: AbortSignal) {
    const [saved, recovered] = await Promise.all([client.read(activityId, signal), journal.get(activityId)]); active(signal);
    clearPreview(); setSnapshot(saved); setDraft(recovered); setText(recovered?.text ?? saved.text); setBlob(recovered?.blob ?? null); setAudioChange(recovered?.audio ?? "keep");
    if (recovered?.blob) showPreview(recovered.blob);
    setNote(recovered ? "Recovered a private draft from this device. Review it before retrying." : "");
  }
  useEffect(() => {
    alive.current = true; suspended.current = false; const controller = new AbortController(); task.current = controller;
    const leave = () => { suspended.current = true; recorder.current?.cancel(); player.current?.pause(); task.current?.abort(); setBusy(false); };
    const resume = () => { if (!suspended.current) return; suspended.current = false; if (alive.current) { setBusy(false); setNote("Returned to the caption. Refresh to recover any interrupted save before continuing."); } };
    const hidden = () => { if (document.visibilityState === "hidden") { recorder.current?.cancel(); player.current?.pause(); } };
    const invalidated = () => { if (alive.current) { leave(); loseAccess(); } };
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", resume);
    document.addEventListener("visibilitychange", hidden);
    client.signal.addEventListener("abort", invalidated, { once: true });
    void Promise.resolve().then(() => { active(controller.signal); return load(controller.signal); }).catch(failure => { if (alive.current && !controller.signal.aborted) failed(failure); }).finally(() => { if (alive.current && !controller.signal.aborted) setBusy(false); });
    return () => { alive.current = false; client.signal.removeEventListener("abort", invalidated); window.removeEventListener("pagehide", leave); window.removeEventListener("pageshow", resume); document.removeEventListener("visibilitychange", hidden); controller.abort(); task.current?.abort(); recorder.current?.cancel(); if (previewRef.current) URL.revokeObjectURL(previewRef.current); previewRef.current = ""; };
    // The caller keys this workspace by account and activity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityId, client, journal]);
  useEffect(() => {
    if (recording !== "recording") return;
    const started = performance.now(), timer = setInterval(() => setSeconds(Math.min(30, Math.floor((performance.now() - started) / 1000))), 250);
    return () => clearInterval(timer);
  }, [recording]);
  async function run(operation: (signal: AbortSignal) => Promise<void>) {
    if (busy || lost || locked) return;
    const controller = new AbortController(); task.current = controller; setBusy(true); setError(""); setNote("");
    try { active(controller.signal); await operation(controller.signal); }
    catch (failure) { if (alive.current && !controller.signal.aborted) failed(failure); }
    finally { if (alive.current && !controller.signal.aborted) setBusy(false); }
  }
  async function keepDraft(nextBlob = blob, nextAudio = audioChange, signal?: AbortSignal) {
    if (!snapshot) throw new Error("missing");
    const next = await journal.save({ id: activityId, remoteRevision: draft?.remoteRevision ?? snapshot.revision, text, audio: nextAudio, blob: nextBlob }, draft?.revision ?? null);
    active(signal); setDraft(next); return next;
  }
  const pending = draft?.state === "pending", unavailable = busy || lost || recording !== "idle" || !snapshot || locked, disabled = unavailable || confirmation !== null;
  async function send(frozen: VoiceDraft, signal: AbortSignal) {
    const saved = frozen.kind === "delete" ? await client.delete(activityId, { requestId: frozen.requestId, revision: frozen.remoteRevision }, signal) : await client.save(activityId, await voiceDraftRequest(frozen), signal);
    active(signal); await journal.forget(activityId, frozen.revision); active(signal);
    setSnapshot(saved); setDraft(null); setText(saved.text); setBlob(null); setAudioChange("keep"); clearPreview();
    setNote(frozen.kind === "delete" ? "Caption deleted. Stored audio cleanup may still be finishing." : "Private caption saved with this memory.");
  }
  const button = `${cloudControl} border border-border hover:bg-muted`;
  return <section inert={locked} className="space-y-4 border-t border-border pt-6" aria-labelledby={`${id}-title`}>
    <h3 ref={heading} tabIndex={-1} id={`${id}-title`} className="font-display text-xl outline-none">Your private voice caption</h3>
    <p className="text-sm text-foreground/75">Only you can access this note. Record up to 30 seconds or write a caption.</p>
    <p role="status" className="text-sm">{recording === "recording" ? `Recording: ${seconds} / 30 seconds` : recording === "requesting" ? synthetic ? "Preparing synthetic audio…" : "Waiting for microphone permission…" : recording === "finishing" ? "Finishing recording…" : busy ? "Checking caption…" : note}</p>
    {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <button className={button} disabled={disabled || pending} onClick={() => {
        try { active(); } catch (failure) { setError(message(failure)); return; }
        recorder.current?.cancel();
        setError(""); setSeconds(0);
        recorder.current = createPcmVoiceRecorder({ state: value => { if (alive.current) setRecording(value); }, error: failure => { if (alive.current) setError(failure.message); }, ready: value => {
          try { active(); } catch { return; }
          setBlob(value); setAudioChange("replace"); showPreview(value);
          void run(async signal => { await keepDraft(value, "replace", signal); setNote("Audio is saved privately on this device. Save caption to upload it."); });
        } }, acquire);
        void recorder.current.start();
      }}>{synthetic ? "Record synthetic PCM tone" : "Allow microphone and record"}</button>
      {recording === "recording" && <button className={button} onClick={() => recorder.current?.stop()}>Stop recording</button>}
      {recording !== "idle" && <button className={button} onClick={() => recorder.current?.cancel()}>Cancel recording</button>}
      {snapshot?.audio && audioChange === "keep" && <button className={button} disabled={disabled} onClick={() => void run(async signal => { const audio = await client.download(activityId, signal); active(signal); showPreview(audio); })}>Load audio for playback</button>}
    </div>
    {preview && <audio ref={player} controls={!confirmation && !locked} preload="metadata" src={preview} aria-label="Private voice caption playback" />}
    {(blob || snapshot?.audio && audioChange === "keep") && <div className="flex flex-wrap gap-2">
      <button className={button} disabled={disabled} onClick={() => void run(async signal => { const audio = blob ?? await client.download(activityId, signal); active(signal); download(audio, "voice-caption.wav"); })}>Download audio</button>
      <button className={button} disabled={disabled || pending} onClick={() => { clearPreview(); setBlob(null); setAudioChange("remove"); setNote("Audio will be removed when you save the caption."); }}>Remove audio</button>
    </div>}
    <label htmlFor={`${id}-text`} className="block text-sm font-medium">Text alternative</label>
    <textarea id={`${id}-text`} rows={4} className={cloudInput} maxLength={PCM_VOICE.text} value={text} disabled={disabled || pending} onChange={event => setText(event.target.value)} />
    <p className="text-xs text-foreground/70">Keep a draft or save before leaving to retain your text. <HelpTooltip label="About audio downloads">Recordings download as WAV files, up to 2.9 MB.</HelpTooltip></p>
    <div className="flex flex-wrap gap-2">
      <button className={button} disabled={disabled} onClick={() => void run(async signal => {
        const savedDraft = pending ? draft! : await keepDraft(blob, audioChange, signal); active(signal);
        const frozen = await journal.freeze(activityId, savedDraft.revision); active(signal); setDraft(frozen);
        await send(frozen, signal);
      })}>{pending ? "Retry saved request" : "Save caption"}</button>
      <button className={button} disabled={disabled || pending} onClick={() => void run(async signal => { await keepDraft(blob, audioChange, signal); setNote("Private draft kept on this device."); })}>Keep draft on this device</button>
      <button className={button} disabled={disabled || !text} onClick={() => download(new Blob([text], { type: "text/plain;charset=utf-8" }), "voice-caption.txt")}>Download text</button>
      {draft && <button className={button} disabled={disabled} onClick={event => ask("discard", event.currentTarget)}>Discard local draft and refresh</button>}
      <button className={button} disabled={disabled || Boolean(draft)} onClick={event => ask("delete", event.currentTarget)}>Delete saved caption</button>
      <button className={button} disabled={busy || lost || recording !== "idle" || locked || confirmation !== null} onClick={event => { if (dirty) ask("refresh", event.currentTarget); else void run(load); }}>Refresh caption</button>
    </div>
    {confirmation && <div role="group" aria-label="Confirm caption change" aria-describedby={`${id}-confirmation`} onKeyDown={event => { if (event.key === "Escape" && !unavailable) { event.preventDefault(); cancelConfirmation(); } }} className="space-y-3 rounded-xl border border-border p-4">
      <p id={`${id}-confirmation`} className="text-sm">{confirmation.kind === "delete" ? "Delete this saved voice caption and text? This cannot be undone." : confirmation.kind === "discard" ? "Discard the local recovery draft? A pending request may already have saved on the server. This does not undo it. The saved caption will be refreshed." : "Refresh and discard unsaved changes in this tab? Any saved recovery draft will remain."}</p>
      <div className="flex flex-wrap gap-2"><button className={button} disabled={unavailable} onClick={() => {
        const action = confirmation; setConfirmation(null);
        void run(async signal => {
          if (action.kind === "delete") { const frozen = await journal.prepareDelete(activityId, action.revision); active(signal); setDraft(frozen); await send(frozen, signal); }
          else { if (action.kind === "discard" && draft) await journal.forget(activityId, draft.revision); await load(signal); }
        }).finally(restoreFocus);
      }}>Confirm {confirmation.kind === "delete" ? "deletion" : confirmation.kind}</button><button ref={keepButton} className={button} disabled={unavailable} onClick={cancelConfirmation}>Keep editing</button></div>
    </div>}
  </section>;
}
