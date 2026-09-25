import manifest from "./manifest.json";

export type AssetCategory = "together" | "create" | "events" | "material";
export type AssetVariant = "full" | "thumbnail";
export interface AssetFile { path: string; width: number; height: number; bytes: number; sha256: string }
export interface CuratedAsset {
  id: string; name: string; version: string; kind: "scene" | "material"; category: AssetCategory;
  full: AssetFile; thumbnail: AssetFile; focalPoint: readonly [number, number]; crop: "cover";
  fallback: { sceneId: string; colour: string }; provenance: { file: string; source: string; sha256: string };
  captionTone: "light" | "dark";
}
export const ASSET_PACK_VERSION = "2.0.0";
export const ASSET_CATEGORIES: readonly AssetCategory[] = ["together", "create", "events", "material"];
export const ASSET_LIMITS = Object.freeze({ fullBytes: 1024 * 1024, thumbnailBytes: 64 * 1024, liveHandles: 4, concurrentLoads: 2, pendingLoads: 8, timeoutMs: 10000 });
export const PROCEDURAL_SCENE_IDS = Object.freeze(["studio-cream", "studio-rose", "sunset", "night", "beach", "polaroid-wall"]);
const fallbacks = PROCEDURAL_SCENE_IDS;
const safeId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const sha = /^[a-f0-9]{64}$/;
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys.sort().join()) throw new Error("Invalid curated asset fields");
  return value as Record<string, unknown>;
}
function boundedInteger(value: unknown, maximum: number): value is number { return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum; }

export function validateAssetRegistry(value: unknown): readonly CuratedAsset[] {
  const root = object(value, ["version", "assets"]);
  if (root.version !== ASSET_PACK_VERSION || !Array.isArray(root.assets) || root.assets.length > 24 || root.assets.length < 1) throw new Error("Unsupported curated asset pack");
  const ids = new Set<string>();
  return Object.freeze(root.assets.map(raw => {
    const asset = object(raw, ["id", "name", "version", "kind", "category", "full", "thumbnail", "focalPoint", "crop", "fallback", "provenance", "captionTone"]);
    if (typeof asset.id !== "string" || !safeId.test(asset.id) || asset.id.length > 80 || ids.has(asset.id)) throw new Error("Invalid or duplicate curated asset ID");
    ids.add(asset.id);
    if (typeof asset.name !== "string" || !asset.name.trim() || asset.name.length > 80 || asset.version !== ASSET_PACK_VERSION
      || !ASSET_CATEGORIES.includes(asset.category as AssetCategory) || asset.kind !== (asset.category === "material" ? "material" : "scene")
      || asset.crop !== "cover" || !["light", "dark"].includes(asset.captionTone as string)) throw new Error("Invalid curated asset metadata");
    const directory = asset.kind === "scene" ? "scenes" : "materials";
    for (const variant of ["full", "thumbnail"] as const) {
      const file = object(asset[variant], ["path", "width", "height", "bytes", "sha256"]);
      const edge = variant === "thumbnail" ? 320 : asset.kind === "scene" ? 1536 : 1024;
      if (!boundedInteger(file.width, edge) || !boundedInteger(file.height, edge) || !boundedInteger(file.bytes, variant === "full" ? ASSET_LIMITS.fullBytes : ASSET_LIMITS.thumbnailBytes)
        || typeof file.sha256 !== "string" || !sha.test(file.sha256) || file.path !== `/${directory}/v2/${asset.id}.${variant}.${file.sha256.slice(0, 12)}.webp`) throw new Error("Invalid curated asset delivery file");
    }
    if (!Array.isArray(asset.focalPoint) || asset.focalPoint.length !== 2 || asset.focalPoint.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) throw new Error("Invalid curated asset focal point");
    const fallback = object(asset.fallback, ["sceneId", "colour"]), provenance = object(asset.provenance, ["file", "source", "sha256"]);
    if (!fallbacks.includes(fallback.sceneId as string) || !/^#[a-fA-F0-9]{6}$/.test(fallback.colour as string)) throw new Error("Invalid procedural fallback");
    if (typeof provenance.file !== "string" || !/^docs\/assets\/v2\/[a-z-]+-generation\.json$/.test(provenance.file)
      || provenance.source !== `docs/assets/v2/${directory}/${asset.id}.png` || typeof provenance.sha256 !== "string" || !sha.test(provenance.sha256)) throw new Error("Invalid asset provenance");
    return Object.freeze({ ...asset, full: Object.freeze({ ...asset.full as AssetFile }), thumbnail: Object.freeze({ ...asset.thumbnail as AssetFile }), focalPoint: Object.freeze([...asset.focalPoint]), fallback: Object.freeze({ ...fallback }), provenance: Object.freeze({ ...provenance }) }) as unknown as CuratedAsset;
  }));
}

export const CURATED_ASSETS = validateAssetRegistry(manifest);
export const SCENE_ASSETS = Object.freeze(CURATED_ASSETS.filter(asset => asset.kind === "scene"));
export const MATERIAL_ASSETS = Object.freeze(CURATED_ASSETS.filter(asset => asset.kind === "material"));
const byId = new Map(CURATED_ASSETS.map(asset => [asset.id, asset]));
export function getCuratedAsset(id: string): CuratedAsset | null { return byId.get(id) ?? null; }
export function getAssetCrop(asset: CuratedAsset, width: number, height: number): { x: number; y: number; width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("Invalid asset crop dimensions");
  const scale = Math.max(width / asset.full.width, height / asset.full.height);
  const sourceWidth = width / scale, sourceHeight = height / scale;
  return { x: Math.max(0, Math.min(asset.full.width - sourceWidth, asset.focalPoint[0] * asset.full.width - sourceWidth / 2)), y: Math.max(0, Math.min(asset.full.height - sourceHeight, asset.focalPoint[1] * asset.full.height - sourceHeight / 2)), width: sourceWidth, height: sourceHeight };
}
