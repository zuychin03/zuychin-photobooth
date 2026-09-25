import { composeStrip, type ComposeInput } from "../compose";
import { CELL_GAP, CELL_W, STRIP_MARGIN, getLayout } from "../layouts";
import { exportProjectBundle, importProjectBundle, projectBlobHash } from "../projects/bundle";
import { inspectImageHeader, inspectProjectImage, projectImageToCanvas } from "../projects/images";
import { appendProjectMedia, createProject } from "../projects/model";
import { defaultCellEdit } from "../projects/transforms";

export interface ProjectRenderProbeResult { name: string; passed: boolean; detail: string }
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

export function insertProbeJpegOrientation(jpeg: Uint8Array, orientation: 1 | 6 = 6): Uint8Array<ArrayBuffer> {
  check(jpeg.length >= 4 && jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg.at(-2) === 0xff && jpeg.at(-1) === 0xd9, "Expected a complete synthetic JPEG");
  check(orientation === 1 || orientation === 6, "Unsupported probe orientation");
  const exif = new Uint8Array(32);
  exif.set(new TextEncoder().encode("Exif\0\0II"));
  const tiff = new DataView(exif.buffer, 6);
  tiff.setUint16(2, 42, true); tiff.setUint32(4, 8, true); tiff.setUint16(8, 1, true);
  tiff.setUint16(10, 0x112, true); tiff.setUint16(12, 3, true); tiff.setUint32(14, 1, true); tiff.setUint16(18, orientation, true);
  const result = new Uint8Array(jpeg.length + exif.length + 4);
  result.set(jpeg.subarray(0, 2));
  result.set([0xff, 0xe1, 0, exif.length + 2], 2);
  result.set(exif, 6); result.set(jpeg.subarray(2), exif.length + 6);
  return result;
}

function canvas(width: number, height: number): HTMLCanvasElement {
  const result = document.createElement("canvas"); result.width = width; result.height = height;
  check(result.getContext("2d"), "Native 2D canvas is unavailable"); return result;
}
function quadrants(): HTMLCanvasElement {
  const result = canvas(120, 80), context = result.getContext("2d")!;
  for (const [colour, x, y] of [["#ff0000", 0, 0], ["#00ff00", 60, 0], ["#0000ff", 0, 40], ["#ffff00", 60, 40]] as const) {
    context.fillStyle = colour; context.fillRect(x, y, 60, 40);
  }
  return result;
}
const encode = (image: HTMLCanvasElement, mime: "image/png" | "image/jpeg") => new Promise<Blob>((resolve, reject) => image.toBlob(blob => blob ? resolve(blob) : reject(new Error(`${mime} encoding failed`)), mime, 0.95));
function expectPixel(image: HTMLCanvasElement, x: number, y: number, expected: readonly number[], tolerance = 3): void {
  const actual = image.getContext("2d")!.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
  check(expected.every((value, index) => Math.abs(actual[index] - value) <= tolerance) && actual[3] === 255,
    `Pixel ${Math.floor(x)},${Math.floor(y)} expected ${expected.join(",")}, received ${Array.from(actual).join(",")}`);
}
function input(source: HTMLCanvasElement): ComposeInput {
  return { layout: getLayout("strip4"), shots: { A: [source, source, source, source] }, stickers: [],
    style: { frameColor: "#ffffff", inkColor: "#000000", patternId: "none", filterId: "none", caption: "", showDate: false, stickerStyle: "flat" },
    capturedAt: "2025-12-31T14:30:00.000Z", captureTimeZone: "Australia/Sydney" };
}

