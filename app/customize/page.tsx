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
  CircleAlert,
  Crop,
  Download,
  Heart,
  LoaderCircle,
  Mountain,
  Palette,
  RotateCcw,
  RotateCw,
  Share2,
  Sticker,
  Trash2,
  Type,
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
import { EditorFinishMenu } from "@/components/EditorFinishMenu";
import { StripPreview } from "@/components/StripPreview";
import dynamic from "next/dynamic";

const ExportStudio = dynamic(() => import("@/components/ExportStudio"), { ssr: false });

const STICKER_HIT_RADIUS = 60;
const EDITOR_TOOLS = [
  { value: "photos", label: "Photos & crop", short: "Photos", icon: Crop },
  { value: "look", label: "Frame & look", short: "Look", icon: Palette },
  { value: "scene", label: "Scenes & textures", short: "Scenes", icon: Mountain },
  { value: "stickers", label: "Stickers", short: "Stickers", icon: Sticker },
  { value: "caption", label: "Caption & date", short: "Caption", icon: Type },
  { value: "project", label: "Project & templates", short: "Project", icon: FolderOpen },
] as const;
type EditorTool = typeof EDITOR_TOOLS[number]["value"];
const toolTitle = "font-display text-lg";
const subTitle = "mb-2 text-sm font-bold text-muted-foreground";
const roundControl = "btn btn-quiet w-11 shrink-0 px-0";

