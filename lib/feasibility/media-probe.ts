import type { ProbeResult } from "./types";
import type { Role } from "../layouts";

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 12;
const RECORD_MS = 2000;
const MAX_BYTES = 10 * 1024 * 1024;

export function printGeometry(widthMm: number, heightMm: number, ppi = 300) {
  if (![widthMm, heightMm, ppi].every((value) => Number.isFinite(value) && value > 0)) {
    throw new RangeError("Print dimensions and resolution must be finite and positive.");
  }
  const widthPx = Math.round((widthMm / 25.4) * ppi);
  const heightPx = Math.round((heightMm / 25.4) * ppi);
  const widthPt = (widthMm / 25.4) * 72;
  const heightPt = (heightMm / 25.4) * 72;
  if (!Number.isSafeInteger(widthPx) || !Number.isSafeInteger(heightPx) || widthPx < 1 || heightPx < 1 || !Number.isFinite(widthPt) || !Number.isFinite(heightPt)) {
    throw new RangeError("Print dimensions must resolve to positive, safe integer pixels.");
  }
  return { widthMm, heightMm, ppi, widthPx, heightPx, widthPt, heightPt };
}

export async function recordingFormatMatches(requestedMime: string, recorderMime: string, blob: Blob): Promise<boolean> {
  const essence = (mime: string) => mime.split(";", 1)[0].trim().toLowerCase();
  const expected = essence(requestedMime);
  if (essence(recorderMime) !== expected || essence(blob.type) !== expected) return false;
  const bytes = new Uint8Array(await blob.slice(0, 512).arrayBuffer());
  if (expected === "video/mp4") {
    if (bytes.length < 16 || String.fromCharCode(...bytes.slice(4, 8)) !== "ftyp") return false;
    const boxSize = new DataView(bytes.buffer).getUint32(0);
    if (boxSize < 16 || boxSize > bytes.length || boxSize % 4 !== 0) return false;
    for (let offset = 8; offset < boxSize; offset += 4) {
      if (offset !== 12 && String.fromCharCode(...bytes.slice(offset, offset + 3)) === "mp4") return true;
    }
  } else if (expected === "video/webm") {
    if (bytes.slice(0, 4).join(",") !== "26,69,223,163") return false;
    for (let offset = 4; offset < Math.min(bytes.length - 6, 38); offset++) {
      if (bytes[offset] === 0x42 && bytes[offset + 1] === 0x82 && bytes[offset + 2] === 0x84
        && String.fromCharCode(...bytes.slice(offset + 3, offset + 7)) === "webm") return true;
    }
  }
  return false;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  if (!canvas.getContext("2d")) {
    canvas.width = canvas.height = 0;
    throw new Error("Canvas 2D context is unavailable.");
  }
  return canvas;
}

function drawFrame(canvas: HTMLCanvasElement, elapsedMs: number): void {
  const context = canvas.getContext("2d")!;
  context.fillStyle = elapsedMs < RECORD_MS / 2 ? "#e63a64" : "#2367d1";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#fff3c2";
  context.fillRect((elapsedMs / RECORD_MS) * (WIDTH - 120), HEIGHT / 2, 120, 160);
}

