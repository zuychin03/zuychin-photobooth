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
    if (live.current && !signal?.aborted) { setDrafts(result.drafts); setRecoveryAvailable(result.available); if (!result.available) setError("This browser can't save postcard progress right now. You can still open postcard links to check or withdraw."); }
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
      if (JSON.stringify(view.source) !== JSON.stringify(props.source)) throw new Error("This postcard is for a different photo.");
      const { draft, persistent } = await recoverBoundPostcard(view, handle.client.guestId, handle.journal, () => handle.client.assertActive(signal));
      if (live.current) setSelected({ draft, view, persistent });
    } else {
      const found = await handle.source.proposal(postcardId, signal); if (found.eventId !== handle.client.eventId) throw new Error("This postcard is for a different event.");
      if (!handle.journal) throw new EventClientError("journal_unavailable"); const draft = await handle.journal.create(found.proposal, handle.session.context.expiresAt); await attach(handle, draft, signal);
    }
    await reload(handle,signal);
  };
  const connect = () => run(async signal => {
    const origin = props.options?.appOrigin ?? location.origin, parsed = invitation.trim() ? parsePostcardInvitation(invitation.trim(), origin) : null, eventId = parsed?.eventId ?? props.initialEventId;
    if (!eventId || props.initialEventId && eventId !== props.initialEventId) throw new Error("Use the invitation for this event.");
    runtime.current?.close(); const handle = createPostcardGuestRuntime({ ...props.options, appOrigin: origin, eventId, storageOrigin: props.options?.storageOrigin ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "" }); runtime.current = handle;
    const inspection = await handle.inspect(signal); if (!inspection.existing && !parsed) throw new Error("Paste the event invitation link to join.");
    const session = inspection.existing ? await handle.resume(inspection.existing, signal) : await handle.join(parsed!.token, postcardNonce(), signal);
    const client = createEventPostcardClient({ ...props.options, appOrigin: origin, storageOrigin: props.options?.storageOrigin ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", guest: session.client });
    const source = createPostcardSourceClient({ ...props.options, appOrigin: origin, source: props.source, assertAuthority: signal => latest.current.assertSourceActive(signal), accessToken: () => latest.current.sourceAccessToken?.() ?? Promise.resolve(null) });
    let journal: PostcardJournal | null = null;
    try { await client.capabilities(signal); try { journal = await openPostcardJournal(session.client, { databaseName: props.options?.databaseName }); } catch { client.assertActive(signal); } client.assertActive(signal); }
    catch (failure) { source.close(); client.close(); (journal as PostcardJournal | null)?.close(); handle.close(); throw failure; }
    const opened = { session, client, source, journal }; owned.current = opened;
    if (!live.current || signal.aborted) { source.close(); client.close(); journal?.close(); handle.close(); return; }
    setInvitation(""); setConnection(opened); if (!journal) setError("This browser can't save postcard progress. You can still open a postcard link to check or withdraw."); await reload(opened,signal);
    if (props.initialPostcardId) await discover(opened, props.initialPostcardId, signal);
  });
  const newPostcard = () => run(async signal => {
    if (!connection?.journal || !recoveryAvailable || !props.design) return; props.assertSourceActive(signal);
    const draft = await connection.journal.create({ postcardId: crypto.randomUUID(), submissionId: crypto.randomUUID(), source: props.source, design: props.design }, connection.session.context.expiresAt);
    await reload(connection); await attach(connection, draft, signal);
  });
  const followReference = () => run(async signal => {
    if (!connection) return; const parsed = parsePostcardReference(reference.trim(), props.options?.appOrigin ?? location.origin);
    if (parsed.eventId !== connection.client.eventId || JSON.stringify(parsed.source) !== JSON.stringify(props.source)) throw new Error("That link is for a different event or photo.");
    await discover(connection, parsed.postcardId, signal); setReference("");
  });
  const close = () => { abort.current?.abort(); owned.current?.client.close(); owned.current?.source.close(); owned.current?.journal?.close(); runtime.current?.close(); owned.current = null; runtime.current = null; setConnection(null); setSelected(null); setDrafts([]); setInvitation(""); setReference(""); setForget(null); setLeave(null); setPanelDirty(false); setRecoveryAvailable(false); requestAnimationFrame(() => heading.current?.focus()); };
  const back = () => { setSelected(null); setPanelDirty(false); if (connection) void reload(connection).catch(failure => { if (owned.current === connection) { close(); setError(eventGuestError(failure)); } }); requestAnimationFrame(() => heading.current?.focus()); };
  const navigate = (target: "close" | "back") => {
    if (panelDirty) { setLeaveFocus(document.activeElement instanceof HTMLElement ? document.activeElement : null); setLeave(target); }
    else if (target === "close") close(); else back();
  };
  useAppNavigationGuard(() => { if (busy) { setError("Wait for this to finish before you leave."); return false; } if (panelDirty) { navigate("close"); return false; } return true; });
  return <section className="border-t border-border py-7" aria-label="Event postcard">
    <h3 ref={heading} tabIndex={-1} className="font-display text-2xl outline-none">Send to an event</h3>
    <p className="mt-3 max-w-2xl text-sm leading-relaxed text-foreground/70">Send this photo to an event. Everyone in it needs to join and approve it first.</p>
    {error && <p role="alert" className="mt-4 rounded-xl bg-muted p-4 text-sm leading-relaxed">{error}</p>}
    {busy && <p role="status" className="mt-4 text-sm">Loading…</p>}
    {!connection ? <div className="mt-5 max-w-2xl space-y-3"><label className="block text-sm font-medium">Event invitation link<input className={`${eventInput} mt-2`} type="text" inputMode="url" autoComplete="off" spellCheck={false} maxLength={1000} value={invitation} disabled={busy || props.disabled} onChange={event => setInvitation(event.target.value)} placeholder="Paste the event invitation link" /></label><p className="text-xs leading-relaxed text-foreground/70">Nothing is sent yet.</p><button className={`${eventControl} bg-accent text-accent-foreground`} disabled={busy || props.disabled || !invitation.trim() && !props.initialEventId} onClick={() => void connect()}>Connect to event</button></div> : <>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3"><p className="text-sm">Event: <strong>{connection.session.context.title}</strong></p><button className={`${eventControl} border border-border`} disabled={busy || Boolean(forget) || Boolean(leave)} onClick={() => navigate("close")}>Close</button></div>
      {leave && <EventHostConfirm title="Leave this postcard?" action={leave === "close" ? "Close" : "Back to postcards"} busy={busy} returnFocus={leaveFocus} onKeep={() => setLeave(null)} onConfirm={() => { const target = leave; setLeave(null); if (target === "close") close(); else back(); }}><p>Unsaved choices and the prepared photo will be cleared. Leaving doesn&apos;t withdraw you from the postcard.</p></EventHostConfirm>}
      {selected ? <div inert={Boolean(leave)}><EventPostcardPanel key={selected.draft.proposal.postcardId} initial={selected} connection={connection} origin={props.options?.appOrigin} render={props.render} onDirtyChange={setPanelDirty} onInvalidated={() => { close(); setError("Your access changed. Connect to the event again."); }} onBusyChange={value => { setBusy(value); props.onBusyChange?.(value); }} onBack={() => navigate("back")} /></div> : <>
        {drafts.length > 0 && <div className="mt-5"><h4 className="font-semibold">Unfinished postcards</h4><p className="mt-2 text-sm text-foreground/70">You can forget postcards you don&apos;t need.</p><ul className="mt-2 divide-y divide-border">{drafts.map((draft, index) => <li key={draft.proposal.postcardId} className="flex flex-wrap items-center gap-2 py-3"><button className={`${eventControl} border border-border`} disabled={busy || props.disabled || Boolean(forget) || JSON.stringify(draft.proposal.source) !== JSON.stringify(props.source)} onClick={() => void run(signal => recover(connection, draft, signal))}>{JSON.stringify(draft.proposal.source) === JSON.stringify(props.source) ? `Continue postcard ${index + 1}` : `Postcard ${index + 1} (different photo)`}</button><button className={eventControl} disabled={busy || props.disabled || Boolean(forget) || JSON.stringify(draft.proposal.source) !== JSON.stringify(props.source)} onClick={() => void run(async signal => { const renewed = await connection.journal!.update(draft.proposal.postcardId, draft.revision, { ticketRequestId: crypto.randomUUID() }); await reload(connection); await attach(connection, renewed, signal); })}>Reconnect</button><button className={eventControl} disabled={busy || props.disabled || Boolean(forget)} onClick={event => { setForgetFocus(event.currentTarget); setForget(draft); }}>Forget postcard {index + 1}…</button></li>)}</ul></div>}
        {forget && <EventHostConfirm title="Forget this postcard?" action="Forget" busy={busy} returnFocus={forgetFocus} onKeep={() => setForget(null)} onConfirm={() => void run(async () => { await connection.journal!.remove(forget.proposal.postcardId); setForget(null); await reload(connection); })}><p>This only removes it from this browser. It doesn&apos;t withdraw you from the postcard. Keep the postcard link if you want to come back.</p></EventHostConfirm>}
        <div className="mt-5 max-w-2xl"><label className="block text-sm font-medium">Postcard link from someone else<input className={`${eventInput} mt-2`} type="text" inputMode="url" autoComplete="off" maxLength={1000} spellCheck={false} value={reference} disabled={busy || props.disabled || Boolean(forget)} onChange={event => setReference(event.target.value)} placeholder="Paste the postcard link" /></label><button className={`${eventControl} mt-3 border border-border`} disabled={busy || props.disabled || Boolean(forget) || !reference.trim()} onClick={() => void followReference()}>Join this postcard</button></div>
        {props.design && <div className="mt-6"><p className="mb-3 text-sm text-foreground/70">If someone else already started one, join theirs instead.</p><button className={`${eventControl} bg-accent text-accent-foreground`} disabled={busy || props.disabled || !connection.journal || !recoveryAvailable || Boolean(forget)} onClick={() => void newPostcard()}>Start a new postcard</button></div>}
      </>}
    </>}
  </section>;
}