export default function CustomizePage() {
  const { project, hydrating, storageError } = useBoothSession();
  if (hydrating) return <main className="m-auto flex items-center gap-2 p-8 text-sm font-bold text-muted-foreground" role="status"><LoaderCircle size={17} className="animate-spin motion-reduce:animate-none" aria-hidden />Opening your project…</main>;
  if (!project) return <main className="m-auto w-full max-w-lg px-4 py-8"><div className="panel flex flex-col items-center gap-4 px-6 py-10 text-center"><span className="glyph size-14 rounded-2xl bg-[#f43f5e]"><FolderOpen size={26} aria-hidden /></span><h1 className="font-display text-2xl sm:text-3xl">Choose a project to edit</h1>{storageError && <p role="alert" className="notice text-left">{storageError}</p>}<Link href="/projects" className="btn btn-primary">Open My projects</Link></div></main>;
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
  const toolClass = (tool: EditorTool) => `${activeTool === tool ? "flex" : "hidden"} panel flex-col gap-5 p-4 sm:p-5 md:flex`;
  const [pack, setPack] = useState(STICKER_PACKS[0].id);
  const [assetsTick, setAssetsTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const exportTrigger = useRef<HTMLButtonElement>(null);
  const mobileFinishTrigger = useRef<HTMLButtonElement>(null);
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
      setSaveError("Wait for this to finish, or close the export window, before you leave."); return false;
    }
    if (draft.pending || draft.error || storageStatus === "saving") {
      setActiveTool("project"); setSaveError("Some edits haven't saved yet. Save or discard them before you leave."); return false;
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
    } catch (error) { setSaveError(error instanceof Error ? error.message : "Couldn't undo or redo that change."); }
    finally { setRestoring(false); }
  };

  const navigate = async (path: string) => {
    try { await draft.flush(); router.push(path); }
    catch (error) { setSaveError(error instanceof Error ? error.message : "Your latest edits haven't saved yet. Try again before you leave."); }
  };

  const discardEdits = async () => {
    setRestoring(true);
    try {
      const saved = await openProject(project.id, project.scope);
      draft.discardUnsaved(); draft.replaceFromProject(saved.editor);
      setDiscardingEdits(false); setSaveError(null); setSelected(null);
    } catch (error) { setSaveError(error instanceof Error ? error.message : "Couldn't bring back your saved edits."); }
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
    if (activeTool !== "stickers" && window.matchMedia("(max-width: 767px)").matches) return;
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
    if (stickers.length >= 32) { setSaveError("You've hit the 32-sticker limit. Remove one to add another."); return; }
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
    if (!hasShots) throw new Error("There are no photos to export. Add some, or press Redo to bring the last ones back.");
    if (curated.loading) throw new Error("The artwork is still loading. Try exporting again in a moment.");
    if (editor.template?.slots.some(slot => [slot, ...(slot.companions ?? [])].some(source => !session.shots[source.role]?.[source.sourceIndex]))) throw new Error("Some template spots are still empty. Add those photos, then export.");
    try { await draft.flush(); }
    catch { setSaveError("Your latest edits haven't saved yet, but they're in this export."); }
    if (sceneId && (!cutouts || segmenting)) throw new Error("The Together scene is still being set up. Wait for it, or turn the scene off to export now.");
    if (stickerStyle === "noto" || theme?.stickerStyle === "noto" || editor.template?.layers.some(layer => layer.kind === "sticker" && layer.style === "noto")) await ensureNotoFont(getComputedStyle(document.documentElement).getPropertyValue("--font-noto-emoji").trim());
    if (stickerStyle !== "noto") {
      await preloadStickers(stickerStyle, stickers.map((s) => s.slug));
    }
    if (theme && theme.stickerStyle !== "noto") {
      await preloadStickers(theme.stickerStyle, theme.decor.map((d) => d.slug));
    }
    for (const layer of editor.template?.layers ?? []) if (layer.kind === "sticker" && layer.style !== "noto") await preloadStickers(layer.style, [layer.slug]);
    if (!mounted.current) throw new Error("The editor closed before the export finished.");
  };

  const exportBlob = async () => { await prepareExport(); return stripToBlob({ ...input, stickers }, 2); };

  const openExportStudio = async () => {
    setSaving(true); setSaveError(null);
    try { await prepareExport(); if (mounted.current) setExportOpen(true); }
    catch (error) { if (mounted.current) setSaveError(error instanceof Error ? error.message : "Couldn't open the export options."); }
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
      setSaveError(error instanceof Error ? error.message : "Couldn't export the strip.");
    } finally {
      setSaving(false);
    }
  };

  const downloadProject = async () => {
    setSaving(true); setSaveError(null);
    try {
      try { await draft.flush(); }
      catch { setSaveError("Your latest edits haven't saved yet, but they're in this backup."); }
      const blob = await exportProject(editor);
      if (!mounted.current) return;
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = projectDownloadName(project.name, "pbproject"); link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) { setSaveError(error instanceof Error ? error.message : "Couldn't back up the project."); }
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
      if (!(error instanceof DOMException && error.name === "AbortError")) setSaveError(error instanceof Error ? error.message : "Couldn't share it. Try downloading the strip instead.");
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
      setSaveError(error instanceof Error ? error.message : "Couldn't save to the Shared Vault. Try again.");
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
        setSaveError("That strip is still being deleted. Check your vault, then try again.");
        return;
      }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Couldn't delete that strip.");
      return;
    }
    await persistStrip();
  };

  const activePack = STICKER_PACKS.find((p) => p.id === pack) ?? STICKER_PACKS[0];

  const finishingActions = (compact: boolean) => <>
    <div className={compact ? "contents" : "flex gap-2"}>
      <button type="button" onClick={event => {
        exportTrigger.current = compact ? mobileFinishTrigger.current : event.currentTarget;
        void openExportStudio();
      }} disabled={saving}
        className={`btn btn-primary ${compact ? "w-full text-sm" : "min-h-12 flex-1 text-base"}`}>
        {saving ? <LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Download size={18} aria-hidden />} {saving ? "Preparing…" : "Export"}
      </button>
      <button type="button" onClick={share} disabled={saving} aria-label="Share"
        className={`btn btn-quiet ${compact ? "w-full text-sm" : "min-h-12 w-12 shrink-0 px-0"}`}>
        <Share2 size={18} aria-hidden /> {compact && "Share"}
      </button>
    </div>
    {authEnabled && <button type="button" onClick={saveToTimeline} disabled={saveState === "saving"}
      aria-label={saveState === "saved" ? "Saved to Shared Vault" : user ? "Save to our Shared Vault" : "Sign in to save"}
      className={`btn btn-quiet ${compact ? "w-full text-sm" : "w-full"}`}>
      {saveState === "saved" ? <Check size={18} className="text-success" aria-hidden /> : <Heart size={18} className="text-accent" aria-hidden />}
      {saveState === "saving" ? "Saving…" : saveState === "saved" ? compact ? "Saved" : "Saved to Shared Vault" : user ? compact ? "Save to vault" : "Save to our Shared Vault" : "Sign in to save"}
    </button>}
  </>;

  return (
    <main className="strip-editor flex h-[calc(100dvh-var(--app-nav-height,0px)-var(--app-bottom-nav-height,0px))] flex-col overflow-hidden md:flex-row md:items-stretch md:justify-center" aria-busy={restoring || saving || saveState === "saving"} inert={restoring || saving || saveState === "saving"} onKeyDown={event => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || restoring || exportOpen || saving) return;
      const target = event.target as HTMLElement;
      if (target.matches("input, textarea, select, [contenteditable='true']")) return;
      if (event.key.toLowerCase() === "z") { event.preventDefault(); void applyHistory(event.shiftKey ? "redo" : "undo"); }
      else if (event.key.toLowerCase() === "y") { event.preventDefault(); void applyHistory("redo"); }
    }}>
      <div className="strip-editor-preview relative flex shrink-0 items-center justify-center bg-muted/50 p-3 sm:p-4 md:my-3 md:ml-3 md:max-w-4xl md:flex-1 md:rounded-[2rem] md:p-6 md:shadow-[inset_0_0_0_1px_var(--panel-stroke)]">
        <EditorFinishMenu triggerRef={mobileFinishTrigger}>{finishingActions(true)}</EditorFinishMenu>
        <StripPreview input={input} assetsVersion={assetsTick} gesturesEnabled={activeTool !== "stickers"} className="contents">
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
            aria-label="Strip preview. Tap to enlarge, or choose Stickers to move a sticker with the arrow keys and Delete to remove it."
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
            onPointerCancel={onPointerUp}
            onLostPointerCapture={onPointerUp}
            className={`h-full w-full rounded-md shadow-[0_2px_4px_rgb(0_0_0/0.08),0_24px_48px_-16px_rgb(0_0_0/0.35)] md:touch-none ${activeTool === "stickers" ? "touch-none" : "touch-pan-y cursor-zoom-in md:cursor-auto"}`}
          />
        </div>
        </StripPreview>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:max-w-md xl:max-w-lg">
        <div className="shrink-0 space-y-2 px-4 pt-3 pb-2 md:space-y-3 md:px-5 md:pt-5">
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={() => void navigate(isShared ? session.roomCode ? `/room/${session.roomCode}` : "/projects" : "/booth")}
              className="btn btn-quiet min-h-10 pl-3 text-sm"
            >
              <ArrowLeft size={16} aria-hidden /> {isShared ? session.roomCode ? "Back to room" : "Back" : hasShots ? "Retake photos" : "Add photos"}
            </button>
            <div className="flex gap-1.5">
              <button type="button" aria-label="Undo edit" disabled={!project.history.past.length || draft.pending} onClick={() => void applyHistory("undo")} className="btn btn-quiet min-h-10 w-10 shrink-0 px-0"><Undo2 size={18} aria-hidden /></button>
              <button type="button" aria-label="Redo edit" disabled={!project.history.future.length || draft.pending} onClick={() => void applyHistory("redo")} className="btn btn-quiet min-h-10 w-10 shrink-0 px-0"><Redo2 size={18} aria-hidden /></button>
            </div>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h1 className="font-display text-2xl max-md:sr-only">
              Edit your strip
            </h1>
            <p role="status" className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground">{draft.error || storageError ? <CircleAlert size={14} className="text-destructive" aria-hidden /> : draft.pending || storageStatus === "saving" ? <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Check size={14} className="text-success" aria-hidden />}{draft.error || storageError ? "Some changes didn't save" : draft.pending || storageStatus === "saving" ? "Saving on this device…" : "Saved on this device"}</p>
          </div>
          {saveError && <p role="alert" className="notice max-h-24 overflow-y-auto border border-destructive/30 bg-destructive/10 font-bold">{saveError}</p>}
          <div className="-mx-4 overflow-x-auto px-4 pt-1 scrollbar-hide md:hidden">
            <div className="segmented" role="group" aria-label="Editing tool">
              {EDITOR_TOOLS.map(tool => <button key={tool.value} type="button" aria-pressed={activeTool === tool.value} onClick={() => { if (activeTool !== tool.value) { setActiveTool(tool.value); toolScroll.current?.scrollTo({ top: 0 }); } }} className="shrink-0"><tool.icon size={15} aria-hidden />{tool.short}</button>)}
            </div>
          </div>
        </div>
        <div ref={toolScroll} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 pt-2 pb-4 md:px-5 md:pb-5" aria-label="Editing tools">
          {!hasShots && <p className="notice">This version has no photos. Press Redo to bring them back, or choose Add photos.</p>}
          {(draft.error || storageError) && <div role="alert" className="notice border border-destructive/30 bg-destructive/10"><p className="font-bold break-words">{draft.error ?? storageError}</p><div className="mt-3 flex flex-wrap gap-2"><button className="btn btn-tinted min-h-10 text-sm" onClick={() => void draft.flush().catch(error => setSaveError(error.message))}>Try saving again</button>{draft.error && <button className="btn btn-plain min-h-10 text-sm" onClick={() => setDiscardingEdits(true)}>Discard unsaved edits</button>}</div></div>}
          {discardingEdits && <div className="notice"><p>Go back to your last saved edits? Unsaved changes will be lost.</p><div className="mt-3 flex flex-wrap gap-2"><button className="btn btn-danger min-h-10 text-sm" onClick={() => void discardEdits()}>Go back to saved edits</button><button className="btn btn-quiet min-h-10 text-sm" onClick={() => setDiscardingEdits(false)}>Keep editing</button></div></div>}
          {curated.loading && <p role="status" className="notice flex items-center gap-2 text-muted-foreground"><LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" aria-hidden />Loading artwork…</p>}
          {curated.fallback.length > 0 && <p role="status" className="notice">Couldn&apos;t load {curated.fallback.join(", ")}. Using a built-in background.</p>}
          <div className={toolClass("photos")}>
            {editor.template ? <><TemplateSourcePanel project={project} onImport={async (role, index, file) => { await draft.flush(); await importShot(role, index, file); }} /><button className="btn btn-tinted min-h-10 self-start text-sm" onClick={() => setField("template", null)}>Use the standard layout</button></> : <PhotoEditPanel project={project} editor={editor} change={draft.patch} reorder={async order => { await draft.flush(); await editProject({}, order); }} />}
          </div>

          <div className={toolClass("look")}>
          <h2 className={toolTitle}>Frame &amp; look</h2>
          <section>
            <h3 className={subTitle}>Theme</h3>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => applyTheme(null)}
                className={`flex h-[5.5rem] w-14 flex-col items-center justify-center rounded-2xl border-2 bg-muted text-[0.6875rem] font-bold ${
                  themeId === null ? "border-accent text-foreground" : "border-transparent text-muted-foreground"
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
                    className={`w-14 overflow-hidden rounded-2xl border-2 ${
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
                    <span className="block truncate bg-card px-1 py-1 text-center text-[0.6875rem] font-bold">
                      {t.name}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <h3 className={subTitle}>Frame</h3>
            <div className="flex flex-wrap gap-2">
              {FRAMES.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFrameId(f.id)}
                  aria-label={f.name}
                  title={f.name}
                  className={`h-11 w-11 rounded-full border-2 shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)] ${
                    frameId === f.id ? "border-accent scale-110" : "border-border"
                  }`}
                  style={{ background: f.color }}
                />
              ))}
            </div>
          </section>

          <section>
            <h3 className={subTitle}>Pattern</h3>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setPatternId("none")}
                className={`flex h-16 w-12 items-center justify-center rounded-xl border-2 bg-muted text-[0.6875rem] font-bold ${
                  patternId === "none" ? "border-accent text-foreground" : "border-transparent text-muted-foreground"
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
                  className={`h-16 w-12 overflow-hidden rounded-xl border-2 ${
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
            <h3 className={subTitle}>Filter</h3>
            <div className="-mx-1">
              <FilterBar
                value={editor.filterId}
                onChange={(id) => setField("filterId", id)}
                layoutClass="flex-wrap"
              />
            </div>
          </section>

          </div>
          <div className={toolClass("scene")}>
          <h2 className={toolTitle}>Scenes &amp; textures</h2>
          <VisualPackPicker sceneId={sceneId} materialId={editor.materialId ?? null} onSceneChange={setSceneId} onMaterialChange={id => setField("materialId", id)} />
          {(sceneId || segFailed) && (
            <section className="border-t border-border pt-4">
              <h3 className={subTitle}>
                Scene placement
              </h3>
              {segmenting && (
                <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" aria-hidden />
                  Cutting out the background…
                </p>
              )}
              {segFailed && (
                <p className="mt-1 text-xs font-bold text-destructive">
                  Couldn&apos;t cut out the background on this device.
                </p>
              )}
              {sceneId && cutouts && !editor.template && (
                <div className="mt-2 flex flex-col gap-3">
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
                      <div key={side} className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`w-14 text-xs font-bold ${
                            mine ? "text-accent" : "text-partner"
                          }`}
                        >
                          {label}
                        </span>
                        <button aria-label={`${side} left`} onClick={() => nudge(-0.04, 0, 0)} className={roundControl}><ChevronLeft size={16} aria-hidden /></button>
                        <button aria-label={`${side} right`} onClick={() => nudge(0.04, 0, 0)} className={roundControl}><ChevronRight size={16} aria-hidden /></button>
                        <button aria-label={`${side} up`} onClick={() => nudge(0, -0.03, 0)} className={roundControl}><ChevronUp size={16} aria-hidden /></button>
                        <button aria-label={`${side} down`} onClick={() => nudge(0, 0.03, 0)} className={roundControl}><ChevronDown size={16} aria-hidden /></button>
                        <button aria-label={`${side} smaller`} onClick={() => nudge(0, 0, -0.08)} className={roundControl}><ZoomOut size={16} aria-hidden /></button>
                        <button aria-label={`${side} bigger`} onClick={() => nudge(0, 0, 0.08)} className={roundControl}><ZoomIn size={16} aria-hidden /></button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}
          </div>

          <div className={toolClass("stickers")}>
          <section className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5"><h2 className={toolTitle}>Stickers</h2><HelpTooltip label="About placing stickers">Select a sticker on the strip, then drag or use the arrow keys to move it.</HelpTooltip></div>
              {selected !== null && (
                <div className="flex gap-1">
                  <button aria-label="Smaller" onClick={() => editSelected((s) => ({ ...s, scale: Math.max(0.4, s.scale - 0.15) }))} className={roundControl}><ZoomOut size={16} aria-hidden /></button>
                  <button aria-label="Bigger" onClick={() => editSelected((s) => ({ ...s, scale: Math.min(3, s.scale + 0.15) }))} className={roundControl}><ZoomIn size={16} aria-hidden /></button>
                  <button aria-label="Rotate left" onClick={() => editSelected((s) => ({ ...s, rotation: s.rotation - Math.PI / 12 }))} className={roundControl}><RotateCcw size={16} aria-hidden /></button>
                  <button aria-label="Rotate right" onClick={() => editSelected((s) => ({ ...s, rotation: s.rotation + Math.PI / 12 }))} className={roundControl}><RotateCw size={16} aria-hidden /></button>
                  <button aria-label="Delete sticker" onClick={deleteSelected} className="btn btn-danger w-11 shrink-0 px-0"><Trash2 size={16} aria-hidden /></button>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap gap-1.5">
                {STICKER_PACKS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setPack(p.id)}
                    className={`min-h-11 shrink-0 rounded-full px-3.5 text-[0.8125rem] font-bold ${
                      pack === p.id ? "bg-foreground text-background" : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
              <div className="segmented shrink-0">
                {STICKER_STYLES.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setStickerStyle(s.id)}
                    aria-pressed={stickerStyle === s.id}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="panel-muted grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-1 p-2">
              {activePack.stickers.map((def) => (
                <button
                  key={def.slug}
                  onClick={() => addSticker(def)}
                  aria-label={def.slug.replaceAll("_", " ")}
                  className="flex h-11 items-center justify-center rounded-xl hover:bg-card"
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
          <h2 className={toolTitle}>Caption &amp; date</h2>
          <section className="flex items-center gap-2">
            <input
              value={caption}
              aria-label="Strip caption"
              onChange={(e) => setCaption(e.target.value.slice(0, 30))}
              placeholder="Add a caption…"
              className="field min-w-0 flex-1 text-base"
            />
            <button
              onClick={() => setShowDate((d) => !d)}
              aria-pressed={showDate}
              aria-label="Show date stamp"
              className={`flex size-[2.875rem] shrink-0 items-center justify-center rounded-full ${
                showDate
                  ? "bg-datestamp/15 text-datestamp shadow-[inset_0_0_0_2px_var(--datestamp)]"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              <Calendar size={18} aria-hidden />
            </button>
          </section>
          </div>

          <div className={toolClass("project")}>
          <h2 className={toolTitle}>Project &amp; templates</h2>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void navigate("/projects")} className="btn btn-quiet min-h-10 text-sm"><FolderOpen size={16} aria-hidden /> My projects</button>
            <button type="button" onClick={() => void navigate("/templates")} className="btn btn-quiet min-h-10 text-sm">Templates</button>
            <button type="button" onClick={() => void navigate("/templates/design")} className="btn btn-quiet min-h-10 text-sm">Frame designer</button>
            {!isShared && <button type="button" onClick={() => void navigate("/booth#then-now")} className="btn btn-quiet min-h-10 text-sm">Then &amp; now</button>}
          </div>
          <button onClick={() => void downloadProject()} disabled={saving} className="btn btn-tinted min-h-10 self-start text-sm"><Download size={16} aria-hidden /> Back up this project</button>
          </div>
        </div>

        <div className="mx-4 mb-4 hidden max-h-[35dvh] shrink-0 flex-col gap-2 overflow-y-auto rounded-[1.75rem] p-2 glass md:mx-5 md:mb-5 md:flex">
          {finishingActions(false)}
        </div>
      </div>

      {capChoices !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(16_10_13/0.32)] p-4 backdrop-blur-[6px] motion-safe:animate-[surface-enter_220ms_ease-out]">
          <div className="glass-strong flex max-h-[85dvh] w-full max-w-md flex-col gap-4 overflow-hidden rounded-[1.75rem] p-5 sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-xl">
                  This week&apos;s vault is full
                </h2>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  You&apos;ve saved {WEEKLY_STRIP_CAP} strips this week. Discard one
                  to make room, or keep them all and save this next week.
                </p>
              </div>
              <button
                onClick={() => setCapChoices(null)}
                aria-label="Cancel"
                className={roundControl}
              >
                <X size={18} aria-hidden />
              </button>
            </div>

            {capChoices.some((s) => s.mine) ? (
              <div className="grid grid-cols-3 gap-3 overflow-y-auto p-0.5">
                {capChoices
                  .filter((s) => s.mine)
                  .map((s) => (
                    <button
                      key={s.id}
                      onClick={() => discardAndSave(s)}
                      className="group relative overflow-hidden rounded-xl shadow-[inset_0_0_0_1px_var(--panel-stroke)]"
                      aria-label="Discard this strip and save the new one"
                    >
                      {s.url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={s.url} alt={s.caption ?? "Photo strip"} className="aspect-[3/4] w-full object-cover" />
                      )}
                      <span className="absolute inset-0 flex items-center justify-center bg-destructive/0 opacity-0 transition group-hover:bg-destructive/70 group-hover:opacity-100 group-focus-visible:bg-destructive/70 group-focus-visible:opacity-100">
                        <Trash2 size={20} className="text-white" aria-hidden />
                      </span>
                    </button>
                  ))}
              </div>
            ) : (
              <p className="notice text-muted-foreground">
                None of your strips from this week can be removed. Download this one
                instead, or wait for the weekly reset.
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
