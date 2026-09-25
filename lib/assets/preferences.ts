import { getCuratedAsset, PROCEDURAL_SCENE_IDS } from "./registry";

export const ASSET_FAVOURITES_KEY = "pb-asset-favourites-v2";
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
const supported = (id: unknown): id is string => typeof id === "string" && (PROCEDURAL_SCENE_IDS.includes(id) || getCuratedAsset(id) !== null);
export function validateAssetFavourites(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 30) throw new Error("Invalid favourite assets");
  return [...new Set(value.filter(supported))];
}
export function readAssetFavourites(storage?: PreferenceStorage): string[] {
  try {
    const raw = (storage ?? localStorage).getItem(ASSET_FAVOURITES_KEY);
    if (!raw || raw.length > 4096) return [];
    const data = JSON.parse(raw);
    return data?.version === 1 ? validateAssetFavourites(data.ids) : [];
  } catch { return []; }
}
export function writeAssetFavourites(ids: string[], storage?: PreferenceStorage): boolean {
  try { (storage ?? localStorage).setItem(ASSET_FAVOURITES_KEY, JSON.stringify({ version: 1, ids: validateAssetFavourites(ids) })); return true; }
  catch { return false; }
}
