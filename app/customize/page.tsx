"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";

import { HelpTooltip } from "@/components/HelpTooltip";

import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import Link from "next/link";
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
  Undo2,
  Redo2,
  FolderOpen,
} from "lucide-react";
import { FilterBar } from "@/components/FilterBar";
import {
  ALL_STICKER_SLUGS,
  FRAMES,
  STICKER_PACKS,
  STICKER_STYLES,
  StickerDef,
  monochromeGlyph,
  stickerAssetUrl,
} from "@/lib/decor";
import { PATTERNS, getPattern } from "@/lib/patterns";
import { THEMES, getTheme } from "@/lib/themes";
import { ensureNotoFont, preloadStickers } from "@/lib/sticker-assets";
import { cutout, preloadSegmenter } from "@/lib/segmentation";
import {
  ComposeInput,
  DEFAULT_PLACEMENT,
  ShotSet,
  StickerInstance,
  composeStrip,
  stripToBlob,
  compositionSize,
} from "@/lib/compose";
import { ROLES, getLayout } from "@/lib/layouts";
import { useBoothSession } from "@/lib/session";
import { useAuth } from "@/lib/auth";
import { TimelineStrip, deleteStrip, getMyCouple, listStrips, saveStrip } from "@/lib/couple";
import { notifyPartner } from "@/lib/push-client";
import { WEEKLY_STRIP_CAP } from "@/lib/retention";
import { sameIsoWeek } from "@/lib/streak";
import { UploadSaveError } from "@/lib/upload-intent";
import { useProjectEditor } from "@/hooks/useProjectEditor";
import type { PhotoProject, ProjectEditorSettings } from "@/lib/projects/model";
import { PhotoEditPanel } from "@/components/PhotoEditPanel";
import { projectDownloadName } from "@/lib/projects/download";
import { useCuratedAssets } from "@/hooks/useCuratedAssets";
import { VisualPackPicker } from "@/components/VisualPackPicker";
import { TemplateSourcePanel } from "@/components/TemplateSourcePanel";
import { Dropdown } from "@/components/Dropdown";
import dynamic from "next/dynamic";

const ExportStudio = dynamic(() => import("@/components/ExportStudio"), { ssr: false });

const STICKER_HIT_RADIUS = 60;
const EDITOR_TOOLS = [
  { value: "photos", label: "Photos & crop" },
  { value: "look", label: "Frame & look" },
  { value: "scene", label: "Scenes & textures" },
  { value: "stickers", label: "Stickers" },
  { value: "caption", label: "Caption & date" },
  { value: "project", label: "Project & templates" },
] as const;
type EditorTool = typeof EDITOR_TOOLS[number]["value"];

export default function CustomizePage() {
  const { project, hydrating, storageError } = useBoothSession();
  if (hydrating) return <main className="m-auto p-8" role="status">Opening your project…</main>;
  if (!project) return <main className="m-auto max-w-lg p-8"><h1 className="font-display text-3xl">Choose a project to edit</h1>{storageError && <p role="alert" className="mt-4">{storageError}</p>}<Link href="/projects" className="mt-6 inline-flex min-h-11 items-center text-accent underline">Open My projects</Link></main>;
  return <CustomizeWorkspace key={`${project.scope.kind}:${project.scope.kind === "account" ? project.scope.ownerId : "device"}:${project.id}`} project={project} />;
}

