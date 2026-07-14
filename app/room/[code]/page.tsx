"use client";

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
import { blobToCanvas, canvasToJpeg, captureFrame } from "@/lib/capture";
import { getFilter } from "@/lib/filters";
import { Role, getLayout, layoutsForMembers } from "@/lib/layouts";
import { newPromptSeed, rollPrompts } from "@/lib/prompts";
import { isValidRoomCode } from "@/lib/room-code";
import { LiveScenePainter } from "@/lib/live-preview";
import { SCENES, getScene } from "@/lib/scenes";
import { preloadSegmenter } from "@/lib/segmentation";
import { EMPTY_SHOTS, useBoothSession } from "@/lib/session";
import { playShutter, playTick } from "@/lib/sound";
import { RoomEngine, RoomStatus, ShotPlan } from "@/lib/rtc/engine";

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

/* Pane width: bounded by the column share of the stage and by the height
   budget (rows must fit the stage), keeping each pane at the exact aspect its
   occupant gets on the strip. The --c/--r/--g vars are set per breakpoint on
   the pane grid. */
const PANE_W =
  "w-[min(calc((100%_-_var(--gsm))/var(--csm)),calc(50dvh*var(--pane-ar)/var(--rsm)))] md:w-[min(calc((100%_-_var(--gmd))/var(--cmd)),calc(76dvh*var(--pane-ar)/var(--rmd)))]";

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

