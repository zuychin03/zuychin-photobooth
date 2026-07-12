// Person cutouts for Together mode. The MediaPipe runtime (wasm) and the
// selfie_segmenter model are served from public/, nothing loads from a CDN.
import type { ImageSegmenter } from "@mediapipe/tasks-vision";

let segmenterPromise: Promise<ImageSegmenter> | null = null;

async function createSegmenter(delegate: "GPU" | "CPU"): Promise<ImageSegmenter> {
  const { FilesetResolver, ImageSegmenter } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
  return ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: "/models/selfie_segmenter.tflite", delegate },
    runningMode: "IMAGE",
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });
}

function getSegmenter(): Promise<ImageSegmenter> {
  segmenterPromise ??= createSegmenter("GPU").catch(() => createSegmenter("CPU"));
  return segmenterPromise;
}

const cutoutCache = new WeakMap<HTMLCanvasElement, Promise<HTMLCanvasElement>>();

/** Soft edge: confidence below lo is transparent, above hi fully opaque. */
function alphaFromConfidence(c: number, lo = 0.35, hi = 0.75): number {
  const t = Math.min(1, Math.max(0, (c - lo) / (hi - lo)));
  return Math.round(t * t * (3 - 2 * t) * 255);
}

async function computeCutout(shot: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  const segmenter = await getSegmenter();
  const result = segmenter.segment(shot);
  try {
    const masks = result.confidenceMasks;
    if (!masks || masks.length === 0) throw new Error("no mask");
    // selfie_segmenter: index 0 is background, index 1 is person
    const mask = masks[masks.length - 1];
    const data = mask.getAsFloat32Array();
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = mask.width;
    maskCanvas.height = mask.height;
    const mctx = maskCanvas.getContext("2d")!;
    const img = mctx.createImageData(mask.width, mask.height);
    for (let i = 0; i < data.length; i++) {
      img.data[i * 4 + 3] = alphaFromConfidence(data[i]);
    }
    mctx.putImageData(img, 0, 0);

    const out = document.createElement("canvas");
    out.width = shot.width;
    out.height = shot.height;
    const ctx = out.getContext("2d")!;
    ctx.drawImage(shot, 0, 0);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(maskCanvas, 0, 0, out.width, out.height);
    return out;
  } finally {
    result.close();
  }
}

/** Segment a captured shot into an RGBA person cutout; cached per canvas. */
export function cutout(shot: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  let p = cutoutCache.get(shot);
  if (!p) {
    p = computeCutout(shot);
    cutoutCache.set(shot, p);
  }
  return p;
}

/** Warm up the wasm runtime and model so the first real cutout is fast. */
export function preloadSegmenter(): void {
  void getSegmenter().catch(() => {});
}
