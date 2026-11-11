"use client";

import { useAppNavigationGuard } from "@/components/AppNavigation";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Camera, Check, Copy, LoaderCircle, LockKeyhole, Palette, RefreshCw, Users, X } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { useStickyTop } from "@/components/ui/useStickyTop";
import { useAuth } from "@/lib/auth";
import { useBoothSession } from "@/lib/session";
import { useCamera } from "@/hooks/useCamera";
import { useCuratedAssets } from "@/hooks/useCuratedAssets";
import type { RoomState } from "@/lib/server/room-contract";
import { RoomWorkspaceController } from "@/lib/rtc/workspace-controller";
import { SharedPreviewPainter, type SharedPreviewStatus } from "@/lib/shared-preview";
import { LAYOUTS, cellShotIndex, layoutCells, layoutRoles, type Role } from "@/lib/layouts";
import { FRAMES, STICKER_PACKS } from "@/lib/decor";
import { FILTERS } from "@/lib/filters";
import { SCENES } from "@/lib/scenes";
import { defaultCellEdit } from "@/lib/projects/transforms";
import type { RecipeEdit } from "@/lib/rtc/recipe-v2";
import { StoryGuide } from "@/components/StoryGuide";
import { storyCaptureProgress } from "@/lib/stories/model";
import { Dropdown } from "@/components/Dropdown";
import { LayoutPicker } from "@/components/LayoutPicker";
import { StripStyleControls } from "@/components/StripStyleControls";
import { resolveStrip } from "@/lib/strip-style";
import { RoomPostcard } from "./RoomPostcard";
import { RoomRoundPreview } from "./RoomRoundPreview";
import { downloadProjectBlob } from "@/lib/projects/download";

export default function RoomWorkspace({ initial }: { initial: RoomState }) {
  const { user } = useAuth();
  const ownerId = user?.id ?? null;
  const [controller, setController] = useState<RoomWorkspaceController | null>(null);
  useEffect(() => {
    const current = new RoomWorkspaceController(initial, ownerId ? { kind: "account", ownerId } : { kind: "device" });
    let active = true;
    queueMicrotask(() => { if (active) { setController(current); void current.start(); } });
    return () => { active = false; current.close(); };
  }, [initial, ownerId]);
  return controller ? <Workspace controller={controller} /> : <main className="booth-mode flex w-full flex-1 items-center justify-center px-6 py-20"><p role="status" className="flex items-center gap-2 text-sm font-bold text-muted-foreground"><LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" aria-hidden />Opening your room…</p></main>;
}

