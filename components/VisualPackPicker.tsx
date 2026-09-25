"use client";

import { HelpTooltip } from "@/components/HelpTooltip";

import { useEffect, useId, useRef, useState } from "react";
import { Check, Download, LoaderCircle, Star, Trash2, X } from "lucide-react";
import { Dropdown } from "./Dropdown";
import { SCENES, getScene } from "@/lib/scenes";
import { CURATED_ASSETS, getCuratedAsset, type AssetCategory, type CuratedAsset } from "@/lib/assets/registry";
import { createAssetLoader } from "@/lib/assets/loader";
import { readAssetFavourites, writeAssetFavourites } from "@/lib/assets/preferences";
import { requestAssetPack } from "@/lib/assets/cache";

interface Props { sceneId: string | null; materialId: string | null; onSceneChange(id: string | null): void; onMaterialChange(id: string | null): void; disabled?: boolean }
interface Choice { id: string; name: string; asset: CuratedAsset | null; previewCss: string }
const controls = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50";
const categories = [{ value: "together", label: "Together" }, { value: "create", label: "Create" }, { value: "events", label: "Events" }, { value: "material", label: "Materials" }, { value: "favourites", label: "Favourites" }];
const choices: Choice[] = [...SCENES.filter(scene => !getCuratedAsset(scene.id)).map(scene => ({ id: scene.id, name: scene.name, asset: null, previewCss: scene.previewCss })), ...CURATED_ASSETS.map(asset => ({ id: asset.id, name: asset.name, asset, previewCss: getScene(asset.fallback.sceneId)?.previewCss ?? asset.fallback.colour }))];

