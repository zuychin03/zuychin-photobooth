import { requestAssetPack } from "./cache";
import { createAssetLoader } from "./loader";
import { ASSET_CATEGORIES, ASSET_PACK_VERSION, CURATED_ASSETS } from "./registry";
import { composeStrip, type ComposeInput, type ShotSet } from "../compose";
import { FOOTER_H, LAYOUTS, ROLES, STRIP_MARGIN } from "../layouts";
import { createProject } from "../projects/model";
import { templateFromProject } from "../templates/from-project";

export interface AssetProbeResult { name: string; passed: boolean; detail: string; preview?: string }

export async function runAssetBrowserProbe(): Promise<AssetProbeResult[]> {
  const results: AssetProbeResult[] = [], bitmaps: ImageBitmap[] = [];
  const asset = CURATED_ASSETS[0];
  const loader = createAssetLoader({ decode: async blob => {
    const bitmap = await createImageBitmap(blob); bitmaps.push(bitmap);
    return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  } });
  try {
    const result = await loader.preload(asset.id);
    results.push({ name: "Native bitmap and verified delivery", passed: result.kind === "ready" && result.width === asset.full.width && result.height === asset.full.height, detail: result.kind === "ready" ? `${result.width} × ${result.height} WebP decoded after size/hash/header checks` : `Fallback: ${result.reason}` });
    if (result.kind === "ready") result.release();
    results.push({ name: "Explicit bitmap release", passed: bitmaps.length === 1 && bitmaps.every(bitmap => bitmap.width === 0 && bitmap.height === 0), detail: "Released ImageBitmap dimensions must become zero" });
  } finally { loader.dispose(); }
  const offline = createAssetLoader({ fetch: async () => { throw new Error("Synthetic unavailable asset"); } });
  try {
    const result = await offline.preload(asset.id);
    results.push({ name: "Unavailable image fallback", passed: result.kind === "fallback" && result.fallback.sceneId === asset.fallback.sceneId, detail: "Synthetic fetch failure chooses the declared procedural scene" });
  } finally { offline.dispose(); }
  const corrupt = createAssetLoader({ fetch: async () => new Response(new Uint8Array(asset.full.bytes), { headers: { "Content-Type": "image/webp" } }) });
  try {
    const result = await corrupt.preload(asset.id);
    results.push({ name: "Corrupt bytes rejected", passed: result.kind === "fallback" && result.reason === "invalid", detail: "Correct encoded length with incorrect SHA-256 never reaches the decoder" });
  } finally { corrupt.dispose(); }
  return results;
}

export async function runAssetCacheProbe(): Promise<AssetProbeResult[]> {
  if (!navigator.serviceWorker?.controller || !globalThis.caches) return [{ name: "Curated service worker", passed: false, detail: "Requires the current production service worker controlling this tab" }];
  const cache = await caches.open(`pb-assets-${ASSET_PACK_VERSION}`), existing = new Set((await cache.keys()).map(key => new URL(key.url).pathname));
  const category = ASSET_CATEGORIES.find(category => CURATED_ASSETS.filter(asset => asset.category === category).every(asset => !existing.has(asset.full.path) && !existing.has(asset.thumbnail.path)));
  if (!category) return [{ name: "Isolated pack cache probe", passed: false, detail: "Every category already has cached images. Existing offline packs were preserved; use a fresh test browser profile for this probe." }];
  const paths = CURATED_ASSETS.filter(asset => asset.category === category).flatMap(asset => [asset.full.path, asset.thumbnail.path]);
  const results: AssetProbeResult[] = [];
  try {
    const reply = await requestAssetPack("cache", category);
    const saved = await Promise.all(paths.map(path => cache.match(path)));
    results.push({ name: "Explicit category cache", passed: reply.files === paths.length && saved.every(Boolean), detail: `${category}: ${saved.filter(Boolean).length}/${paths.length} images cached after an explicit message` });
    await requestAssetPack("clear", category);
    const removed = await Promise.all(paths.map(path => cache.match(path)));
    results.push({ name: "Explicit category clear", passed: removed.every(value => !value), detail: "Only the newly cached test category was cleared" });
    const remaining = new Set((await cache.keys()).map(key => new URL(key.url).pathname));
    results.push({ name: "Existing pack preservation", passed: [...existing].every(path => remaining.has(path)), detail: "Every image present before the test remains cached" });
  } catch (error) { results.push({ name: "Pack cache request", passed: false, detail: error instanceof Error ? error.message : "Cache request failed" }); }
  finally { await requestAssetPack("clear", category).catch(() => {}); }
  return results;
}