export async function runProjectRenderProbe(): Promise<ProjectRenderProbeResult[]> {
  if (process.env.NODE_ENV === "production") throw new Error("Native render probes are development-only");
  check(typeof document !== "undefined" && typeof createImageBitmap === "function", "Run this probe in a browser with native image decoding");
  const results: ProjectRenderProbeResult[] = [];
  const run = async (name: string, work: () => Promise<string> | string) => {
    try { results.push({ name, passed: true, detail: await work() }); }
    catch (error) { results.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) }); }
  };

  await run("native-png-bundle-originals", async () => {
    const source = quadrants();
    try {
      const blob = await encode(source, "image/png"), originalHash = await projectBlobHash(blob);
      const info = await inspectProjectImage(blob), timestamp = "2026-01-01T00:00:00.000Z";
      const empty = createProject({ id: "render-probe", createdAt: timestamp, captureTimeZone: "Australia/Sydney", scope: { kind: "account", ownerId: "synthetic-owner" }, participants: [{ id: "synthetic-person", role: "A" }], capture: { cameraId: "synthetic-local-camera" } });
      const project = appendProjectMedia(empty, [{ ...info, id: "original", kind: "photo", participantId: "synthetic-person", bytes: blob.size }], { ...empty.sourceOrder, A: ["original"] }, timestamp, timestamp);
      const first = await importProjectBundle(await exportProjectBundle(project, new Map([["original", blob]])), { newId: () => "import-probe", now: () => timestamp });
      check(first.project.scope.kind === "device" && first.project.capture.cameraId === null, "Portable project retained account scope or local camera selection");
      check(first.project.capturedAt === timestamp && first.project.captureTimeZone === "Australia/Sydney", "Portable capture date settings changed");
      check(await projectBlobHash(first.media.get("original")!) === originalHash, "PNG source bytes changed during first bundle import");
      const second = await importProjectBundle(await exportProjectBundle(first.project, first.media), { newId: () => "reimport-probe", now: () => timestamp });
      check(await projectBlobHash(second.media.get("original")!) === originalHash, "PNG source bytes changed during bundle re-export");
      return "Native 120×80 PNG bytes survived export, native-validated import and re-export exactly; account and camera fields were redacted.";
    } finally { source.width = source.height = 0; }
  });

  await run("native-jpeg-exif-orientation", async () => {
    const source = quadrants(); let actual: HTMLCanvasElement | undefined, native: HTMLCanvasElement | undefined, bitmap: ImageBitmap | undefined;
    try {
      const jpeg = await encode(source, "image/jpeg");
      const bytes = insertProbeJpegOrientation(new Uint8Array(await jpeg.arrayBuffer()));
      const blob = new Blob([bytes], { type: "image/jpeg" }), originalHash = await projectBlobHash(blob);
      const info = inspectImageHeader(bytes);
      check(info.width === 80 && info.height === 120, "EXIF header did not rotate the declared dimensions");
      bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      check(bitmap.width === 80 && bitmap.height === 120, "Native JPEG decoder did not honour EXIF orientation 6");
      native = canvas(bitmap.width, bitmap.height); native.getContext("2d")!.drawImage(bitmap, 0, 0);
      actual = await projectImageToCanvas(blob, info);
      for (const image of [native, actual]) {
        expectPixel(image, 20, 30, [0, 0, 255], 30);
        expectPixel(image, 60, 30, [255, 0, 0], 30);
        expectPixel(image, 20, 90, [255, 255, 0], 30);
        expectPixel(image, 60, 90, [0, 255, 0], 30);
      }
      check(await projectBlobHash(blob) === originalHash, "Decoding mutated the original JPEG bytes");
      return "A real canvas JPEG with valid EXIF orientation 6 decoded to 80×120 with all four quadrant colours correctly rotated, through both native and app decoding.";
    } finally {
      bitmap?.close(); source.width = source.height = 0;
      if (native) native.width = native.height = 0;
      if (actual) actual.width = actual.height = 0;
    }
  });

  await run("native-cell-transforms", () => {
    const source = quadrants(), output = canvas(1, 1);
    const before = source.getContext("2d")!.getImageData(0, 0, source.width, source.height).data;
    try {
      const settings = input(source);
      settings.cellEdits = {
        "0:A": defaultCellEdit(0),
        "1:A": { ...defaultCellEdit(0), mirror: true },
        "2:A": { ...defaultCellEdit(0), rotation: 90 },
        "3:A": { ...defaultCellEdit(0), zoom: 2, offsetX: 1 },
      };
      for (const scale of [1, 2]) {
        composeStrip(output, settings, scale);
        const sample = (cell: number, x: number, y: number, colour: number[]) => expectPixel(output,
          (STRIP_MARGIN + CELL_W * x) * scale,
          (STRIP_MARGIN + cell * (CELL_W / settings.layout.cellAspect + CELL_GAP) + CELL_W / settings.layout.cellAspect * y) * scale, colour);
        sample(0, 0.25, 0.25, [255, 0, 0]); sample(0, 0.75, 0.25, [0, 255, 0]);
        sample(1, 0.25, 0.25, [0, 255, 0]); sample(1, 0.75, 0.25, [255, 0, 0]);
        sample(2, 0.25, 0.25, [0, 0, 255]); sample(2, 0.75, 0.25, [255, 0, 0]);
        sample(3, 0.25, 0.25, [255, 0, 0]); sample(3, 0.75, 0.25, [255, 0, 0]);
        expectPixel(output, 5 * scale, 5 * scale, [255, 255, 255]);
      }
      const after = source.getContext("2d")!.getImageData(0, 0, source.width, source.height).data;
      check(before.every((byte, index) => byte === after[index]), "Composition mutated source pixels");
      return "Native composition at 1× and 2× matched independent quadrant expectations for unchanged, mirrored, quarter-turned and zoomed/panned cells, without changing source pixels.";
    } finally { source.width = source.height = output.width = output.height = 0; }
  });

  await run("native-cell-source-selection", () => {
    const source = quadrants(), alternate = canvas(120, 80), output = canvas(1, 1);
    try {
      const context = alternate.getContext("2d")!; context.fillStyle = "#ff00ff"; context.fillRect(0, 0, 120, 80);
      const settings = input(source); settings.shots.A = [source, alternate, source, source];
      settings.cellEdits = { "0:A": defaultCellEdit(1), "1:A": defaultCellEdit(0) };
      composeStrip(output, settings);
      expectPixel(output, STRIP_MARGIN + 120, STRIP_MARGIN + 80, [255, 0, 255]);
      expectPixel(output, STRIP_MARGIN + 120, STRIP_MARGIN + 320 + CELL_GAP + 80, [255, 0, 0]);
      return "Changing one cell's source index selected the alternate original while another cell independently selected the first original.";
    } finally { source.width = source.height = alternate.width = alternate.height = output.width = output.height = 0; }
  });

  await run("native-capture-date-stability", () => {
    const source = quadrants(), output = canvas(1, 1), context = output.getContext("2d")!;
    const originalFill = context.fillText, originalNow = Date.now, labels: string[] = [];
    try {
      context.fillText = function (text: string, x: number, y: number, maxWidth?: number) {
        labels.push(text);
        if (maxWidth === undefined) originalFill.call(this, text, x, y); else originalFill.call(this, text, x, y, maxWidth);
      };
      const settings = input(source); settings.style.showDate = true;
      for (const wallClock of ["2020-01-01T00:00:00.000Z", "2030-07-01T00:00:00.000Z"]) {
        Date.now = () => Date.parse(wallClock); composeStrip(output, settings);
      }
      composeStrip(output, { ...settings, captureTimeZone: "UTC" });
      check(labels.length === 3 && labels[0] === "01·01·2026" && labels[1] === labels[0] && labels[2] === "31·12·2025", `Unexpected capture date labels: ${labels.join(" / ")}`);
      return "Native composition used the persisted capture instant and IANA timezone: Sydney stayed 01/01/2026 across two wall clocks; explicit UTC rendered 31/12/2025.";
    } finally { context.fillText = originalFill; Date.now = originalNow; source.width = source.height = output.width = output.height = 0; }
  });
  return results;
}
