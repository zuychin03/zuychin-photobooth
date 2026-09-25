"use client";
import { useAppNavigationGuard } from "@/components/AppNavigation";

import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Download, Plus, Redo2, Save, Trash2, Undo2 } from "lucide-react";
import { Dropdown } from "@/components/Dropdown";
import { VisualPackPicker } from "@/components/VisualPackPicker";
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
import { validateTemplateRecipe, type TemplateDesign, type TemplateLayer, type TemplatePhotoSlot, type TemplateRecipe, type TemplateScope } from "@/lib/templates/model";
import { openTemplateShelf } from "@/lib/templates/storage";

const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border px-3 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40";
const field = "min-h-11 w-full rounded-xl border border-border bg-card px-3 text-sm focus:outline-2 focus:outline-accent";

export default function DesignerPage() { return <Suspense fallback={<p className="m-auto p-8" role="status">Opening frame designer…</p>}><DesignerEntry /></Suspense>; }

function DesignerEntry() {
  const query = useSearchParams(), { user, loading } = useAuth();
  if (loading) return <p className="m-auto p-8" role="status">Opening frame designer…</p>;
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
    if (working.current || busy) { setStatus("Wait for the current design action to finish before leaving."); return false; }
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
        if (accountScope && !owner) throw new Error("Sign in to the template owner's account, or return to your device templates.");
        const shelf = await openTemplateShelf(accountScope ? { kind: "account", ownerId: owner! } : { kind: "device" });
        try {
          const loaded = await shelf.load(id);
          if (!loaded || loaded.kind !== "current") throw new Error("This template needs recovery. Keep a raw backup from the template shelf.");
          stored = loaded.recipe; source = templateFromRecipe(stored); files = loaded.decorations;
        } finally { shelf.close(); }
      } else {
        const active = await flushEditor(); source = templateFromProject(active ?? createProject()); files = getDecorationBlobs();
      }
      for (const media of source.decorations) {
        const blob = files.get(media.id); if (!blob) throw new Error("A PNG decoration is missing");
        const image = await projectImageToCanvas(blob, media);
        if (lifetime.current !== token) { image.width = image.height = 0; return; }
        decoded.set(media.id, image);
      }
      if (lifetime.current !== token) return;
      images.current = decoded; blobs.current = new Map(files);
      setRecipe(stored); setName(stored?.name ?? "My frame"); setDesign(source); setSelected(source.slots[0]?.id ?? null);
    };
    void load().catch(error => { if (lifetime.current === token) setError(error instanceof Error ? error.message : "The designer could not open"); });
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
      } catch { if (active) { setCuts(null); setStatus("Background removal is unavailable. Original photos are shown."); } }
      finally { if (active) setSegmenting(false); }
    };
    void prepare(); return () => { active = false; };
  }, [sceneEnabled, session.shots]);

  const input = useMemo<ComposeInput | null>(() => {
    if (!design) return null;
    const frame = FRAMES.find(frame => frame.id === design.look.frameId)!;
    return { layout: getLayout(project?.editor.layoutId ?? "strip4"), shots: session.shots, template: design,
      style: { frameColor: frame.color, inkColor: frame.ink, patternId: design.look.patternId, filterId: design.look.filterId, ...design.defaults, stickerStyle: "flat" },
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
  const edit = (patch: Partial<TemplateDesign>) => { if (design) try { change(reviseTemplate(design, patch)); } catch (error) { setError(error instanceof Error ? error.message : "This change exceeds the template limits"); } };
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
    if (!design) throw new Error("Open a design first");
    const now = new Date().toISOString();
    return validateTemplateRecipe({ ...design, schemaVersion: 1, id: copy || !recipe ? crypto.randomUUID() : recipe.id, name,
      scope: recipe?.scope ?? scope, revision: copy || !recipe ? 0 : recipe.revision + 1, createdAt: copy || !recipe ? now : recipe.createdAt, updatedAt: now });
  };
  const filesForDesign = () => new Map((design?.decorations ?? []).map(media => [media.id, blobs.current.get(media.id)!]));
  const work = async (action: (assertCurrent: () => void) => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    const token = lifetime.current; setBusy(true); setError(null);
    const assertCurrent = () => { if (token !== lifetime.current) throw new Error("The active designer or account changed"); };
    try { await action(assertCurrent); } catch (error) { if (token === lifetime.current) setError(error instanceof Error ? error.message : "The action could not finish. Your design is still here."); }
    finally { if (token === lifetime.current && !navigatingToSaved.current) { working.current = false; setBusy(false); } }
  };
  const save = (copy = false) => work(async assertCurrent => {
    const next = makeRecipe(copy), files = filesForDesign(), shelf = await openTemplateShelf(next.scope);
    try {
      assertCurrent(); const saved = await shelf.save(next, files, copy ? null : recipe?.revision ?? null); assertCurrent();
      setRecipe(saved); setDirty(false); setStatus("Template saved on this device.");
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

  if (!design) return <main className="mx-auto max-w-2xl p-8"><button className={button} onClick={() => router.push("/templates")}><ArrowLeft size={16} /> Templates</button><h1 className="mt-8 font-display text-3xl">Frame designer</h1><p className="mt-4" role={error ? "alert" : "status"}>{error ?? "Opening your design…"}</p></main>;
  return <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-8" aria-busy={busy}>
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
      <div><button ref={templatesButton} disabled={busy} className="mb-3 flex min-h-11 items-center gap-2 text-sm underline" onClick={() => go("/templates")}><ArrowLeft size={16} /> Templates</button><h1 className="font-display text-3xl sm:text-4xl">Frame designer</h1><p className="mt-2 max-w-xl text-sm text-muted-foreground">Make a frame to use again.</p></div>
      <div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => void save()}><Save size={16} /> Save template</button><button className={`${button} border-transparent bg-accent text-accent-foreground hover:bg-accent/90`} disabled={busy || !project || segmenting || curated.loading} onClick={() => void work(async assertCurrent => { assertCurrent(); await applyTemplate(design, filesForDesign()); assertCurrent(); setDirty(false); router.push("/customize"); })}>Apply to project</button></div>
    </header>
    {leaveTo && <div role="group" aria-label="Unsaved template changes" className="my-4 border-y border-border py-4 text-sm"><p>Leave without saving this template? The project itself has not changed.</p><div className="mt-2 flex gap-4"><button ref={keepDesigning} disabled={busy} className={button} onClick={() => { setLeaveTo(null); const target = leaveTrigger.current; requestAnimationFrame(() => { if (target?.isConnected && !target.matches(":disabled") && !target.closest("[inert]")) target.focus(); else templatesButton.current?.focus(); }); }}>Keep designing</button><button disabled={busy} className={button} onClick={() => { if (!working.current) router.push(leaveTo); }}>Leave designer</button></div></div>}
    {error && <p role="alert" className="my-4 rounded-xl bg-destructive/10 p-4 text-sm">{error}</p>}
    <p role="status" className="my-4 text-sm text-muted-foreground">{busy ? "Working…" : status || (dirty ? "Unsaved template changes" : "Your design is ready to edit")}</p>
    <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_360px]" inert={busy}>
      <section className="lg:sticky lg:top-6" aria-label="Frame preview">
        <div className="flex min-h-72 justify-center rounded-2xl bg-muted p-5 sm:p-8">
          <canvas ref={canvas} tabIndex={0} aria-label="Frame preview. Select an item from the dropdown, then use arrow keys to move it." className="max-h-[60dvh] max-w-full rounded-sm object-contain shadow-xl shadow-black/15 focus-visible:outline-2 focus-visible:outline-accent" style={{ aspectRatio: `${design.canvas.width}/${design.canvas.height}` }} onClick={event => {
            const rect = event.currentTarget.getBoundingClientRect(), x = (event.clientX - rect.left) / rect.width, y = (event.clientY - rect.top) / rect.height;
            setSelected([...design.slots, ...design.layers].reverse().find(item => x >= item.x && x <= item.x + item.width && y >= item.y && y <= item.y + item.height)?.id ?? null);
          }} onKeyDown={event => {
            if (!item || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault(); const step = event.shiftKey ? 0.05 : 0.005;
            change(moveTemplateItem(design, item.id, item.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), item.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0)));
          }} />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">{design.canvas.width} × {design.canvas.height} px · {design.slots.length}/16 photo slots</p><div className="flex gap-2"><button className={button} aria-label="Undo design change" disabled={!past.length} onClick={() => { setFuture(values => [design, ...values]); setDesign(past[past.length - 1]); setPast(past.slice(0, -1)); setDirty(true); }}><Undo2 size={18} /></button><button className={button} aria-label="Redo design change" disabled={!future.length} onClick={() => { setPast(values => [...values, design]); setDesign(future[0]); setFuture(future.slice(1)); setDirty(true); }}><Redo2 size={18} /></button></div></div>
        {segmenting && <p role="status" className="mt-2 text-sm">Preparing the scene preview…</p>}
        {curated.fallback.length > 0 && <p className="mt-2 text-sm">Using a built-in fallback for {curated.fallback.join(", ")}.</p>}
        {!project && <p className="mt-3 text-sm">Save this frame, then use it in a new project from Templates.</p>}
      </section>
      <div className="min-w-0 space-y-7">
        <section className="space-y-3"><label className="block text-sm font-medium">Template name<input className={`${field} mt-1`} value={name} maxLength={100} onChange={event => { setName(event.target.value); setDirty(true); }} /></label><div className="grid grid-cols-2 gap-3"><NumberField label="Canvas width" value={design.canvas.width} min={128} max={4096} change={width => edit({ canvas: { ...design.canvas, width } })} /><NumberField label="Canvas height" value={design.canvas.height} min={128} max={4096} change={height => edit({ canvas: { ...design.canvas, height } })} /></div></section>
        <section className="space-y-3 border-t border-border pt-5"><h2 className="font-medium">Photos and layers</h2><div className="flex flex-wrap gap-2"><button className={button} disabled={design.slots.length >= 16} onClick={() => { const next = newTemplateSlot(design, crypto.randomUUID()); edit({ slots: [...design.slots, next] }); setSelected(next.id); }}><Plus size={16} /> Photo</button><button className={button} disabled={design.layers.filter(layer => layer.kind === "text").length >= 16} onClick={() => addLayer("text")}>Text</button><button className={button} disabled={design.layers.filter(layer => layer.kind === "sticker").length >= 32} onClick={() => addLayer("sticker")}>Sticker</button>
          <label className={`${button} relative cursor-pointer focus-within:outline-2 focus-within:outline-accent`}>PNG decoration<input className="sr-only" type="file" accept="image/png" aria-label="Add PNG decoration" disabled={design.decorations.length >= 8} onChange={event => {
            const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
            void work(async assertCurrent => {
              if (file.size > 4 * 1024 * 1024) throw new Error("Choose a PNG smaller than 4 MiB");
              const token = lifetime.current, info = await inspectProjectImage(file);
              const media = validateMediaResource({ ...info, id: crypto.randomUUID(), kind: "decoration", bytes: file.size });
              assertCurrent();
              if (images.current.size >= RESOURCE_LIMITS.files || [...blobs.current.values()].reduce((sum, blob) => sum + blob.size, file.size) > RESOURCE_LIMITS.totalEncodedBytes || [...images.current.values()].reduce((sum, image) => sum + image.width * image.height, media.width * media.height) > RESOURCE_LIMITS.totalPixels) throw new Error("The design and its undo history have reached the image limit. Save and reopen this template before adding another decoration.");
              const image = await projectImageToCanvas(file, info); if (token !== lifetime.current) { image.width = image.height = 0; return; }
              const next: TemplateLayer = { id: crypto.randomUUID(), kind: "decoration", mediaId: media.id, fit: "contain", x: 0.1, y: 0.1, width: 0.3, height: 0.3, rotation: 0 };
              try { const changed = reviseTemplate(design, { decorations: [...design.decorations, media], layers: [...design.layers, next] }); blobs.current.set(media.id, file.slice(0, file.size, "image/png")); images.current.set(media.id, image); change(changed); setSelected(next.id); }
              catch (error) { image.width = image.height = 0; throw error; }
            });
          }} /></label></div>
          <Dropdown showLabel label="Selected item" value={selected ?? ""} options={[...design.slots.map((slot, index) => ({ value: slot.id, label: `Photo slot ${index + 1} · ${slot.role}${slot.sourceIndex + 1}` })), ...design.layers.map((layer, index) => ({ value: layer.id, label: `${layer.kind === "text" ? "Text" : layer.kind === "sticker" ? "Sticker" : "PNG"} ${index + 1}` }))]} onChange={setSelected} />
          {item && <><div className="grid grid-cols-2 gap-3">{(["x", "y", "width", "height"] as const).map(key => <NumberField key={key} label={`${key === "x" ? "Left" : key === "y" ? "Top" : key === "width" ? "Width" : "Height"} (%)`} value={Number((item[key] * 100).toFixed(2))} min={key === "x" || key === "y" ? 0 : 0.1} max={100} change={value => setBounds(key, value)} />)}</div>
            {slot && <><div className="grid grid-cols-2 gap-3"><Dropdown showLabel label="Participant" value={slot.role} options={ROLES.map(role => ({ value: role, label: role }))} onChange={role => updateSlot({ role: role as Role, companions: slot.companions?.filter(source => source.role !== role) })} /><Dropdown showLabel label="Source photo" value={String(slot.sourceIndex)} options={[0, 1, 2, 3].map(index => ({ value: String(index), label: `Photo ${index + 1}` }))} onChange={value => updateSlot({ sourceIndex: Number(value) })} /></div>
              <NumberField label="Photo zoom" value={slot.crop.zoom} min={1} max={4} change={zoom => updateSlot({ crop: { ...slot.crop, zoom } })} />
              <div className="grid grid-cols-2 gap-3"><NumberField label="Photo pan X" value={slot.crop.offsetX} min={-1} max={1} change={offsetX => updateSlot({ crop: { ...slot.crop, offsetX } })} /><NumberField label="Photo pan Y" value={slot.crop.offsetY} min={-1} max={1} change={offsetY => updateSlot({ crop: { ...slot.crop, offsetY } })} /></div>
              <Dropdown showLabel label="Photo rotation" value={String(slot.crop.rotation)} options={[0, 90, 180, 270].map(value => ({ value: String(value), label: `${value}°` }))} onChange={value => updateSlot({ crop: { ...slot.crop, rotation: Number(value) as 0 | 90 | 180 | 270 } })} />
              <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={slot.crop.mirror} onChange={event => updateSlot({ crop: { ...slot.crop, mirror: event.target.checked } })} /> Mirror photo</label>
              <Dropdown showLabel label="Photo filter" value={slot.filterId ?? "inherit"} options={[{ value: "inherit", label: "Follow frame filter" }, ...FILTERS.map(filter => ({ value: filter.id, label: filter.name }))]} onChange={value => updateSlot({ filterId: value === "inherit" ? null : value })} />
              {slot.companions?.length ? <p className="text-sm text-muted-foreground">Together cell: {slot.role} and {slot.companions.map(source => source.role).join(", ")}. Positions follow the saved scene placement.</p> : null}
            </>}
            {layer && <><NumberField label="Layer rotation (°)" value={layer.rotation} min={-180} max={180} change={rotation => updateLayer({ ...layer, rotation })} />
              {layer.kind === "text" && <><label className="block text-sm font-medium">Text<textarea className={`${field} mt-1 min-h-24 py-2`} value={layer.text} maxLength={500} onChange={event => updateLayer({ ...layer, text: event.target.value })} /></label><Dropdown showLabel label="Typeface" value={layer.font} options={[{ value: "serif", label: "Fraunces" }, { value: "sans", label: "Geist" }, { value: "mono", label: "Geist Mono" }]} onChange={value => updateLayer({ ...layer, font: value as "serif" | "sans" | "mono" })} /><NumberField label="Text size (% of width)" value={layer.fontSize * 100} min={0.5} max={25} change={value => updateLayer({ ...layer, fontSize: value / 100 })} /><Dropdown showLabel label="Text alignment" value={layer.align} options={["left", "center", "right"].map(value => ({ value, label: value }))} onChange={value => updateLayer({ ...layer, align: value as "left" | "center" | "right" })} /><label className="flex min-h-11 items-center justify-between text-sm">Text colour<input type="color" value={layer.colour} onChange={event => updateLayer({ ...layer, colour: event.target.value })} className="h-11 w-16 rounded-md" /></label></>}
              {layer.kind === "sticker" && <><Dropdown showLabel label="Sticker" value={layer.slug} options={STICKER_PACKS.flatMap(pack => pack.stickers.map(sticker => ({ value: sticker.slug, label: sticker.slug.replaceAll("_", " ") })))} onChange={slug => updateLayer({ ...layer, slug })} /><Dropdown showLabel label="Sticker style" value={layer.style} options={STICKER_STYLES.map(style => ({ value: style.id, label: style.name }))} onChange={style => updateLayer({ ...layer, style: style as typeof layer.style })} /></>}
              {layer.kind === "decoration" && <Dropdown showLabel label="Decoration fit" value={layer.fit} options={[{ value: "contain", label: "Show whole image" }, { value: "cover", label: "Fill and crop" }]} onChange={fit => updateLayer({ ...layer, fit: fit as "contain" | "cover" })} />}
              <div className="flex gap-2"><button className={button} onClick={() => edit({ layers: [layer, ...design.layers.filter(value => value.id !== layer.id)] })}>Send to back</button><button className={button} onClick={() => edit({ layers: [...design.layers.filter(value => value.id !== layer.id), layer] })}>Bring to front</button></div>
            </>}
            <button className={`${button} text-destructive`} disabled={Boolean(slot && design.slots.length === 1)} onClick={() => { edit({ slots: design.slots.filter(value => value.id !== item.id), layers: design.layers.filter(value => value.id !== item.id) }); setSelected(null); }}><Trash2 size={16} /> Remove selected item</button></>}
        </section>
        <section className="space-y-3 border-t border-border pt-5"><h2 className="font-medium">Frame finish</h2><Dropdown showLabel label="Frame colour" value={design.look.frameId} options={FRAMES.map(frame => ({ value: frame.id, label: frame.name }))} onChange={frameId => edit({ look: { ...design.look, frameId } })} /><Dropdown showLabel label="Frame filter" value={design.look.filterId} options={FILTERS.map(filter => ({ value: filter.id, label: filter.name }))} onChange={filterId => edit({ look: { ...design.look, filterId } })} /><Dropdown showLabel label="Pattern" value={design.look.patternId} options={[{ value: "none", label: "None" }, ...PATTERNS.map(pattern => ({ value: pattern.id, label: pattern.name }))]} onChange={patternId => edit({ look: { ...design.look, patternId } })} /><label className="block text-sm font-medium">Default caption<input className={`${field} mt-1`} value={design.defaults.caption} maxLength={500} onChange={event => edit({ defaults: { ...design.defaults, caption: event.target.value } })} /></label><label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={design.defaults.showDate} onChange={event => edit({ defaults: { ...design.defaults, showDate: event.target.checked } })} /> Show capture date</label></section>
        <VisualPackPicker sceneId={design.look.sceneId} materialId={design.look.materialId} onSceneChange={sceneId => edit({ look: { ...design.look, sceneId } })} onMaterialChange={materialId => edit({ look: { ...design.look, materialId } })} />
        <section className="space-y-3 border-t border-border pt-5"><h2 className="font-medium">Save or share</h2><p className="text-sm text-muted-foreground">Recipes include PNG decorations, but no source photos. Captions and text are excluded unless selected below.</p><label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={includeText} onChange={event => setIncludeText(event.target.checked)} /> Include captions and text in exported recipe</label><div className="flex flex-wrap gap-2"><button className={button} onClick={() => void work(async assertCurrent => { const file = await exportTemplateBundle(makeRecipe(true), filesForDesign(), { includeText }); assertCurrent(); downloadProjectBlob(file, projectDownloadName(name, "pbtemplate")); setStatus("Template file prepared."); })}><Download size={16} /> Export recipe</button>{recipe && <button className={button} onClick={() => void save(true)}>Save as a copy</button>}</div></section>
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
  return <label className="block text-sm font-medium">{label}<input key={String(value)} type="number" min={min} max={max} step="any" defaultValue={Number(value.toFixed(4))} className={`${field} mt-1 tabular-nums`} onBlur={event => {
    const next = Number(event.target.value); if (event.target.value.trim() && Number.isFinite(next)) change(Math.max(min, Math.min(max, next))); else event.target.value = String(value);
  }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}