export async function runTemplateRenderProbe(): Promise<AssetProbeResult[]> {
  const results: AssetProbeResult[] = [], originals: HTMLCanvasElement[] = [], shots: ShotSet = {};
  const loader = createAssetLoader(), legacy = document.createElement("canvas"), embedded = document.createElement("canvas");
  try {
    for (const [index, role] of ROLES.entries()) shots[role] = Array.from({ length: 4 }, (_, shot) => {
      const canvas = document.createElement("canvas"); canvas.width = 240; canvas.height = 160; originals.push(canvas);
      const ctx = canvas.getContext("2d")!; ctx.fillStyle = ["#c06470", "#9271bc", "#5e9587", "#bc904f"][index]; ctx.fillRect(0, 0, 240, 160);
      ctx.fillStyle = "#fff8ed"; ctx.fillRect(10 + shot * 12, 10, 24, 140); ctx.font = "bold 36px sans-serif"; ctx.fillText(`${role}${shot + 1}`, 85, 95);
      return canvas;
    });
    for (const layout of LAYOUTS) {
      const count = layout.mode === "solo" ? 1 : layout.mode === "duo" ? 2 : layout.minMembers!;
      const project = createProject({ mode: layout.mode, participants: ROLES.slice(0, count).map(role => ({ id: `probe-${role}`, role })), editor: { layoutId: layout.id } });
      const template = templateFromProject(project);
      const base: ComposeInput = { layout, shots, stickers: [], capturedAt: "2026-09-23T00:00:00.000Z", captureTimeZone: "Australia/Sydney", style: { frameColor: "#fff8ed", inkColor: "#2c2520", patternId: "none", filterId: "none", caption: "Caption stays clear", showDate: false, stickerStyle: "flat" } };
      const scale = Math.min(1, 480 / template.canvas.width);
      composeStrip(legacy, base, scale); composeStrip(embedded, { ...base, template }, scale);
      const original = legacy.getContext("2d")!.getImageData(0, 0, legacy.width, legacy.height).data, saved = embedded.getContext("2d")!.getImageData(0, 0, embedded.width, embedded.height).data;
      let difference = 0; for (let i = 0; i < original.length; i++) difference += Math.abs(original[i] - saved[i]);
      const mean = difference / original.length;
      results.push({ name: `Template geometry: ${layout.name}`, passed: mean <= 1, detail: `Mean RGBA error ${mean.toFixed(4)}/255 against the existing renderer; synthetic labelled sources`, preview: embedded.toDataURL("image/webp", 0.6) });
      const roles = ROLES.slice(0, count), roleShots = Object.fromEntries(roles.map(role => [role, shots[role]])) as ShotSet;
      const together = { sceneId: "studio-cream", places: { A: { dx: -0.08, dy: 0.04, scale: 1.1 }, B: { dx: 0.08, dy: 0, scale: 0.9 } } };
      const togetherProject = createProject({ mode: layout.mode, participants: roles.map(role => ({ id: `probe-${role}`, role })), editor: { layoutId: layout.id, sceneId: together.sceneId, places: together.places } });
      const togetherTemplate = templateFromProject(togetherProject);
      for (const complete of [true, false]) {
        const cutouts = complete ? roleShots : { ...roleShots, [roles[roles.length - 1]]: [null, null, null, null] };
        const input = { ...base, shots: roleShots, cutouts, together };
        composeStrip(legacy, input, scale); composeStrip(embedded, { ...input, template: togetherTemplate }, scale);
        const before = legacy.getContext("2d")!.getImageData(0, 0, legacy.width, legacy.height).data, after = embedded.getContext("2d")!.getImageData(0, 0, embedded.width, embedded.height).data;
        let difference = 0; for (let index = 0; index < before.length; index++) difference += Math.abs(before[index] - after[index]);
        const mean = difference / before.length;
        results.push({ name: `Together ${complete ? "all ready" : "atomic fallback"}: ${layout.name}`, passed: mean <= 1, detail: `Mean RGBA error ${mean.toFixed(4)}/255; all participant placements and split fallback compared with existing composition` });
      }
      for (const asset of CURATED_ASSETS.filter(asset => asset.kind === "material")) {
        const resource = await loader.preload(asset.id);
        if (resource.kind !== "ready") { results.push({ name: `Material: ${asset.name} / ${layout.name}`, passed: false, detail: `Fallback ${resource.reason}` }); continue; }
        try {
          composeStrip(embedded, { ...base, template, materialId: asset.id, resources: new Map([[asset.id, resource]]) }, scale);
          const footerY = Math.ceil((template.canvas.height - STRIP_MARGIN - FOOTER_H + 5) * scale), footerX = Math.ceil((STRIP_MARGIN / 2 + 5) * scale);
          const pixel = embedded.getContext("2d")!.getImageData(footerX, footerY, 1, 1).data;
          results.push({ name: `Material caption backing: ${asset.name} / ${layout.name}`, passed: pixel[0] === 255 && pixel[1] === 248 && pixel[2] === 237 && pixel[3] === 255, detail: "Native canvas confirms solid caption backing, with dark caption on warm ivory. This is not a complete text/print contrast audit." });
        } finally { resource.release(); }
      }
    }
  } finally { loader.dispose(); for (const canvas of [...originals, legacy, embedded]) canvas.width = canvas.height = 0; }
  return results;
}
