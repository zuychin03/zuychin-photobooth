"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";

import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Download, Plus, Redo2, Save, Trash2, Undo2 } from "lucide-react";
import { Dropdown } from "@/components/Dropdown";
import { StripStyleControls } from "@/components/StripStyleControls";
import { resolveStrip, withStrip } from "@/lib/strip-style";
import { VisualPackPicker } from "@/components/VisualPackPicker";
import { PageHeader } from "@/components/ui/PageHeader";
import { useCuratedAssets } from "@/hooks/useCuratedAssets";
import { useAuth } from "@/lib/auth";
import { composeStrip, type ComposeInput, type ShotSet } from "@/lib/compose";
import { FRAMES, STICKER_PACKS, STICKER_STYLES } from "@/lib/decor";
import { FILTERS } from "@/lib/filters";
import { getLayout, ROLES, type Role } from "@/lib/layouts";
import { PATTERNS } from "@/lib/patterns";
import { createProject } from "@/lib/projects/model";
import { inspectProjectImage, projectImageToCanvas } from "@/lib/projects/images";
import { downloadProjectBlob, projectDownloadName } from "@/lib/projects/download";
import { RESOURCE_LIMITS, validateMediaResource } from "@/lib/projects/resource-bounds";
import { useBoothSession } from "@/lib/session";
import { cutout } from "@/lib/segmentation";
import { ensureNotoFont, preloadStickers } from "@/lib/sticker-assets";
import { getTheme } from "@/lib/themes";
import { exportTemplateBundle } from "@/lib/templates/bundle";
import { moveTemplateItem, newTemplateSlot, reviseTemplate } from "@/lib/templates/designer";
import { templateFromProject } from "@/lib/templates/from-project";
import { templateSchemaFor, validateTemplateRecipe, type TemplateDesign, type TemplateLayer, type TemplatePhotoSlot, type TemplateRecipe, type TemplateScope } from "@/lib/templates/model";
import { openTemplateShelf } from "@/lib/templates/storage";

const button = "btn btn-quiet min-h-10 text-sm";
const field = "field font-medium";
const panelTitle = "font-display text-lg";
const shell = "mx-auto flex min-h-dvh w-full flex-1 flex-col gap-6 px-4 pt-4 pb-10 sm:px-8 sm:pt-6";
const loadingNote = "m-auto p-8 text-sm font-bold text-muted-foreground";

export default function DesignerPage() { return <Suspense fallback={<p className={loadingNote} role="status">Opening frame designer…</p>}><DesignerEntry /></Suspense>; }

function DesignerEntry() {
  const query = useSearchParams(), { user, loading } = useAuth();
  if (loading) return <p className={loadingNote} role="status">Opening frame designer…</p>;
  return <Designer key={JSON.stringify([user?.id ?? null, query.get("template"), query.get("scope")])} />;
}

