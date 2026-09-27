import { ASSET_CATEGORIES, ASSET_PACK_VERSION, type AssetCategory } from "./registry";

export async function requestAssetPack(action: "cache" | "clear", category: AssetCategory | "all"): Promise<{ files: number; version: string }> {
  if (!["cache", "clear"].includes(action) || ![...ASSET_CATEGORIES, "all"].includes(category)) throw new Error("Unknown asset pack");
  const worker = typeof navigator !== "undefined" && navigator.serviceWorker?.controller;
  if (!worker) throw new Error("Offline packs aren't ready in this tab yet. Reload the page while you're online, then try again.");
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = () => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); };
    const timer = setTimeout(() => { finish(); reject(new Error("This is taking a while, and the pack might still be downloading. Clear it to cancel, or try again later.")); }, 60000);
    channel.port1.onmessage = event => {
      finish();
      const result = event.data;
      if (result?.ok !== true || result.version !== ASSET_PACK_VERSION || !Number.isSafeInteger(result.files) || result.files < 0 || result.files > 48) reject(new Error("Couldn't save the pack. Check your connection and free up some space, then try again."));
      else resolve({ files: result.files, version: result.version });
    };
    try { worker.postMessage({ type: action === "cache" ? "PB_CACHE_ASSET_PACK" : "PB_CLEAR_ASSET_PACK", category }, [channel.port2]); }
    catch { finish(); reject(new Error("Something went wrong with offline storage. Reload the page while you're online and try again.")); }
  });
}
