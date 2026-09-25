import { ASSET_CATEGORIES, ASSET_PACK_VERSION, type AssetCategory } from "./registry";

export async function requestAssetPack(action: "cache" | "clear", category: AssetCategory | "all"): Promise<{ files: number; version: string }> {
  if (!["cache", "clear"].includes(action) || ![...ASSET_CATEGORIES, "all"].includes(category)) throw new Error("Unknown asset pack");
  const worker = typeof navigator !== "undefined" && navigator.serviceWorker?.controller;
  if (!worker) throw new Error("Offline packs are not ready in this tab. Open the installed app online and reload, then try again.");
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = () => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); };
    const timer = setTimeout(() => { finish(); reject(new Error("The pack request has not finished. It may still be downloading. Clear the pack to cancel it, or try again online.")); }, 60000);
    channel.port1.onmessage = event => {
      finish();
      const result = event.data;
      if (result?.ok !== true || result.version !== ASSET_PACK_VERSION || !Number.isSafeInteger(result.files) || result.files < 0 || result.files > 48) reject(new Error("The pack could not be saved. Check the connection and available browser storage, then try again."));
      else resolve({ files: result.files, version: result.version });
    };
    try { worker.postMessage({ type: action === "cache" ? "PB_CACHE_ASSET_PACK" : "PB_CLEAR_ASSET_PACK", category }, [channel.port2]); }
    catch { finish(); reject(new Error("The offline worker could not be reached. Reload online and try again.")); }
  });
}
