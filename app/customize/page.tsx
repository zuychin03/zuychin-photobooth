"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  Heart,
  RotateCcw,
  RotateCw,
  Share2,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { FilterBar } from "@/components/FilterBar";
import {
  ALL_STICKER_SLUGS,
  FRAMES,
  STICKER_PACKS,
  STICKER_STYLES,
  StickerDef,
  StickerStyle,
  monochromeGlyph,
  stickerAssetUrl,
} from "@/lib/decor";
import { ensureNotoFont, preloadStickers } from "@/lib/sticker-assets";
import { SCENES } from "@/lib/scenes";
import { cutout, preloadSegmenter } from "@/lib/segmentation";
import {
  ComposeInput,
  DEFAULT_PLACEMENT,
  ShotSet,
  StickerInstance,
  TogetherPlacement,
  composeStrip,
  stripToBlob,
} from "@/lib/compose";
import { ROLES, Role, getLayout, stripSize } from "@/lib/layouts";
import { useBoothSession } from "@/lib/session";
import { useAuth } from "@/lib/auth";
import { TimelineStrip, deleteStrip, getMyCouple, listStrips, saveStrip } from "@/lib/couple";
import { WEEKLY_STRIP_CAP } from "@/lib/retention";
import { sameIsoWeek } from "@/lib/streak";

const STICKER_HIT_RADIUS = 60;