async function probeStill(canvas: HTMLCanvasElement): Promise<ProbeResult> {
  const id = "media-png-fallback";
  let url: string | undefined;
  const image = new Image();
  const sample = makeCanvas(1, 1);
  try {
    drawFrame(canvas, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("PNG encoding timed out after 8 seconds.")), 8000);
      try {
        canvas.toBlob((value) => {
          window.clearTimeout(timeout);
          if (value?.size) resolve(value);
          else reject(new Error("PNG encoder produced no data."));
        }, "image/png");
      } catch (error) {
        window.clearTimeout(timeout);
        reject(error);
      }
    });
    url = URL.createObjectURL(blob);
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => finish(new Error("PNG decoding timed out after 8 seconds.")), 8000);
      function finish(error?: Error) {
        window.clearTimeout(timeout);
        image.onload = null;
        image.onerror = null;
        if (error) reject(error);
        else resolve();
      }
      image.onload = () => finish();
      image.onerror = () => finish(new Error("Exported PNG could not be decoded."));
      image.src = url!;
    });
    const context = sample.getContext("2d")!;
    context.drawImage(image, 10, 10, 1, 1, 0, 0, 1, 1);
    const pixel = [...context.getImageData(0, 0, 1, 1).data];
    const pass = blob.type === "image/png" && image.naturalWidth === WIDTH && image.naturalHeight === HEIGHT && pixel.join(",") === "230,58,100,255";
    return { id, status: pass ? "pass" : "fail", detail: pass ? "PNG encoded, decoded and retained the expected synthetic pixel independently of motion." : "PNG dimensions, MIME or decoded pixels did not match the source.", metrics: { mime: blob.type, bytes: blob.size, width: image.naturalWidth, height: image.naturalHeight, pixel: pixel.join(",") } };
  } catch (error) {
    return { id, status: "fail", detail: errorDetail(error) };
  } finally {
    image.onload = null;
    image.onerror = null;
    image.removeAttribute("src");
    if (url) URL.revokeObjectURL(url);
    sample.width = sample.height = 0;
  }
}

async function probeLayouts(): Promise<ProbeResult[]> {
  const [{ composeStrip }, { LAYOUTS, ROLES, CELL_W, CELL_GAP, STRIP_MARGIN, stripSize }] = await Promise.all([import("../compose"), import("../layouts")]);
  const shots: Partial<Record<Role, HTMLCanvasElement[]>> = {};
  const colour = (role: Role, shot: number) => [40 + ROLES.indexOf(role) * 55, 40 + shot * 45, 180 - shot * 20, 255];
  const results: ProbeResult[] = [];
  try {
    for (const role of ROLES) {
      shots[role] = [];
      for (let shot = 0; shot < 4; shot++) {
        const source = makeCanvas(160, 120);
        shots[role]!.push(source);
        const context = source.getContext("2d")!;
        context.fillStyle = `rgb(${colour(role, shot).slice(0, 3).join(",")})`;
        context.fillRect(0, 0, source.width, source.height);
      }
    }
    for (const layout of LAYOUTS) {
      const canvas = makeCanvas(1, 1);
      try {
        composeStrip(canvas, { layout, shots, style: { frameColor: "#f7f1e8", inkColor: "#222222", patternId: "none", filterId: "none", caption: "", showDate: false, stickerStyle: "flat" }, stickers: [] });
        const context = canvas.getContext("2d")!;
        const expectedSize = stripSize(layout);
        const mismatches: string[] = [];
        let checkedSamples = 0;
        for (let cell = 0; cell < layout.cols * layout.rows; cell++) {
          const col = cell % layout.cols;
          const row = Math.floor(cell / layout.cols);
          const shot = layout.mode === "solo" ? cell : row;
          const owner = layout.duoPattern?.[cell] ?? "A";
          const owners: Role[] = owner === "AB" ? ["A", "B"] : [owner];
          owners.forEach((role, part) => {
            const x = STRIP_MARGIN + col * (CELL_W + CELL_GAP) + CELL_W * ((part + 0.5) / owners.length);
            const y = STRIP_MARGIN + row * (CELL_W / layout.cellAspect + CELL_GAP) + CELL_W / layout.cellAspect / 2;
            const actual = [...context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data];
            if (actual.join(",") !== colour(role, shot).join(",")) mismatches.push(`cell ${cell}, role ${role}, shot ${shot}`);
            checkedSamples++;
          });
        }
        const margin = [...context.getImageData(0, 0, 1, 1).data].join(",");
        if (margin !== "247,241,232,255") mismatches.push("frame margin");
        if (canvas.width !== expectedSize.width || canvas.height !== expectedSize.height) mismatches.push("output dimensions");
        results.push({ id: `compose-${layout.id}`, status: mismatches.length ? "fail" : "pass", detail: mismatches.length ? `Unexpected rendered pixels: ${mismatches.join("; ")}` : "Existing compositor painted the expected participant/shot colours and frame margin.", metrics: { width: canvas.width, height: canvas.height, checkedSamples } });
      } catch (error) {
        results.push({ id: `compose-${layout.id}`, status: "fail", detail: errorDetail(error) });
      } finally {
        canvas.width = canvas.height = 0;
      }
    }
  } finally {
    Object.values(shots).flat().forEach((canvas) => { canvas.width = canvas.height = 0; });
  }
  return results;
}

