"use client";

import { useAppNavigationGuard } from "@/components/AppNavigation";

import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Check, Copy, Heart } from "lucide-react";
import { CameraPreview } from "@/components/CameraPreview";
import { Countdown, CaptureFlash } from "@/components/Countdown";
import { FilterBar } from "@/components/FilterBar";
import { useCamera } from "@/hooks/useCamera";
import { useCuratedAssets } from "@/hooks/useCuratedAssets";
import { getCuratedAsset } from "@/lib/assets/registry";
import { canvasToJpeg, captureFrame } from "@/lib/capture";
import { getFilter } from "@/lib/filters";
import { Role, getLayout, layoutsForMembers } from "@/lib/layouts";
import { newPromptSeed, rollPrompts } from "@/lib/prompts";
import { isValidRoomCode } from "@/lib/room-code";
import { LiveScenePainter } from "@/lib/live-preview";
import { SCENES, getScene } from "@/lib/scenes";
import { preloadSegmenter } from "@/lib/segmentation";
import { EMPTY_SHOTS, useBoothSession } from "@/lib/session";
import { CaptureFeedbackSettings } from "@/components/CaptureFeedbackSettings";
import { playShutter, playTick } from "@/lib/sound";
import { RoomEngine, RoomStatus, ShotPlan } from "@/lib/rtc/engine";
import { RESOURCE_LIMITS } from "@/lib/projects/resource-bounds";
import { useAuth } from "@/lib/auth";

const COUNTDOWN_MS = 3000;
const INTERVAL_MS = 4600;
const LEAD_IN_MS = 2500;
const FINISH_TIMEOUT_MS = 15000;

const ROLE_COLORS: Record<Role, string> = {
  A: "bg-accent/85 text-accent-foreground",
  B: "bg-partner/85 text-white",
  C: "bg-info/85 text-white",
  D: "bg-success/85 text-white",
};

// Fit the strip-shaped panes inside the stage space left by the controls.
const PANE_W =
  "min-h-0 min-w-0 shrink-0 w-[min(calc((100%_-_var(--gsm))/var(--csm)),calc((100cqh_-_var(--vsm))*var(--pane-ar)/var(--rsm)))] md:w-[min(calc((100%_-_var(--gmd))/var(--cmd)),calc((100cqh_-_var(--vmd))*var(--pane-ar)/var(--rmd)))]";