export function Workspace({ controller, fixtureCamera, fixtureProjectDatabaseName, onOpenCopy, previewActive = true }: { controller: RoomWorkspaceController; fixtureCamera?: ReturnType<typeof useCamera>; fixtureProjectDatabaseName?: string; onOpenCopy?(id: string): Promise<void>; previewActive?: boolean }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const { room, recipe, round } = snapshot;
  const router = useRouter(), session = useBoothSession();
  const [consent, setConsent] = useState(Boolean(fixtureCamera)), [copied, setCopied] = useState(false), [endConfirm, setEndConfirm] = useState(false);
  const [now, setNow] = useState(0), [selectedCell, setSelectedCell] = useState("0");
  const [leaveWarning, setLeaveWarning] = useState(false);
  const [postcardBusy, setPostcardBusy] = useState(false);
  const [livePaused, setLivePaused] = useState(false);
  const livePainter = useRef<SharedPreviewPainter | null>(null);
  const registerPainter = useCallback((painter: SharedPreviewPainter | null) => { livePainter.current = painter; }, []);
  const suspendLive = useCallback(async () => { setLivePaused(true); await livePainter.current?.dispose(); }, []);
  const resumeLive = useCallback(() => setLivePaused(false), []);
  const [caption, setCaption] = useState("");
  const sidebar = useStickyTop();
  const actionFocus = useRef<{ control: HTMLElement; controller: RoomWorkspaceController } | null>(null);
  const alive = room.status === "open" && room.members.some(member => member.id === room.selfId && member.status !== "removed");
  const realCamera = useCamera(!fixtureCamera && consent && Boolean(room.selfRole) && alive);
  const { videoRef, stream: cameraStream, ready, attachVideo, error: cameraError, retry: retryCamera } = fixtureCamera ?? realCamera;
  const cameraReady = ready && consent && alive && Boolean(room.selfRole);
  const getVideo = useCallback(() => videoRef.current, [videoRef]);
  const host = room.selfId === room.hostId;
  const members = useMemo(() => room.members.filter(member => member.status === "admitted" && member.role), [room.members]);
  const pending = room.members.filter(member => member.status === "pending");
  const edit = recipe?.recipe.editor;
  const roomBusy = snapshot.busy || snapshot.capturing || snapshot.pendingProposal || Boolean(snapshot.recoveryRecipe) || !alive;
  const busy = roomBusy || postcardBusy;
  useAppNavigationGuard(() => {
    if (snapshot.busy || snapshot.capturing || snapshot.pendingProposal || postcardBusy || snapshot.pendingLocalFrames.some(frame => !frame.persisted)) {
      setLeaveWarning(true); return false;
    }
    return true;
  }, !fixtureCamera && !fixtureProjectDatabaseName);
  const act = (action: () => Promise<unknown>) => {
    const control = document.activeElement;
    actionFocus.current = control instanceof HTMLElement && control !== document.body ? { control, controller } : null;
    void controller.action(action);
  };
  const change = (value: RecipeEdit) => act(() => controller.edit(value.kind === "shared" && value.patch.layoutId && LAYOUTS.find(item => item.id === value.patch.layoutId)?.shots !== 4 ? { ...value, patch: { ...value.patch, story: null } } : value));
  const layout = LAYOUTS.find(item => item.id === edit?.layoutId);
  const fourCut = edit?.template ? Object.values(edit.template.requiredSources).every(count => count === 4) : layout?.shots === 4;
  const roomLayouts = LAYOUTS.filter(item => item.mode === snapshot.draft?.mode && item.mode !== "solo" && members.every(member => member.role && layoutRoles(item).has(member.role)));
  const hasEmptyRoles = layout && layout.mode !== "solo" && [...layoutRoles(layout)].some(role => !members.some(member => member.role === role));
  const expected = room.capture && round?.id === room.capture.captureId ? room.capture.shotIds.length * room.capture.memberIds.length : 0;
  const complete = Boolean(round && expected > 0 && snapshot.savedShots === expected);
  const ownRole = room.selfRole ?? "A";
  const ownCells = layout ? layoutCells(layout).filter(cell => layout.mode === "solo" || cell.owners.includes(ownRole)).map(cell => cell.index) : [0];
  const cellIndex = ownCells.includes(Number(selectedCell)) ? Number(selectedCell) : ownCells[0] ?? 0;
  const cellEdit = edit?.cellEdits[`${cellIndex}:${ownRole}`] ?? defaultCellEdit(layout ? cellShotIndex(layout, cellIndex) : 0);
  const place = edit?.places[ownRole] ?? { dx: 0, dy: 0, scale: 1 };
  useLayoutEffect(() => {
    if (busy) return;
    const target = actionFocus.current;
    actionFocus.current = null;
    if (target?.controller === controller && target.control.isConnected && target.control.getClientRects().length
      && document.activeElement === document.body && !target.control.matches(":disabled") && !target.control.closest("[inert]")) target.control.focus({ preventScroll: true });
  }, [busy, controller]);
  useEffect(() => {
    if (!cameraReady || !videoRef.current || !cameraStream.current) return;
    void controller.connect(videoRef.current, cameraStream.current);
    return () => controller.disconnect();
  }, [cameraReady, cameraStream, videoRef, controller]);
  useEffect(() => {
    if (!snapshot.capturing) return;
    const timer = setInterval(() => setNow(controller.serverNow), 100);
    return () => clearInterval(timer);
  }, [controller, snapshot.capturing]);
  useEffect(() => {
    if (fixtureCamera || fixtureProjectDatabaseName || (!snapshot.capturing && !snapshot.pendingProposal && !snapshot.pendingLocalFrames.length && !postcardBusy)) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    const intercept = (event: MouseEvent) => {
      if ((snapshot.pendingLocalFrames.some(frame => !frame.persisted) || snapshot.capturing || snapshot.pendingProposal || postcardBusy) && event.target instanceof Element && event.target.closest("a[href]")) { event.preventDefault(); event.stopPropagation(); setLeaveWarning(true); }
    };
    window.addEventListener("beforeunload", warn); document.addEventListener("click", intercept, true);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("click", intercept, true); };
  }, [snapshot.capturing, snapshot.pendingProposal, snapshot.pendingLocalFrames, postcardBusy, fixtureCamera, fixtureProjectDatabaseName]);
  const storyProgress = room.capture?.state === "committed" && snapshot.capturing && edit?.story ? storyCaptureProgress(room.capture.fireAt, room.capture.intervalMs, now) : null;
  const countdown = storyProgress?.countdown ?? (room.capture?.state === "committed" && snapshot.capturing ? Math.max(0, Math.ceil((room.capture.fireAt - now) / 1000)) : null);
  const openCopy = async () => {
    const copyId = await controller.openEditableCopy();
    if (onOpenCopy) { await onOpenCopy(copyId); return; }
    await session.openProject(copyId, controller.scope);
    controller.disconnect(); setConsent(false); router.push("/customize");
  };
  const copyInvite = async () => {
    await navigator.clipboard.writeText(`${location.origin}/room/${room.code}?v=2&id=${room.roomId}`); setCopied(true);
  };
  return <main className="booth-mode mx-auto w-full max-w-7xl px-4 pt-4 pb-10 sm:px-8 sm:pt-6">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="glass flex min-h-12 items-center gap-3 rounded-full py-1.5 pr-4 pl-5"><span className="text-xs font-bold text-muted-foreground">Room</span><h1 className="text-xl font-black tracking-[0.24em] uppercase sm:text-2xl">{room.code}</h1>{room.locked && <LockKeyhole size={17} aria-label="Room locked" />}</div>
      <div className="flex flex-wrap items-center gap-3"><span className="text-sm font-bold text-muted-foreground tabular-nums">{members.length}/4 people</span><button className="btn btn-glass" onClick={() => act(copyInvite)} disabled={!alive}>{copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}{copied ? "Invite copied" : "Copy invite"}</button></div>
    </header>
    <div className="grid gap-5 pt-5 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-6">
      <section className="flex min-w-0 flex-col gap-4" aria-label="Live room">
        <h2 className="sr-only">Take photos together</h2>
        {!room.selfRole && alive ? <div className="panel grid min-h-72 place-content-center justify-items-center p-8 text-center"><span className="glyph mb-4 size-12 rounded-2xl bg-[#8b5cf6]"><Users size={24} strokeWidth={2.25} aria-hidden /></span><h3 className="font-display text-2xl">Waiting for the host</h3><p className="mt-2 max-w-sm text-sm text-muted-foreground">Your camera stays off until they let you in.</p></div> : <>
          <div className="relative overflow-hidden rounded-[1.75rem] bg-card">
            <video ref={attachVideo} autoPlay playsInline muted aria-label="Your camera" className="absolute h-px w-px opacity-0" />
            {cameraReady ? <SharedView controller={controller} getVideo={getVideo} paused={livePaused || !previewActive} registerPainter={registerPainter} /> : <div className="grid aspect-[3/2] min-h-60 place-content-center justify-items-center px-8 text-center"><Camera size={32} className="mb-4 text-muted-foreground" aria-hidden /><p className="font-display text-2xl">{alive ? "Your camera is off." : room.status === "open" ? "You're no longer in this room." : "This room has closed."}</p>{!alive && <p className="mt-2 max-w-sm text-sm text-muted-foreground">Any photos you already saved are still on this device.</p>}</div>}
            {countdown !== null && countdown > 0 && <div className="pointer-events-none absolute inset-0 grid place-content-center justify-items-center bg-black/30 text-center text-white"><span className="font-display text-8xl tabular-nums">{countdown}</span><span className="glass mt-3 rounded-full px-4 py-1.5 text-sm font-bold">Get into position</span></div>}
          </div>
          {alive && <label className="panel flex cursor-pointer items-start gap-3 p-4 sm:p-5"><input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-accent" checked={consent} disabled={!room.selfRole} onChange={event => setConsent(event.target.checked)} /><span className="text-sm"><strong className="block font-bold">Turn on my camera and take photos together</strong><span className="mt-0.5 block text-muted-foreground">Everyone in the room will see your video and get copies of your photos.</span></span></label>}
          {cameraError && <div role="alert" className="notice border border-destructive/25 bg-destructive/8"><p>Couldn&apos;t start your camera. Check that it&apos;s allowed and that no other app is using it.</p><div className="mt-3 flex flex-wrap gap-2"><button className="btn btn-quiet min-h-10 text-sm" onClick={retryCamera}>Try again</button><Link className="btn btn-quiet min-h-10 text-sm" href="/booth">Use the solo booth</Link></div></div>}
        </>}
        {room.selfRole && alive && <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-primary min-h-12 px-6" disabled={busy || !cameraReady || !recipe || (host && (snapshot.peers.length < 1 || snapshot.peers.some(peer => !peer.connected) || Boolean(round && !complete)))} onClick={() => act(() => controller.capture())}><Camera size={18} aria-hidden />{snapshot.capturing ? "Getting everyone ready…" : host ? round ? "Take another round" : "Get everyone ready" : "Ask for a photo round"}</button>
          {snapshot.capturing && host && <button className="btn btn-quiet" onClick={() => act(() => controller.cancelCapture())}>Cancel round</button>}
          {!snapshot.capturing && cameraReady && <button className="btn btn-quiet" disabled={busy} onClick={() => act(() => controller.reconnect())}><RefreshCw size={15} aria-hidden /> Reconnect</button>}
        </div>}
        {snapshot.captureRequest && host && <p role="status" className="text-sm font-bold text-accent">{snapshot.captureRequest} wants to take some photos.</p>}
        {edit && alive && fourCut && (host || edit.story) && <div><StoryGuide plan={edit.story ?? null} members={members.map(member => ({ id: member.id, name: member.displayName }))} editable={host} disabled={busy} activeStep={storyProgress?.step} onChange={story => change({ kind: "shared", patch: { story, ...(story && !edit.template && layout?.shots !== 4 ? { layoutId: "quad-story" } : {}) } })} />{edit.story && <p className="mt-2 text-xs text-muted-foreground">There are 15 seconds between story photos.</p>}</div>}
        <p role="status" className="text-sm text-muted-foreground">{snapshot.status}</p>
        {snapshot.pendingLocalFrames.length > 0 && <section role="alert" className="panel p-5"><h3 className="font-bold text-accent">{snapshot.pendingLocalFrames.some(frame => !frame.persisted) ? "Keep this tab open. A photo hasn't saved yet." : "Your photo saved, but it didn't reach everyone."}</h3><p className="mt-2 text-sm text-muted-foreground">{snapshot.pendingLocalFrames.some(frame => !frame.persisted) ? "This device couldn't save every photo. Try again or download a copy now, because closing the tab could lose it." : "Try again to send it to the room."}</p><div className="mt-4 flex flex-wrap gap-2"><button className="btn btn-primary min-h-10 text-sm" disabled={busy} onClick={() => act(() => controller.retryLocalFrames())}>Try again</button>{snapshot.pendingLocalFrames.map(frame => <button key={frame.id} className="btn btn-quiet min-h-10 text-sm" onClick={() => { const blob = controller.getLocalRecoveryBlob(frame.id); if (blob) downloadProjectBlob(blob, `room-${room.code}-photo-${frame.shotIndex + 1}-recovery.jpg`); }}>Download photo {frame.shotIndex + 1}</button>)}</div>{leaveWarning && <p className="mt-3 text-sm font-bold">Save your photo before you leave.</p>}</section>}
        {leaveWarning && (snapshot.busy || snapshot.capturing || snapshot.pendingProposal || postcardBusy) && snapshot.pendingLocalFrames.every(frame => frame.persisted) && <p role="alert" className="text-sm font-bold">Finish or cancel what&apos;s in progress before you leave.</p>}
        {snapshot.error && <div role="alert" className="notice border border-destructive/25 bg-destructive/8"><p>{snapshot.error}</p>{alive && <div className="mt-3 flex flex-wrap gap-2"><button className="btn btn-quiet min-h-10 text-sm" disabled={busy} onClick={() => act(() => controller.reconnect())}><RefreshCw size={15} aria-hidden /> Reconnect</button><button className="btn btn-quiet min-h-10 text-sm" disabled={busy} onClick={() => act(() => controller.retrySave())}>Try saving the design again</button></div>}</div>}
        {snapshot.recoveryRecipe && <section aria-label="Choose a design" className="panel p-5"><h3 className="font-bold">The host has a newer design.</h3><p className="mt-2 text-sm text-muted-foreground">Switch to it to keep editing together. Your version is saved as its own project first.</p><div className="mt-4 flex flex-wrap gap-2"><button className="btn btn-primary" disabled={busy} onClick={() => act(() => controller.acceptHost())}>Save mine and switch</button><button className="btn btn-quiet" disabled={busy} onClick={() => act(openCopy)}>Leave with my copy</button></div></section>}
        {!round && snapshot.draft && recipe && <section className="panel p-4 sm:p-6" aria-label="Shared print preview"><h3 className="font-display text-xl">Your strip</h3><p className="mt-1 text-sm text-muted-foreground">Pick a frame before the first round.</p><RoomRoundPreview project={snapshot.draft} fixtureDatabaseName={fixtureProjectDatabaseName} suspendLive={suspendLive} resumeLive={resumeLive} /><button className="btn btn-quiet mt-4" disabled={busy || snapshot.capturing || snapshot.pendingProposal} onClick={() => act(openCopy)}>Leave with a copy to edit</button></section>}
        {round && <section className="panel p-4 sm:p-6" aria-label="Saved round"><h3 className="font-display text-xl">{complete ? "All the photos are in." : "Photos are still coming in."}</h3><p className="mt-1 text-sm text-muted-foreground tabular-nums">{snapshot.savedShots} {expected ? `of ${expected} ` : ""}photos saved on this device.</p><ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">{round.participants.map(person => { const count = round.sourceOrder[person.role].filter(Boolean).length; return <li key={person.id} className="panel-muted min-w-0 p-3"><span className="block truncate font-bold">{room.members.find(member => member.id === person.id)?.displayName ?? `Person ${person.role}`}</span><p className="mt-1 text-xs text-muted-foreground tabular-nums">{count} saved{room.capture ? ` / ${room.capture.shotIds.length}` : ""}</p></li>; })}</ul><RoomRoundPreview project={round} fixtureDatabaseName={fixtureProjectDatabaseName} suspendLive={suspendLive} resumeLive={resumeLive} /><div className="mt-4 flex flex-wrap gap-2">{alive && <button className="btn btn-quiet" disabled={busy || snapshot.capturing || !snapshot.cameraConnected} onClick={() => act(() => controller.resumeSavedOriginals())}>Send my photos again</button>}<button className={`btn ${complete ? "btn-primary" : "btn-quiet"}`} disabled={busy || snapshot.capturing || snapshot.pendingLocalFrames.some(frame => !frame.persisted)} onClick={() => act(openCopy)}>{complete ? "Leave with a copy to edit" : "Leave with what we have"}</button>{!complete && host && alive && <button className="btn btn-quiet" disabled={busy || snapshot.capturing || Boolean(snapshot.pendingLocalFrames.length)} onClick={() => act(() => controller.keepIncompleteRoundAndCapture())}>Keep this round as it is and go again</button>}</div>{!complete && <p className="mt-3 text-xs text-muted-foreground">Missing photos will be left blank. Reconnect to keep sharing.</p>}</section>}
        {complete && alive && <RoomPostcard key={`${room.sessionId}:${room.selfId}:${round!.id}:${JSON.stringify(controller.scope)}`} controller={controller} disabled={roomBusy} databaseName={fixtureProjectDatabaseName} onBusyChange={setPostcardBusy} />}
      </section>
      <aside ref={sidebar} className="flex min-w-0 flex-col gap-5 lg:sticky lg:top-[var(--sticky-top,5.5rem)] lg:self-start" aria-label="People and shared design">
        <Section id="room-people-title" title="Who's here" icon={Users} tone="violet" bodyClassName="mt-2" action={host && alive && <button className="btn btn-quiet min-h-10 text-sm" disabled={busy} onClick={() => act(() => controller.control("lock", !room.locked))}><LockKeyhole size={15} aria-hidden />{room.locked ? "Unlock room" : "Lock room"}</button>}>
          <ul className="divide-y divide-border">{members.map(member => <li key={member.id} className="flex items-center gap-3 py-3"><span className="grid h-9 w-9 shrink-0 place-content-center rounded-full bg-muted text-sm font-black">{member.role}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{member.displayName}{member.id === room.selfId ? " (you)" : ""}</p><p className="text-xs text-muted-foreground">{member.id === room.hostId ? "Host · " : ""}{member.id === room.selfId ? cameraReady ? "Camera ready" : "Camera off" : snapshot.peers.some(peer => peer.id === member.id && peer.connected) ? "Connected" : "Connecting"}</p></div>{host && member.id !== room.selfId && alive && <button className="btn btn-plain min-h-11 min-w-11 px-0" aria-label={`Remove ${member.displayName}`} disabled={busy} onClick={() => act(() => controller.control("remove", member.id))}><X size={16} aria-hidden /></button>}</li>)}</ul>
          {host && pending.length > 0 && <div className="panel-muted mt-2 p-3 sm:p-4"><h3 className="text-sm font-bold">Asking to join</h3>{pending.map(member => <div key={member.id} className="mt-3 flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 break-words text-sm font-bold">{member.displayName}</span><button className="btn btn-partner min-h-10 text-sm" disabled={busy || members.length >= 4} onClick={() => act(() => controller.control("admit", member.id))}>Let in</button><button className="btn btn-plain min-h-10 text-sm" disabled={busy} onClick={() => act(() => controller.control("remove", member.id))}>Decline</button></div>)}</div>}
        </Section>
        {edit && alive && <section className="panel flex flex-col gap-4 p-4 sm:p-6" aria-label="Shared design"><div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"><div className="flex min-w-0 items-center gap-3"><span className="glyph bg-[#f43f5e]"><Palette size={18} strokeWidth={2.25} aria-hidden /></span><h2 className="font-display text-xl leading-tight">Design it together</h2></div><p role="status" className="text-xs font-bold text-muted-foreground">{snapshot.pendingProposal ? "Waiting for the host to confirm your edit…" : "Up to date"}</p></div>
          {!host && <p className="text-sm text-muted-foreground">The host picks the frame. You can edit your own photos and stickers.</p>}
          {host && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1"><div className="sm:col-span-2 lg:col-span-1"><p className="mb-1.5 text-sm font-bold">Layout</p><LayoutPicker label="Layout" layouts={roomLayouts} value={edit.layoutId} disabled={busy} onChange={layoutId => change({ kind: "shared", patch: { layoutId } })} /></div><Dropdown showLabel label="Frame" value={edit.frameId} disabled={busy} options={FRAMES.map(item => ({ value: item.id, label: item.name }))} onChange={frameId => change({ kind: "shared", patch: { frameId } })} /><Dropdown showLabel label="Filter" value={edit.filterId} disabled={busy} options={FILTERS.map(item => ({ value: item.id, label: item.name }))} onChange={filterId => change({ kind: "shared", patch: { filterId } })} /><div className="sm:col-span-2 lg:col-span-1"><StripStyleControls value={resolveStrip(edit.strip)} disabled={busy} fields={["finish", "sprockets", "date"]} onChange={strip => change({ kind: "shared", patch: { strip } })} /></div><Dropdown showLabel label="Together scene" value={edit.sceneId ?? "none"} disabled={busy} options={[{ value: "none", label: "Original backgrounds" }, ...SCENES.map(item => ({ value: item.id, label: item.name }))]} onChange={sceneId => change({ kind: "shared", patch: { sceneId: sceneId === "none" ? null : sceneId } })} /><form className="sm:col-span-2 lg:col-span-1" onSubmit={event => { event.preventDefault(); change({ kind: "shared", patch: { caption } }); }}><label className="text-xs font-bold" htmlFor="room-caption">Caption</label><div className="mt-2 flex gap-2"><input id="room-caption" maxLength={160} placeholder={edit.caption || "Add a caption…"} value={caption} onChange={event => setCaption(event.target.value)} disabled={busy} className="field min-h-11 min-w-0 flex-1 text-sm" /><button className="btn btn-quiet shrink-0" disabled={busy}>Apply caption</button></div></form></div>}
          {hasEmptyRoles && <p className="text-xs text-muted-foreground">Empty spots belong to people who left. Everyone else keeps their place.</p>}
          <div className="panel-muted p-4"><fieldset disabled={busy} className="space-y-4"><legend className="mb-1 text-sm font-bold">Your photos</legend>
            {edit.sceneId && <><Range label="Your position" value={place.dx} min={-.5} max={.5} step={.05} onCommit={dx => change({ kind: "placement", role: ownRole, value: { ...place, dx } })} /><Range label="Your size" value={place.scale} min={.5} max={1.6} step={.05} onCommit={scale => change({ kind: "placement", role: ownRole, value: { ...place, scale } })} /></>}
            {!edit.template && <><Dropdown label="Your photo slot" showLabel value={String(cellIndex)} disabled={busy} options={ownCells.map(index => ({ value: String(index), label: `Slot ${index + 1}` }))} onChange={setSelectedCell} /><Range label="Photo zoom" value={cellEdit.zoom} min={1} max={4} step={.1} onCommit={zoom => change({ kind: "cell", role: ownRole, cellIndex, value: { ...cellEdit, zoom } })} /><Range label="Horizontal crop" value={cellEdit.offsetX} min={-1} max={1} step={.1} onCommit={offsetX => change({ kind: "cell", role: ownRole, cellIndex, value: { ...cellEdit, offsetX } })} /><Range label="Vertical crop" value={cellEdit.offsetY} min={-1} max={1} step={.1} onCommit={offsetY => change({ kind: "cell", role: ownRole, cellIndex, value: { ...cellEdit, offsetY } })} /></>}
            <div><p className="text-xs font-bold">Add a sticker</p><div className="mt-2 flex flex-wrap gap-2">{STICKER_PACKS[0].stickers.slice(0, 6).map(sticker => <button key={sticker.slug} type="button" className="grid min-h-11 min-w-11 place-items-center rounded-full bg-card text-2xl" aria-label={`Add ${sticker.slug}`} onClick={() => { const key = Date.now() * 100 + Math.floor(Math.random() * 100); change({ kind: "sticker", role: ownRole, key, value: { key, emoji: sticker.emoji, slug: sticker.slug, x: .2 + members.findIndex(member => member.id === room.selfId) * .2, y: .94, scale: 1, rotation: 0 } }); }}>{sticker.emoji}</button>)}</div></div>
            {edit.stickers.filter(sticker => recipe!.recipe.stickerOwners[String(sticker.key)] === room.selfId).map(sticker => <div key={sticker.key} className="space-y-2 border-t border-border pt-3"><p className="text-sm font-bold">Your {sticker.emoji} sticker</p><Range label={`${sticker.emoji} horizontal position`} value={sticker.x} min={0} max={1} step={.05} onCommit={x => change({ kind: "sticker", role: ownRole, key: sticker.key, value: { ...sticker, x } })} /><Range label={`${sticker.emoji} vertical position`} value={sticker.y} min={0} max={1} step={.05} onCommit={y => change({ kind: "sticker", role: ownRole, key: sticker.key, value: { ...sticker, y } })} /><button className="btn btn-danger min-h-10 text-sm" onClick={() => change({ kind: "sticker", role: ownRole, key: sticker.key, value: null })}>Remove sticker</button></div>)}
          </fieldset></div>
        </section>}
        <div className="flex flex-wrap gap-2"><Link className="btn btn-quiet" href="/projects">My projects</Link>{host && alive && <button className="btn btn-plain" onClick={() => setEndConfirm(true)}>End room</button>}</div>
        {endConfirm && <section className="notice" aria-label="Confirm end room"><p>End this room for everyone? Photos people already saved stay on their devices.</p><div className="mt-3 flex flex-wrap gap-2"><button className="btn btn-danger min-h-10 text-sm" disabled={busy} onClick={() => act(async () => { await controller.control("end"); setConsent(false); setEndConfirm(false); })}>End for everyone</button><button className="btn btn-plain min-h-10 text-sm" onClick={() => setEndConfirm(false)}>Keep it open</button></div></section>}
      </aside>
    </div>
  </main>;
}

function Range({ label, value, min, max, step, onCommit }: { label: string; value: number; min: number; max: number; step: number; onCommit(value: number): void }) {
  const [draft, setDraft] = useState<{ source: number; value: number }>({ source: value, value });
  const shown = draft.source === value ? draft.value : value;
  return <label className="block text-xs"><span className="flex justify-between gap-4 font-bold"><span>{label}</span><span className="tabular-nums text-muted-foreground">{shown.toFixed(2)}</span></span><input type="range" min={min} max={max} step={step} value={shown} className="mt-2 min-h-11 w-full accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" onChange={event => setDraft({ source: value, value: Number(event.target.value) })} onPointerUp={event => onCommit(Number(event.currentTarget.value))} onKeyUp={event => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) onCommit(Number(event.currentTarget.value)); }} /></label>;
}

function SharedView({ controller, getVideo, paused, registerPainter }: { controller: RoomWorkspaceController; getVideo(): HTMLVideoElement | null; paused: boolean; registerPainter(value: SharedPreviewPainter | null): void }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const canvas = useRef<HTMLCanvasElement>(null);
  const painterRef = useRef<SharedPreviewPainter | null>(null);
  const [status, setStatus] = useState<SharedPreviewStatus | null>(null);
  const scene = SCENES.find(item => item.id === snapshot.recipe?.recipe.editor.sceneId) ?? null;
  const assets = useCuratedAssets(scene?.assetId ?? null, null);
  const members = snapshot.room.members.filter(member => member.status === "admitted" && member.role);
  const roles = members.map(member => member.role!) as Role[];
  const inputKey = `${snapshot.remoteStreamRevision}:${snapshot.room.connectionEpoch}:${members.map(member => `${member.id}:${member.connectionEpoch}:${snapshot.peers.find(peer => peer.id === member.id)?.connected}`).join(":")}`;
  useEffect(() => {
    const video = getVideo();
    if (!canvas.current || !video || !snapshot.room.selfRole || paused) return;
    const painter = new SharedPreviewPainter(canvas.current, { onStatus: setStatus });
    painterRef.current = painter;
    registerPainter(painter);
    const remoteVideos: HTMLVideoElement[] = [];
    const inputs = [{ role: snapshot.room.selfRole, video, mirror: true }];
    for (const [id, stream] of controller.remoteStreams) {
      const member = members.find(item => item.id === id);
      if (!member?.role) continue;
      const remote = document.createElement("video"); remote.muted = true; remote.playsInline = true; remote.srcObject = stream;
      void remote.play().catch(() => {}); remoteVideos.push(remote); inputs.push({ role: member.role, video: remote, mirror: true });
    }
    painter.start({ inputs, intendedRoles: roles, localRole: snapshot.room.selfRole, scene, sceneAsset: scene?.assetId ? assets.resources.get(scene.assetId) : null, places: { ...snapshot.recipe?.recipe.editor.places } });
    return () => { painterRef.current = null; registerPainter(null); void painter.dispose(); for (const remote of remoteVideos) { remote.pause(); remote.srcObject = null; } };
    // Media references are reconciled by connection epochs; recipe changes rebuild the bounded painter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, getVideo, inputKey, scene, assets.resources, snapshot.recipe?.recipe.editor.places, paused, registerPainter]);
  const label = paused ? "Live preview paused" : status?.mode === "together" ? "Together preview" : status?.mode === "warming" ? "Preparing Together preview…" : status?.mode === "local-only" ? "Your camera only · waiting for the others" : status?.mode === "waiting" ? "Waiting for cameras to start" : "Camera previews";
  return <><canvas ref={canvas} className="aspect-[3/2] w-full" aria-label={label} /><div className="absolute right-3 bottom-3 left-3 flex flex-wrap items-center justify-between gap-2 text-xs"><span className="glass rounded-full px-3 py-1.5 font-bold">{label}</span>{status?.reason === "slow-segmentation" || status?.reason === "segmentation-unavailable" ? <button className="btn btn-glass min-h-11 text-xs" disabled={paused} onClick={() => painterRef.current?.retryTogether()}>Try Together again</button> : null}</div></>;
}
