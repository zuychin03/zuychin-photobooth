"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";
import { useEffect, useRef, useState } from "react";
import { postcardError as eventGuestError } from "@/lib/events/postcard-ui";
import { createPostcardGuestRuntime, type PostcardGuestRuntime, type PostcardGuestSession } from "@/lib/events/postcard-guest-runtime";
import { createEventPostcardClient, createPostcardSourceClient, type EventPostcardClient, type PostcardSourceClient } from "@/lib/events/postcard-client";
import { listPostcardRecovery, recoverBoundPostcard } from "@/lib/events/postcard-recovery";
import { openPostcardJournal, type PostcardDraft, type PostcardJournal } from "@/lib/events/postcard-journal";
import { parsePostcardInvitation, parsePostcardReference, postcardNonce } from "@/lib/events/postcard-links";
import type { PostcardSource, PostcardView } from "@/lib/events/postcard-contract";
import type { TemplateDesign } from "@/lib/templates/model";
import { EventClientError } from "@/lib/events/client";
import { eventControl, eventInput, EventHostConfirm } from "./EventHostControls";
import { EventPostcardPanel } from "./EventPostcardPanel";

export interface EventPostcardComposerProps {
  source: PostcardSource; design?: TemplateDesign;
  assertSourceActive(signal?: AbortSignal): void;
  render?(signal: AbortSignal, frozenDesign: TemplateDesign): Promise<Blob>;
  sourceAccessToken?(): Promise<string | null>;
  disabled?: boolean; onBusyChange?(busy: boolean): void;
  initialEventId?: string; initialPostcardId?: string;
  options?: { appOrigin: string; storageOrigin: string; fetch?: typeof fetch; databaseName?: string; decode?: Parameters<typeof createEventPostcardClient>[0]["decode"] };
}
export interface PostcardConnection { session: PostcardGuestSession; client: EventPostcardClient; source: PostcardSourceClient; journal: PostcardJournal | null }
type Connection = PostcardConnection;
export function EventPostcardComposer(props: EventPostcardComposerProps) { return <Composer key={JSON.stringify([props.source, props.initialEventId, props.initialPostcardId])} {...props} />; }
function Composer(props: EventPostcardComposerProps) {
  const [invitation, setInvitation] = useState(""), [reference, setReference] = useState(""), [connection, setConnection] = useState<Connection | null>(null);
  const [drafts, setDrafts] = useState<PostcardDraft[]>([]), [selected, setSelected] = useState<{ draft: PostcardDraft; view: PostcardView; persistent?: boolean } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [panelDirty, setPanelDirty] = useState(false), [leave, setLeave] = useState<"close" | "back" | null>(null);
  const [leaveFocus, setLeaveFocus] = useState<HTMLElement | null>(null), [forgetFocus, setForgetFocus] = useState<HTMLElement | null>(null);
  const [forget, setForget] = useState<PostcardDraft | null>(null), [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const live = useRef(false), running = useRef(false), abort = useRef<AbortController | null>(null), runtime = useRef<PostcardGuestRuntime | null>(null), owned = useRef<Connection | null>(null), heading = useRef<HTMLHeadingElement>(null), latest = useRef(props);
  useEffect(() => { latest.current = props; });
  useEffect(() => { latest.current.onBusyChange?.(busy || Boolean(leave) || Boolean(forget)); }, [busy, leave, forget]);
  useEffect(() => { live.current = true; return () => { live.current = false; abort.current?.abort(); owned.current?.source.close(); owned.current?.client.close(); owned.current?.journal?.close(); runtime.current?.close(); latest.current.onBusyChange?.(false); }; }, []);
  const run = async (work: (signal: AbortSignal) => Promise<void>) => {
    if (running.current) return; running.current = true; const active = new AbortController(); abort.current = active; setBusy(true); props.onBusyChange?.(true); setError(null);
    try { await work(active.signal); }
    catch (failure) { if (live.current && !active.signal.aborted) { const code = failure && typeof failure === "object" && "code" in failure ? failure.code : null; if (["access_denied", "identity_changed", "access_lost"].includes(String(code))) close(); setError(failure instanceof Error && !(failure instanceof EventClientError) ? failure.message : eventGuestError(failure)); } }
    finally { running.current = false; if (live.current) { setBusy(false); props.onBusyChange?.(false); requestAnimationFrame(() => heading.current?.focus()); } }
  };
  const reload = async (handle: Connection, signal?: AbortSignal) => {
    const result = await listPostcardRecovery(handle.journal, () => handle.client.assertActive(signal));
    if (live.current && !signal?.aborted) { setDrafts(result.drafts); setRecoveryAvailable(result.available); if (!result.available) setError("Device recovery storage cannot be read. Existing postcard links still allow review or withdrawal; saved records were not deleted."); }
  };
  const attach = async (handle: Connection, draft: PostcardDraft, signal: AbortSignal) => {
    const ticket = await handle.client.ticket(draft.proposal.postcardId, draft.ticketRequestId, signal);
    const view = await handle.source.attach(draft.eventId, ticket.ticket, draft.proposal, signal); handle.client.assertActive(signal);
    if (live.current) setSelected({ draft, view });
  };
  const recover = async (handle: Connection, draft: PostcardDraft, signal: AbortSignal) => {
    try { const view = await handle.client.view(draft.proposal.postcardId, signal); if (JSON.stringify(view.source) !== JSON.stringify(props.source)) throw new EventClientError("conflict"); const recovered = await recoverBoundPostcard(view, handle.client.guestId, handle.journal, () => handle.client.assertActive(signal)); if (live.current) setSelected({ ...recovered, view }); }
    catch (failure) { if (!(failure instanceof EventClientError) || failure.code !== "access_denied") throw failure; await attach(handle, draft, signal); }
  };
  const discover = async (handle: Connection, postcardId: string, signal: AbortSignal) => {
    let view: PostcardView | null = null;
    try { view = await handle.client.view(postcardId, signal); } catch (failure) { if (!(failure instanceof EventClientError) || failure.code !== "access_denied") throw failure; }
    if (view) {
      if (JSON.stringify(view.source) !== JSON.stringify(props.source)) throw new Error("This postcard belongs to another shared result.");
      const { draft, persistent } = await recoverBoundPostcard(view, handle.client.guestId, handle.journal, () => handle.client.assertActive(signal));
      if (live.current) setSelected({ draft, view, persistent });
    } else {
      const found = await handle.source.proposal(postcardId, signal); if (found.eventId !== handle.client.eventId) throw new Error("This postcard belongs to another event.");
      if (!handle.journal) throw new EventClientError("journal_unavailable"); const draft = await handle.journal.create(found.proposal, handle.session.context.expiresAt); await attach(handle, draft, signal);
    }
    await reload(handle,signal);
  };
  const connect = () => run(async signal => {
    const origin = props.options?.appOrigin ?? location.origin, parsed = invitation.trim() ? parsePostcardInvitation(invitation.trim(), origin) : null, eventId = parsed?.eventId ?? props.initialEventId;
    if (!eventId || props.initialEventId && eventId !== props.initialEventId) throw new Error("Use the host’s invitation for this event.");
    runtime.current?.close(); const handle = createPostcardGuestRuntime({ ...props.options, appOrigin: origin, eventId, storageOrigin: props.options?.storageOrigin ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "" }); runtime.current = handle;
    const inspection = await handle.inspect(signal); if (!inspection.existing && !parsed) throw new Error("Paste the host’s event invitation to join on this browser.");
    const session = inspection.existing ? await handle.resume(inspection.existing, signal) : await handle.join(parsed!.token, postcardNonce(), signal);
    const client = createEventPostcardClient({ ...props.options, appOrigin: origin, storageOrigin: props.options?.storageOrigin ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", guest: session.client });
    const source = createPostcardSourceClient({ ...props.options, appOrigin: origin, source: props.source, assertAuthority: signal => latest.current.assertSourceActive(signal), accessToken: () => latest.current.sourceAccessToken?.() ?? Promise.resolve(null) });
    let journal: PostcardJournal | null = null;
    try { await client.capabilities(signal); try { journal = await openPostcardJournal(session.client, { databaseName: props.options?.databaseName }); } catch { client.assertActive(signal); } client.assertActive(signal); }
    catch (failure) { source.close(); client.close(); (journal as PostcardJournal | null)?.close(); handle.close(); throw failure; }
    const opened = { session, client, source, journal }; owned.current = opened;
    if (!live.current || signal.aborted) { source.close(); client.close(); journal?.close(); handle.close(); return; }
    setInvitation(""); setConnection(opened); if (!journal) setError("Device recovery storage is unavailable. An existing postcard link can still be opened to review or withdraw your contribution."); await reload(opened,signal);
    if (props.initialPostcardId) await discover(opened, props.initialPostcardId, signal);
  });
  const newPostcard = () => run(async signal => {
    if (!connection?.journal || !recoveryAvailable || !props.design) return; props.assertSourceActive(signal);
    const draft = await connection.journal.create({ postcardId: crypto.randomUUID(), submissionId: crypto.randomUUID(), source: props.source, design: props.design }, connection.session.context.expiresAt);
    await reload(connection); await attach(connection, draft, signal);
  });
  const followReference = () => run(async signal => {
    if (!connection) return; const parsed = parsePostcardReference(reference.trim(), props.options?.appOrigin ?? location.origin);
    if (parsed.eventId !== connection.client.eventId || JSON.stringify(parsed.source) !== JSON.stringify(props.source)) throw new Error("Open a postcard link for this event and shared result.");
    await discover(connection, parsed.postcardId, signal); setReference("");
  });
  const close = () => { abort.current?.abort(); owned.current?.client.close(); owned.current?.source.close(); owned.current?.journal?.close(); runtime.current?.close(); owned.current = null; runtime.current = null; setConnection(null); setSelected(null); setDrafts([]); setInvitation(""); setReference(""); setForget(null); setLeave(null); setPanelDirty(false); setRecoveryAvailable(false); requestAnimationFrame(() => heading.current?.focus()); };
  const back = () => { setSelected(null); setPanelDirty(false); if (connection) void reload(connection).catch(failure => { if (owned.current === connection) { close(); setError(eventGuestError(failure)); } }); requestAnimationFrame(() => heading.current?.focus()); };
  const navigate = (target: "close" | "back") => {
    if (panelDirty) { setLeaveFocus(document.activeElement instanceof HTMLElement ? document.activeElement : null); setLeave(target); }
    else if (target === "close") close(); else back();
  };
  useAppNavigationGuard(() => { if (busy) { setError("Wait for this postcard request to finish before leaving."); return false; } if (panelDirty) { navigate("close"); return false; } return true; });
  return <section className="border-t border-border py-7" aria-label="Remote event postcard">
    <h3 ref={heading} tabIndex={-1} className="font-display text-2xl outline-none">Send a remote postcard</h3>
    <p className="mt-3 max-w-2xl text-sm leading-relaxed text-foreground/70">Send this shared photo to an event. Everyone must join and approve it. Gallery and wall sharing also need everyone’s consent and host approval.</p>
    {error && <p role="alert" className="mt-4 rounded-xl bg-muted p-4 text-sm leading-relaxed">{error}</p>}
    {busy && <p role="status" className="mt-4 text-sm">Checking this postcard…</p>}
    {!connection ? <div className="mt-5 max-w-2xl space-y-3"><label className="block text-sm font-medium">Host’s event invitation<input className={`${eventInput} mt-2`} type="text" inputMode="url" autoComplete="off" spellCheck={false} maxLength={1000} value={invitation} disabled={busy || props.disabled} onChange={event => setInvitation(event.target.value)} placeholder="Paste the event invitation link" /></label><p className="text-xs leading-relaxed text-foreground/70">Connect with your existing guest access or this invitation. No photo is sent.</p><button className={`${eventControl} bg-accent text-accent-foreground`} disabled={busy || props.disabled || !invitation.trim() && !props.initialEventId} onClick={() => void connect()}>Connect to event</button></div> : <>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3"><p className="text-sm">Event: <strong>{connection.session.context.title}</strong></p><button className={`${eventControl} border border-border`} disabled={busy || Boolean(forget) || Boolean(leave)} onClick={() => navigate("close")}>Close event postcard</button></div>
      {leave && <EventHostConfirm title="Leave this postcard?" action={leave === "close" ? "Close postcard" : "Return to postcards"} busy={busy} returnFocus={leaveFocus} onKeep={() => setLeave(null)} onConfirm={() => { const target = leave; setLeave(null); if (target === "close") close(); else back(); }}><p>Unsaved permission choices and the prepared photo in memory will be cleared. Saved pending requests stay on this browser for exact retry and may already have reached the server. Leaving does not withdraw your contribution. Keep a local JPEG copy if you need to recover an upload.</p></EventHostConfirm>}
      {selected ? <div inert={Boolean(leave)}><EventPostcardPanel key={selected.draft.proposal.postcardId} initial={selected} connection={connection} origin={props.options?.appOrigin} render={props.render} onDirtyChange={setPanelDirty} onInvalidated={() => { close(); setError("Your access changed. The previous postcard and recovery list were cleared from this page. Connect again to inspect the current guest session."); }} onBusyChange={value => { setBusy(value); props.onBusyChange?.(value); }} onBack={() => navigate("back")} /></div> : <>
        {drafts.length > 0 && <div className="mt-5"><h4 className="font-semibold">Saved postcard recovery</h4><p className="mt-2 text-sm text-foreground/70">Your saved postcard requests. You can forget other shared results without opening them.</p><ul className="mt-2 divide-y divide-border">{drafts.map((draft, index) => <li key={draft.proposal.postcardId} className="flex flex-wrap items-center gap-2 py-3"><button className={`${eventControl} border border-border`} disabled={busy || props.disabled || Boolean(forget) || JSON.stringify(draft.proposal.source) !== JSON.stringify(props.source)} onClick={() => void run(signal => recover(connection, draft, signal))}>{JSON.stringify(draft.proposal.source) === JSON.stringify(props.source) ? `Continue postcard ${index + 1}` : `Postcard ${index + 1} from another shared result`}</button><button className={eventControl} disabled={busy || props.disabled || Boolean(forget) || JSON.stringify(draft.proposal.source) !== JSON.stringify(props.source)} onClick={() => void run(async signal => { const renewed = await connection.journal!.update(draft.proposal.postcardId, draft.revision, { ticketRequestId: crypto.randomUUID() }); await reload(connection); await attach(connection, renewed, signal); })}>Renew expired connection</button><button className={eventControl} disabled={busy || props.disabled || Boolean(forget)} onClick={event => { setForgetFocus(event.currentTarget); setForget(draft); }}>Forget local recovery {index + 1}…</button></li>)}</ul></div>}
        {forget && <EventHostConfirm title="Forget this local recovery request?" action="Forget local request" busy={busy} returnFocus={forgetFocus} onKeep={() => setForget(null)} onConfirm={() => void run(async () => { await connection.journal!.remove(forget.proposal.postcardId); setForget(null); await reload(connection); })}><p>This removes only this browser’s recovery metadata. It does not withdraw consent, cancel an uncertain upload or delete the event postcard. Keep the contributor link if you want to return to it.</p></EventHostConfirm>}
        <div className="mt-5 max-w-2xl"><label className="block text-sm font-medium">A contributor’s postcard link<input className={`${eventInput} mt-2`} type="text" inputMode="url" autoComplete="off" maxLength={1000} spellCheck={false} value={reference} disabled={busy || props.disabled || Boolean(forget)} onChange={event => setReference(event.target.value)} placeholder="Paste the shared postcard link" /></label><button className={`${eventControl} mt-3 border border-border`} disabled={busy || props.disabled || Boolean(forget) || !reference.trim()} onClick={() => void followReference()}>Join this postcard</button></div>
        {props.design && <div className="mt-6"><p className="mb-3 text-sm text-foreground/70">If someone has already started, join their postcard to keep one shared result.</p><button className={`${eventControl} bg-accent text-accent-foreground`} disabled={busy || props.disabled || !connection.journal || !recoveryAvailable || Boolean(forget)} onClick={() => void newPostcard()}>Start a new postcard</button></div>}
      </>}
    </>}
  </section>;
}