function CustomizeWorkspace({ project }: { project: PhotoProject }) {
  const router = useRouter();
  const { session, editProject, openProject, undo, redo, exportProject, storageStatus, storageError, decorationCanvases, importShot } = useBoothSession();
  const persistEditor = useCallback((patch: Partial<ProjectEditorSettings>) => editProject(patch, undefined, project), [editProject, project]);
  const draft = useProjectEditor(project, persistEditor);
  const { editor, setField } = draft;
  const { frameId, caption, showDate, stickers, stickerStyle, patternId, themeId, sceneId, places } = editor;
  const setters = useMemo(() => {
    const field = <K extends keyof ProjectEditorSettings>(key: K) => (value: SetStateAction<ProjectEditorSettings[K]>) => setField(key, value);
    return { setFrameId: field("frameId"), setCaption: field("caption"), setShowDate: field("showDate"), setStickers: field("stickers"), setStickerStyle: field("stickerStyle"), setPatternId: field("patternId"), setThemeId: field("themeId"), setSceneId: field("sceneId"), setPlaces: field("places") };
  }, [setField]);
  const { setFrameId, setCaption, setShowDate, setStickers, setStickerStyle, setPatternId, setThemeId, setSceneId, setPlaces } = setters;
  const { user, enabled: authEnabled } = useAuth();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const [selected, setSelected] = useState<number | null>(null);
  const [activeTool, setActiveTool] = useState<EditorTool>("photos");
  const toolScroll = useRef<HTMLDivElement>(null);
  const toolClass = (tool: EditorTool) => `${activeTool === tool ? "block" : "hidden"} space-y-5 md:block`;
  const [pack, setPack] = useState(STICKER_PACKS[0].id);
  const [assetsTick, setAssetsTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const exportTrigger = useRef<HTMLButtonElement>(null);
  const [segmentation, setSegmentation] = useState<{ sources: ShotSet; cutouts: ShotSet } | null>(null);
  const cutouts = segmentation?.sources === session.shots ? segmentation.cutouts : null;
  const [segmenting, setSegmenting] = useState(false);
  const [segFailed, setSegFailed] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [discardingEdits, setDiscardingEdits] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveIdentity = useRef<string | null>(null);
  // This week's strips offered for discard when the vault is at its weekly cap.
  const [capChoices, setCapChoices] = useState<TimelineStrip[] | null>(null);
  useAppNavigationGuard(() => {
    if (restoring || saving || saveState === "saving" || discardingEdits || exportOpen) {
      setSaveError("Finish the current action or close the export studio before leaving."); return false;
    }
    if (draft.pending || draft.error || storageStatus === "saving") {
      setActiveTool("project"); setSaveError("Save or discard the unsaved edits before leaving."); return false;
    }
    return true;
  });
  const dragRef = useRef<{ key: number; dx: number; dy: number } | null>(null);
  const nextKey = useRef(Math.max(0, ...project.editor.stickers.map(sticker => sticker.key)) + 1);

  const layout = getLayout(editor.layoutId);
  const frame = FRAMES.find((f) => f.id === frameId) ?? FRAMES[0];
  const theme = getTheme(themeId);
  const hasShots = ROLES.some((r) => session.shots[r].some(Boolean));
  const { width: stripW, height: stripH } = compositionSize({ layout, template: editor.template });
  const curated = useCuratedAssets(sceneId, editor.materialId ?? null);

  const input: ComposeInput = useMemo(
    () => ({
      layout,
      shots: session.shots,
      style: {
        frameColor: frame.color,
        inkColor: frame.ink,
        patternId,
        filterId: editor.filterId,
        caption,
        showDate,
        stickerStyle,
      },
      stickers,
      cutouts: cutouts ?? undefined,
      together: sceneId ? { sceneId, places } : null,
      theme,
      cellEdits: { ...editor.cellEdits },
      capturedAt: project.capturedAt,
      captureTimeZone: project.captureTimeZone,
      template: editor.template,
      materialId: editor.materialId,
      resources: curated.resources,
      decorations: decorationCanvases,
    }),
    [layout, session.shots, editor.filterId, editor.cellEdits, frame, patternId, caption, showDate, stickers, stickerStyle, cutouts, sceneId, places, theme, project.capturedAt, project.captureTimeZone, editor.template, editor.materialId, curated.resources, decorationCanvases],
  );

  const isShared = session.mode === "duo" || session.mode === "group";

  useEffect(() => {
    if (!draft.pending && !draft.error && storageStatus !== "saving") return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft.pending, draft.error, storageStatus]);

  const applyHistory = async (direction: "undo" | "redo") => {
    setRestoring(true); setSaveError(null);
    try {
      await draft.flush();
      const next = await (direction === "undo" ? undo() : redo());
      draft.replaceFromProject(next.editor);
      setSelected(null);
    } catch (error) { setSaveError(error instanceof Error ? error.message : "History could not be restored"); }
    finally { setRestoring(false); }
  };

  const navigate = async (path: string) => {
    try { await draft.flush(); router.push(path); }
    catch (error) { setSaveError(error instanceof Error ? error.message : "Save your pending edits before leaving"); }
  };

  const discardEdits = async () => {
    setRestoring(true);
    try {
      const saved = await openProject(project.id, project.scope);
      draft.discardUnsaved(); draft.replaceFromProject(saved.editor);
      setDiscardingEdits(false); setSaveError(null); setSelected(null);
    } catch (error) { setSaveError(error instanceof Error ? error.message : "Saved edits could not be restored"); }
    finally { setRestoring(false); }
  };

  // warm the segmenter for shared sessions so picking a scene is fast
  useEffect(() => {
    if (isShared) preloadSegmenter();
  }, [isShared]);

  const sceneEnabled = Boolean(sceneId);
  useEffect(() => {
    let cancelled = false;
    const prepare = async () => {
      setSegFailed(false);
      if (!sceneEnabled) { setSegmenting(false); return; }
      setSegmenting(true);
      try {
        const next: Required<ShotSet> = { A: [], B: [], C: [], D: [] };
        for (const role of ROLES) for (const shot of session.shots[role]) {
          if (cancelled) return;
          next[role].push(shot ? await cutout(shot) : null);
        }
        if (!cancelled) setSegmentation({ sources: session.shots, cutouts: next });
      } catch {
        if (!cancelled) { setSegFailed(true); setSceneId(null); }
      } finally { if (!cancelled) setSegmenting(false); }
    };
    void prepare();
    return () => { cancelled = true; };
  }, [sceneEnabled, session.shots, setSceneId]);

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

  // theme decor uses its own sticker style; warm those assets too
  useEffect(() => {
    if (!theme) return;
    if (theme.stickerStyle === "noto") {
      const family = getComputedStyle(document.documentElement)
        .getPropertyValue("--font-noto-emoji")
        .trim();
      void ensureNotoFont(family).then(() => setAssetsTick((t) => t + 1));
    } else {
      void preloadStickers(theme.stickerStyle, theme.decor.map((d) => d.slug)).then(() =>
        setAssetsTick((t) => t + 1),
      );
    }
  }, [theme]);

  // Redraw preview + selection ring (assetsTick re-runs after asset loads)
  useEffect(() => {
    void assetsTick;
    const canvas = canvasRef.current;
    if (!canvas) return;
    composeStrip(canvas, input, 1);
    if (selected !== null) {
      const s = stickers.find((st) => st.key === selected);
      if (s) {
        const ctx = canvas.getContext("2d")!;
        const { width, height } = compositionSize(input);
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
      const { width, height } = compositionSize(input);
      return {
        x: ((e.clientX - rect.left) / rect.width) * width,
        y: ((e.clientY - rect.top) / rect.height) * height,
        width,
        height,
      };
    },
    [input],
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
        setActiveTool("stickers");
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
    if (stickers.length >= 32) { setSaveError("This project already has 32 stickers. Remove one before adding another."); return; }
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

  const applyTheme = (id: string | null) => {
    const prev = getTheme(themeId);
    setThemeId(id);
    const t = getTheme(id);
    if (!t) return;
    setFrameId(t.frameId);
    setPatternId(t.patternId);
    // only swap in the suggested caption while the field is untouched
    if (!caption || caption === prev?.caption) setCaption(t.caption ?? "");
  };

  const prepareExport = async () => {
    if (!hasShots) throw new Error("Add a photo or redo the previous capture before exporting a strip.");
    if (curated.loading) throw new Error("Wait for the selected artwork to finish loading before exporting.");
    if (editor.template?.slots.some(slot => [slot, ...(slot.companions ?? [])].some(source => !session.shots[source.role]?.[source.sourceIndex]))) throw new Error("Import the missing template photos before exporting.");
    try { await draft.flush(); }
    catch { setSaveError("This export includes edits that have not saved on this device. Keep the file, then retry saving."); }
    if (sceneId && (!cutouts || segmenting)) throw new Error("Wait for the Together scene to finish, or switch it off before exporting.");
    if (stickerStyle === "noto" || theme?.stickerStyle === "noto" || editor.template?.layers.some(layer => layer.kind === "sticker" && layer.style === "noto")) await ensureNotoFont(getComputedStyle(document.documentElement).getPropertyValue("--font-noto-emoji").trim());
    if (stickerStyle !== "noto") {
      await preloadStickers(stickerStyle, stickers.map((s) => s.slug));
    }
    if (theme && theme.stickerStyle !== "noto") {
      await preloadStickers(theme.stickerStyle, theme.decor.map((d) => d.slug));
    }
    for (const layer of editor.template?.layers ?? []) if (layer.kind === "sticker" && layer.style !== "noto") await preloadStickers(layer.style, [layer.slug]);
    if (!mounted.current) throw new Error("The editor was closed before export finished");
  };

  const exportBlob = async () => { await prepareExport(); return stripToBlob({ ...input, stickers }, 2); };

  const openExportStudio = async () => {
    setSaving(true); setSaveError(null);
    try { await prepareExport(); if (mounted.current) setExportOpen(true); }
    catch (error) { if (mounted.current) setSaveError(error instanceof Error ? error.message : "The export tools could not open."); }
    finally { if (mounted.current) setSaving(false); }
  };

  const download = async () => {
    setSaving(true);
    try {
      const blob = await exportBlob();
      if (!mounted.current) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = projectDownloadName(project.name, "png");
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "The strip could not be exported");
    } finally {
      setSaving(false);
    }
  };

  const downloadProject = async () => {
    setSaving(true); setSaveError(null);
    try {
      try { await draft.flush(); }
      catch { setSaveError("The backup includes edits that have not saved on this device. Keep the file, then retry saving."); }
      const blob = await exportProject(editor);
      if (!mounted.current) return;
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = projectDownloadName(project.name, "pbproject"); link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) { setSaveError(error instanceof Error ? error.message : "Project backup failed"); }
    finally { setSaving(false); }
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
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setSaveError(error instanceof Error ? error.message : "Sharing failed. Try downloading the strip instead.");
    } finally {
      setSaving(false);
    }
  };

  const persistStrip = async () => {
    if (!user) return;
    setSaveState("saving");
    setSaveError(null);
    try {
      const couple = await getMyCouple(user.id);
      const blob = await exportBlob();
      if (!mounted.current) return;
      saveIdentity.current ??= crypto.randomUUID();
      const stripId = await saveStrip(user.id, couple?.id ?? null, blob, {
        layoutId: editor.layoutId,
        caption,
      }, { id: saveIdentity.current });
      if (couple?.member_b) notifyPartner("strip", stripId);
      saveIdentity.current = null;
      setSaveState("saved");
    } catch (error) {
      if (error instanceof UploadSaveError && error.restartRequired) saveIdentity.current = null;
      setSaveError(error instanceof Error ? error.message : "Cloud saving failed. Your photos remain here; please try again.");
      setSaveState("idle");
    }
  };

  const saveToTimeline = async () => {
    if (!user) {
      await navigate("/login?next=/timeline");
      return;
    }
    // The vault holds at most WEEKLY_STRIP_CAP non-recap strips per ISO week. At
    // the cap, let the couple discard one to make room instead of blocking.
    try {
      const week = (await listStrips(user.id)).filter(
        (s) => s.layout_id !== "recap" && sameIsoWeek(new Date(s.created_at), new Date()),
      );
      if (week.length >= WEEKLY_STRIP_CAP) {
        setCapChoices(week.filter(strip => !strip.kept));
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
      const result = await deleteStrip(strip);
      if (result.pending) {
        setSaveError("Deletion is queued. Check your vault before trying another cloud save. Your current photos remain here.");
        return;
      }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Deletion failed. Your current photos remain here.");
      return;
    }
    await persistStrip();
  };

  const activePack = STICKER_PACKS.find((p) => p.id === pack) ?? STICKER_PACKS[0];

  return (
    <main className="flex h-[calc(100dvh-var(--app-nav-height,0px)-var(--app-bottom-nav-height,0px))] flex-col overflow-hidden md:flex-row md:items-stretch md:justify-center" aria-busy={restoring || saving || saveState === "saving"} inert={restoring || saving || saveState === "saving"} onKeyDown={event => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || restoring || exportOpen || saving) return;
      const target = event.target as HTMLElement;
      if (target.matches("input, textarea, select, [contenteditable='true']")) return;
      if (event.key.toLowerCase() === "z") { event.preventDefault(); void applyHistory(event.shiftKey ? "redo" : "undo"); }
      else if (event.key.toLowerCase() === "y") { event.preventDefault(); void applyHistory("redo"); }
    }}>
      <div className="flex shrink-0 items-center justify-center bg-muted/40 p-3 sm:p-4 md:max-w-4xl md:flex-1 md:p-6">
        <div
          className="strip-print w-[min(100%,280px,28dvh*var(--strip-ar))] sm:w-[min(100%,320px,28dvh*var(--strip-ar))] md:w-[min(100%,300px,78dvh*var(--strip-ar))] lg:w-[min(100%,360px,78dvh*var(--strip-ar))]"
          style={
            {
              aspectRatio: `${stripW} / ${stripH}`,
              "--strip-ar": stripW / stripH,
            } as React.CSSProperties
          }
        >
          <canvas
            ref={canvasRef}
            tabIndex={0}
            aria-label="Strip preview. Select a sticker, then use arrow keys to move it or Delete to remove it."
            onKeyDown={event => {
              if (selected === null) return;
              if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); deleteSelected(); }
              if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
                event.preventDefault();
                const step = event.shiftKey ? 0.04 : 0.01;
                editSelected(sticker => ({ ...sticker, x: Math.min(1, Math.max(0, sticker.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0))), y: Math.min(1, Math.max(0, sticker.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0))) }));
              }
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            className="h-full w-full touch-none rounded-md shadow-2xl shadow-black/25"
          />
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:max-w-md xl:max-w-lg">
        <div className="shrink-0 space-y-2 border-b border-border px-4 py-3 md:px-5">
          <div className="flex items-center justify-between">
            <button
              onClick={() => void navigate(isShared ? session.roomCode ? `/room/${session.roomCode}` : "/projects" : "/booth")}
              className="flex min-h-11 items-center gap-2 rounded-full bg-muted px-4 text-sm font-medium"
            >
              <ArrowLeft size={16} /> {isShared && !session.roomCode ? "Back" : hasShots ? "Retake" : "Add photos"}
            </button>
            <h1 className="text-lg font-semibold" style={{ fontFamily: "var(--font-fraunces)" }}>
              Make it yours
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <Dropdown label="Editing tool" value={activeTool} className="min-w-0 flex-1 md:hidden" options={EDITOR_TOOLS} onChange={value => { setActiveTool(value as EditorTool); toolScroll.current?.scrollTo({ top: 0 }); }} />
            <button type="button" aria-label="Undo edit" disabled={!project.history.past.length || draft.pending} onClick={() => void applyHistory("undo")} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border disabled:opacity-30"><Undo2 size={18} /></button>
            <button type="button" aria-label="Redo edit" disabled={!project.history.future.length || draft.pending} onClick={() => void applyHistory("redo")} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border disabled:opacity-30"><Redo2 size={18} /></button>
          </div>
          <p role="status" className="text-sm text-muted-foreground">{draft.error || storageError ? "Changes need attention" : draft.pending || storageStatus === "saving" ? "Saving on this device…" : "Saved on this device"}</p>
        </div>
        <div ref={toolScroll} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain p-4 md:p-5" aria-label="Editing tools">
          <div className={toolClass("project")}>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void navigate("/projects")} className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm"><FolderOpen size={16} /> My projects</button>
            <button type="button" onClick={() => void navigate("/templates")} className="min-h-11 rounded-lg border border-border px-3 text-sm">Templates</button>
            <button type="button" onClick={() => void navigate("/templates/design")} className="min-h-11 rounded-lg border border-border px-3 text-sm">Frame designer</button>
            {!isShared && <button type="button" onClick={() => void navigate("/booth#then-now")} className="min-h-11 rounded-lg border border-border px-3 text-sm">Then &amp; now</button>}
            <button onClick={() => void downloadProject()} disabled={saving} className="min-h-11 text-sm text-muted-foreground underline underline-offset-4 disabled:opacity-50">Back up editable project</button>
          </div>
          </div>
          {!hasShots && <p className="text-sm">No active photos in this version. Redo the previous capture to restore it, or choose Add photos. Your original files remain in the project backup.</p>}
          {(draft.error || storageError) && <div role="alert" className="text-sm"><p>{draft.error ?? storageError}</p><div className="flex flex-wrap gap-4"><button className="mt-2 min-h-11 text-accent underline" onClick={() => void draft.flush().catch(error => setSaveError(error.message))}>Retry local save</button>{draft.error && <button className="mt-2 min-h-11 underline" onClick={() => setDiscardingEdits(true)}>Discard unsaved edits</button>}</div></div>}
          {discardingEdits && <div className="border-y border-border py-3 text-sm"><p>Restore the last saved edits? Unsaved changes will be removed. Back up your editable project first if you want to keep them.</p><div className="mt-2 flex gap-4"><button className="min-h-11 text-destructive underline" onClick={() => void discardEdits()}>Restore saved edits</button><button className="min-h-11 underline" onClick={() => setDiscardingEdits(false)}>Keep editing</button></div></div>}
          <div className={toolClass("photos")}>
            {editor.template ? <><TemplateSourcePanel project={project} onImport={async (role, index, file) => { await draft.flush(); await importShot(role, index, file); }} /><button className="min-h-11 text-left text-sm underline" onClick={() => setField("template", null)}>Use the standard layout</button></> : <PhotoEditPanel project={project} editor={editor} change={draft.patch} reorder={async order => { await draft.flush(); await editProject({}, order); }} />}
          </div>

          <div className={toolClass("scene")}>
          <VisualPackPicker sceneId={sceneId} materialId={editor.materialId ?? null} onSceneChange={setSceneId} onMaterialChange={id => setField("materialId", id)} />
          </div>
          {curated.loading && <p role="status" className="text-sm text-muted-foreground">Loading selected artwork…</p>}
          {curated.fallback.length > 0 && <p role="status" className="text-sm">Artwork unavailable: {curated.fallback.join(", ")}. A built-in background will be used in your preview and export.</p>}

          <div className={toolClass("look")}>
          <section>
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">Theme</h2>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => applyTheme(null)}
                className={`flex h-[5.5rem] w-14 flex-col items-center justify-center rounded-xl border-2 text-[10px] font-medium transition ${
                  themeId === null ? "border-accent" : "border-border"
                }`}
              >
                None
              </button>
              {THEMES.map((t) => {
                const f = FRAMES.find((fr) => fr.id === t.frameId) ?? FRAMES[0];
                return (
                  <button
                    key={t.id}
                    onClick={() => applyTheme(t.id)}
                    title={t.name}
                    aria-label={t.name}
                    className={`w-14 overflow-hidden rounded-xl border-2 transition ${
                      themeId === t.id ? "border-accent scale-105" : "border-border"
                    }`}
                  >
                    <span className="relative block h-16">
                      <PatternPreview
                        frameColor={f.color}
                        ink={f.ink}
                        patternId={t.patternId}
                        className="absolute inset-0 h-full w-full"
                      />
                      <span className="absolute inset-0 flex items-center justify-center text-xl">
                        {t.decor[0].emoji}
                      </span>
                    </span>
                    <span className="block truncate bg-card px-1 py-1 text-center text-[10px] font-medium">
                      {t.name}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

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
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">Pattern</h2>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setPatternId("none")}
                className={`flex h-16 w-12 items-center justify-center rounded-lg border-2 text-[10px] font-medium transition ${
                  patternId === "none" ? "border-accent" : "border-border"
                }`}
              >
                None
              </button>
              {PATTERNS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setPatternId(p.id)}
                  title={p.name}
                  aria-label={p.name}
                  className={`h-16 w-12 overflow-hidden rounded-lg border-2 transition ${
                    patternId === p.id ? "border-accent scale-105" : "border-border"
                  }`}
                >
                  <PatternPreview
                    frameColor={frame.color}
                    ink={frame.ink}
                    patternId={p.id}
                    className="h-full w-full"
                  />
                </button>
              ))}
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">Filter</h2>
            <FilterBar
              value={editor.filterId}
              onChange={(id) => setField("filterId", id)}
              layoutClass="flex-wrap"
            />
          </section>

          </div>
          <div className={toolClass("scene")}>
          {(sceneId || segFailed) && (
            <section>
              <h2 className="mb-2 text-sm font-medium text-muted-foreground">
                Scene placement
              </h2>
              {segmenting && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Preparing the background cutouts…
                </p>
              )}
              {segFailed && (
                <p className="mt-1 text-xs text-destructive">
                  Couldn&apos;t run the background cutout on this device.
                </p>
              )}
              {sceneId && cutouts && !editor.template && (
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
                      <div key={side} className="flex flex-wrap items-center gap-1">
                        <span
                          className={`mr-1 text-xs font-semibold ${
                            mine ? "text-accent" : "text-partner"
                          }`}
                        >
                          {label}
                        </span>
                        <button aria-label={`${side} left`} onClick={() => nudge(-0.04, 0, 0)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted"><ChevronLeft size={16} /></button>
                        <button aria-label={`${side} right`} onClick={() => nudge(0.04, 0, 0)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted"><ChevronRight size={16} /></button>
                        <button aria-label={`${side} up`} onClick={() => nudge(0, -0.03, 0)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted"><ChevronUp size={16} /></button>
                        <button aria-label={`${side} down`} onClick={() => nudge(0, 0.03, 0)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted"><ChevronDown size={16} /></button>
                        <button aria-label={`${side} smaller`} onClick={() => nudge(0, 0, -0.08)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted"><ZoomOut size={16} /></button>
                        <button aria-label={`${side} bigger`} onClick={() => nudge(0, 0, 0.08)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted"><ZoomIn size={16} /></button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}
          </div>

          <div className={toolClass("stickers")}>
          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2"><h2 className="text-sm font-medium text-muted-foreground">Stickers</h2><HelpTooltip label="About placing stickers">Select a sticker on the strip, then drag or use the arrow keys to move it.</HelpTooltip></div>
              {selected !== null && (
                <div className="flex gap-1">
                  <button aria-label="Smaller" onClick={() => editSelected((s) => ({ ...s, scale: Math.max(0.4, s.scale - 0.15) }))} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted"><ZoomOut size={16} /></button>
                  <button aria-label="Bigger" onClick={() => editSelected((s) => ({ ...s, scale: Math.min(3, s.scale + 0.15) }))} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted"><ZoomIn size={16} /></button>
                  <button aria-label="Rotate left" onClick={() => editSelected((s) => ({ ...s, rotation: s.rotation - Math.PI / 12 }))} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted"><RotateCcw size={16} /></button>
                  <button aria-label="Rotate right" onClick={() => editSelected((s) => ({ ...s, rotation: s.rotation + Math.PI / 12 }))} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted"><RotateCw size={16} /></button>
                  <button aria-label="Delete sticker" onClick={deleteSelected} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive"><Trash2 size={16} /></button>
                </div>
              )}
            </div>
            <div className="mb-2 flex flex-wrap items-start gap-2">
              <div className="flex min-w-0 flex-1 flex-wrap gap-2">
                {STICKER_PACKS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setPack(p.id)}
                    className={`min-h-11 shrink-0 rounded-full px-3 text-xs font-medium ${
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
                    className={`min-h-11 rounded-full px-3 text-xs font-medium transition ${
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

          </section>
          </div>

          <div className={toolClass("caption")}>
          <section className="flex items-center gap-3">
            <input
              value={caption}
              aria-label="Strip caption"
              onChange={(e) => setCaption(e.target.value.slice(0, 30))}
              placeholder="Add a caption…"
              className="min-h-11 min-w-0 flex-1 rounded-xl border border-border bg-card px-4 text-base outline-none focus:border-accent"
            />
            <button
              onClick={() => setShowDate((d) => !d)}
              aria-pressed={showDate}
              aria-label="Toggle datestamp"
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition ${
                showDate
                  ? "border-datestamp bg-datestamp/15 text-datestamp"
                  : "border-border bg-card text-muted-foreground"
              }`}
            >
              <Calendar size={18} />
            </button>
          </section>
          </div>
        </div>

        <div className="flex max-h-[35dvh] shrink-0 flex-col gap-3 overflow-y-auto border-t border-border bg-background px-4 pt-3 pb-[max(0.75rem,calc(env(safe-area-inset-bottom)-var(--app-bottom-nav-height,0px)))] md:px-5">
          <div className="flex gap-3">
            <button
              ref={exportTrigger}
              onClick={() => void openExportStudio()}
              disabled={saving}
              className="flex min-h-13 flex-1 items-center justify-center gap-2 rounded-2xl bg-accent font-semibold text-accent-foreground shadow-lg shadow-accent/25 transition active:scale-[0.99] disabled:opacity-50"
            >
              <Download size={18} /> {saving ? "Preparing…" : "Export"}
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
          {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
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
                There are no unkept strips of yours available to discard. Kept
                memories stay protected here. Download this strip or wait for the weekly reset.
              </p>
            )}
          </div>
        </div>
      )}
      {exportOpen && <ExportStudio input={input} name={project.name} solo={project.mode === "solo"} settings={editor.exportSettings} onSettingsChange={settings => draft.patch({ exportSettings: settings })} saveError={draft.error || storageError} prepare={prepareExport} close={() => { setExportOpen(false); requestAnimationFrame(() => { if (mounted.current && document.activeElement === document.body) exportTrigger.current?.focus({ preventScroll: true }); }); }} />}
    </main>
  );
}

// Picker swatch that renders the real pattern over a frame color, at strip
// proportions so previews match the composed output.
function PatternPreview({
  frameColor,
  ink,
  patternId,
  className = "",
}: {
  frameColor: string;
  ink: string;
  patternId: string;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    // abstract units: 536 = width of a single-column strip (2*28 + 480)
    const k = canvas.width / 536;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const w = 536;
    const h = canvas.height / k;
    ctx.fillStyle = frameColor;
    ctx.fillRect(0, 0, w, h);
    getPattern(patternId)?.draw(ctx, w, h, ink);
  }, [frameColor, ink, patternId]);
  return <canvas ref={ref} width={96} height={128} className={className} />;
}