async function recordClip(canvas: HTMLCanvasElement, mime: string) {
  let stream: MediaStream | undefined;
  let recorder: MediaRecorder | undefined;
  let drawTimer: number | undefined;
  let stopTimer: number | undefined;
  let timeout: number | undefined;
  let framesDrawn = 0;
  let captureElapsedMs = 0;
  let chunkBytes = 0;
  const chunks: Blob[] = [];
  try {
    drawFrame(canvas, 0);
    stream = canvas.captureStream(FPS);
    const trackRate = stream.getVideoTracks()[0]?.getSettings().frameRate;
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 2_000_000 } : { videoBitsPerSecond: 2_000_000 });
    const activeRecorder = recorder;
    const startedAt = performance.now();
    const blob = await new Promise<Blob>((resolve, reject) => {
      timeout = window.setTimeout(() => reject(new Error("Recorder did not finish within 7 seconds.")), 7000);
      activeRecorder.ondataavailable = (event) => {
        chunkBytes += event.data.size;
        if (chunkBytes > MAX_BYTES) {
          reject(new Error("Synthetic recording exceeded the 10 MB probe limit."));
          return;
        }
        if (event.data.size) chunks.push(event.data);
      };
      activeRecorder.onerror = (event) => reject((event as Event & { error?: DOMException }).error ?? new Error("MediaRecorder emitted an error."));
      activeRecorder.onstop = () => {
        if (!chunkBytes) reject(new Error("Recorder produced an empty clip."));
        else resolve(new Blob(chunks, { type: chunks.find((chunk) => chunk.type)?.type || activeRecorder.mimeType }));
      };
      activeRecorder.start(250);
      drawTimer = window.setInterval(() => {
        try {
          drawFrame(canvas, performance.now() - startedAt);
          framesDrawn++;
        } catch (error) { reject(error); }
      }, 1000 / FPS);
      stopTimer = window.setTimeout(() => {
        captureElapsedMs = performance.now() - startedAt;
        try { activeRecorder.stop(); } catch (error) { reject(error); }
      }, RECORD_MS);
    });
    return { blob, recorderMime: recorder.mimeType, framesDrawn, captureElapsedMs, trackRate: trackRate ?? "unreported" };
  } finally {
    window.clearInterval(drawTimer);
    window.clearTimeout(stopTimer);
    window.clearTimeout(timeout);
    if (recorder) {
      recorder.ondataavailable = recorder.onerror = recorder.onstop = null;
      if (recorder.state !== "inactive") {
        try { recorder.stop(); } catch { /* Tracks still stop if recorder shutdown fails. */ }
      }
    }
    stream?.getTracks().forEach((track) => track.stop());
  }
}

async function decodeClip(blob: Blob) {
  const video = document.createElement("video");
  const sample = makeCanvas(96, 54);
  const url = URL.createObjectURL(blob);
  let timeout: number | undefined;
  let sampleTimer: number | undefined;
  let decodedSamples = 0;
  let lastTime = -1;
  const colours = new Set<string>();
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.setAttribute("aria-hidden", "true");
  video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.append(video);
  try {
    await new Promise<void>((resolve, reject) => {
      timeout = window.setTimeout(() => reject(new Error("Recorded clip did not decode and finish playback within 8 seconds.")), 8000);
      video.onerror = () => reject(new Error(`Recorded clip decoder failed (media error ${video.error?.code ?? "unknown"}).`));
      video.onended = () => resolve();
      video.onloadeddata = () => { void video.play().catch(reject); };
      sampleTimer = window.setInterval(() => {
        if (video.readyState < 2 || video.currentTime <= lastTime) return;
        try {
          const context = sample.getContext("2d")!;
          context.drawImage(video, 0, 0, sample.width, sample.height);
          const pixel = context.getImageData(3, 3, 1, 1).data;
          colours.add(`${pixel[0] >> 4},${pixel[1] >> 4},${pixel[2] >> 4}`);
          decodedSamples++;
          lastTime = video.currentTime;
        } catch (error) { reject(error); }
      }, 50);
      video.src = url;
      video.load();
    });
    const metrics = { decodedWidth: video.videoWidth, decodedHeight: video.videoHeight, metadataDurationSeconds: Number.isFinite(video.duration) ? Number(video.duration.toFixed(3)) : String(video.duration), playbackEndSeconds: Number(video.currentTime.toFixed(3)), decodedSamples, distinctSampleColours: colours.size };
    const pass = video.videoWidth === WIDTH && video.videoHeight === HEIGHT && video.currentTime >= 1.4 && video.currentTime <= 3 && decodedSamples >= 2 && colours.size >= 2;
    return { pass, metrics };
  } finally {
    window.clearTimeout(timeout);
    window.clearInterval(sampleTimer);
    video.onloadeddata = video.onerror = video.onended = null;
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
    sample.width = sample.height = 0;
  }
}

