// Person cutouts for Together mode. The MediaPipe runtime (wasm) and the
// selfie_segmenter model are served from public/, nothing loads from a CDN.
import type { ImageSegmenter } from "@mediapipe/tasks-vision";

type Mode = "IMAGE" | "VIDEO";

const segmenterPromises: Partial<Record<Mode, Promise<ImageSegmenter>>> = {};

async function createSegmenter(mode: Mode, delegate: "GPU" | "CPU"): Promise<ImageSegmenter> {
  const { FilesetResolver, ImageSegmenter } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
  return ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: "/models/selfie_segmenter.tflite", delegate },
    runningMode: mode,
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });
}

// separate instances per mode: a segmenter is bound to one runningMode
function getSegmenter(mode: Mode = "IMAGE"): Promise<ImageSegmenter> {
  segmenterPromises[mode] ??= createSegmenter(mode, "GPU").catch(() =>
    createSegmenter(mode, "CPU"),
  );
  return segmenterPromises[mode]!;
}

const cutoutCache = new WeakMap<HTMLCanvasElement, Promise<HTMLCanvasElement>>();

/** Soft edge: confidence below lo is transparent, above hi fully opaque. */
function alphaFromConfidence(c: number, lo = 0.35, hi = 0.75): number {
  const t = Math.min(1, Math.max(0, (c - lo) / (hi - lo)));
  return Math.round(t * t * (3 - 2 * t) * 255);
}

type SegmentResult = { confidenceMasks?: { width: number; height: number; getAsFloat32Array(): Float32Array }[]; close(): void };

/** selfie_segmenter: index 0 is background, the last mask is the person. */
function maskToAlphaCanvas(result: SegmentResult, target?: HTMLCanvasElement): HTMLCanvasElement {
  const masks = result.confidenceMasks;
  if (!masks || masks.length === 0) throw new Error("no mask");
  const mask = masks[masks.length - 1];
  const data = mask.getAsFloat32Array();
  const maskCanvas = target ?? document.createElement("canvas");
  maskCanvas.width = mask.width;
  maskCanvas.height = mask.height;
  const mctx = maskCanvas.getContext("2d")!;
  const img = mctx.createImageData(mask.width, mask.height);
  for (let i = 0; i < data.length; i++) {
    img.data[i * 4 + 3] = alphaFromConfidence(data[i]);
  }
  mctx.putImageData(img, 0, 0);
  return maskCanvas;
}

async function computeCutout(shot: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  const segmenter = await getSegmenter();
  const result = segmenter.segment(shot);
  try {
    const maskCanvas = maskToAlphaCanvas(result as SegmentResult);
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

/**
 * Live path: segment the current video frame and write the person alpha
 * into `maskTarget`. Timestamps must be monotonic per video.
 */
export async function segmentVideoMask(
  video: HTMLVideoElement,
  timestampMs: number,
  maskTarget: HTMLCanvasElement,
): Promise<void> {
  const segmenter = await getSegmenter("VIDEO");
  const result = segmenter.segmentForVideo(video, timestampMs);
  try {
    maskToAlphaCanvas(result as SegmentResult, maskTarget);
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
export function preloadSegmenter(mode: "IMAGE" | "VIDEO" = "IMAGE"): void {
  void getSegmenter(mode).catch(() => {});
}