export default function CustomizePage() {
  const router = useRouter();
  const { session, update } = useBoothSession();
  const { user, enabled: authEnabled } = useAuth();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [frameId, setFrameId] = useState("film");
  const [caption, setCaption] = useState("");
  const [showDate, setShowDate] = useState(true);
  const [stickers, setStickers] = useState<StickerInstance[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [pack, setPack] = useState(STICKER_PACKS[0].id);
  const [stickerStyle, setStickerStyle] = useState<StickerStyle>("flat");
  const [assetsTick, setAssetsTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [cutouts, setCutouts] = useState<ShotSet | null>(null);
  const [segmenting, setSegmenting] = useState(false);
  const [segFailed, setSegFailed] = useState(false);
  const [places, setPlaces] = useState<Partial<Record<Role, TogetherPlacement>>>({});
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  // This week's strips offered for discard when the vault is at its weekly cap.
  const [capChoices, setCapChoices] = useState<TimelineStrip[] | null>(null);
  const dragRef = useRef<{ key: number; dx: number; dy: number } | null>(null);
  const nextKey = useRef(1);

  const layout = getLayout(session.layoutId);
  const frame = FRAMES.find((f) => f.id === frameId) ?? FRAMES[0];
  const hasShots = ROLES.some((r) => session.shots[r].some(Boolean));
  const { width: stripW, height: stripH } = stripSize(layout);

  const input: ComposeInput = useMemo(
    () => ({
      layout,
      shots: session.shots,
      style: {
        frameColor: frame.color,
        inkColor: frame.ink,
        filterId: session.filterId,
        caption,
        showDate,
        stickerStyle,
      },
      stickers,
      cutouts: cutouts ?? undefined,
      together: sceneId ? { sceneId, places } : null,
    }),
    [layout, session.shots, session.filterId, frame, caption, showDate, stickers, stickerStyle, cutouts, sceneId, places],
  );

  const isShared = session.mode === "duo" || session.mode === "group";

  // warm the segmenter for shared sessions so picking a scene is fast
  useEffect(() => {
    if (isShared) preloadSegmenter();
  }, [isShared]);

  const autoSceneApplied = useRef(false);
  const selectScene = useCallback(async (id: string | null) => {
    setSceneId(id);
    setSegFailed(false);
    if (!id || cutouts || segmenting) return;
    setSegmenting(true);
    try {
      const segSide = (arr: (HTMLCanvasElement | null)[]) =>
        Promise.all(arr.map((s) => (s ? cutout(s) : Promise.resolve(null))));
      const [A, B, C, D] = await Promise.all(
        ROLES.map((r) => segSide(session.shots[r])),
      );
      setCutouts({ A, B, C, D });
    } catch {
      setSegFailed(true);
      setSceneId(null);
    } finally {
      setSegmenting(false);
    }
  }, [cutouts, segmenting, session.shots]);

  // scene agreed in the room applies automatically on arrival
  useEffect(() => {
    if (!autoSceneApplied.current && isShared && session.sceneId && hasShots) {
      autoSceneApplied.current = true;
      void selectScene(session.sceneId);
    }
  }, [isShared, session.sceneId, hasShots, selectScene]);

  // canvas composition needs the style's assets ready; re-render when they land
  useEffect(() => {
    if (stickerStyle === "noto") {
      const family = getComputedStyle(document.documentElement)
        .getPropertyValue("--font-noto-emoji")
        .trim();
      void ensureNotoFont(family).then(() => setAssetsTick((t) => t + 1));
    } else {
      void preloadStickers(stickerStyle, ALL_STICKER_SLUGS).then(() =>
        setAssetsTick((t) => t + 1),
      );
    }
  }, [stickerStyle]);

  // No shots means a direct visit; send them to the start
  useEffect(() => {
    if (!hasShots) router.replace("/");
  }, [hasShots, router]);

  // Redraw preview + selection ring (assetsTick re-runs after asset loads)
  useEffect(() => {
    void assetsTick;
    const canvas = canvasRef.current;
    if (!canvas || !hasShots) return;
    composeStrip(canvas, input, 1);
    if (selected !== null) {
      const s = stickers.find((st) => st.key === selected);
      if (s) {
        const ctx = canvas.getContext("2d")!;
        const { width, height } = stripSize(layout);
        ctx.strokeStyle = "rgba(225, 29, 72, 0.85)";
        ctx.setLineDash([6, 5]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(s.x * width, s.y * height, 58 * s.scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }, [input, selected, stickers, layout, hasShots, assetsTick]);

  const toStripCoords = useCallback(
    (e: React.PointerEvent) => {
      const rect = canvasRef.current!.getBoundingClientRect();
      const { width, height } = stripSize(layout);
      return {
        x: ((e.clientX - rect.left) / rect.width) * width,
        y: ((e.clientY - rect.top) / rect.height) * height,
        width,
        height,
      };
    },
    [layout],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (!canvasRef.current) return;
    const p = toStripCoords(e);
    // topmost sticker wins
    for (let i = stickers.length - 1; i >= 0; i--) {
      const s = stickers[i];
      const dx = p.x - s.x * p.width;
      const dy = p.y - s.y * p.height;
      if (Math.hypot(dx, dy) <= STICKER_HIT_RADIUS * s.scale) {
        setSelected(s.key);
        dragRef.current = { key: s.key, dx, dy };
        canvasRef.current.setPointerCapture(e.pointerId);
        return;
      }
    }
    setSelected(null);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const p = toStripCoords(e);
    setStickers((list) =>
      list.map((s) =>
        s.key === drag.key
          ? {
              ...s,
              x: Math.min(1, Math.max(0, (p.x - drag.dx) / p.width)),
              y: Math.min(1, Math.max(0, (p.y - drag.dy) / p.height)),
            }
          : s,
      ),
    );
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  const addSticker = (def: StickerDef) => {
    const key = nextKey.current++;
    setStickers((list) => [
      ...list,
      {
        key,
        emoji: def.emoji,
        slug: def.slug,
        x: 0.5 + (Math.random() - 0.5) * 0.2,
        y: 0.4 + (Math.random() - 0.5) * 0.2,
        scale: 1,
        rotation: ((Math.random() - 0.5) * Math.PI) / 6,
      },
    ]);
    setSelected(key);
  };

  const editSelected = (fn: (s: StickerInstance) => StickerInstance) => {
    setStickers((list) => list.map((s) => (s.key === selected ? fn(s) : s)));
  };

  const deleteSelected = () => {
    setStickers((list) => list.filter((s) => s.key !== selected));
    setSelected(null);
  };

  const exportBlob = async () => {
    if (stickerStyle !== "noto") {
      await preloadStickers(stickerStyle, stickers.map((s) => s.slug));
    }
    return stripToBlob({ ...input, stickers }, 2);
  };

  const download = async () => {
    setSaving(true);
    try {
      const blob = await exportBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `zuychin-strip-${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setSaving(false);
    }
  };

  const share = async () => {
    setSaving(true);
    try {
      const blob = await exportBlob();
      const file = new File([blob], "zuychin-strip.png", { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: "Zuychin Photobooth" });
      } else {
        await download();
      }
    } catch {
      // user cancelled the share sheet
    } finally {
      setSaving(false);
    }
  };

  const persistStrip = async () => {
    if (!user) return;
    setSaveState("saving");
    try {
      const couple = await getMyCouple(user.id);
      const blob = await exportBlob();
      await saveStrip(user.id, couple?.id ?? null, blob, {
        layoutId: session.layoutId,
        caption,
      });
      setSaveState("saved");
    } catch {
      setSaveState("idle");
    }
  };

  const saveToTimeline = async () => {
    if (!user) {
      router.push("/login?next=/timeline");
      return;
    }
    // The vault holds at most WEEKLY_STRIP_CAP non-recap strips per ISO week. At
    // the cap, let the couple discard one to make room instead of blocking.
    try {
      const week = (await listStrips(user.id)).filter(
        (s) => s.layout_id !== "recap" && sameIsoWeek(new Date(s.created_at), new Date()),
      );
      if (week.length >= WEEKLY_STRIP_CAP) {
        setCapChoices(week);
        return;
      }
    } catch {
      // If the check fails, fall through and try to save anyway.
    }
    await persistStrip();
  };

  const discardAndSave = async (strip: TimelineStrip) => {
    setCapChoices(null);
    try {
      await deleteStrip(strip);
    } catch {
      // Best effort; still attempt the save.
    }
    await persistStrip();
  };

  if (!hasShots) return null;

  const activePack = STICKER_PACKS.find((p) => p.id === pack) ?? STICKER_PACKS[0];

  return (
    <main className="flex h-dvh flex-col overflow-hidden md:flex-row md:items-stretch md:justify-center">
      {/* Strip preview: the box keeps the strip's exact aspect ratio and its
          width is capped both directly and by the height budget (45dvh in the
          stacked layout, 78dvh beside the sidebar), so it can never balloon to
          dominate the viewport and push the controls out of view. */}
      <div className="flex shrink-0 items-center justify-center bg-muted/40 p-4 sm:p-6 md:max-w-4xl md:flex-1">
        <div
          className="strip-print w-[min(100%,280px,45dvh*var(--strip-ar))] sm:w-[min(100%,320px,45dvh*var(--strip-ar))] md:w-[min(100%,300px,78dvh*var(--strip-ar))] lg:w-[min(100%,360px,78dvh*var(--strip-ar))]"
          style={
            {
              aspectRatio: `${stripW} / ${stripH}`,
              "--strip-ar": stripW / stripH,
            } as React.CSSProperties
          }
        >
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            className="h-full w-full touch-none rounded-md shadow-2xl shadow-black/25"
          />
        </div>
      </div>

      {/* Controls: its own scroll region so the action buttons stay pinned
          to the bottom of the screen instead of the whole page scrolling. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:max-w-md xl:max-w-lg">
        <div className="flex flex-1 flex-col gap-5 p-5 pb-3">
          <div className="flex items-center justify-between">
            <button
              onClick={() => router.push(isShared && session.roomCode ? `/room/${session.roomCode}` : "/booth")}
              className="flex min-h-11 items-center gap-2 rounded-full bg-muted px-4 text-sm font-medium"
            >
              <ArrowLeft size={16} /> Retake
            </button>
            <h1 className="text-lg font-semibold" style={{ fontFamily: "var(--font-fraunces)" }}>
              Make it yours
            </h1>
          </div>

          <section>
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">Frame</h2>
            <div className="flex flex-wrap gap-2">
              {FRAMES.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFrameId(f.id)}
                  aria-label={f.name}
                  title={f.name}
                  className={`h-11 w-11 rounded-full border-2 transition ${
                    frameId === f.id ? "border-accent scale-110" : "border-border"
                  }`}
                  style={{ background: f.color }}
                />
              ))}
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">Filter</h2>
            <FilterBar
              value={session.filterId}
              onChange={(id) => update({ filterId: id })}
              layoutClass="flex-wrap"
            />
          </section>

          {isShared && (
            <section>
              <h2 className="mb-2 text-sm font-medium text-muted-foreground">
                Together scene
              </h2>
              <div className="flex flex-wrap gap-2 pb-1">
                <button
                  onClick={() => void selectScene(null)}
                  className={`min-h-11 shrink-0 rounded-xl border-2 px-3 text-xs font-medium ${
                    sceneId === null ? "border-accent" : "border-border"
                  }`}
                >
                  None
                </button>
                {SCENES.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => void selectScene(s.id)}
                    title={s.name}
                    aria-label={s.name}
                    className={`h-11 w-16 shrink-0 rounded-xl border-2 ${
                      sceneId === s.id ? "border-accent" : "border-border"
                    }`}
                    style={{ background: s.previewCss }}
                  />
                ))}
              </div>
              {segmenting && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Cutting you both out of your backgrounds…
                </p>
              )}
              {segFailed && (
                <p className="mt-1 text-xs text-destructive">
                  Couldn&apos;t run the background cutout on this device.
                </p>
              )}
              {sceneId && cutouts && (
                <div className="mt-2 flex flex-wrap gap-4">
                  {session.members.map((side) => {
                    const mine = side === session.role;
                    const place = places[side] ?? DEFAULT_PLACEMENT;
                    const nudge = (dx: number, dy: number, ds: number) =>
                      setPlaces((p) => ({
                        ...p,
                        [side]: {
                          dx: Math.min(0.5, Math.max(-0.5, place.dx + dx)),
                          dy: Math.min(0.25, Math.max(-0.25, place.dy + dy)),
                          scale: Math.min(1.6, Math.max(0.5, place.scale + ds)),
                        },
                      }));
                    const label = mine
                      ? "You"
                      : session.members.length > 2
                        ? `Friend ${side}`
                        : "Partner";
                    return (
                      <div key={side} className="flex items-center gap-1">
                        <span
                          className={`mr-1 text-xs font-semibold ${
                            mine ? "text-accent" : "text-partner"
                          }`}
                        >
                          {label}
                        </span>
                        <button aria-label={`${side} left`} onClick={() => nudge(-0.04, 0, 0)} className="flex h-9 w-9 items-center justify-center rounded-full bg-muted"><ChevronLeft size={16} /></button>
                        <button aria-label={`${side} right`} onClick={() => nudge(0.04, 0, 0)} className="flex h-9 w-9 items-center justify-center rounded-full bg-muted"><ChevronRight size={16} /></button>
                        <button aria-label={`${side} up`} onClick={() => nudge(0, -0.03, 0)} className="flex h-9 w-9 items-center justify-center rounded-full bg-muted"><ChevronUp size={16} /></button>
                        <button aria-label={`${side} down`} onClick={() => nudge(0, 0.03, 0)} className="flex h-9 w-9 items-center justify-center rounded-full bg-muted"><ChevronDown size={16} /></button>
                        <button aria-label={`${side} smaller`} onClick={() => nudge(0, 0, -0.08)} className="flex h-9 w-9 items-center justify-center rounded-full bg-muted"><ZoomOut size={16} /></button>
                        <button aria-label={`${side} bigger`} onClick={() => nudge(0, 0, 0.08)} className="flex h-9 w-9 items-center justify-center rounded-full bg-muted"><ZoomIn size={16} /></button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-medium text-muted-foreground">Stickers</h2>
              {selected !== null && (
                <div className="flex gap-1">
                  <button aria-label="Smaller" onClick={() => editSelected((s) => ({ ...s, scale: Math.max(0.4, s.scale - 0.15) }))} className="flex h-9 w-9 items-center justify-center rounded-full bg-muted"><ZoomOut size={16} /></button>
                  <button aria-label="Bigger" onClick={() => editSelected((s) => ({ ...s, scale: Math.min(3, s.scale + 0.15) }))} className="flex h-9 w-9 items-center justify-center rounded-full bg-muted"><ZoomIn size={16} /></button>
                  <button aria-label="Rotate left" onClick={() => editSelected((s) => ({ ...s, rotation: s.rotation - Math.PI / 12 }))} className="flex h-9 w-9 items-center justify-center rounded-full bg-muted"><RotateCcw size={16} /></button>
                  <button aria-label="Rotate right" onClick={() => editSelected((s) => ({ ...s, rotation: s.rotation + Math.PI / 12 }))} className="flex h-9 w-9 items-center justify-center rounded-full bg-muted"><RotateCw size={16} /></button>
                  <button aria-label="Delete sticker" onClick={deleteSelected} className="flex h-9 w-9 items-center justify-center rounded-full bg-destructive/15 text-destructive"><Trash2 size={16} /></button>
                </div>
              )}
            </div>
            <div className="mb-2 flex items-start gap-2">
              <div className="flex min-w-0 flex-1 flex-wrap gap-2">
                {STICKER_PACKS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setPack(p.id)}
                    className={`min-h-9 shrink-0 rounded-full px-3 text-xs font-medium ${
                      pack === p.id ? "bg-foreground text-background" : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
              <div className="flex shrink-0 rounded-full bg-muted p-0.5">
                {STICKER_STYLES.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setStickerStyle(s.id)}
                    className={`min-h-8 rounded-full px-3 text-xs font-medium transition ${
                      stickerStyle === s.id
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground"
                    }`}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-1">
              {activePack.stickers.map((def) => (
                <button
                  key={def.slug}
                  onClick={() => addSticker(def)}
                  aria-label={def.slug.replaceAll("_", " ")}
                  className="flex h-11 w-11 items-center justify-center rounded-xl transition hover:bg-muted"
                >
                  {stickerStyle === "noto" ? (
                    <span
                      className="text-2xl"
                      style={{ fontFamily: "var(--font-noto-emoji)", color: frame.ink }}
                    >
                      {monochromeGlyph(def.emoji)}
                    </span>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={stickerAssetUrl(stickerStyle, def.slug)}
                      alt=""
                      className="h-8 w-8"
                    />
                  )}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Tap a sticker on the strip to select it, then drag to move.
            </p>
          </section>

          <section className="flex items-center gap-3">
            <input
              value={caption}
              onChange={(e) => setCaption(e.target.value.slice(0, 30))}
              placeholder="Add a caption…"
              className="min-h-11 flex-1 rounded-xl border border-border bg-card px-4 outline-none focus:border-accent"
            />
            <button
              onClick={() => setShowDate((d) => !d)}
              aria-pressed={showDate}
              aria-label="Toggle datestamp"
              className={`flex h-11 w-11 items-center justify-center rounded-xl border transition ${
                showDate
                  ? "border-datestamp bg-datestamp/15 text-datestamp"
                  : "border-border bg-card text-muted-foreground"
              }`}
            >
              <Calendar size={18} />
            </button>
          </section>
        </div>

        <div className="sticky bottom-0 flex flex-col gap-3 border-t border-border bg-background/95 px-5 pt-3 pb-5 backdrop-blur">
          <div className="flex gap-3">
            <button
              onClick={download}
              disabled={saving}
              className="flex min-h-13 flex-1 items-center justify-center gap-2 rounded-2xl bg-accent font-semibold text-accent-foreground shadow-lg shadow-accent/25 transition active:scale-[0.99] disabled:opacity-50"
            >
              <Download size={18} /> {saving ? "Saving…" : "Download"}
            </button>
            <button
              onClick={share}
              disabled={saving}
              aria-label="Share"
              className="glass-card flex min-h-13 w-16 items-center justify-center rounded-2xl transition active:scale-[0.99] disabled:opacity-50"
            >
              <Share2 size={18} />
            </button>
          </div>
          {authEnabled && (
            <button
              onClick={saveToTimeline}
              disabled={saveState === "saving"}
              className="flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-border font-semibold transition active:scale-[0.99] disabled:opacity-50"
            >
              {saveState === "saved" ? (
                <>
                  <Check size={18} className="text-success" /> Saved to Shared Vault
                </>
              ) : (
                <>
                  <Heart size={18} className="text-accent" />
                  {saveState === "saving"
                    ? "Saving…"
                    : user
                      ? "Save to our Shared Vault"
                      : "Sign in to save"}
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {capChoices !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="glass-card flex max-h-[85dvh] w-full max-w-md flex-col gap-4 overflow-hidden rounded-2xl p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold" style={{ fontFamily: "var(--font-fraunces)" }}>
                  This week&apos;s vault is full
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  You&apos;ve saved {WEEKLY_STRIP_CAP} strips this week. Discard one
                  to make room, or keep them all and save this next week.
                </p>
              </div>
              <button
                onClick={() => setCapChoices(null)}
                aria-label="Cancel"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted"
              >
                <X size={18} />
              </button>
            </div>

            {capChoices.some((s) => s.mine) ? (
              <div className="grid grid-cols-3 gap-3 overflow-y-auto">
                {capChoices
                  .filter((s) => s.mine)
                  .map((s) => (
                    <button
                      key={s.id}
                      onClick={() => discardAndSave(s)}
                      className="group relative overflow-hidden rounded-lg border border-border"
                      aria-label="Discard this strip and save the new one"
                    >
                      {s.url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={s.url} alt={s.caption ?? "Photo strip"} className="aspect-[3/4] w-full object-cover" />
                      )}
                      <span className="absolute inset-0 flex items-center justify-center bg-destructive/0 opacity-0 transition group-hover:bg-destructive/70 group-hover:opacity-100">
                        <Trash2 size={20} className="text-white" />
                      </span>
                    </button>
                  ))}
              </div>
            ) : (
              <p className="rounded-xl bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
                All {WEEKLY_STRIP_CAP} strips this week are your partner&apos;s. Ask
                them to remove one, or wait for the weekly reset.
              </p>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