function RoomInner() {
  const router = useRouter();
  const params = useParams<{ code: string }>();
  const search = useSearchParams();
  const code = (params.code ?? "").toUpperCase();
  const isHost = search.get("host") === "1";

  const { session, update, setShot } = useBoothSession();
  const { videoRef, attachVideo, ready, error, facing, retry } = useCamera(true);
  const engineRef = useRef<RoomEngine | null>(null);

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
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const painterRef = useRef<LiveScenePainter | null>(null);

  const cancelled = useRef(false);
  const myCaptureTimes = useRef<Record<number, number>>({});
  const receivedCount = useRef(0);
  const sentShots = useRef(0);
  const planRef = useRef<ShotPlan | null>(null);
  const myRoleRef = useRef<Role>(myRole);

  const filter = getFilter(session.filterId);
  const mirror = facing === "user";
  const memberCount = Math.max(memberRoles.length, 1);
  const roomLayouts = layoutsForMembers(memberCount);
  const layoutValid = roomLayouts.some((l) => l.id === session.layoutId);
  const activeLayoutId = layoutValid ? session.layoutId : roomLayouts[0].id;

  // shared scene: applies locally and (optionally) broadcasts to the room
  const applyScene = useCallback(
    (id: string | null, broadcast: boolean) => {
      setRoomScene(id);
      update({ sceneId: id });
      if (broadcast) engineRef.current?.sendScene(id);
      const video = videoRef.current;
      const canvas = previewCanvasRef.current;
      if (!video || !canvas) return;
      const scene = id ? getScene(id) : null;
      if (scene) {
        painterRef.current ??= new LiveScenePainter(video, canvas, facing === "user");
        painterRef.current.start(scene);
      } else {
        painterRef.current?.stop();
      }
    },
    [update, videoRef, facing],
  );

  useEffect(() => {
    return () => painterRef.current?.stop();
  }, []);

  // warm the video-mode segmenter once connected so the preview starts fast
  useEffect(() => {
    if (status === "connected") preloadSegmenter("VIDEO");
  }, [status]);

  const maybeFinish = useCallback(() => {
    const plan = planRef.current;
    if (!plan) return;
    const expectedRemote = plan.shots * Math.max(plan.members.length - 1, 1);
    if (sentShots.current >= plan.shots && receivedCount.current >= expectedRemote) {
      router.push("/customize");
    }
  }, [router]);

  const runPlan = useCallback(
    async (plan: ShotPlan) => {
      const video = videoRef.current;
      if (!video) return;
      planRef.current = plan;
      cancelled.current = false;
      myCaptureTimes.current = {};
      sentShots.current = 0;
      receivedCount.current = 0;
      setShooting(true);
      setShotProgress(0);
      setShotTotal(plan.shots);
      const role = myRoleRef.current;
      update({
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
        const shot = captureFrame(video, mirror);
        playShutter();
        setFlash((f) => f + 1);
        myCaptureTimes.current[i] = capturedAt;
        setShot(role, i, shot);
        setShotProgress(i + 1);
        void canvasToJpeg(shot).then((blob) => {
          void engineRef.current?.sendFrame(i, blob, capturedAt).then(() => {
            sentShots.current++;
            maybeFinish();
          });
        });
      }
      setPrompt(null);
      // don't strand the session if someone's frames never arrive
      setTimeout(() => {
        if (!cancelled.current && planRef.current) router.push("/customize");
      }, FINISH_TIMEOUT_MS);
    },
    [videoRef, mirror, code, update, setShot, router, maybeFinish],
  );

  const runPlanRef = useRef(runPlan);
  const applySceneRef = useRef(applyScene);
  useEffect(() => {
    runPlanRef.current = runPlan;
    applySceneRef.current = applyScene;
  }, [runPlan, applyScene]);

  useEffect(() => {
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
      onArm: (plan) => void runPlanRef.current(plan),
      onRemoteFrame: (role, shot, blob, capturedAtLocal) => {
        void blobToCanvas(blob).then((canvas) => {
          setShot(role, shot, canvas);
          receivedCount.current++;
          const mine = myCaptureTimes.current[shot];
          if (mine !== undefined) {
            const skew = Math.abs(capturedAtLocal - mine);
            setSkewMs(Math.round(skew));
            console.log(`[sync] ${role} shot ${shot} capture skew ${Math.round(skew)}ms`);
          }
          maybeFinish();
        });
      },
      onPeerLeft: (role) => {
        setRemoteStreams((s) => {
          const next = { ...s };
          delete next[role];
          return next;
        });
      },
    });
    engineRef.current = engine;
    return () => {
      cancelled.current = true;
      engine.close();
      engineRef.current = null;
    };
    // engine lives for the lifetime of the room view
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, isHost]);

  // announce once the camera stream exists so offers include our tracks
  const announced = useRef(false);
  useEffect(() => {
    if (ready && !announced.current && videoRef.current?.srcObject) {
      announced.current = true;
      engineRef.current?.start(videoRef.current.srcObject as MediaStream);
    }
  }, [ready, videoRef]);

  const armShoot = () => {
    const engine = engineRef.current;
    if (!engine) return;
    const layout = getLayout(activeLayoutId);
    engine.arm({
      layoutId: layout.id,
      filterId: session.filterId,
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
    "--cmd": colsMd,
    "--rmd": Math.ceil(paneCount / colsMd),
    "--gmd": `${(colsMd - 1) * 12}px`,
  } as React.CSSProperties;

  return (
    <main className="booth-mode flex h-dvh flex-col overflow-hidden bg-background md:flex-row md:items-stretch md:justify-center">
      {/* Stage: local pane + one pane per connected member, each shaped to its
          strip footprint. Width-capped so controls stay beside the panes. */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-4 pt-16 sm:p-6 sm:pt-16 md:max-w-4xl">
        <div className="absolute top-0 z-40 flex w-full items-center justify-between p-4">
          <button
            onClick={() => router.push("/")}
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
      <div className="z-40 flex shrink-0 flex-col gap-3 overflow-y-auto p-4 pb-6 md:w-96 md:justify-center md:gap-5 md:p-6">
        {!shooting && (
          <>
            <div className="scrollbar-hide flex gap-2 overflow-x-auto md:flex-wrap md:overflow-visible">
              {roomLayouts.map((l) => (
                <button
                  key={l.id}
                  onClick={() => update({ layoutId: l.id })}
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
              value={session.filterId}
              onChange={(id) => update({ filterId: id })}
              layoutClass="scrollbar-hide overflow-x-auto md:flex-wrap md:overflow-visible"
            />
            {connected && (
              <div className="scrollbar-hide flex items-center gap-2 overflow-x-auto md:flex-wrap md:overflow-visible">
                <span className="shrink-0 text-xs font-medium text-muted-foreground">
                  Scene
                </span>
                <button
                  onClick={() => applyScene(null, true)}
                  className={`min-h-9 shrink-0 rounded-xl border-2 px-3 text-xs font-medium ${
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
                    className={`h-9 w-14 shrink-0 rounded-xl border-2 ${
                      roomScene === s.id ? "border-accent" : "border-border"
                    }`}
                    style={{ background: s.previewCss }}
                  />
                ))}
              </div>
            )}
            <button
              onClick={armShoot}
              disabled={!connected || !ready}
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
            Smile together: perfectly in sync
          </p>
        )}
      </div>
    </main>
  );
}

export default function RoomPage() {
  return (
    <Suspense fallback={null}>
      <RoomInner />
    </Suspense>
  );
}
