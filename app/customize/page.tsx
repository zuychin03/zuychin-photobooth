"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Calendar,
  Download,
  RotateCcw,
  RotateCw,
  Share2,
  Trash2,
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
import {
  ComposeInput,
  StickerInstance,
  composeStrip,
  stripToBlob,
} from "@/lib/compose";
import { getLayout, stripSize } from "@/lib/layouts";
import { useBoothSession } from "@/lib/session";

const STICKER_HIT_RADIUS = 60;

export default function CustomizePage() {
  const router = useRouter();
  const { session, update } = useBoothSession();
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
  const dragRef = useRef<{ key: number; dx: number; dy: number } | null>(null);
  const nextKey = useRef(1);

  const layout = getLayout(session.layoutId);
  const frame = FRAMES.find((f) => f.id === frameId) ?? FRAMES[0];
  const hasShots = session.shots.A.some(Boolean) || session.shots.B.some(Boolean);

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
    }),
    [layout, session.shots, session.filterId, frame, caption, showDate, stickers, stickerStyle],
  );

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

  if (!hasShots) return null;

  const activePack = STICKER_PACKS.find((p) => p.id === pack) ?? STICKER_PACKS[0];

  return (
    <main className="flex min-h-dvh flex-1 flex-col lg:flex-row lg:items-stretch">
      {/* Strip preview */}
      <div className="flex flex-1 items-center justify-center bg-muted/40 p-6">
        <div className="strip-print">
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            className="max-h-[70dvh] w-auto max-w-full touch-none rounded-md shadow-2xl shadow-black/25 lg:max-h-[86dvh]"
          />
        </div>
      </div>

      {/* Controls */}
      <div className="flex w-full flex-col gap-5 p-5 lg:max-w-md lg:overflow-y-auto">
        <div className="flex items-center justify-between">
          <button
            onClick={() => router.push(session.mode === "duo" && session.roomCode ? `/room/${session.roomCode}` : "/booth")}
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
          />
        </section>

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
          <div className="mb-2 flex items-center gap-2">
            <div className="scrollbar-hide flex min-w-0 flex-1 gap-2 overflow-x-auto">
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

        <div className="mt-auto flex gap-3 pt-2">
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
      </div>
    </main>
  );
}
