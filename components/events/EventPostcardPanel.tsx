"use client";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { EventClientError } from "@/lib/events/client";
import { postcardError as eventGuestError } from "@/lib/events/postcard-ui";
import type { PostcardView } from "@/lib/events/postcard-contract";
import type { PostcardReviewedImage } from "@/lib/events/postcard-client";
import { postcardDisplayedConsent } from "@/lib/events/postcard-recovery";
import { postcardImageProof, type PostcardDraft, type PostcardJournal } from "@/lib/events/postcard-journal";
import { postcardReferenceUrl } from "@/lib/events/postcard-links";
import { prepareEventPostcardPhoto } from "@/lib/events/postcard-photo";
import { downloadProjectBlob } from "@/lib/projects/download";
import type { TemplateDesign } from "@/lib/templates/model";
import type { PostcardConnection } from "./EventPostcardComposer";
import { eventControl, eventInput, EventHostConfirm, useEventLeaveWarning } from "./EventHostControls";

interface Props {
  initial: { draft: PostcardDraft; view: PostcardView; persistent?: boolean }; connection: PostcardConnection; origin?: string;
  render?(signal: AbortSignal, design: TemplateDesign): Promise<Blob>;
  onDirtyChange?(dirty: boolean): void; onBusyChange(busy: boolean): void; onBack(): void; onInvalidated(): void;
}
export function EventPostcardPanel({ initial, connection, origin, render, onDirtyChange, onBusyChange, onBack, onInvalidated }: Props) {
  const { client, session, journal } = connection, id = initial.draft.proposal.postcardId;
  const [draft, setDraft] = useState(initial.draft), [view, setView] = useState(initial.view), [choices, setChoices] = useState(initial.draft.consentIntent?.consent ?? initial.view.selfConsent);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [lost, setLost] = useState(false), [confirm, setConfirm] = useState<"withdraw" | "discard" | null>(null);
  const [preview, setPreview] = useState<{ url: string; image: PostcardReviewedImage } | null>(null), [decoded, setDecoded] = useState(false), [hasPrepared, setHasPrepared] = useState(false), [reference, setReference] = useState<string | null>(null);
  const [persistent, setPersistent] = useState(initial.persistent !== false && journal !== null);
  const alive = useRef(false), running = useRef(false), active = useRef<AbortController | null>(null), heading = useRef<HTMLHeadingElement>(null), previewHeading = useRef<HTMLHeadingElement>(null), fileInput = useRef<HTMLInputElement>(null), localBlob = useRef<Blob | null>(null), objectUrl = useRef<string | null>(null), lastVerified = useRef(0), busyCallback = useRef(onBusyChange), invalidate = useRef(onInvalidated);
  useEffect(() => { busyCallback.current = onBusyChange; }, [onBusyChange]);
  useEffect(() => { invalidate.current = onInvalidated; }, [onInvalidated]);
  const clearPreview = () => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; setPreview(null); setDecoded(false); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); localBlob.current = null; busyCallback.current(false); }; }, []);
  const dirty = Boolean(draft.consentIntent) || hasPrepared || JSON.stringify(choices) !== JSON.stringify(view.selfConsent);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEventLeaveWarning(busy || dirty);
  const adopt = (next: PostcardView, pending = draft.consentIntent) => { client.assertActive(); if (next.submissionId !== draft.proposal.submissionId || JSON.stringify(next.source) !== JSON.stringify(draft.proposal.source) || JSON.stringify(next.design) !== JSON.stringify(draft.proposal.design)) throw new EventClientError("conflict"); setView(next); setChoices(postcardDisplayedConsent(next,pending)); };
  const update = async (current: PostcardDraft, patch: Parameters<PostcardJournal["update"]>[2]) => { if (!journal || !persistent) throw new EventClientError("journal_unavailable"); const next = await journal.update(id, current.revision, patch); if (alive.current) setDraft(next); return next; };
  const clearIntent = async (current: PostcardDraft) => { try { if (current.consentIntent) await update(current, { consentIntent: null }); } catch { setPersistent(false); setDraft({ ...current, consentIntent: null }); } };
  const run = async (work: (signal: AbortSignal) => Promise<void>, focusPreview = false) => {
    if (running.current || lost) return; running.current = true; const controller = new AbortController(); active.current = controller; setBusy(true); onBusyChange(true); setError(null); setNotice(null);
    try { await work(controller.signal); }
    catch (failure) { if (alive.current && !controller.signal.aborted) { setError(eventGuestError(failure)); const code = failure && typeof failure === "object" && "code" in failure ? failure.code : null; if (["identity_changed", "access_denied", "access_lost"].includes(String(code))) { clearPreview(); localBlob.current = null; setHasPrepared(false); setReference(null); setLost(true); invalidate.current(); } } }
    finally { running.current = false; if (alive.current) { setBusy(false); onBusyChange(false); requestAnimationFrame(() => (focusPreview ? previewHeading.current : heading.current)?.focus()); } }
  };
  useEffect(() => {
    if (!preview) return; let checking = false; const lifetime = new AbortController();
    const hide = () => { lifetime.abort(); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; setPreview(null); setDecoded(false); };
    const visibility = () => { if (document.hidden || !navigator.onLine) hide(); };
    const check = async () => {
      if (checking || lifetime.signal.aborted || running.current) return; checking = true;
      try { const next = await client.view(id, lifetime.signal); if (lifetime.signal.aborted) return; if (!["candidate", "ready"].includes(next.state) || JSON.stringify(next.candidate) !== JSON.stringify(preview.image.candidate)) hide(); else lastVerified.current = Date.now(); }
      catch (failure) { if (!lifetime.signal.aborted) { hide(); if (failure instanceof EventClientError && ["access_denied", "identity_changed"].includes(failure.code)) invalidate.current(); } } finally { checking = false; }
    };
    const poll = setInterval(() => void check(), 4000), deadline = setInterval(() => { if (Date.now() - lastVerified.current >= 10000) hide(); }, 200);
    document.addEventListener("visibilitychange", visibility); window.addEventListener("offline", visibility); visibility();
    return () => { lifetime.abort(); clearInterval(poll); clearInterval(deadline); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("offline", visibility); };
  }, [client, id, preview]);
  const refresh = () => run(async signal => { clearPreview(); adopt(await client.view(id, signal)); if (draft.consentIntent) setChoices(draft.consentIntent.consent); setNotice("Current postcard status loaded. Any pending permission request still keeps its original choices."); });
  const saveChoices = (withdraw = false) => run(async signal => {
    clearPreview(); let current = draft;
    if (withdraw || !current.consentIntent && !Object.entries(choices).some(([key, value]) => value && !view.selfConsent[key as keyof typeof choices])) {
      const next = await client.scopeConsent(id, view.revision, withdraw ? { submission: false, gallery: false, wall: false } : choices, signal);
      await clearIntent(current); adopt(next,null); setConfirm(null); setNotice(withdraw ? "Your contribution to this postcard has been withdrawn." : "Your reduced permissions were saved."); return;
    }
    if (!current.consentIntent) current = await update(current, { consentIntent: { expectedRevision: view.revision, consent: choices } });
    const intent = current.consentIntent!;
    const next = await client.scopeConsent(id, intent.expectedRevision, intent.consent, signal);
    await update(current, { consentIntent: null }); adopt(next,null); setConfirm(null); setNotice(next.state === "revoked" ? "Your contribution to this postcard has been withdrawn." : "Your permissions were saved. The host’s approval is separate.");
  });
  const discard = () => run(async signal => { clearPreview(); const next = await client.view(id, signal); await clearIntent(draft); adopt(next,null); setConfirm(null); setNotice("Current choices loaded. The earlier request may have succeeded; these are the choices saved now."); });
  const prepare = () => run(async signal => {
    if (!render) return; clearPreview(); const source = await render(signal, draft.proposal.design); client.assertActive(signal);
    const prepared = await prepareEventPostcardPhoto(source, { signal }); client.assertActive(signal);
    const proof = await postcardImageProof(prepared.blob); client.assertActive(signal);
    if (draft.image && JSON.stringify(draft.image) !== JSON.stringify(proof)) throw new EventClientError("image_mismatch");
    if (!draft.image) await update(draft, { image: proof });
    localBlob.current = prepared.blob; setHasPrepared(true); setNotice("The finished JPEG is ready on this device. Save a copy before sending if you want to recover it after closing this page.");
  });
  const choose = (file: File) => run(async signal => {
    const proof = await postcardImageProof(file); client.assertActive(signal); if (!draft.image || JSON.stringify(proof) !== JSON.stringify(draft.image)) throw new EventClientError("image_mismatch"); localBlob.current = file; setHasPrepared(true); setNotice("The saved JPEG matches this postcard. You can resume the same request.");
  });
  const submit = () => run(async signal => {
    clearPreview(); let current = draft;
    const reserved = await client.reserve(id, current.proposal.submissionId, current.reserveRequestId, signal); current = await update(current, { receipt: reserved.receipt });
    if (["reserved", "uploading"].includes(reserved.receipt.state)) {
      if (!current.image || !localBlob.current) throw new EventClientError("original_required");
      if (JSON.stringify(await postcardImageProof(localBlob.current)) !== JSON.stringify(current.image)) throw new EventClientError("image_mismatch"); client.assertActive(signal);
      const grant = await session.client.mintUpload(current.proposal.submissionId, signal); await session.client.upload(current.proposal.submissionId, localBlob.current, grant, signal);
    }
    if (!["failed", "expired", "deleted", "ready"].includes(reserved.receipt.state)) current = await update(current, { receipt: await session.client.finalise(current.proposal.submissionId, signal) });
    const next = await client.view(id, signal); adopt(next); setNotice(next.state === "candidate" ? "The verified image is ready for everyone to review." : next.state === "ready" ? "Everyone has approved the finished postcard." : "The image is being checked. Refresh its status before retrying; the original request is saved.");
  });
  const review = () => run(async signal => { clearPreview(); const image = await client.download(id, signal); client.assertActive(signal); if (document.hidden || !navigator.onLine) throw new EventClientError("cancelled"); const url = URL.createObjectURL(image.blob); objectUrl.current = url; lastVerified.current = Date.now(); setPreview({ url, image }); }, true);
  const checkUpload = () => run(async signal => { clearPreview(); const receipt = await session.client.finalise(draft.proposal.submissionId, signal); if (persistent) await update(draft, { receipt }); adopt(await client.view(id, signal)); setNotice("Upload verification requested. No photo bytes were sent again. Refresh to check the result."); });
  const approve = () => run(async signal => { if (!preview || !decoded || Date.now() - lastVerified.current >= 10000) throw new EventClientError("image_review_required"); adopt(await client.approveCandidate(preview.image, signal)); clearPreview(); setNotice("You approved this exact image. The postcard is delivered after every contributor has approved."); });
  const unanimous = view.participants.every(person => person.bound && person.consent), mine = view.participants.find(person => person.principalId === view.selfPrincipalId), ended = ["revoked", "expired"].includes(view.state), locked = busy || ended || Boolean(draft.consentIntent), totalApproved = view.participants.filter(person => person.approved).length;
  if (lost) return <div className="mt-5"><p role="alert" className="rounded-xl bg-muted p-4 text-sm leading-relaxed">This guest session can no longer access the postcard. Its photo and controls have been cleared. Close this panel and reconnect with the correct event session.</p><button className={`${eventControl} mt-3 border border-border`} onClick={onBack}>Return to postcards</button></div>;
  return <div className="mt-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h4 ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">{view.state === "ready" ? "Your postcard is delivered" : ended ? "This postcard has ended" : "Your postcard, together"}</h4><button className={`${eventControl} border border-border`} disabled={busy} onClick={() => { clearPreview(); onBack(); }}>Other postcards</button></div>
    <p className="mt-2 text-sm leading-relaxed text-foreground/70">{view.state === "draft" ? "1. Everyone joins and chooses their permissions." : view.state === "reserved" ? "2. The finished photo is being prepared for review." : view.state === "candidate" ? `3. Review the exact image. ${totalApproved} of ${view.participants.length} people have approved.` : view.state === "ready" ? "Each contributor approved the finished image. Public sharing still follows everyone’s permissions and the host’s decision." : "New uploads and approvals are unavailable."}</p>
    {view.logicalExpiresAt && !ended && view.state !== "ready" && <p className="mt-2 text-xs text-foreground/70">Upload and review deadline: {new Date(view.logicalExpiresAt).toLocaleString("en-AU")} ({Intl.DateTimeFormat().resolvedOptions().timeZone}).</p>}
    {error && <p role="alert" className="mt-4 rounded-xl bg-muted p-4 text-sm">{error}</p>}{notice && <p role="status" className="mt-4 rounded-xl bg-muted p-4 text-sm leading-relaxed">{notice}</p>}
    {!persistent && <p role="status" className="mt-4 rounded-xl bg-muted p-4 text-sm leading-relaxed">Local recovery is unavailable for this postcard. You can still review, approve or reduce your permissions and withdraw. New permission grants and uploads need working recovery storage.</p>}
    {busy && <div className="mt-4 flex flex-wrap items-center gap-3"><p role="status" className="text-sm">Waiting for confirmation…</p><button className={`${eventControl} border border-border`} onClick={() => { active.current?.abort(); clearPreview(); setNotice("Stopped waiting. The request may already have reached the server. Check its status before trying another action."); }}>Stop waiting</button></div>}
    <ul className="mt-5 grid gap-2 sm:grid-cols-2" aria-label="Postcard contributors">{view.participants.map(person => <li key={person.principalId} className="rounded-xl bg-muted px-4 py-3 text-sm"><strong>Role {person.role}{person.principalId === view.selfPrincipalId ? " · You" : ""}</strong><p className="mt-1 text-foreground/70">{!person.bound ? "Waiting to join" : !person.consent ? "Waiting for permission" : person.approved ? "Finished image approved" : "Permission given; image approval pending"}</p></li>)}</ul>
    <div className="mt-4 flex flex-wrap gap-2"><button className={`${eventControl} border border-border`} disabled={busy} onClick={() => void refresh()}>Refresh postcard</button><button className={`${eventControl} border border-border`} disabled={busy || ended} onClick={() => setReference(postcardReferenceUrl(origin ?? location.origin, client.eventId, id, view.source))}>Show contributor link</button></div>
    {reference && <div className="mt-4 max-w-2xl"><label className="text-sm font-medium">Share with this result’s contributors<input className={`${eventInput} mt-2`} readOnly value={reference} onFocus={event => event.target.select()} /></label><p className="mt-2 text-xs leading-relaxed text-foreground/70">Each person still needs access to the shared result and the host’s event invitation.</p></div>}
    {!ended && <fieldset className="mt-6 border-t border-border pt-5" disabled={locked}><legend className="font-semibold">Your permissions</legend><p className="mb-3 mt-2 text-sm text-foreground/70">Your choices apply to this postcard only. Neither public destination is selected by default.</p>{([['submission', 'Allow this finished result to be submitted to the event'], ['gallery', 'Allow the host to approve it for the event gallery'], ['wall', 'Allow the host to approve it for the event wall']] as const).map(([key, label]) => <label key={key} className="flex min-h-11 items-start gap-3 py-2 text-sm leading-relaxed"><input type="checkbox" className="mt-1 size-4 shrink-0 accent-[var(--accent)]" checked={choices[key]} onChange={event => setChoices(previous => key === "submission" && !event.target.checked ? { submission: false, gallery: false, wall: false } : { ...previous, [key]: event.target.checked })} disabled={locked || !persistent && !view.selfConsent[key] || key !== "submission" && !choices.submission} />{label}</label>)}</fieldset>}
    {!ended && <div className="mt-3 flex flex-wrap gap-2"><button className={`${eventControl} bg-accent text-accent-foreground`} disabled={busy || !draft.consentIntent && !choices.submission} onClick={() => void saveChoices()}>{draft.consentIntent ? "Retry saved permissions" : "Save my permissions"}</button>{draft.consentIntent && <button className={`${eventControl} border border-border`} disabled={busy} onClick={() => setConfirm("discard")}>Check current choices</button>}</div>}
    {confirm && <EventHostConfirm title={confirm === "withdraw" ? "Withdraw this postcard?" : "Set aside the pending permission request?"} action={confirm === "withdraw" ? "Withdraw my contribution" : "Load current choices"} busy={busy} onKeep={() => setConfirm(null)} onConfirm={() => void (confirm === "withdraw" ? saveChoices(true) : discard())}><p>{confirm === "withdraw" ? "This removes access to this event postcard for everyone. Their original room or challenge is separate. Already downloaded copies cannot be recalled." : "The earlier request may already have succeeded. Load the current saved choices before making another change."}</p></EventHostConfirm>}
    {!ended && view.canSubmit && persistent && ["draft", "reserved"].includes(view.state) && <section className="mt-6 border-t border-border pt-5"><h5 className="font-semibold">Prepare one finished photo</h5><p className="mt-2 max-w-2xl text-sm leading-relaxed text-foreground/70">Once everyone agrees, one person sends the photo. Everyone then reviews the finished JPEG.</p><div className="mt-4 flex flex-wrap gap-2">{render && <button className={`${eventControl} border border-border`} disabled={locked || !unanimous} onClick={() => void prepare()}>{draft.image ? "Recover from this shared result" : "Prepare finished photo"}</button>}{draft.image && <button className={`${eventControl} border border-border`} disabled={locked} onClick={() => fileInput.current?.click()}>Choose saved prepared JPEG</button>}{hasPrepared && <button className={`${eventControl} border border-border`} disabled={busy} onClick={() => { if (localBlob.current) { downloadProjectBlob(localBlob.current, `event-postcard-${id}.jpg`); setNotice("JPEG prepared for download. Check your browser’s downloads."); } }}>Save prepared JPEG</button>}<input ref={fileInput} type="file" accept="image/jpeg" tabIndex={-1} hidden aria-label="Choose saved postcard JPEG" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void choose(file); }} /><button className={`${eventControl} bg-accent text-accent-foreground`} disabled={locked || !unanimous || !hasPrepared && !draft.receipt} onClick={() => void submit()}>{draft.receipt ? "Resume this submission" : "Send image for group review"}</button></div>{draft.receipt && <button className={`${eventControl} mt-3 border border-border`} disabled={busy} onClick={() => void checkUpload()}>Check uploaded photo without resending</button>}{!render && !draft.receipt && <p className="mt-3 text-sm text-foreground/70">The contributor with the finished room or challenge open can prepare and send it from there.</p>}</section>}
    {["candidate", "ready"].includes(view.state) && <section className="mt-6 border-t border-border pt-5"><h5 className="font-semibold">The exact finished image</h5><button className={`${eventControl} mt-3 border border-border`} disabled={busy} onClick={() => void review()}>Review finished postcard</button>{preview && <figure className="mt-4"><h6 ref={previewHeading} tabIndex={-1} className="font-semibold outline-none">Review before approving</h6><Image unoptimized src={preview.url} width={preview.image.candidate.width} height={preview.image.candidate.height} alt="The exact finished postcard everyone is being asked to approve" className="mx-auto mt-4 max-h-[32rem] w-auto max-w-full object-contain" onLoad={() => setDecoded(true)} onError={() => { clearPreview(); setError("The image could not be displayed. Try loading it again before approving."); }} /><figcaption className="mt-3 text-sm leading-relaxed text-foreground/70">Check the people, crops and full layout. Your approval applies only to this image. The preview clears when permission checks stop or this page is hidden.</figcaption><div className="mt-4 flex flex-wrap gap-2">{!mine?.approved && <button className={`${eventControl} bg-accent text-accent-foreground`} disabled={busy || !decoded} onClick={() => void approve()}>Approve this exact image</button>}<button className={`${eventControl} border border-border`} disabled={busy} onClick={() => { clearPreview(); heading.current?.focus(); }}>Close image</button></div></figure>}</section>}
    {!ended && <button className={`${eventControl} mt-6 underline underline-offset-4`} disabled={busy} onClick={() => setConfirm("withdraw")}>Withdraw my postcard contribution…</button>}
    <p className="mt-5 text-xs leading-relaxed text-foreground/70">Up to eight recovery requests are kept on this browser for up to 24 hours or the event’s expiry, whichever comes first. Photo bytes are kept in memory only. Keep this guest session to manage your permission later.</p>
  </div>;
}
