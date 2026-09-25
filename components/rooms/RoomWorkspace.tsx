"use client";

import { useAppNavigationGuard } from "@/components/AppNavigation";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Camera, Check, Copy, LockKeyhole, RefreshCw, Users, X } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useBoothSession } from "@/lib/session";
import { useCamera } from "@/hooks/useCamera";
import { useCuratedAssets } from "@/hooks/useCuratedAssets";
import type { RoomState } from "@/lib/server/room-contract";
import { RoomWorkspaceController } from "@/lib/rtc/workspace-controller";
import { SharedPreviewPainter, type SharedPreviewStatus } from "@/lib/shared-preview";
import { LAYOUTS, cellShotIndex, type Role } from "@/lib/layouts";
import { FRAMES, STICKER_PACKS } from "@/lib/decor";
import { FILTERS } from "@/lib/filters";
import { SCENES } from "@/lib/scenes";
import { defaultCellEdit } from "@/lib/projects/transforms";
import type { RecipeEdit } from "@/lib/rtc/recipe-v2";
import { StoryGuide } from "@/components/StoryGuide";
import { storyCaptureProgress } from "@/lib/stories/model";
import { Dropdown } from "@/components/Dropdown";
import { RoomPostcard } from "./RoomPostcard";
import { RoomRoundPreview } from "./RoomRoundPreview";
import { downloadProjectBlob } from "@/lib/projects/download";