function PackThumbnail({ choice }: { choice: Choice }) {
  const [failed, setFailed] = useState(false);
  return <span className="relative block aspect-[3/2] overflow-hidden rounded-xl" style={{ background: choice.previewCss }}>
    {/* Fixed local thumbnails use their measured delivery files directly. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {choice.asset && !failed && <img src={choice.asset.thumbnail.path} alt="" loading="lazy" decoding="async" width={choice.asset.thumbnail.width} height={choice.asset.thumbnail.height} onError={() => setFailed(true)} className="h-full w-full object-cover" />}
    {failed && <span className="absolute inset-x-0 bottom-0 bg-card/95 px-2 py-1 text-xs text-foreground">Built-in fallback</span>}
  </span>;
}

function PackPreview({ choice, disabled, apply, close }: { choice: Choice; disabled: boolean; apply(): void; close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), canvas = useRef<HTMLCanvasElement>(null), title = useId();
  const [status, setStatus] = useState<"loading" | "ready" | "fallback">(choice.asset ? "loading" : "ready");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); };
  }, []);
  useEffect(() => {
    let active = true;
    const loader = createAssetLoader(), target = canvas.current!, ctx = target.getContext("2d")!;
    target.width = choice.asset?.kind === "material" ? 640 : 768;
    target.height = choice.asset?.kind === "material" ? 640 : 512;
    const fallback = () => {
      ctx.clearRect(0, 0, target.width, target.height);
      if (choice.asset?.kind === "material") { ctx.fillStyle = choice.asset.fallback.colour; ctx.fillRect(0, 0, target.width, target.height); }
      else getScene(choice.asset?.fallback.sceneId ?? choice.id)?.draw(ctx, 0, 0, target.width, target.height);
    };
    fallback();
    if (choice.asset) void loader.preload(choice.id).then(result => {
      if (!active) { if (result.kind === "ready") result.release(); return; }
      if (result.kind === "ready") { ctx.drawImage(result.image, 0, 0, target.width, target.height); setStatus("ready"); }
      else { fallback(); setStatus("fallback"); }
    }).catch(() => { if (active) { fallback(); setStatus("fallback"); } });
    return () => { active = false; loader.dispose(); target.width = target.height = 0; };
  }, [choice]);
  return <dialog ref={dialog} aria-labelledby={title} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }} className="m-auto w-[calc(100%_-_2rem)] max-w-xl max-h-[calc(100dvh_-_2rem)] overflow-auto rounded-2xl bg-card p-5 text-foreground shadow-xl backdrop:bg-black/50">
    <div className="mb-4 flex items-start justify-between gap-4"><h3 id={title} className="font-display text-2xl">{choice.name}</h3><button type="button" onClick={close} className={`${controls} -mr-2 w-11 shrink-0`} aria-label="Close asset preview"><X size={20} /></button></div>
    <canvas ref={canvas} width={choice.asset?.kind === "material" ? 640 : 768} height={choice.asset?.kind === "material" ? 640 : 512} className="block max-h-[48dvh] w-full rounded-xl object-contain" role="img" aria-label={`${choice.name} full preview`} />
    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{status === "loading" ? "Loading the full image…" : status === "fallback" ? "The image is unavailable. This built-in fallback will keep your photos usable; the original theme will load when available." : choice.asset?.kind === "material" ? "Frame texture. Check your caption is readable." : "Your layout may crop this backdrop. Check it after applying."}</p>
    <div className="mt-5 flex flex-wrap justify-end gap-2"><button type="button" className={`${controls} bg-muted`} onClick={close}>Cancel</button><button type="button" disabled={disabled || status === "loading"} className={`${controls} bg-accent text-accent-foreground`} onClick={apply}>{status === "loading" && <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" />}Apply {choice.asset?.kind === "material" ? "material" : "scene"}</button></div>
  </dialog>;
}

export function VisualPackPicker({ sceneId, materialId, onSceneChange, onMaterialChange, disabled = false }: Props) {
  const [category, setCategory] = useState<AssetCategory | "favourites">("together"), [favourites, setFavourites] = useState<string[]>([]);
  const [preview, setPreview] = useState<Choice | null>(null), [notice, setNotice] = useState<string | null>(null), [cacheBusy, setCacheBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const read = () => { if (active) setFavourites(readAssetFavourites()); };
    queueMicrotask(read);
    window.addEventListener("storage", read);
    return () => { active = false; window.removeEventListener("storage", read); };
  }, []);
  const visible = choices.filter(choice => category === "favourites" ? favourites.includes(choice.id) : choice.asset ? choice.asset.category === category : category === "together");
  const toggleFavourite = (id: string) => {
    const next = favourites.includes(id) ? favourites.filter(value => value !== id) : [...favourites, id];
    setFavourites(next);
    if (!writeAssetFavourites(next)) setNotice("Favourites are available for this visit. Browser storage could not save them for next time.");
  };
  const cache = async (action: "cache" | "clear") => {
    if (category === "favourites") return;
    setCacheBusy(true); setNotice(null);
    try { await requestAssetPack(action, category); setNotice(action === "cache" ? "This pack is saved for offline use in this browser. The browser may clear it when storage is needed." : "This pack’s offline copy is cleared. Project photos and settings are unchanged."); }
    catch (error) { setNotice(error instanceof Error ? error.message : "The offline pack could not be updated. Try again online."); }
    finally { setCacheBusy(false); }
  };
  return <section aria-label="Scenes and materials" className="flex flex-col gap-4">
    <Dropdown label="Visual pack category" value={category} options={categories} onChange={value => setCategory(value as typeof category)} disabled={disabled} />
    {category === "material" && <button type="button" className={`${controls} justify-start bg-muted`} disabled={disabled} aria-pressed={!materialId} onClick={() => onMaterialChange(null)}>{!materialId && <Check size={16} />}No material</button>}
    {category !== "material" && <button type="button" className={`${controls} justify-start bg-muted`} disabled={disabled} aria-pressed={!sceneId} onClick={() => onSceneChange(null)}>{!sceneId && <Check size={16} />}Use original backgrounds</button>}
    {!visible.length ? <p className="py-4 text-sm text-muted-foreground">Star a scene or material to find it here.</p> : <div className="grid grid-cols-2 gap-x-3 gap-y-5">{visible.map(choice => {
      const selected = choice.asset?.kind === "material" ? materialId === choice.id : sceneId === choice.id;
      return <div key={choice.id} className="min-w-0">
        <button type="button" className={`block w-full rounded-xl text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 ${selected ? "outline-2 outline-offset-2 outline-accent" : ""}`} disabled={disabled} aria-label={`Preview ${choice.name}${selected ? ", selected" : ""}`} onClick={() => setPreview(choice)}><PackThumbnail choice={choice} /></button>
        <div className="mt-1 flex items-start gap-1"><span className="min-w-0 flex-1 pt-2 text-sm leading-snug">{choice.name}{!choice.asset && <span className="block text-xs text-muted-foreground">Built-in</span>}</span><button type="button" aria-label={`${favourites.includes(choice.id) ? "Remove" : "Add"} ${choice.name} ${favourites.includes(choice.id) ? "from" : "to"} favourites`} aria-pressed={favourites.includes(choice.id)} disabled={disabled} onClick={() => toggleFavourite(choice.id)} className={`${controls} -mr-2 w-11 shrink-0 px-0 ${favourites.includes(choice.id) ? "text-accent" : "text-muted-foreground"}`}><Star size={17} fill={favourites.includes(choice.id) ? "currentColor" : "none"} /></button></div>
      </div>;
    })}</div>}
    {category !== "favourites" && <div className="border-t border-border pt-4"><div className="flex flex-wrap gap-2"><button type="button" className={`${controls} bg-muted`} disabled={disabled || cacheBusy} onClick={() => void cache("cache")}>{cacheBusy ? <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" /> : <Download size={16} />}Save pack offline</button><button type="button" className={`${controls} text-muted-foreground`} disabled={disabled || cacheBusy} onClick={() => void cache("clear")}><Trash2 size={16} />Clear offline copy</button><HelpTooltip label="About offline packs">Saves this category in this browser. Built-in backgrounds work without a pack. Your browser may clear downloaded packs to free space.</HelpTooltip></div></div>}
    {notice && <p role="status" className="text-sm leading-relaxed text-muted-foreground">{notice}</p>}
    {preview && <PackPreview key={preview.id} choice={preview} disabled={disabled} close={() => setPreview(null)} apply={() => { if (preview.asset?.kind === "material") onMaterialChange(preview.id); else onSceneChange(preview.id); setPreview(null); }} />}
  </section>;
}
