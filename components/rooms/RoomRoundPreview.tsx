"use client";

import { useEffect, useRef, useState } from "react";
import type { PhotoProject } from "@/lib/projects/model";
import { openProjectRepository, type ProjectRepository } from "@/lib/projects/storage";
import { projectImageToCanvas } from "@/lib/projects/images";
import { composeStrip, compositionSize, type ShotSet } from "@/lib/compose";
import { FRAMES } from "@/lib/decor";
import { LAYOUTS, ROLES } from "@/lib/layouts";
import { SCENES } from "@/lib/scenes";
import { THEMES } from "@/lib/themes";
import { preloadStickers } from "@/lib/sticker-assets";
import { useCuratedAssets } from "@/hooks/useCuratedAssets";

export function RoomRoundPreview({ project, fixtureDatabaseName, suspendLive, resumeLive }: { project: PhotoProject; fixtureDatabaseName?: string; suspendLive(): Promise<void>; resumeLive(): void }) {
  const target = useRef<HTMLCanvasElement>(null);
  const [decoded, setDecoded] = useState<{ key: string; images: Map<string, HTMLCanvasElement> } | null>(null);
  const [error, setError] = useState(false);
  const [assetRevision, setAssetRevision] = useState(0);
  const [cutoutRequest, setCutoutRequest] = useState<string | null>(null);
  const [cutouts, setCutouts] = useState<{ key: string; images: Map<string, HTMLCanvasElement> } | null>(null);
  const [segmentingKey, setSegmentingKey] = useState<string | null>(null), [segmentError, setSegmentError] = useState(false);
  const key = `${project.id}:${project.scope.kind === "account" ? project.scope.ownerId : "device"}:${project.media.map(media => media.id).join(",")}`;
  const scene = SCENES.find(item => item.id === project.editor.sceneId);
  const curated = useCuratedAssets(scene?.assetId ?? null, project.editor.materialId ?? null);
  const cutoutKey = `${key}:${project.editor.sceneId ?? "none"}`;
  const segmenting = segmentingKey === cutoutKey;
  useEffect(() => {
    let active = true;
    const images = new Map<string, HTMLCanvasElement>();
    void (async () => {
      let repository: ProjectRepository | null = null;
      try {
        repository = await openProjectRepository(project.scope, { databaseName: fixtureDatabaseName });
        const stored = await repository.load(project.id);
        if (!active) return;
        if (!stored || stored.kind !== "current") throw new Error("Saved round is unavailable");
        for (const media of project.media) {
          const blob = stored.media.get(media.id);
          if (!blob) throw new Error("A saved original is unavailable");
          const full = await projectImageToCanvas(blob);
          try {
            if (!active) return;
            const scaled = document.createElement("canvas"), scale = Math.min(1, 640 / Math.max(full.width, full.height));
            scaled.width = Math.max(1, Math.round(full.width * scale)); scaled.height = Math.max(1, Math.round(full.height * scale));
            scaled.getContext("2d")!.drawImage(full, 0, 0, scaled.width, scaled.height); images.set(media.id, scaled);
          } finally { full.width = full.height = 0; }
        }
        if (active) { setDecoded({ key, images }); setError(false); }
      } catch { if (active) setError(true); }
      finally { repository?.close(); }
    })();
    return () => { active = false; for (const image of images.values()) image.width = image.height = 0; images.clear(); };
    // Editor-only changes reuse decoded thumbnails; original bytes never change in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fixtureDatabaseName]);
  const stickersKey = `${project.editor.stickerStyle}:${project.editor.stickers.map(item => item.slug).join(",")}`;
  useEffect(() => {
    let active = true;
    const style = project.editor.stickerStyle;
    void Promise.all([document.fonts.ready, style === "noto" ? Promise.resolve() : preloadStickers(style, project.editor.stickers.map(item => item.slug))]).then(() => { if (active) setAssetRevision(value => value + 1); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stickersKey]);
  useEffect(() => {
    if (!project.editor.sceneId || cutoutRequest !== cutoutKey || decoded?.key !== key) return;
    const controller = new AbortController();
    let owned: Map<string, HTMLCanvasElement> | null = null;
    void (async () => {
      setSegmentingKey(cutoutKey); setSegmentError(false);
      try {
        await suspendLive(); controller.signal.throwIfAborted();
        const sources = new Map(project.media.filter(media => media.kind === "photo").flatMap(media => { const source = decoded.images.get(media.id); return source ? [[media.id, source] as const] : []; }));
        const result = await (await import("@/lib/shared-preview")).createSharedStillCutouts(sources, { signal: controller.signal });
        owned = result;
        if (controller.signal.aborted) { for (const image of result.values()) image.width = image.height = 0; return; }
        setCutouts({ key: cutoutKey, images: result });
      } catch { if (!controller.signal.aborted) { setSegmentError(true); setCutoutRequest(null); } }
      finally { resumeLive(); if (!controller.signal.aborted) setSegmentingKey(null); }
    })();
    return () => { controller.abort(); if (owned) for (const image of owned.values()) image.width = image.height = 0; };
    // A placement or caption change reuses masks from the same immutable originals.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cutoutRequest, cutoutKey, decoded, key, suspendLive, resumeLive]);
  useEffect(() => {
    if (!target.current || decoded?.key !== key) return;
    const editor = project.editor, layout = LAYOUTS.find(item => item.id === editor.layoutId)!;
    const frame = FRAMES.find(item => item.id === editor.frameId)!;
    const shots: ShotSet = {}, people: ShotSet = {}, decorations = new Map<string, HTMLCanvasElement>();
    for (const role of ROLES) shots[role] = project.sourceOrder[role].map(id => id ? decoded.images.get(id) ?? null : null);
    if (cutouts?.key === cutoutKey) for (const role of ROLES) people[role] = project.sourceOrder[role].map(id => id ? cutouts.images.get(id) ?? null : null);
    for (const media of project.media) if (media.kind === "decoration") { const image = decoded.images.get(media.id); if (image) decorations.set(media.id, image); }
    const input = { layout, shots, style: { frameColor: frame.color, inkColor: frame.ink, patternId: editor.patternId, filterId: editor.filterId, caption: editor.caption, showDate: editor.showDate, stickerStyle: editor.stickerStyle }, stickers: editor.stickers, cellEdits: { ...editor.cellEdits }, capturedAt: project.capturedAt, captureTimeZone: project.captureTimeZone, template: editor.template, materialId: editor.materialId, resources: curated.resources, decorations, theme: THEMES.find(item => item.id === editor.themeId) ?? null };
    const size = compositionSize(input);
    composeStrip(target.current, { ...input, cutouts: people, together: project.editor.sceneId && cutouts?.key === cutoutKey ? { sceneId: project.editor.sceneId, places: { ...project.editor.places } } : null }, Math.min(1, 1000 / Math.max(size.width, size.height)));
  }, [project, decoded, key, curated.resources, assetRevision, cutouts, cutoutKey]);
  return <figure className="mt-5 rounded-2xl border border-border bg-muted/30 p-4"><div className="flex min-h-40 justify-center"><canvas ref={target} className="max-h-[36rem] max-w-full object-contain" aria-label="Shared saved-photo design preview" /></div><figcaption className="mt-3 text-center text-xs leading-relaxed text-muted-foreground">{error ? "This preview could not load. The saved originals are still available in My projects." : decoded?.key !== key ? "Loading saved originals…" : segmenting ? "Preparing saved-photo cutouts. The live preview pauses briefly." : project.editor.sceneId && cutouts?.key !== cutoutKey ? "Original backgrounds shown. Prepare Together to preview the saved photos in your chosen scene." : "Your shared frame, photo crops, caption and stickers. Full-resolution originals are preserved."}</figcaption>{project.editor.sceneId && <div className="mt-3 text-center"><button disabled={segmenting || decoded?.key !== key || !project.media.some(media => media.kind === "photo")} className="min-h-11 rounded-xl border border-border bg-card px-4 text-sm disabled:opacity-50" onClick={() => setCutoutRequest(cutoutKey)}>{segmenting ? "Preparing Together…" : cutouts?.key === cutoutKey ? "Together preview ready" : "Prepare Together preview"}</button>{segmentError && <p role="alert" className="mt-2 text-xs">Together could not be prepared on this device. Originals remain visible; you can retry.</p>}</div>}</figure>;
}
