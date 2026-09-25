import { LAYOUTS, stripSize } from "../layouts";

export interface HeapObservation {
  source: "performance.memory" | "unavailable";
  samples: number;
  firstUsedBytes: number | null;
  lastUsedBytes: number | null;
  maxSampledUsedBytes: number | null;
  nativeAndGpuMemoryMeasured: false;
}

export function rgbaBytes(width: number, height: number, copies = 1): number {
  if (![width, height, copies].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError("Surface dimensions and copies must be positive safe integers.");
  }
  const bytes = width * height * copies * 4;
  if (!Number.isSafeInteger(bytes)) throw new RangeError("Surface byte count exceeds a safe integer.");
  return bytes;
}

export function mediaResourceInventory() {
  const canvas = rgbaBytes(1280, 720);
  const maxLayout = Math.max(...LAYOUTS.map(layout => {
    const { width, height } = stripSize(layout);
    return rgbaBytes(Math.trunc(width), Math.trunc(height));
  }));
  return {
    basis: "RGBA8 arithmetic for known surfaces, not measured process memory",
    persistentMediaCanvasBytes: canvas,
    layoutFixtureCanvasBytes: rgbaBytes(160, 120, 16),
    largestLayoutCanvasBytes: maxLayout,
    layoutKnownSurfacePeakBytes: canvas + rgbaBytes(160, 120, 16) + maxLayout,
    pngKnownSurfaceBytes: canvas * 2 + 4,
    playbackKnownSurfaceBytes: canvas * 2 + 4,
    encodedClipLimitBytes: 10 * 1024 * 1024,
    queuedRawFrameBytes: 0,
    hypothetical24RawFramesBytes: rgbaBytes(1280, 720, 24),
    exclusions: "Encoder/decoder internals, GPU copies, browser/compositor surfaces, Blob copies, delayed garbage collection and app/React memory are additional and unknown.",
  };
}

export function startHeapObservation(): () => HeapObservation {
  const values: number[] = [];
  const sample = () => {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
    const used = memory?.usedJSHeapSize;
    if (typeof used === "number" && Number.isSafeInteger(used) && used >= 0) values.push(used);
  };
  sample();
  const timer = setInterval(sample, 100);
  return () => {
    clearInterval(timer);
    sample();
    return {
      source: values.length ? "performance.memory" : "unavailable",
      samples: values.length,
      firstUsedBytes: values[0] ?? null,
      lastUsedBytes: values.at(-1) ?? null,
      maxSampledUsedBytes: values.length ? Math.max(...values) : null,
      nativeAndGpuMemoryMeasured: false,
    };
  };
}