function RemotePane({
  role,
  stream,
  filterCss,
  label,
  halfCell,
  paneStyle,
}: {
  role: Role;
  stream: MediaStream;
  filterCss: string;
  label: string;
  halfCell: boolean;
  paneStyle: React.CSSProperties;
}) {
  const attach = useCallback(
    (el: HTMLVideoElement | null) => {
      if (el && el.srcObject !== stream) {
        el.srcObject = stream;
        void el.play().catch(() => {});
      }
    },
    [stream],
  );
  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-border/40 bg-black ${PANE_W}`}
      style={paneStyle}
    >
      <video
        ref={attach}
        autoPlay
        playsInline
        muted
        className={`object-cover ${
          halfCell ? "absolute inset-y-0 left-1/2 h-full w-[200%] max-w-none" : "h-full w-full"
        }`}
        style={{
          transform: halfCell ? "translateX(-50%) scaleX(-1)" : "scaleX(-1)",
          filter: filterCss !== "none" ? filterCss : undefined,
        }}
      />
      <span
        className={`absolute bottom-2 left-3 z-10 rounded-full px-3 py-1 text-xs font-semibold ${ROLE_COLORS[role]}`}
      >
        {label}
      </span>
    </div>
  );
}

export interface LegacyRoomRehearsal {
  code: string;
  isHost: boolean;
  camera: ReturnType<typeof useCamera>;
  session: Pick<ReturnType<typeof useBoothSession>, "update" | "setShot" | "importShot" | "hydrating">;
  navigation: { push(path: string): void; replace(path: string): void };
  onEngine(engine: RoomEngine): void;
}

function RoomInner({ rehearsal }: { rehearsal?: LegacyRoomRehearsal }) {
  const nativeRouter = useRouter(), router = rehearsal?.navigation ?? nativeRouter;
  const params = useParams<{ code: string }>();
  const search = useSearchParams();
  const code = rehearsal?.code ?? (params.code ?? "").toUpperCase();
  const isHost = rehearsal?.isHost ?? search.get("host") === "1";

  const nativeSession = useBoothSession();
  const { update, setShot, importShot, hydrating } = rehearsal?.session ?? nativeSession;
  const { user } = useAuth();
  const ownerId = rehearsal ? null : user?.id ?? null;
  const [accountChanged, setAccountChanged] = useState(false);
  const nativeCamera = useCamera(!rehearsal && !accountChanged);
  const { videoRef, attachVideo, ready, error, facing, retry } = rehearsal?.camera ?? nativeCamera;
  const engineRef = useRef<RoomEngine | null>(null);
  const announced = useRef(false);

  const [status, setStatus] = useState<RoomStatus>("connecting");
  const [myRole, setMyRole] = useState<Role>(isHost ? "A" : "B");
  const [memberRoles, setMemberRoles] = useState<Role[]>([]);
  const [remoteStreams, setRemoteStreams] = useState<Partial<Record<Role, MediaStream>>>({});
  const [copied, setCopied] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [flash, setFlash] = useState(0);
  const [shooting, setShooting] = useState(false);
  const [shotProgress, setShotProgress] = useState(0);
  const [shotTotal, setShotTotal] = useState(4);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [skewMs, setSkewMs] = useState<number | null>(null);
  const [roomScene, setRoomScene] = useState<string | null>(null);
  const curated = useCuratedAssets(roomScene, null);
  const sceneReadiness = useRef({ id: roomScene, loading: curated.loading, available: false });
  const [roundSceneFallback, setRoundSceneFallback] = useState(false);
  useEffect(() => { sceneReadiness.current = { id: roomScene, loading: curated.loading, available: Boolean(roomScene && curated.resources.has(roomScene)) }; }, [roomScene, curated.loading, curated.resources]);
  const [roomLayoutId, setRoomLayoutId] = useState("duo-alternate");
  const [roomFilterId, setRoomFilterId] = useState("none");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingFrames, setPendingFrames] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const painterRef = useRef<LiveScenePainter | null>(null);

  const cancelled = useRef(false);
  const myCaptureTimes = useRef<Record<number, number>>({});
  const receivedCount = useRef(0);
  const sentShots = useRef(0);
  const planRef = useRef<ShotPlan | null>(null);
  const myRoleRef = useRef<Role>(myRole);
  const planReady = useRef<Promise<void> | null>(null);
  const finishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localFrames = useRef(new Map<number, { role: Role; canvas: HTMLCanvasElement; capturedAt: number; saved: boolean }>());
  const remoteFrames = useRef(new Map<string, { role: Role; shot: number; blob: Blob; capturedAt: number }>());
  const savedLocal = useRef(new Set<number>());
  const savedRemote = useRef(new Set<string>());
  const sentLocal = useRef(new Set<number>());
  const savingFrames = useRef(new Set<string>());
  const retryLock = useRef(false);
  const captureOwner = useRef<string | null>(ownerId);
  const captureRole = useRef<Role | null>(null);

  useEffect(() => {
    if (captureOwner.current === ownerId) return;
    captureOwner.current = ownerId;
    if (!planRef.current) return;
    cancelled.current = true;
    engineRef.current?.close();
    painterRef.current?.stop();
    localFrames.current.clear(); remoteFrames.current.clear();
    if (finishTimer.current) clearTimeout(finishTimer.current);
    queueMicrotask(() => {
      setAccountChanged(true); setPendingFrames(0); setIncomplete(false); setCount(null);
      setSaveError("The active account changed. This round has stopped; return home before starting another room.");
    });
  }, [ownerId]);

  const canLeave = () => {
    const unsaved = [...localFrames.current.values()].some(frame => !frame.saved) || remoteFrames.current.size > 0;
    const capturing = shooting && !incomplete && savedLocal.current.size < shotTotal;
    if (capturing || unsaved || retrying) {
      setSaveError("Finish the round and save pending originals before leaving.");
      return false;
    }
    return true;
  };
  useAppNavigationGuard(canLeave, !rehearsal);

  const filter = getFilter(roomFilterId);
  const mirror = facing === "user";
  const memberCount = Math.max(memberRoles.length, 1);
  const roomLayouts = layoutsForMembers(memberCount);
  const layoutValid = roomLayouts.some((l) => l.id === roomLayoutId);
  const activeLayoutId = layoutValid ? roomLayoutId : roomLayouts[0].id;

  // shared scene: applies locally and (optionally) broadcasts to the room
  const applyScene = useCallback(
    (id: string | null, broadcast: boolean) => {
      if (planRef.current) return;
      setRoomScene(id);
      if (broadcast) engineRef.current?.sendScene(id);
    },
    [],
  );

  useEffect(() => {
    const scene = roomScene ? getScene(roomScene) : null, video = videoRef.current, canvas = previewCanvasRef.current;
    if (!scene || !video || !canvas || !ready || accountChanged) return;
    const painter = new LiveScenePainter(video, canvas, mirror);
    painterRef.current = painter;
    painter.start(scene, !roundSceneFallback && scene.assetId ? curated.resources.get(scene.assetId) ?? null : null);
    return () => { painter.stop(); if (painterRef.current === painter) painterRef.current = null; };
  }, [roomScene, curated.resources, ready, mirror, accountChanged, roundSceneFallback, videoRef]);

  // warm the video-mode segmenter once connected so the preview starts fast
  useEffect(() => {
    if (status === "connected" && !rehearsal) preloadSegmenter("VIDEO");
  }, [status, rehearsal]);

  const maybeFinish = useCallback(() => {
    const plan = planRef.current;
    if (!plan || cancelled.current) return;
    const expectedRemote = plan.shots * Math.max(plan.members.length - 1, 0);
    if (sentShots.current >= plan.shots && receivedCount.current >= expectedRemote && !localFrames.current.size && !remoteFrames.current.size) {
      if (finishTimer.current) clearTimeout(finishTimer.current);
      router.push("/customize");
    }
  }, [router]);

  const reportFailure = useCallback((error: unknown) => {
    if (!cancelled.current) setSaveError(error instanceof Error ? error.message : "A photo could not be saved. Keep this page open and retry.");
  }, []);
  const updatePending = useCallback(() => {
    if (!cancelled.current) setPendingFrames(localFrames.current.size + remoteFrames.current.size);
  }, []);
  const saveLocalFrame = useCallback(async (shot: number) => {
    const entry = localFrames.current.get(shot), key = `local:${shot}`;
    if (!entry || savingFrames.current.has(key) || cancelled.current) return;
    savingFrames.current.add(key);
    try {
      await planReady.current;
      if (cancelled.current) return;
      if (!entry.saved) {
        await setShot(entry.role, shot, entry.canvas);
        if (cancelled.current) return;
        entry.saved = true;
        savedLocal.current.add(shot);
        setShotProgress(savedLocal.current.size);
      }
      if (!sentLocal.current.has(shot)) {
        const blob = await canvasToJpeg(entry.canvas);
        const engine = engineRef.current;
        if (cancelled.current) return;
        if (!engine) throw new Error("The room connection closed before this photo was sent");
        await engine.sendFrame(shot, blob, entry.capturedAt);
        if (cancelled.current) return;
        sentLocal.current.add(shot);
        sentShots.current = sentLocal.current.size;
      }
      localFrames.current.delete(shot);
      updatePending(); maybeFinish();
    } finally { savingFrames.current.delete(key); }
  }, [maybeFinish, setShot, updatePending]);
  const saveRemoteFrame = useCallback(async (key: string) => {
    const entry = remoteFrames.current.get(key);
    if (!entry || savingFrames.current.has(key) || savedRemote.current.has(key) || cancelled.current) return;
    savingFrames.current.add(key);
    try {
      await planReady.current;
      if (cancelled.current) return;
      await importShot(entry.role, entry.shot, entry.blob);
      if (cancelled.current) return;
      savedRemote.current.add(key);
      receivedCount.current = savedRemote.current.size;
      remoteFrames.current.delete(key);
      const mine = myCaptureTimes.current[entry.shot];
      if (mine !== undefined) setSkewMs(Math.round(Math.abs(entry.capturedAt - mine)));
      updatePending(); maybeFinish();
    } finally { savingFrames.current.delete(key); }
  }, [importShot, maybeFinish, updatePending]);

  const retryFrames = async () => {
    if (retryLock.current) return;
    retryLock.current = true; setRetrying(true); setSaveError(null);
    try {
      for (const shot of localFrames.current.keys()) await saveLocalFrame(shot);
      for (const key of remoteFrames.current.keys()) await saveRemoteFrame(key);
      maybeFinish();
    } catch (error) { reportFailure(error); }
    finally { retryLock.current = false; if (!cancelled.current) setRetrying(false); }
  };

  const runPlan = useCallback(
    async (plan: ShotPlan) => {
      const video = videoRef.current;
      if (!video || planRef.current) return;
      if (!Number.isInteger(plan.shots) || plan.shots < 1 || plan.shots > 4 || getLayout(plan.layoutId).shots !== plan.shots || !Array.isArray(plan.members) || plan.members.length < 2 || plan.members.length > 4 || new Set(plan.members).size !== plan.members.length) {
        reportFailure(new Error("This room sent an unsupported capture plan")); return;
      }
      applyScene(plan.sceneId, false);
      setRoundSceneFallback(Boolean(plan.sceneId && getCuratedAsset(plan.sceneId) && (sceneReadiness.current.id !== plan.sceneId || sceneReadiness.current.loading || !sceneReadiness.current.available)));
      planRef.current = plan;
      cancelled.current = false;
      myCaptureTimes.current = {};
      sentShots.current = 0;
      receivedCount.current = 0;
      savedLocal.current.clear(); savedRemote.current.clear(); sentLocal.current.clear();
      localFrames.current.clear(); remoteFrames.current.clear(); savingFrames.current.clear();
      setSaveError(null); setPendingFrames(0); setIncomplete(false);
      setRoomLayoutId(plan.layoutId); setRoomFilterId(plan.filterId); setRoomScene(plan.sceneId);
      setShooting(true);
      setShotProgress(0);
      setShotTotal(plan.shots);
      const role = myRoleRef.current;
      captureRole.current = role;
      planReady.current = update({
        mode: plan.members.length > 2 ? "group" : "duo",
        role,
        layoutId: plan.layoutId,
        filterId: plan.filterId,
        promptSeed: plan.seed,
        roomCode: code,
        shots: EMPTY_SHOTS,
        members: plan.members,
        sceneId: plan.sceneId,
      });
      try { await planReady.current; }
      catch (error) { reportFailure(error); planRef.current = null; setShooting(false); return; }
      if (cancelled.current) return;
      const prompts = rollPrompts(
        plan.members.length > 2 ? "group" : "couple",
        plan.shots,
        plan.seed,
      );

      for (let i = 0; i < plan.shots; i++) {
        const fireAt = plan.t0 + i * plan.intervalMs;
        setPrompt(prompts[i]);
        let lastTick = -1;
        while (Date.now() < fireAt) {
          if (cancelled.current) return;
          const remaining = fireAt - Date.now();
          if (remaining <= COUNTDOWN_MS) {
            const tick = Math.max(1, Math.ceil(remaining / 1000));
            if (tick !== lastTick) {
              setCount(tick);
              playTick();
              lastTick = tick;
            }
          }
          await new Promise((r) => setTimeout(r, 40));
        }
        setCount(null);
        if (cancelled.current) return;
        const capturedAt = Date.now();
        if (!video.videoWidth || !video.videoHeight || video.videoWidth > RESOURCE_LIMITS.photoEdge || video.videoHeight > RESOURCE_LIMITS.photoEdge || video.videoWidth * video.videoHeight > RESOURCE_LIMITS.photoPixels) {
          reportFailure(new Error("This camera's image size exceeds the project limit. Your saved photos are safe."));
          setIncomplete(true); return;
        }
        let shot: HTMLCanvasElement;
        try { shot = captureFrame(video, mirror); }
        catch (error) { reportFailure(error); setIncomplete(true); return; }
        playShutter();
        setFlash((f) => f + 1);
        myCaptureTimes.current[i] = capturedAt;
        localFrames.current.set(i, { role, canvas: shot, capturedAt, saved: false });
        updatePending();
        try { await saveLocalFrame(i); } catch (error) { reportFailure(error); }
      }
      setPrompt(null);
      finishTimer.current = setTimeout(() => {
        if (!cancelled.current && planRef.current) {
          setIncomplete(true);
          setSaveError("Some photos are still missing or waiting to save. Keep this page open to retry, or open only the photos already saved.");
        }
      }, FINISH_TIMEOUT_MS);
    },
    [videoRef, mirror, code, update, reportFailure, saveLocalFrame, updatePending, applyScene],
  );

  const runPlanRef = useRef(runPlan);
  const applySceneRef = useRef(applyScene);
  const saveRemoteFrameRef = useRef(saveRemoteFrame);
  useEffect(() => {
    runPlanRef.current = runPlan;
    applySceneRef.current = applyScene;
    saveRemoteFrameRef.current = saveRemoteFrame;
  }, [runPlan, applyScene, saveRemoteFrame]);

  useEffect(() => {
    const pendingLocal = localFrames.current, pendingRemote = remoteFrames.current;
    cancelled.current = false;
    if (!isValidRoomCode(code)) {
      router.replace("/");
      return;
    }
    const engine = new RoomEngine(code, isHost, {
      onStatus: setStatus,
      onRoster: (members, selfRole) => {
        setMyRole(selfRole);
        myRoleRef.current = selfRole;
        setMemberRoles(members.map((m) => m.role));
      },
      onRemoteStream: (role, stream) => {
        setRemoteStreams((s) => ({ ...s, [role]: stream }));
      },
      onScene: (id) => applySceneRef.current(id, false),
      onArm: (plan) => void runPlanRef.current(plan).catch(reportFailure),
      onRemoteFrame: (role, shot, blob, capturedAtLocal) => {
        const plan = planRef.current, key = `${role}:${shot}`;
        if (!plan || cancelled.current || role === captureRole.current || !plan.members.includes(role) || !Number.isInteger(shot) || shot < 0 || shot >= plan.shots || savedRemote.current.has(key) || remoteFrames.current.has(key)) return;
        const retainedBytes = [...remoteFrames.current.values()].reduce((sum, entry) => sum + entry.blob.size, 0);
        if (blob.size > RESOURCE_LIMITS.photoBytes || remoteFrames.current.size >= 12 || retainedBytes + blob.size > RESOURCE_LIMITS.totalEncodedBytes) {
          reportFailure(new Error("Incoming photos exceed the local capture budget. Previously saved photos are safe.")); return;
        }
        remoteFrames.current.set(key, { role, shot, blob, capturedAt: capturedAtLocal });
        updatePending();
        void saveRemoteFrameRef.current(key).catch(reportFailure);
      },
      onPeerLeft: (role) => {
        setRemoteStreams((s) => {
          const next = { ...s };
          delete next[role];
          return next;
        });
      },
    }, Boolean(rehearsal));
    engineRef.current = engine;
    rehearsal?.onEngine(engine);
    return () => {
      cancelled.current = true;
      if (finishTimer.current) clearTimeout(finishTimer.current);
      pendingLocal.clear(); pendingRemote.clear();
      engine.close();
      engineRef.current = null;
      announced.current = false;
    };
    // engine lives for the lifetime of the room view
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, isHost]);

  // announce once the camera stream exists so offers include our tracks
  useEffect(() => {
    if (ready && !announced.current && videoRef.current?.srcObject) {
      announced.current = true;
      engineRef.current?.start(videoRef.current.srcObject as MediaStream);
    }
  }, [ready, videoRef]);

  const armShoot = () => {
    if (curated.loading) return;
    const engine = engineRef.current;
    if (!engine) return;
    const layout = getLayout(activeLayoutId);
    engine.arm({
      layoutId: layout.id,
      filterId: roomFilterId,
      seed: newPromptSeed(),
      t0: Date.now() + LEAD_IN_MS + COUNTDOWN_MS,
      intervalMs: INTERVAL_MS,
      shots: layout.shots,
      sceneId: roomScene,
      members: engine.memberRoles,
    });
  };

  const copyInvite = async () => {
    await navigator.clipboard.writeText(`${location.origin}/room/${code}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const connected = status === "connected";
  const remotes = (Object.entries(remoteStreams) as [Role, MediaStream][]).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  const activeLayout = getLayout(activeLayoutId);

  // Pane geometry mirrors the strip: split cells give each person half a cell
  // (portrait), everything else a full cell. A Together scene fills the whole
  // cell regardless, so the split preview is suspended while one is active.
  const isSplit = !roomScene && !!activeLayout.duoPattern?.includes("AB");
  const paneAr = isSplit ? activeLayout.cellAspect / 2 : activeLayout.cellAspect;
  const paneCount = 1 + Math.max(remotes.length, 1);
  const colsSm = isSplit || paneCount >= 3 ? 2 : 1;
  const colsMd = Math.min(paneCount, 2);
  const paneVars = {
    "--pane-ar": paneAr,
    "--csm": colsSm,
    "--rsm": Math.ceil(paneCount / colsSm),
    "--gsm": `${(colsSm - 1) * 12}px`,
    "--vsm": `${(Math.ceil(paneCount / colsSm) - 1) * 12}px`,
    "--cmd": colsMd,
    "--rmd": Math.ceil(paneCount / colsMd),
    "--gmd": `${(colsMd - 1) * 12}px`,
    "--vmd": `${(Math.ceil(paneCount / colsMd) - 1) * 12}px`,
  } as React.CSSProperties;

  return (
    <main className="booth-mode flex h-[calc(100dvh-var(--app-nav-height,0px)-var(--app-bottom-nav-height,0px))] flex-col overflow-hidden bg-background md:flex-row md:items-stretch md:justify-center">
      {/* Stage: local pane + one pane per connected member, each shaped to its
          strip footprint. Width-capped so controls stay beside the panes. */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4 pt-16 [container-type:size] sm:p-6 sm:pt-16 md:max-w-4xl">
        <div className="absolute top-0 z-40 flex w-full items-center justify-between p-4">
          <button
            onClick={() => { if (canLeave()) { cancelled.current = true; router.push("/"); } }}
            aria-label="Leave room"
            className="glass-card flex h-11 w-11 items-center justify-center rounded-full"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="glass-card flex min-h-11 items-center gap-2 rounded-full px-4 font-mono text-sm tracking-[0.25em]">
            {code}
            {memberRoles.length > 1 && (
              <span className="font-sans text-xs tracking-normal text-muted-foreground">
                {memberRoles.length}/4
              </span>
            )}
          </div>
        </div>

        <div
          className="flex w-full flex-wrap items-center justify-center gap-3"
          style={paneVars}
        >
          <div
            className={`relative overflow-hidden rounded-xl border border-accent/50 bg-black ${PANE_W}`}
            style={{ aspectRatio: paneAr }}
          >
            {error ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
                <p>Camera unavailable. Allow access to join the booth.</p>
                <button
                  onClick={retry}
                  className="glass-card min-h-11 rounded-full px-4 font-medium text-foreground"
                >
                  Try again
                </button>
              </div>
            ) : (
              <CameraPreview
                videoRef={attachVideo}
                mirror={mirror}
                filterCss={filter.css}
                variant={isSplit ? "half-cell" : "cover"}
              />
            )}
            <canvas
              ref={previewCanvasRef}
              className={`pointer-events-none absolute inset-0 h-full w-full object-cover ${
                roomScene ? "" : "hidden"
              }`}
              style={{ filter: filter.css !== "none" ? filter.css : undefined }}
            />
            <span
              className={`absolute bottom-2 left-3 z-10 rounded-full px-3 py-1 text-xs font-semibold ${ROLE_COLORS[myRole]}`}
            >
              You
            </span>
          </div>

          {remotes.map(([role, stream]) => (
            <RemotePane
              key={role}
              role={role}
              stream={stream}
              filterCss={filter.css}
              label={memberRoles.length > 2 ? `Friend ${role}` : "Partner"}
              halfCell={isSplit}
              paneStyle={{ aspectRatio: paneAr }}
            />
          ))}

          {remotes.length === 0 && (
            <div
              className={`relative flex flex-col items-center justify-center gap-3 rounded-xl border border-border/40 bg-card/60 px-6 text-center ${PANE_W}`}
              style={{ aspectRatio: paneAr }}
            >
              <Heart className="text-partner" size={28} />
              {status === "waiting" || status === "connecting" ? (
                <>
                  <p className="font-semibold">Waiting for the others…</p>
                  <button
                    onClick={copyInvite}
                    className="glass-card flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-medium"
                  >
                    {copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
                    {copied ? "Link copied!" : "Copy invite link"}
                  </button>
                </>
              ) : status === "full" ? (
                <p className="font-semibold">This booth is already full (4 max).</p>
              ) : status === "failed" ? (
                <p className="font-semibold">
                  Connection failed. This network may need a TURN relay.
                </p>
              ) : (
                <p className="font-semibold">Everyone left the room.</p>
              )}
            </div>
          )}
        </div>

        <Countdown value={count} />
        <CaptureFlash trigger={flash} />

        {prompt && (
          <div className="pointer-events-none absolute top-16 left-1/2 z-20 w-max max-w-[85%] -translate-x-1/2">
            <div className="glass-card rounded-2xl px-5 py-2.5 text-center font-semibold shadow-lg">
              {prompt}
            </div>
          </div>
        )}

        {shooting && (
          <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 gap-2">
            {Array.from({ length: shotTotal }, (_, i) => (
              <div
                key={i}
                className={`h-2 w-6 rounded-full transition ${
                  i < shotProgress ? "bg-accent" : "bg-white/25"
                }`}
              />
            ))}
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="z-40 flex shrink-0 flex-col gap-3 overflow-y-auto p-4 pb-6 md:w-96 md:[justify-content:safe_center] md:gap-5 md:p-6">
        {!shooting && (
          <>
            <div className="scrollbar-hide flex gap-2 overflow-x-auto md:flex-wrap md:overflow-visible">
              {roomLayouts.map((l) => (
                <button
                  key={l.id}
                  onClick={() => setRoomLayoutId(l.id)}
                  className={`min-h-11 shrink-0 rounded-full px-4 text-sm font-medium transition ${
                    activeLayoutId === l.id
                      ? "bg-foreground text-background"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {l.name}
                </button>
              ))}
            </div>
            <FilterBar
              value={roomFilterId}
              onChange={setRoomFilterId}
              layoutClass="scrollbar-hide overflow-x-auto md:flex-wrap md:overflow-visible"
            />
            {connected && (
              <div className="scrollbar-hide flex items-center gap-2 overflow-x-auto md:flex-wrap md:overflow-visible">
                <span className="shrink-0 text-xs font-medium text-muted-foreground">
                  Scene
                </span>
                <button
                  onClick={() => applyScene(null, true)}
                  className={`min-h-11 shrink-0 rounded-xl border-2 px-3 text-xs font-medium ${
                    roomScene === null ? "border-accent" : "border-border"
                  }`}
                >
                  None
                </button>
                {SCENES.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => applyScene(s.id, true)}
                    title={s.name}
                    aria-label={s.name}
                    className={`h-11 w-16 shrink-0 overflow-hidden rounded-xl border-2 ${
                      roomScene === s.id ? "border-accent" : "border-border"
                    }`}
                    style={{ background: s.previewCss }}
                  >
                    {/* Curated thumbnails use validated local delivery paths. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {s.assetId && <img src={getCuratedAsset(s.assetId)!.thumbnail.path} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" onError={event => { event.currentTarget.hidden = true; }} />}
                  </button>
                ))}
              </div>
            )}
            <CaptureFeedbackSettings disabled={shooting} />
            <button
              onClick={armShoot}
              disabled={!connected || !ready || hydrating || curated.loading}
              aria-label="Start shooting together"
              className="mx-auto mt-1 flex h-20 w-20 shrink-0 items-center justify-center rounded-full border-4 border-white/80 bg-accent shadow-lg shadow-accent/40 transition active:scale-95 disabled:opacity-40"
            >
              <span className="h-14 w-14 rounded-full bg-white/90" />
            </button>
            {connected && (
              <p className="text-center text-xs text-muted-foreground">
                Anyone can press the shutter; the countdown fires on every screen
                at once. {activeLayout.shots} shots.
                {skewMs !== null && ` Last sync: ${skewMs}ms apart.`}
              </p>
            )}
          </>
        )}
        {shooting && (
          <p className="text-center text-sm text-muted-foreground">
            {accountChanged ? "Round stopped." : <>{shotProgress} of {shotTotal} local photos saved. {pendingFrames > 0 ? `${pendingFrames} photos waiting to save or send.` : "Waiting for everyone's saved photos."}</>}
          </p>
        )}
        {curated.loading && !roundSceneFallback && <p role="status" className="text-center text-sm text-muted-foreground">Loading the selected backdrop before capture…</p>}
        {(roundSceneFallback || curated.fallback.length > 0) && <p role="status" className="text-center text-sm text-muted-foreground">This round’s live preview uses a built-in fallback. Your saved photos can use the image backdrop when it is available.</p>}
        {saveError && <div role="alert" className="rounded-xl border border-destructive p-3 text-sm">
          <p>{saveError}</p>
          {pendingFrames > 0 && <><p className="mt-2">Unsaved photos are still on this page. Retry before leaving.</p><button disabled={retrying} onClick={() => void retryFrames()} className="mt-2 min-h-11 rounded-lg bg-foreground px-4 text-background">{retrying ? "Retrying…" : "Retry saving and sending photos"}</button></>}
          {incomplete && pendingFrames === 0 && <button onClick={() => { cancelled.current = true; router.push("/customize"); }} className="mt-2 min-h-11 px-2 font-medium underline underline-offset-4">Open saved shots (incomplete)</button>}
        </div>}
      </div>
    </main>
  );
}

export default function RoomPage({ rehearsal }: { rehearsal?: LegacyRoomRehearsal }) {
  if (rehearsal && process.env.NODE_ENV !== "development") throw new Error("Room rehearsal requires development");
  return (
    <Suspense fallback={null}>
      <RoomInner rehearsal={rehearsal} />
    </Suspense>
  );
}
