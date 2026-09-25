import { createAssetLoader } from "./loader";
import { getAssetCrop, SCENE_ASSETS } from "./registry";

export interface SceneCropProbeResult { name: string; passed: boolean; detail: string; preview?: string }
const targets = [{ name: "3:2", width: 300, height: 200 }, { name: "4:3", width: 300, height: 225 }, { name: "Portrait 3:4", width: 225, height: 300 }];
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

export async function runSceneCropProbe(): Promise<SceneCropProbeResult[]> {
  if (process.env.NODE_ENV !== "development") throw new Error("Scene crop probes are available only in development");
  const results: SceneCropProbeResult[] = [], loader = createAssetLoader();
  try {
    for (const asset of SCENE_ASSETS) {
      const row = document.createElement("canvas"), tile = document.createElement("canvas");
      const resource = await loader.preload(asset.id);
      try {
        check(resource.kind === "ready", resource.kind === "fallback" ? `Scene unavailable: ${resource.reason}` : "Scene unavailable");
        check(resource.width === asset.full.width && resource.height === asset.full.height, "Native decoded dimensions differ from registry");
        row.width = 889; row.height = 368;
        const context = row.getContext("2d"); check(context, "Canvas is unavailable");
        context.fillStyle = "#faf7f2"; context.fillRect(0, 0, row.width, row.height);
        context.fillStyle = "#292524"; context.font = "600 15px sans-serif"; context.fillText(asset.name, 16, 22);
        let left = 16;
        for (const target of targets) {
          const crop = getAssetCrop(asset, target.width, target.height);
          check(crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0 && crop.x + crop.width <= resource.width + 0.001 && crop.y + crop.height <= resource.height + 0.001, "Focal crop extends beyond the source image");
          check(Math.abs(crop.width / crop.height - target.width / target.height) < 0.000001, "Crop aspect ratio would distort the image");
          tile.width = target.width; tile.height = target.height;
          const tileContext = tile.getContext("2d", { willReadFrequently: true }); check(tileContext, "Crop canvas is unavailable");
          tileContext.drawImage(resource.image, crop.x, crop.y, crop.width, crop.height, 0, 0, tile.width, tile.height);
          for (const [x, y] of [[0, 0], [tile.width - 1, 0], [0, tile.height - 1], [tile.width - 1, tile.height - 1], [Math.floor(tile.width / 2), Math.floor(tile.height / 2)]]) {
            check(tileContext.getImageData(x, y, 1, 1).data[3] === 255, "Crop contains an unfilled edge or transparent scene pixel");
          }
          context.font = "13px sans-serif"; context.fillStyle = "#292524"; context.fillText(target.name, left, 46);
          context.drawImage(tile, left, 56); left += target.width + 16;
        }
        const preview = row.toDataURL("image/webp", 0.78);
        check(preview.startsWith("data:image/"), "Scene preview could not be encoded");
        results.push({ name: asset.name, passed: true, detail: `${resource.width} × ${resource.height}, verified bytes/hash and native decode. Focal cover crops at 3:2, 4:3 and portrait 3:4; no stretched geometry or unfilled sample edges. Visual review still required.`, preview });
      } catch (error) {
        results.push({ name: asset.name, passed: false, detail: error instanceof Error ? error.message : String(error) });
      } finally {
        if (resource.kind === "ready") resource.release();
        row.width = row.height = tile.width = tile.height = 0;
      }
    }
  } finally { loader.dispose(); }
  return results;
}