function Designer() {
  const query = useSearchParams(), router = useRouter(), { user, loading } = useAuth();
  const { project, session, hydrating, flushEditor, getDecorationBlobs, applyTemplate } = useBoothSession();
  const id = query.get("template"), accountScope = query.get("scope") === "account", owner = user?.id ?? null;
  const [design, setDesign] = useState<TemplateDesign | null>(null), [recipe, setRecipe] = useState<TemplateRecipe | null>(null);
  const [name, setName] = useState("My frame"), [selected, setSelected] = useState<string | null>(null);
  const [past, setPast] = useState<TemplateDesign[]>([]), [future, setFuture] = useState<TemplateDesign[]>([]);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [status, setStatus] = useState("");
  const [includeText, setIncludeText] = useState(false), [leaveTo, setLeaveTo] = useState<string | null>(null), [tick, setTick] = useState(0);
  const [cuts, setCuts] = useState<{ sources: ShotSet; value: ShotSet } | null>(null), [segmenting, setSegmenting] = useState(false);
  const blobs = useRef(new Map<string, Blob>()), images = useRef(new Map<string, HTMLCanvasElement>()), canvas = useRef<HTMLCanvasElement>(null);
  const lifetime = useRef(0);
  const working = useRef(false), navigatingToSaved = useRef(false);
  const templatesButton = useRef<HTMLButtonElement>(null), keepDesigning = useRef<HTMLButtonElement>(null);
  const leaveTrigger = useRef<HTMLElement | null>(null);
  const allowNavigation = (path: string) => {
    if (working.current || busy) { setStatus("Wait for your design to finish saving."); return false; }
    if (!dirty) return true;
    leaveTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setLeaveTo(path); return false;
  };
  useAppNavigationGuard(allowNavigation);
  useLayoutEffect(() => { if (leaveTo) keepDesigning.current?.focus(); }, [leaveTo]);
  useLayoutEffect(() => () => { lifetime.current++; }, []);
  const scope = useMemo<TemplateScope>(() => owner ? { kind: "account", ownerId: owner } : { kind: "device" }, [owner]);
  const curated = useCuratedAssets(design?.look.sceneId ?? null, design?.look.materialId ?? null);

  useEffect(() => {
    if (loading || hydrating) return;
    const token = ++lifetime.current, decoded = new Map<string, HTMLCanvasElement>();
    const load = async () => {
      setDesign(null); setError(null); setStatus(""); setDirty(false); setPast([]); setFuture([]);
      let source: TemplateDesign, stored: TemplateRecipe | null = null, files: ReadonlyMap<string, Blob>;
      if (id) {
        if (accountScope && !owner) throw new Error("This template belongs to an account. Sign in to that account to open it.");
        const shelf = await openTemplateShelf(accountScope ? { kind: "account", ownerId: owner! } : { kind: "device" });
        try {
          const loaded = await shelf.load(id);
          if (!loaded || loaded.kind !== "current") throw new Error("This template can't be opened here. Download its recovery files from My templates.");
          stored = loaded.recipe; source = templateFromRecipe(stored); files = loaded.decorations;
        } finally { shelf.close(); }
      } else {
        const active = await flushEditor(); source = templateFromProject(active ?? createProject()); files = getDecorationBlobs();
      }
      for (const media of source.decorations) {
        const blob = files.get(media.id); if (!blob) throw new Error("One of the PNG decorations is missing.");
        const image = await projectImageToCanvas(blob, media);
        if (lifetime.current !== token) { image.width = image.height = 0; return; }
        decoded.set(media.id, image);
      }
      if (lifetime.current !== token) return;
      images.current = decoded; blobs.current = new Map(files);
      setRecipe(stored); setName(stored?.name ?? "My frame"); setDesign(source); setSelected(source.slots[0]?.id ?? null);
    };
    void load().catch(error => { if (lifetime.current === token) setError(error instanceof Error ? error.message : "Couldn't open the frame designer."); });
    const generation = lifetime;
    return () => { generation.current++; for (const image of decoded.values()) releaseCanvas(image); };
  }, [id, accountScope, owner, loading, hydrating, flushEditor, getDecorationBlobs]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    const retained = new Set([...(design ? [design] : []), ...past, ...future].flatMap(value => value.decorations.map(item => item.id)));
    for (const [id, image] of images.current) if (!retained.has(id)) { releaseCanvas(image); images.current.delete(id); blobs.current.delete(id); }
  }, [design, past, future]);

  const sceneEnabled = Boolean(design?.look.sceneId);
  useEffect(() => {
    let active = true;
    const prepare = async () => {
      if (!sceneEnabled) { setSegmenting(false); return; }
      setSegmenting(true);
      try {
        const value: Required<ShotSet> = { A: [], B: [], C: [], D: [] };
        for (const role of ROLES) for (const shot of session.shots[role]) {
          if (!active) return; value[role].push(shot ? await cutout(shot) : null);
        }
        if (active) setCuts({ sources: session.shots, value });
      } catch { if (active) { setCuts(null); setStatus("Background removal doesn't work on this device."); } }
      finally { if (active) setSegmenting(false); }
    };
    void prepare(); return () => { active = false; };
  }, [sceneEnabled, session.shots]);

  const input = useMemo<ComposeInput | null>(() => {
    if (!design) return null;
    const frame = FRAMES.find(frame => frame.id === design.look.frameId)!;
    return { layout: getLayout(project?.editor.layoutId ?? "strip4"), shots: session.shots, template: design,
      style: { frameColor: frame.color, inkColor: frame.ink, frameGradient: frame.gradient ?? null, patternId: design.look.patternId, filterId: design.look.filterId, ...design.defaults, stickerStyle: "flat" }, strip: design.look.strip,
      stickers: [], theme: getTheme(design.look.themeId), together: design.look.sceneId ? { sceneId: design.look.sceneId, places: design.places ?? {} } : null,
      cutouts: cuts?.sources === session.shots ? cuts.value : undefined, materialId: design.look.materialId, resources: curated.resources,
      capturedAt: project?.capturedAt, captureTimeZone: project?.captureTimeZone };
  }, [design, project, session.shots, cuts, curated.resources]);
  useEffect(() => {
    if (!design) return;
    let active = true;
    const load = async () => {
      for (const style of STICKER_STYLES) {
        const slugs = design.layers.filter(layer => layer.kind === "sticker" && layer.style === style.id).map(layer => (layer as Extract<TemplateLayer, { kind: "sticker" }>).slug);
        if (style.id === "noto") await ensureNotoFont(getComputedStyle(document.documentElement).getPropertyValue("--font-noto-emoji").trim());
        else await preloadStickers(style.id, slugs);
      }
      if (active) setTick(value => value + 1);
    };
    void load(); return () => { active = false; };
  }, [design]);
  useEffect(() => {
    void tick;
    if (!canvas.current || !input) return;
    composeStrip(canvas.current, { ...input, decorations: images.current });
    const item = [...input.template!.slots, ...input.template!.layers].find(item => item.id === selected);
    if (item) {
      const ctx = canvas.current.getContext("2d")!, { width, height } = input.template!.canvas;
      ctx.strokeStyle = "#e11d48"; ctx.lineWidth = Math.max(2, width / 250); ctx.setLineDash([8, 5]);
      ctx.strokeRect(item.x * width, item.y * height, item.width * width, item.height * height);
    }
  }, [input, selected, tick]);

  const change = (next: TemplateDesign) => {
    if (!design) return;
    setPast(values => [...values, design].slice(-20)); setFuture([]); setDesign(next); setDirty(true); setError(null); setStatus("");
  };
  const edit = (patch: Partial<TemplateDesign>) => { if (design) try { change(reviseTemplate(design, patch)); } catch (error) { setError(error instanceof Error ? error.message : "That goes over the template's limits."); } };
  const slot = design?.slots.find(item => item.id === selected), layer = design?.layers.find(item => item.id === selected), item = slot ?? layer;
  const updateSlot = (patch: Partial<TemplatePhotoSlot>) => { if (design && slot) edit({ slots: design.slots.map(value => value.id === slot.id ? Object.fromEntries(Object.entries({ ...value, ...patch }).filter(([, value]) => value !== undefined)) as unknown as TemplatePhotoSlot : value) }); };
  const updateLayer = (next: TemplateLayer) => { if (design) edit({ layers: design.layers.map(value => value.id === next.id ? next : value) }); };
  const setBounds = (key: "x" | "y" | "width" | "height", value: number) => {
    if (!item) return;
    const next = { ...item, [key]: value / 100 };
    next.width = Math.min(1, Math.max(0.001, next.width)); next.height = Math.min(1, Math.max(0.001, next.height));
    next.x = Math.min(1 - next.width, Math.max(0, next.x)); next.y = Math.min(1 - next.height, Math.max(0, next.y));
    if ("kind" in next) updateLayer(next); else updateSlot(next);
  };
  const makeRecipe = (copy = false) => {
    if (!design) throw new Error("Open a design first.");
    const now = new Date().toISOString();
    return validateTemplateRecipe({ ...design, schemaVersion: templateSchemaFor(design), id: copy || !recipe ? crypto.randomUUID() : recipe.id, name,
      scope: recipe?.scope ?? scope, revision: copy || !recipe ? 0 : recipe.revision + 1, createdAt: copy || !recipe ? now : recipe.createdAt, updatedAt: now });
  };
  const filesForDesign = () => new Map((design?.decorations ?? []).map(media => [media.id, blobs.current.get(media.id)!]));
  const work = async (action: (assertCurrent: () => void) => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    const token = lifetime.current; setBusy(true); setError(null);
    const assertCurrent = () => { if (token !== lifetime.current) throw new Error("You switched designs or accounts."); };
    try { await action(assertCurrent); } catch (error) { if (token === lifetime.current) setError(error instanceof Error ? error.message : "That didn't work, but your design is still here."); }
    finally { if (token === lifetime.current && !navigatingToSaved.current) { working.current = false; setBusy(false); } }
  };
  const save = (copy = false) => work(async assertCurrent => {
    const next = makeRecipe(copy), files = filesForDesign(), shelf = await openTemplateShelf(next.scope);
    try {
      assertCurrent(); const saved = await shelf.save(next, files, copy ? null : recipe?.revision ?? null); assertCurrent();
      setRecipe(saved); setDirty(false); setStatus("Template saved.");
      if (id !== saved.id || accountScope !== (saved.scope.kind === "account")) {
        router.replace(`/templates/design?template=${encodeURIComponent(saved.id)}&scope=${saved.scope.kind}`, { scroll: false });
        navigatingToSaved.current = true;
      }
    } finally { shelf.close(); }
  });
  const go = (path: string) => { if (allowNavigation(path)) router.push(path); };
  const addLayer = (kind: "text" | "sticker") => {
    if (!design) return;
    const base = { id: crypto.randomUUID(), x: 0.1, y: 0.75, width: 0.8, height: 0.1, rotation: 0 };
    const next: TemplateLayer = kind === "text" ? { ...base, kind, text: "Your words", personal: true, font: "serif", fontSize: 0.04, colour: "#1c1917", align: "center" }
      : { ...base, width: 0.15, height: 0.15, kind, slug: STICKER_PACKS[0].stickers[0].slug, style: "flat" };
    edit({ layers: [...design.layers, next] }); setSelected(next.id);
  };

  if (!design) return <main className={`${shell} max-w-5xl`}><PageHeader title="Frame designer" leading={<button className="btn btn-plain -ml-3.5 min-h-10 text-sm" onClick={() => router.push("/templates")}><ArrowLeft size={16} aria-hidden /> Templates</button>} /><div className="page-body"><p className={error ? "notice border border-destructive/30 bg-destructive/10 font-bold" : "panel flex min-h-48 items-center justify-center p-6 text-sm font-bold text-muted-foreground"} role={error ? "alert" : "status"}>{error ?? "Opening your design…"}</p></div></main>;
  return <main className={`${shell} max-w-7xl`} aria-busy={busy}>
    <PageHeader title="Frame designer"
      leading={<button ref={templatesButton} disabled={busy} className="btn btn-plain -ml-3.5 min-h-10 text-sm" onClick={() => go("/templates")}><ArrowLeft size={16} aria-hidden /> Templates</button>}
      meta={<p role="status">{busy ? "Working…" : status || (dirty ? "Unsaved changes" : "Ready to edit")}</p>}
      actions={<><button className="btn btn-quiet" disabled={busy} onClick={() => void save()}><Save size={16} aria-hidden /> Save template</button><button className="btn btn-primary" disabled={busy || !project || segmenting || curated.loading} onClick={() => void work(async assertCurrent => { assertCurrent(); await applyTemplate(design, filesForDesign()); assertCurrent(); setDirty(false); router.push("/customize"); })}>Apply to project</button></>} />
    <div className="page-body flex flex-col gap-5">
    {leaveTo && <div role="group" aria-label="Unsaved template changes" className="notice"><p>Leave without saving this template? Your project stays as it was.</p><div className="mt-3 flex flex-wrap gap-2"><button ref={keepDesigning} disabled={busy} className={button} onClick={() => { setLeaveTo(null); const target = leaveTrigger.current; requestAnimationFrame(() => { if (target?.isConnected && !target.matches(":disabled") && !target.closest("[inert]")) target.focus(); else templatesButton.current?.focus(); }); }}>Keep designing</button><button disabled={busy} className="btn btn-danger min-h-10 text-sm" onClick={() => { if (!working.current) router.push(leaveTo); }}>Leave designer</button></div></div>}
    {error && <p role="alert" className="notice border border-destructive/30 bg-destructive/10 font-bold">{error}</p>}
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]" inert={busy}>
      <section className="panel p-3 sm:p-4" aria-label="Frame preview"><div className="lg:sticky lg:top-[5.5rem]">
        <div className="panel-muted flex min-h-72 justify-center p-5 sm:p-8">
          <canvas ref={canvas} tabIndex={0} aria-label="Frame preview. Select an item from the dropdown, then use arrow keys to move it." className="max-h-[60dvh] max-w-full rounded-sm object-contain shadow-[0_2px_4px_rgb(0_0_0/0.08),0_24px_48px_-16px_rgb(0_0_0/0.3)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring" style={{ aspectRatio: `${design.canvas.width}/${design.canvas.height}` }} onClick={event => {
            const rect = event.currentTarget.getBoundingClientRect(), x = (event.clientX - rect.left) / rect.width, y = (event.clientY - rect.top) / rect.height;
            setSelected([...design.slots, ...design.layers].reverse().find(item => x >= item.x && x <= item.x + item.width && y >= item.y && y <= item.y + item.height)?.id ?? null);
          }} onKeyDown={event => {
            if (!item || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault(); const step = event.shiftKey ? 0.05 : 0.005;
            change(moveTemplateItem(design, item.id, item.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), item.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0)));
          }} />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 px-1"><p className="text-sm font-bold text-muted-foreground tabular-nums">{design.canvas.width} × {design.canvas.height} px · {design.slots.length}/16 photo slots</p><div className="flex gap-1.5"><button className="btn btn-quiet min-h-10 w-10 px-0" aria-label="Undo design change" disabled={!past.length} onClick={() => { setFuture(values => [design, ...values]); setDesign(past[past.length - 1]); setPast(past.slice(0, -1)); setDirty(true); }}><Undo2 size={18} aria-hidden /></button><button className="btn btn-quiet min-h-10 w-10 px-0" aria-label="Redo design change" disabled={!future.length} onClick={() => { setPast(values => [...values, design]); setDesign(future[0]); setFuture(future.slice(1)); setDirty(true); }}><Redo2 size={18} aria-hidden /></button></div></div>
        {segmenting && <p role="status" className="notice mt-3">Preparing the scene preview…</p>}
        {curated.fallback.length > 0 && <p className="notice mt-3">Couldn&apos;t load {curated.fallback.join(", ")}. Using a built-in background.</p>}
        {!project && <p className="notice mt-3">Save this frame, then start a new project with it from My templates.</p>}</div>
      </section>
      <div className="tile-stack min-w-0 gap-4">
        <section className="panel space-y-3 p-4 sm:p-5"><label className="block text-sm font-bold">Template name<input className={`${field} mt-1.5`} value={name} maxLength={100} onChange={event => { setName(event.target.value); setDirty(true); }} /></label><div className="grid grid-cols-2 gap-3"><NumberField label="Canvas width" value={design.canvas.width} min={128} max={4096} change={width => edit({ canvas: { ...design.canvas, width } })} /><NumberField label="Canvas height" value={design.canvas.height} min={128} max={4096} change={height => edit({ canvas: { ...design.canvas, height } })} /></div></section>
        <section className="panel space-y-4 p-4 sm:p-5"><h2 className={panelTitle}>Photos and layers</h2><div className="flex flex-wrap gap-2"><button className={button} disabled={design.slots.length >= 16} onClick={() => { const next = newTemplateSlot(design, crypto.randomUUID()); edit({ slots: [...design.slots, next] }); setSelected(next.id); }}><Plus size={16} aria-hidden /> Photo</button><button className={button} disabled={design.layers.filter(layer => layer.kind === "text").length >= 16} onClick={() => addLayer("text")}><Plus size={16} aria-hidden /> Text</button><button className={button} disabled={design.layers.filter(layer => layer.kind === "sticker").length >= 32} onClick={() => addLayer("sticker")}><Plus size={16} aria-hidden /> Sticker</button>
          <label className={`${button} relative cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring`}><Plus size={16} aria-hidden /> PNG decoration<input className="sr-only" type="file" accept="image/png" aria-label="Add PNG decoration" disabled={design.decorations.length >= 8} onChange={event => {
            const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
            void work(async assertCurrent => {
              if (file.size > 4 * 1024 * 1024) throw new Error("Choose a PNG under 4 MB.");
              const token = lifetime.current, info = await inspectProjectImage(file);
              const media = validateMediaResource({ ...info, id: crypto.randomUUID(), kind: "decoration", bytes: file.size });
              assertCurrent();
              if (images.current.size >= RESOURCE_LIMITS.files || [...blobs.current.values()].reduce((sum, blob) => sum + blob.size, file.size) > RESOURCE_LIMITS.totalEncodedBytes || [...images.current.values()].reduce((sum, image) => sum + image.width * image.height, media.width * media.height) > RESOURCE_LIMITS.totalPixels) throw new Error("That's as many images as the designer can hold, counting your undo history. Save and reopen the template to add another.");
              const image = await projectImageToCanvas(file, info); if (token !== lifetime.current) { image.width = image.height = 0; return; }
              const next: TemplateLayer = { id: crypto.randomUUID(), kind: "decoration", mediaId: media.id, fit: "contain", x: 0.1, y: 0.1, width: 0.3, height: 0.3, rotation: 0 };
              try { const changed = reviseTemplate(design, { decorations: [...design.decorations, media], layers: [...design.layers, next] }); blobs.current.set(media.id, file.slice(0, file.size, "image/png")); images.current.set(media.id, image); change(changed); setSelected(next.id); }
              catch (error) { image.width = image.height = 0; throw error; }
            });
          }} /></label></div>
          <Dropdown showLabel label="Selected item" value={selected ?? ""} options={[...design.slots.map((slot, index) => ({ value: slot.id, label: `Photo slot ${index + 1} · ${slot.role}${slot.sourceIndex + 1}` })), ...design.layers.map((layer, index) => ({ value: layer.id, label: `${layer.kind === "text" ? "Text" : layer.kind === "sticker" ? "Sticker" : "PNG"} ${index + 1}` }))]} onChange={setSelected} />
          {item && <div className="space-y-4 border-t border-border pt-4"><div className="grid grid-cols-2 gap-3">{(["x", "y", "width", "height"] as const).map(key => <NumberField key={key} label={`${key === "x" ? "Left" : key === "y" ? "Top" : key === "width" ? "Width" : "Height"} (%)`} value={Number((item[key] * 100).toFixed(2))} min={key === "x" || key === "y" ? 0 : 0.1} max={100} change={value => setBounds(key, value)} />)}</div>
            {slot && <><div className="grid grid-cols-2 gap-3"><Dropdown showLabel label="Person" value={slot.role} options={ROLES.map(role => ({ value: role, label: role }))} onChange={role => updateSlot({ role: role as Role, companions: slot.companions?.filter(source => source.role !== role) })} /><Dropdown showLabel label="Source photo" value={String(slot.sourceIndex)} options={[0, 1, 2, 3].map(index => ({ value: String(index), label: `Photo ${index + 1}` }))} onChange={value => updateSlot({ sourceIndex: Number(value) })} /></div>
              <NumberField label="Photo zoom" value={slot.crop.zoom} min={1} max={4} change={zoom => updateSlot({ crop: { ...slot.crop, zoom } })} />
              <div className="grid grid-cols-2 gap-3"><NumberField label="Photo pan X" value={slot.crop.offsetX} min={-1} max={1} change={offsetX => updateSlot({ crop: { ...slot.crop, offsetX } })} /><NumberField label="Photo pan Y" value={slot.crop.offsetY} min={-1} max={1} change={offsetY => updateSlot({ crop: { ...slot.crop, offsetY } })} /></div>
              <Dropdown showLabel label="Photo rotation" value={String(slot.crop.rotation)} options={[0, 90, 180, 270].map(value => ({ value: String(value), label: `${value}°` }))} onChange={value => updateSlot({ crop: { ...slot.crop, rotation: Number(value) as 0 | 90 | 180 | 270 } })} />
              <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-bold"><input type="checkbox" checked={slot.crop.mirror} onChange={event => updateSlot({ crop: { ...slot.crop, mirror: event.target.checked } })} className="size-5" /> Mirror photo</label>
              <Dropdown showLabel label="Photo filter" value={slot.filterId ?? "inherit"} options={[{ value: "inherit", label: "Same as the frame" }, ...FILTERS.map(filter => ({ value: filter.id, label: filter.name }))]} onChange={value => updateSlot({ filterId: value === "inherit" ? null : value })} />
              {slot.companions?.length ? <p className="text-sm text-muted-foreground">{slot.role} shares this slot with {slot.companions.map(source => source.role).join(", ")} in a Together scene.</p> : null}
            </>}
            {layer && <><NumberField label="Layer rotation (°)" value={layer.rotation} min={-180} max={180} change={rotation => updateLayer({ ...layer, rotation })} />
              {layer.kind === "text" && <><label className="block text-sm font-bold">Text<textarea className={`${field} mt-1.5 min-h-24 py-2.5`} value={layer.text} maxLength={500} onChange={event => updateLayer({ ...layer, text: event.target.value })} /></label><Dropdown showLabel label="Typeface" value={layer.font} options={[{ value: "serif", label: "Fraunces" }, { value: "sans", label: "Geist" }, { value: "mono", label: "Geist Mono" }]} onChange={value => updateLayer({ ...layer, font: value as "serif" | "sans" | "mono" })} /><NumberField label="Text size (% of width)" value={layer.fontSize * 100} min={0.5} max={25} change={value => updateLayer({ ...layer, fontSize: value / 100 })} /><Dropdown showLabel label="Text alignment" value={layer.align} options={[{ value: "left", label: "Left" }, { value: "center", label: "Centre" }, { value: "right", label: "Right" }]} onChange={value => updateLayer({ ...layer, align: value as "left" | "center" | "right" })} /><label className="flex min-h-11 items-center justify-between text-sm font-bold">Text colour<input type="color" value={layer.colour} onChange={event => updateLayer({ ...layer, colour: event.target.value })} className="h-11 w-16 cursor-pointer rounded-xl" /></label></>}
              {layer.kind === "sticker" && <><Dropdown showLabel label="Sticker" value={layer.slug} options={STICKER_PACKS.flatMap(pack => pack.stickers.map(sticker => ({ value: sticker.slug, label: sticker.slug.replaceAll("_", " ") })))} onChange={slug => updateLayer({ ...layer, slug })} /><Dropdown showLabel label="Sticker style" value={layer.style} options={STICKER_STYLES.map(style => ({ value: style.id, label: style.name }))} onChange={style => updateLayer({ ...layer, style: style as typeof layer.style })} /></>}
              {layer.kind === "decoration" && <Dropdown showLabel label="Decoration fit" value={layer.fit} options={[{ value: "contain", label: "Show whole image" }, { value: "cover", label: "Fill and crop" }]} onChange={fit => updateLayer({ ...layer, fit: fit as "contain" | "cover" })} />}
              <div className="flex flex-wrap gap-2"><button className={button} onClick={() => edit({ layers: [layer, ...design.layers.filter(value => value.id !== layer.id)] })}>Send to back</button><button className={button} onClick={() => edit({ layers: [...design.layers.filter(value => value.id !== layer.id), layer] })}>Bring to front</button></div>
            </>}
            <button className="btn btn-danger min-h-10 text-sm" disabled={Boolean(slot && design.slots.length === 1)} onClick={() => { edit({ slots: design.slots.filter(value => value.id !== item.id), layers: design.layers.filter(value => value.id !== item.id) }); setSelected(null); }}><Trash2 size={16} aria-hidden /> Remove selected item</button></div>}
        </section>
        <section className="panel space-y-4 p-4 sm:p-5"><h2 className={panelTitle}>Frame finish</h2><Dropdown showLabel label="Frame colour" value={design.look.frameId} options={FRAMES.map(frame => ({ value: frame.id, label: frame.name }))} onChange={frameId => edit({ look: { ...design.look, frameId } })} /><Dropdown showLabel label="Frame filter" value={design.look.filterId} options={FILTERS.map(filter => ({ value: filter.id, label: filter.name }))} onChange={filterId => edit({ look: { ...design.look, filterId } })} /><Dropdown showLabel label="Pattern" value={design.look.patternId} options={[{ value: "none", label: "None" }, ...PATTERNS.map(pattern => ({ value: pattern.id, label: pattern.name }))]} onChange={patternId => edit({ look: { ...design.look, patternId } })} /><StripStyleControls value={resolveStrip(design.look.strip)} fields={["finish", "sprockets", "band", "footer", "date", "font", "dateFormat"]} onChange={next => edit({ look: withStrip(design.look, next) })} /><label className="block text-sm font-bold">Default caption<input className={`${field} mt-1.5`} value={design.defaults.caption} maxLength={500} onChange={event => edit({ defaults: { ...design.defaults, caption: event.target.value } })} /></label><label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-bold"><input type="checkbox" checked={design.defaults.showDate} onChange={event => edit({ defaults: { ...design.defaults, showDate: event.target.checked } })} className="size-5" /> Show capture date</label></section>
        <section className="panel space-y-4 p-4 sm:p-5"><h2 className={panelTitle}>Scenes &amp; textures</h2><VisualPackPicker sceneId={design.look.sceneId} materialId={design.look.materialId} onSceneChange={sceneId => edit({ look: { ...design.look, sceneId } })} onMaterialChange={materialId => edit({ look: { ...design.look, materialId } })} /></section>
        <section className="panel space-y-3 p-4 sm:p-5"><h2 className={panelTitle}>Save or share</h2><p className="text-sm text-muted-foreground">Exported templates never include your photos.</p><label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-bold"><input type="checkbox" checked={includeText} onChange={event => setIncludeText(event.target.checked)} className="size-5" /> Include captions and text in the export</label><div className="flex flex-wrap gap-2"><button className={button} onClick={() => void work(async assertCurrent => { const file = await exportTemplateBundle(makeRecipe(true), filesForDesign(), { includeText }); assertCurrent(); downloadProjectBlob(file, projectDownloadName(name, "pbtemplate")); setStatus("Template exported."); })}><Download size={16} aria-hidden /> Export template</button>{recipe && <button className={button} onClick={() => void save(true)}>Save as a copy</button>}</div></section>
      </div>
    </div>
    </div>
  </main>;
}

function templateFromRecipe(recipe: TemplateRecipe): TemplateDesign {
  const { canvas, requiredSources, slots, layers, decorations, look, defaults, places } = recipe;
  return { canvas, requiredSources, slots, layers, decorations, look, defaults, ...(places ? { places } : {}) };
}

function releaseCanvas(canvas: HTMLCanvasElement): void { canvas.width = canvas.height = 0; }

function NumberField({ label, value, min, max, change }: { label: string; value: number; min: number; max: number; change: (value: number) => void }) {
  return <label className="block text-sm font-bold">{label}<input key={String(value)} type="number" min={min} max={max} step="any" defaultValue={Number(value.toFixed(4))} className={`${field} mt-1.5 tabular-nums`} onBlur={event => {
    const next = Number(event.target.value); if (event.target.value.trim() && Number.isFinite(next)) change(Math.max(min, Math.min(max, next))); else event.target.value = String(value);
  }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}