const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45";
const secondary = `${button} border border-border bg-card hover:bg-muted`;
const primary = `${button} bg-accent text-accent-foreground hover:brightness-105`;

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
  return controller ? <Workspace controller={controller} /> : <main className="m-auto px-6 py-20"><p role="status">Opening your room…</p></main>;
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
  const roomLayouts = LAYOUTS.filter(item => item.mode === snapshot.draft?.mode && members.every(member => item.duoPattern?.some(role => role === member.role || role === "AB" && (member.role === "A" || member.role === "B"))));
  const hasEmptyRoles = layout?.duoPattern?.some(role => role !== "AB" && !members.some(member => member.role === role));
  const expected = room.capture && round?.id === room.capture.captureId ? room.capture.shotIds.length * room.capture.memberIds.length : 0;
  const complete = Boolean(round && expected > 0 && snapshot.savedShots === expected);
  const ownRole = room.selfRole ?? "A";
  const ownCells = Array.from({ length: (layout?.cols ?? 1) * (layout?.rows ?? 4) }, (_, index) => index).filter(index => !layout?.duoPattern || layout.duoPattern[index] === ownRole || (layout.duoPattern[index] === "AB" && ["A", "B"].includes(ownRole)));
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
  return <main className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-8 sm:py-8">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
      <div className="flex items-center gap-3"><span className="text-sm text-muted-foreground">Room</span><h1 className="font-mono text-xl font-semibold tracking-[.15em]">{room.code}</h1>{room.locked && <LockKeyhole size={17} aria-label="Room locked" />}</div>
      <button className={secondary} onClick={() => act(copyInvite)} disabled={!alive}>{copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}{copied ? "Invite copied" : "Copy invite"}</button>
    </header>
    <div className="grid gap-8 py-7 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <section className="min-w-0" aria-label="Live room">
        <div className="mb-5 flex items-end justify-between gap-4"><div><p className="text-xs uppercase tracking-widest text-muted-foreground">Together, wherever you are</p><h2 className="mt-2 font-display text-3xl">A little moment with everyone.</h2></div><span className="shrink-0 text-sm text-muted-foreground">{members.length}/4 people</span></div>
        {!room.selfRole && alive ? <div className="grid min-h-72 place-content-center rounded-2xl border border-border bg-card p-8 text-center"><Users className="mx-auto mb-4 text-accent" size={32} aria-hidden /><h3 className="font-display text-2xl">Your seat is waiting.</h3><p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">The host will review your request. Your camera stays off while you wait.</p></div> : <>
          <div className="relative overflow-hidden rounded-2xl border border-border bg-[#181818] text-white">
            <video ref={attachVideo} autoPlay playsInline muted aria-label="Your local camera" className="absolute h-px w-px opacity-0" />
            {cameraReady ? <SharedView controller={controller} getVideo={getVideo} paused={livePaused || !previewActive} registerPainter={registerPainter} /> : <div className="grid aspect-[3/2] min-h-60 place-content-center px-8 text-center"><Camera size={32} className="mx-auto mb-4 text-white/60" aria-hidden /><p className="font-display text-2xl">{alive ? "Come into the frame." : room.status === "open" ? "Your room access has ended." : "Your room is closed."}</p><p className="mt-3 max-w-sm text-sm leading-relaxed text-white/65">{alive ? "Turn on your camera when you’re ready to join the live preview." : "The originals already saved on this device stay with you."}</p></div>}
            {countdown !== null && countdown > 0 && <div className="pointer-events-none absolute inset-0 grid place-content-center bg-black/30 text-center"><span className="font-display text-7xl tabular-nums">{countdown}</span><span className="mt-2 text-sm">Get into position</span></div>}
          </div>
          {alive && <div className="mt-4 rounded-xl border border-border p-4"><label className="flex cursor-pointer items-start gap-3"><input type="checkbox" className="mt-1 h-5 w-5 accent-accent" checked={consent} disabled={!room.selfRole} onChange={event => setConsent(event.target.checked)} /><span className="text-sm leading-relaxed"><strong className="block font-semibold">Join with my camera and take shared photos</strong><span className="text-muted-foreground">People admitted to this room can see your video and save your photos. Photos are mirrored like your preview. No microphone is used.</span></span></label></div>}
          {cameraError && <div role="alert" className="mt-4 rounded-xl border border-border p-4 text-sm"><p>Your camera could not start. Check its permission and that another app is not using it.</p><div className="mt-3 flex flex-wrap gap-2"><button className={secondary} onClick={retryCamera}>Retry camera</button><Link className={secondary} href="/booth">Use the solo booth</Link></div></div>}
        </>}
        {edit && alive && (host || edit.story) && <div className="mt-5"><StoryGuide plan={edit.story ?? null} members={members.map(member => ({ id: member.id, name: member.displayName }))} editable={host} disabled={busy || Boolean(edit.template && Object.values(edit.template.requiredSources).some(count => count !== 4))} activeStep={storyProgress?.step} onChange={story => change({ kind: "shared", patch: { story, ...(story && !edit.template && layout?.shots !== 4 ? { layoutId: "quad-story" } : {}) } })} />{edit.story && <p className="mt-2 text-xs text-muted-foreground">There are 15 seconds between story photos. Preview the four prompts together before the host starts.</p>}</div>}
        <p role="status" className="mt-4 text-sm leading-relaxed text-muted-foreground">{snapshot.status}</p>
        {snapshot.pendingLocalFrames.length > 0 && <section role="alert" className="mt-4 rounded-xl border border-accent p-5"><h3 className="font-semibold">{snapshot.pendingLocalFrames.some(frame => !frame.persisted) ? "Keep this tab open. A photo still needs saving." : "Your original is saved. Sharing needs another try."}</h3><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{snapshot.pendingLocalFrames.some(frame => !frame.persisted) ? "Local storage could not save every original. Retry saving or download a recovery copy now. Closing the tab can lose an unsaved photo." : "Your original is saved. Retry to share it with the room."}</p><div className="mt-4 flex flex-wrap gap-3"><button className={primary} disabled={busy} onClick={() => act(() => controller.retryLocalFrames())}>Retry saving originals</button>{snapshot.pendingLocalFrames.map(frame => <button key={frame.id} className={secondary} onClick={() => { const blob = controller.getLocalRecoveryBlob(frame.id); if (blob) downloadProjectBlob(blob, `room-${room.code}-photo-${frame.shotIndex + 1}-recovery.jpg`); }}>Download photo {frame.shotIndex + 1}</button>)}</div>{leaveWarning && <p className="mt-3 text-sm">Save the pending original before leaving this room.</p>}</section>}
        {leaveWarning && (snapshot.busy || snapshot.capturing || snapshot.pendingProposal || postcardBusy) && snapshot.pendingLocalFrames.every(frame => frame.persisted) && <p role="alert" className="mt-3 text-sm">Finish or cancel the current work before leaving.</p>}
        {snapshot.error && <div role="alert" className="mt-4 rounded-xl border border-accent/40 bg-accent/5 p-4 text-sm leading-relaxed"><p>{snapshot.error}</p>{alive && <div className="mt-3 flex flex-wrap gap-2"><button className={secondary} disabled={busy} onClick={() => act(() => controller.reconnect())}><RefreshCw size={15} aria-hidden /> Reconnect</button><button className={secondary} disabled={busy} onClick={() => act(() => controller.retrySave())}>Retry saving design</button></div>}</div>}
        {snapshot.recoveryRecipe && <section aria-label="Choose a recovered design" className="mt-5 rounded-xl border border-accent/40 p-5"><h3 className="font-semibold">The host has a newer design.</h3><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Accept it to keep editing together. Your current version is saved as a separate editable project first. Or leave with your current copy.</p><div className="mt-4 flex flex-wrap gap-3"><button className={primary} disabled={busy} onClick={() => act(() => controller.acceptHost())}>Save my version and accept</button><button className={secondary} disabled={busy} onClick={() => act(openCopy)}>Leave with my copy</button></div></section>}
        {room.selfRole && alive && <div className="mt-6 flex flex-wrap items-center gap-3">
          <button className={primary} disabled={busy || !cameraReady || !recipe || (host && (snapshot.peers.length < 1 || snapshot.peers.some(peer => !peer.connected) || Boolean(round && !complete)))} onClick={() => act(() => controller.capture())}><Camera size={18} aria-hidden />{snapshot.capturing ? "Getting everyone ready…" : host ? round ? "Take another round" : "Get everyone ready" : "Request a photo round"}</button>
          {snapshot.capturing && host && <button className={secondary} onClick={() => act(() => controller.cancelCapture())}>Cancel round</button>}
          {!snapshot.capturing && cameraReady && <button className={secondary} disabled={busy} onClick={() => act(() => controller.reconnect())}><RefreshCw size={15} aria-hidden /> Reconnect</button>}
        </div>}
        {snapshot.captureRequest && host && <p role="status" className="mt-3 text-sm text-accent">{snapshot.captureRequest} would like to take a photo round.</p>}
        {!round && snapshot.draft && recipe && <section className="mt-8 border-t border-border pt-6" aria-label="Shared print preview"><h3 className="font-display text-2xl">Your shared print</h3><p className="mt-2 text-sm text-muted-foreground">Choose a frame before the first round.</p><RoomRoundPreview project={snapshot.draft} fixtureDatabaseName={fixtureProjectDatabaseName} suspendLive={suspendLive} resumeLive={resumeLive} /><button className={`${secondary} mt-5`} disabled={busy || snapshot.capturing || snapshot.pendingProposal} onClick={() => act(openCopy)}>Leave with an editable design</button></section>}
        {round && <section className="mt-8 border-t border-border pt-6" aria-label="Saved round"><h3 className="font-display text-2xl">{complete ? "Every photo, safely together." : "Your round is still arriving."}</h3><p className="mt-2 text-sm text-muted-foreground">{snapshot.savedShots} of {expected || "the expected"} originals saved on this device.</p><ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">{round.participants.map(person => { const count = round.sourceOrder[person.role].filter(Boolean).length; return <li key={person.id} className="rounded-xl border border-border p-3"><span className="font-medium">{room.members.find(member => member.id === person.id)?.displayName ?? `Person ${person.role}`}</span><p className="mt-1 text-xs text-muted-foreground">{count} saved{room.capture ? ` / ${room.capture.shotIds.length}` : ""}</p></li>; })}</ul><RoomRoundPreview project={round} fixtureDatabaseName={fixtureProjectDatabaseName} suspendLive={suspendLive} resumeLive={resumeLive} />{alive && <button className={`${secondary} mt-5`} disabled={busy || snapshot.capturing || !snapshot.cameraConnected} onClick={() => act(() => controller.resumeSavedOriginals())}>Resume sending my saved originals</button>}<button className={`${secondary} mt-5`} disabled={busy || snapshot.capturing || snapshot.pendingLocalFrames.some(frame => !frame.persisted)} onClick={() => act(openCopy)}>{complete ? "Leave with an editable copy" : "Leave with an incomplete copy"}</button>{!complete && host && alive && <button className={`${secondary} mt-3`} disabled={busy || snapshot.capturing || Boolean(snapshot.pendingLocalFrames.length)} onClick={() => act(() => controller.keepIncompleteRoundAndCapture())}>Keep this incomplete round and take another</button>}{!complete && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Missing photos stay empty. Reconnect to resume sharing.</p>}</section>}
        {complete && alive && <RoomPostcard key={`${room.sessionId}:${room.selfId}:${round!.id}:${JSON.stringify(controller.scope)}`} controller={controller} disabled={roomBusy} databaseName={fixtureProjectDatabaseName} onBusyChange={setPostcardBusy} />}
      </section>
      <aside className="min-w-0 space-y-7" aria-label="People and shared design">
        <section className="rounded-2xl border border-border bg-card p-5"><div className="flex items-center justify-between gap-3"><h2 className="font-semibold">Your people</h2>{host && alive && <button className="min-h-11 px-2 text-sm text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50" disabled={busy} onClick={() => act(() => controller.control("lock", !room.locked))}>{room.locked ? "Unlock room" : "Lock room"}</button>}</div><ul className="mt-3 divide-y divide-border">{members.map(member => <li key={member.id} className="flex items-center gap-3 py-3"><span className="grid h-9 w-9 shrink-0 place-content-center rounded-full bg-muted text-sm font-semibold">{member.role}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{member.displayName}{member.id === room.selfId ? " (you)" : ""}</p><p className="text-xs text-muted-foreground">{member.id === room.hostId ? "Host · " : ""}{member.id === room.selfId ? cameraReady ? "Camera ready" : "Camera off" : snapshot.peers.some(peer => peer.id === member.id && peer.connected) ? "Connected" : "Connecting"}</p></div>{host && member.id !== room.selfId && alive && <button className="grid min-h-11 min-w-11 place-items-center rounded-lg p-2 text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Remove ${member.displayName}`} disabled={busy} onClick={() => act(() => controller.control("remove", member.id))}><X size={16} aria-hidden /></button>}</li>)}</ul>{host && pending.length > 0 && <div className="mt-3 border-t border-border pt-4"><h3 className="text-sm font-medium">Asking to join</h3>{pending.map(member => <div key={member.id} className="mt-3 flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 break-words text-sm">{member.displayName}</span><button className={secondary} disabled={busy || members.length >= 4} onClick={() => act(() => controller.control("admit", member.id))}>Admit</button><button className={secondary} disabled={busy} onClick={() => act(() => controller.control("remove", member.id))}>Decline</button></div>)}</div>}</section>
        {edit && alive && <section className="space-y-4 rounded-2xl border border-border p-5" aria-label="Shared finishing"><div><h2 className="font-semibold">Make it yours, together.</h2><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{host ? "Choose the shared frame and scene. Everyone edits their own photos and stickers." : "The host chooses the frame. Edit your own photos and stickers."}</p><p role="status" className="mt-2 text-xs text-muted-foreground">{snapshot.pendingProposal ? "Waiting for the host to confirm your edit…" : "Shared design"}</p></div>
          {host && <><Dropdown showLabel label="Room layout" value={edit.layoutId} disabled={busy} options={roomLayouts.map(item => ({ value: item.id, label: item.name }))} onChange={layoutId => change({ kind: "shared", patch: { layoutId } })} /><Dropdown showLabel label="Shared frame" value={edit.frameId} disabled={busy} options={FRAMES.map(item => ({ value: item.id, label: item.name }))} onChange={frameId => change({ kind: "shared", patch: { frameId } })} /><Dropdown showLabel label="Shared filter" value={edit.filterId} disabled={busy} options={FILTERS.map(item => ({ value: item.id, label: item.name }))} onChange={filterId => change({ kind: "shared", patch: { filterId } })} /><Dropdown showLabel label="Together scene" value={edit.sceneId ?? "none"} disabled={busy} options={[{ value: "none", label: "Original backgrounds" }, ...SCENES.map(item => ({ value: item.id, label: item.name }))]} onChange={sceneId => change({ kind: "shared", patch: { sceneId: sceneId === "none" ? null : sceneId } })} /><form onSubmit={event => { event.preventDefault(); change({ kind: "shared", patch: { caption } }); }}><label className="text-xs font-medium" htmlFor="room-caption">Shared caption</label><input id="room-caption" maxLength={160} placeholder={edit.caption || "Add a little memory…"} value={caption} onChange={event => setCaption(event.target.value)} disabled={busy} className="mt-2 min-h-11 w-full rounded-xl border border-border bg-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring" /><button className={`${secondary} mt-2 w-full`} disabled={busy}>Apply caption</button></form></>}
          {hasEmptyRoles && <p className="text-xs leading-relaxed text-muted-foreground">Empty places belong to people who left. Everyone still in the room keeps their own position.</p>}
          <fieldset disabled={busy} className="space-y-4 border-t border-border pt-4"><legend className="px-1 text-sm font-medium">Your part of the picture</legend>
            {edit.sceneId && <><Range label="Your position" value={place.dx} min={-.5} max={.5} step={.05} onCommit={dx => change({ kind: "placement", role: ownRole, value: { ...place, dx } })} /><Range label="Your size" value={place.scale} min={.5} max={1.6} step={.05} onCommit={scale => change({ kind: "placement", role: ownRole, value: { ...place, scale } })} /></>}
            {!edit.template && <><Dropdown label="Your photo cell" showLabel value={String(cellIndex)} disabled={busy} options={ownCells.map(index => ({ value: String(index), label: `Cell ${index + 1}` }))} onChange={setSelectedCell} /><Range label="Photo zoom" value={cellEdit.zoom} min={1} max={4} step={.1} onCommit={zoom => change({ kind: "cell", role: ownRole, cellIndex, value: { ...cellEdit, zoom } })} /><Range label="Horizontal crop" value={cellEdit.offsetX} min={-1} max={1} step={.1} onCommit={offsetX => change({ kind: "cell", role: ownRole, cellIndex, value: { ...cellEdit, offsetX } })} /><Range label="Vertical crop" value={cellEdit.offsetY} min={-1} max={1} step={.1} onCommit={offsetY => change({ kind: "cell", role: ownRole, cellIndex, value: { ...cellEdit, offsetY } })} /></>}
            <div><p className="text-xs font-medium">Add your sticker</p><div className="mt-2 flex flex-wrap gap-2">{STICKER_PACKS[0].stickers.slice(0, 6).map(sticker => <button key={sticker.slug} type="button" className="grid min-h-11 min-w-11 place-items-center rounded-lg border border-border text-2xl hover:bg-muted" aria-label={`Add ${sticker.slug}`} onClick={() => { const key = Date.now() * 100 + Math.floor(Math.random() * 100); change({ kind: "sticker", role: ownRole, key, value: { key, emoji: sticker.emoji, slug: sticker.slug, x: .2 + members.findIndex(member => member.id === room.selfId) * .2, y: .94, scale: 1, rotation: 0 } }); }}>{sticker.emoji}</button>)}</div></div>
            {edit.stickers.filter(sticker => recipe!.recipe.stickerOwners[String(sticker.key)] === room.selfId).map(sticker => <div key={sticker.key} className="space-y-2 border-t border-border pt-3"><p className="text-sm">Your {sticker.emoji} sticker</p><Range label={`${sticker.emoji} horizontal position`} value={sticker.x} min={0} max={1} step={.05} onCommit={x => change({ kind: "sticker", role: ownRole, key: sticker.key, value: { ...sticker, x } })} /><Range label={`${sticker.emoji} vertical position`} value={sticker.y} min={0} max={1} step={.05} onCommit={y => change({ kind: "sticker", role: ownRole, key: sticker.key, value: { ...sticker, y } })} /><button className={secondary} onClick={() => change({ kind: "sticker", role: ownRole, key: sticker.key, value: null })}>Remove sticker</button></div>)}
          </fieldset>
        </section>}
        <div className="flex flex-wrap gap-3"><Link className={secondary} href="/projects">My saved projects</Link>{host && alive && <button className={`${button} text-muted-foreground hover:bg-muted`} onClick={() => setEndConfirm(true)}>End room</button>}</div>
        {endConfirm && <section className="rounded-xl border border-border p-4" aria-label="Confirm end room"><p className="text-sm leading-relaxed">End this room for everyone? Their saved originals stay on their devices.</p><div className="mt-3 flex gap-2"><button className={primary} disabled={busy} onClick={() => act(async () => { await controller.control("end"); setConsent(false); setEndConfirm(false); })}>End for everyone</button><button className={secondary} onClick={() => setEndConfirm(false)}>Keep open</button></div></section>}
      </aside>
    </div>
  </main>;
}

function Range({ label, value, min, max, step, onCommit }: { label: string; value: number; min: number; max: number; step: number; onCommit(value: number): void }) {
  const [draft, setDraft] = useState<{ source: number; value: number }>({ source: value, value });
  const shown = draft.source === value ? draft.value : value;
  return <label className="block text-xs"><span className="flex justify-between gap-4"><span>{label}</span><span className="tabular-nums text-muted-foreground">{shown.toFixed(2)}</span></span><input type="range" min={min} max={max} step={step} value={shown} className="mt-2 min-h-11 w-full accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" onChange={event => setDraft({ source: value, value: Number(event.target.value) })} onPointerUp={event => onCommit(Number(event.currentTarget.value))} onKeyUp={event => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) onCommit(Number(event.currentTarget.value)); }} /></label>;
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
  const label = paused ? "Live preview paused" : status?.mode === "together" ? "Together preview" : status?.mode === "warming" ? "Preparing Together preview…" : status?.mode === "local-only" ? "Your camera only · waiting for the others" : status?.mode === "waiting" ? "Waiting for camera playback" : "Original camera previews";
  return <><canvas ref={canvas} className="aspect-[3/2] w-full" aria-label={label} /><div className="absolute bottom-3 left-3 right-3 flex flex-wrap items-center justify-between gap-2 text-xs"><span className="rounded-full bg-black/60 px-3 py-1.5">{label}</span>{status?.reason === "slow-segmentation" || status?.reason === "segmentation-unavailable" ? <button className="min-h-11 rounded-full bg-black/70 px-3 py-1.5 underline underline-offset-2" disabled={paused} onClick={() => painterRef.current?.retryTogether()}>Try Together again</button> : null}</div></>;
}