export async function runMediaProbe(): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [
    { id: "print-strip-geometry", status: "pass", detail: "Physical geometry calculation only: 50.8 x 152.4 mm at 300 ppi. No printer or PDF rendering tested.", metrics: printGeometry(50.8, 152.4) },
    { id: "print-sheet-geometry", status: "pass", detail: "Physical geometry calculation only: 101.6 x 152.4 mm at 300 ppi. No printer or PDF rendering tested.", metrics: printGeometry(101.6, 152.4) },
  ];
  if (typeof document === "undefined") return [...results, { id: "media-browser", status: "unsupported", detail: "Canvas and codec probes require a browser document." }];
  let canvas: HTMLCanvasElement;
  try { canvas = makeCanvas(WIDTH, HEIGHT); } catch (error) { return [...results, { id: "media-canvas", status: "unsupported", detail: errorDetail(error) }]; }
  try {
    results.push(await probeStill(canvas));
    try { results.push(...await probeLayouts()); } catch (error) { results.push({ id: "compose-layouts", status: "fail", detail: errorDetail(error) }); }
    if (typeof canvas.captureStream !== "function" || typeof MediaRecorder === "undefined") {
      results.push({ id: "media-motion", status: "unsupported", detail: "Canvas captureStream or MediaRecorder is unavailable; see the independent PNG result." });
      return results;
    }
    const formats = [{ id: "mp4", candidates: ["video/mp4;codecs=avc1.42E01E", "video/mp4"] }, { id: "webm", candidates: ["video/webm;codecs=vp8", "video/webm"] }];
    for (const format of formats) {
      const mime = format.candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
      if (!mime) {
        results.push({ id: `media-${format.id}`, status: "unsupported", detail: `The browser does not advertise a supported ${format.id.toUpperCase()} recording candidate. No format conversion or relabelling attempted.` });
        continue;
      }
      let recording: Awaited<ReturnType<typeof recordClip>> | undefined;
      try {
        recording = await recordClip(canvas, mime);
        if (!await recordingFormatMatches(mime, recording.recorderMime, recording.blob)) {
          throw new Error("Requested format does not match the recorder MIME, Blob MIME or expected container header.");
        }
        const decoded = await decodeClip(recording.blob);
        results.push({ id: `media-${format.id}`, status: decoded.pass ? "pass" : "fail", detail: decoded.pass ? "Synthetic clip encoded and played to completion with changed decoded pixels. Requested 2 seconds, 12 fps, 1280 x 720; this is not a camera or measured output-fps test." : "Clip playback completed but dimensions, duration or decoded motion did not meet the probe profile.", metrics: { requestedMime: mime, recorderMime: recording.recorderMime, blobMime: recording.blob.type || "unreported", bytes: recording.blob.size, requestedFps: FPS, trackRate: recording.trackRate, framesDrawn: recording.framesDrawn, captureElapsedMs: Math.round(recording.captureElapsedMs), ...decoded.metrics } });
      } catch (error) {
        results.push({ id: `media-${format.id}`, status: "fail", detail: errorDetail(error), metrics: { requestedMime: mime, ...(recording ? { recorderMime: recording.recorderMime, blobMime: recording.blob.type || "unreported", bytes: recording.blob.size } : {}) } });
      }
    }
    return results;
  } finally {
    canvas.width = canvas.height = 0;
  }
}
