import { ROLES, type Role } from "./layouts";
import type { TogetherPlacement } from "./compose";
import type { SceneDef } from "./scenes";
import { getAssetCrop } from "./assets/registry";
import type { ReadyAsset } from "./assets/loader";

export interface SharedPreviewInput { role: Role; video: HTMLVideoElement; mirror: boolean }
export interface SharedPreviewConfig {
  inputs: readonly SharedPreviewInput[]; intendedRoles: readonly Role[]; localRole: Role;
  scene: SceneDef | null; sceneAsset?: ReadyAsset | null; materialAsset?: ReadyAsset | null;
  places?: Partial<Record<Role, TogetherPlacement>>; aspectRatio?: number;
}
export interface SharedPreviewStatus {
  mode: "warming" | "together" | "originals" | "local-only" | "waiting" | "stopped";
  displayedRoles: Role[]; missingRoles: Role[];
  reason?: "missing-peer" | "no-scene" | "slow-segmentation" | "segmentation-unavailable";
  fps: number; inferenceMs: number | null;
}
export interface SharedPreviewSegmenter { segment(source: HTMLCanvasElement, mask: HTMLCanvasElement): void | Promise<void>; close(): void }
export interface SharedPreviewOptions {
  onStatus(status: SharedPreviewStatus): void;
  createCanvas?: () => HTMLCanvasElement;
  createSegmenter?: () => Promise<SharedPreviewSegmenter>;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}
const EDGE = 640, MIN_DELAY = 125;
let inferenceActive = false;

export function previewSourceSize(width: number, height: number, edge = EDGE) {
  if (![width, height, edge].every(value => Number.isFinite(value) && value > 0) || edge > EDGE) throw new Error("Invalid preview dimensions");
  const factor = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)) };
}
export function sharedPersonRect(width: number, height: number, sourceWidth: number, sourceHeight: number, index: number, count: number, place: TogetherPlacement = { dx: 0, dy: 0, scale: 1 }) {
  const h = height * (count > 2 ? 0.8 : 0.92) * place.scale, w = sourceWidth / sourceHeight * h;
  return { x: width * ((index + 1) / (count + 1) + place.dx) - w / 2, y: height + height * place.dy - h, width: w, height: h };
}
async function createNativeSegmenter(): Promise<SharedPreviewSegmenter> {
  const { FilesetResolver, ImageSegmenter } = await import("@mediapipe/tasks-vision");
  const files = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
  const create = (delegate: "GPU" | "CPU") => ImageSegmenter.createFromOptions(files, { baseOptions: { modelAssetPath: "/models/selfie_segmenter.tflite", delegate }, runningMode: "IMAGE", outputConfidenceMasks: true, outputCategoryMask: false });
  const model = await create("GPU").catch(() => create("CPU"));
  return {
    segment(source, mask) {
      const result = model.segment(source);
      try {
        const confidence = result.confidenceMasks?.at(-1);
        if (!confidence || confidence.width > EDGE || confidence.height > EDGE) throw new Error("Invalid preview mask");
        const values = confidence.getAsFloat32Array();
        if (values.length !== confidence.width * confidence.height) throw new Error("Invalid preview mask");
        mask.width = confidence.width; mask.height = confidence.height;
        const ctx = mask.getContext("2d")!, image = ctx.createImageData(mask.width, mask.height);
        for (let i = 0; i < values.length; i++) { const t = Math.max(0, Math.min(1, (values[i] - 0.35) / 0.4)); image.data[i * 4 + 3] = Math.round(t * t * (3 - 2 * t) * 255); }
        ctx.putImageData(image, 0, 0);
      } finally { result.close(); }
    },
    close: () => model.close(),
  };
}

export async function createSharedStillCutouts(inputs: ReadonlyMap<string, HTMLCanvasElement>, options: { signal?: AbortSignal; createCanvas?: () => HTMLCanvasElement; createSegmenter?: () => Promise<SharedPreviewSegmenter>; now?: () => number } = {}): Promise<Map<string, HTMLCanvasElement>> {
  if (inferenceActive) throw new Error("preview_busy");
  if (!inputs.size || inputs.size > 16 || [...inputs.keys()].some(id => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id))) throw new Error("preview_sources_invalid");
  const sizes = [...inputs.values()].map(source => previewSourceSize(source.width, source.height));
  if (sizes.reduce((sum, size) => sum + size.width * size.height, 0) > 8 * 1024 * 1024) throw new Error("preview_sources_exceeded");
  const canvas = options.createCanvas ?? (() => document.createElement("canvas")), now = options.now ?? (() => performance.now());
  const outputs = new Map<string, HTMLCanvasElement>(), mask = canvas(); let model: SharedPreviewSegmenter | null = null, succeeded = false;
  const active = () => { if (options.signal?.aborted) throw new Error("preview_cancelled"); };
  inferenceActive = true;
  try {
    active(); model = await (options.createSegmenter ?? createNativeSegmenter)(); active(); const started = now();
    let index = 0;
    for (const [id, source] of inputs) {
      active(); if (now() - started > 4000) throw new Error("preview_too_slow");
      const target = canvas(), size = sizes[index++]; target.width = size.width; target.height = size.height; outputs.set(id, target);
      const ctx = target.getContext("2d")!; ctx.drawImage(source, 0, 0, target.width, target.height);
      await model.segment(target, mask); active();
      if (now() - started > 4000) throw new Error("preview_too_slow");
      ctx.globalCompositeOperation = "destination-in"; ctx.drawImage(mask, 0, 0, target.width, target.height); ctx.globalCompositeOperation = "source-over";
    }
    succeeded = true; return outputs;
  } finally {
    try { model?.close(); } finally {
      mask.width = mask.height = 0;
      if (!succeeded) outputs.forEach(output => { output.width = output.height = 0; });
      inferenceActive = false;
    }
  }
}
function checkedConfig(input: SharedPreviewConfig): SharedPreviewConfig {
  const roles = [...input.intendedRoles].sort((a, b) => ROLES.indexOf(a) - ROLES.indexOf(b));
  if (!roles.length || roles.length > 4 || new Set(roles).size !== roles.length || roles.some(role => !ROLES.includes(role)) || !roles.includes(input.localRole)
    || input.inputs.length > 4 || new Set(input.inputs.map(item => item.role)).size !== input.inputs.length || input.inputs.some(item => !roles.includes(item.role) || typeof item.mirror !== "boolean")) throw new Error("Invalid shared preview roster");
  const aspectRatio = input.aspectRatio ?? 3 / 2;
  if (!Number.isFinite(aspectRatio) || aspectRatio < 0.5 || aspectRatio > 2) throw new Error("Invalid preview aspect ratio");
  const places: Partial<Record<Role, TogetherPlacement>> = {};
  for (const role of roles) {
    const place = input.places?.[role];
    if (!place) continue;
    if (![place.dx, place.dy, place.scale].every(Number.isFinite) || Math.abs(place.dx) > 0.5 || Math.abs(place.dy) > 0.25 || place.scale < 0.5 || place.scale > 1.6) throw new Error("Invalid preview placement");
    places[role] = { ...place };
  }
  return { ...input, intendedRoles: roles, inputs: input.inputs.map(item => ({ ...item })), places, aspectRatio,
    sceneAsset: input.sceneAsset?.asset.id === input.scene?.assetId ? input.sceneAsset : null,
    materialAsset: input.materialAsset?.asset.kind === "material" ? input.materialAsset : null };
}

export class SharedPreviewPainter {
  private config: SharedPreviewConfig | null = null;
  private generation = 0;
  private busy = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private model: SharedPreviewSegmenter | null = null;
  private modelPending: Promise<SharedPreviewSegmenter> | null = null;
  private frames = new Map<Role, HTMLCanvasElement>();
  private mask: HTMLCanvasElement;
  private stage: HTMLCanvasElement;
  private delay = MIN_DELAY;
  private inferenceMs: number | null = null;
  private warm = false;
  private degraded: SharedPreviewStatus["reason"] | null = null;
  private disposal: Promise<void> | null = null;
  private resolveDisposal: (() => void) | null = null;
  private readonly now: () => number;
  private readonly createCanvas: () => HTMLCanvasElement;
  constructor(private readonly target: HTMLCanvasElement, private readonly options: SharedPreviewOptions) {
    this.createCanvas = options.createCanvas ?? (() => document.createElement("canvas"));
    this.mask = this.createCanvas(); this.stage = this.createCanvas(); this.now = options.now ?? (() => performance.now());
  }
  start(config: SharedPreviewConfig): void { this.update(config); this.schedule(); }
  update(config: SharedPreviewConfig): void {
    if (this.disposed) throw new Error("Preview disposed");
    const next = checkedConfig(config);
    if (this.config?.intendedRoles.join() !== next.intendedRoles.join()) this.retryTogether();
    this.config = next; this.generation++;
  }
  retryTogether(): void { this.warm = false; this.degraded = null; this.delay = MIN_DELAY; this.inferenceMs = null; }
  private schedule() {
    if (!this.config || this.disposed || this.timer) return;
    this.timer = (this.options.schedule ?? setTimeout)(() => {
      this.timer = null;
      void this.renderFrame().catch(() => { if (this.config) this.emit("waiting", [], [...this.config.intendedRoles], "segmentation-unavailable"); }).finally(() => this.schedule());
    }, this.delay);
  }
  private emit(mode: SharedPreviewStatus["mode"], inputs: readonly SharedPreviewInput[], missingRoles: Role[], reason?: SharedPreviewStatus["reason"]) {
    this.options.onStatus({ mode, displayedRoles: inputs.map(item => item.role), missingRoles, reason, fps: mode === "stopped" ? 0 : Math.min(8, 1000 / (this.delay + (mode === "together" ? this.inferenceMs ?? 0 : 0))), inferenceMs: this.inferenceMs });
  }
  private async segmenter(generation: number): Promise<SharedPreviewSegmenter> {
    if (this.model) return this.model;
    if (!this.modelPending) {
      const pending = (this.options.createSegmenter ?? createNativeSegmenter)().then(model => {
        if (this.disposed || !this.config || this.generation !== generation) { model.close(); throw new Error("Preview changed"); }
        this.model = model; return model;
      });
      this.modelPending = pending;
      void pending.finally(() => { if (this.modelPending === pending) this.modelPending = null; }).catch(() => {});
    }
    return this.modelPending;
  }
  private background(config: SharedPreviewConfig, ctx: CanvasRenderingContext2D) {
    const { width, height } = this.stage;
    ctx.fillStyle = "#e8e3dd"; ctx.fillRect(0, 0, width, height);
    const asset = config.sceneAsset ?? (!config.scene ? config.materialAsset : null);
    if (asset) { const crop = getAssetCrop(asset.asset, width, height); ctx.drawImage(asset.image, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height); }
    else config.scene?.draw(ctx, 0, 0, width, height);
  }
  private originalTiles(config: SharedPreviewConfig, inputs: readonly SharedPreviewInput[]) {
    const ctx = this.stage.getContext("2d")!; this.background(config, ctx);
    const columns = inputs.length > 2 ? 2 : Math.max(1, inputs.length), rows = Math.ceil(inputs.length / columns), w = this.stage.width / columns, h = this.stage.height / Math.max(1, rows);
    inputs.forEach((input, index) => {
      const x = index % columns * w, y = Math.floor(index / columns) * h, scale = Math.max(w / input.video.videoWidth, h / input.video.videoHeight);
      const sw = w / scale, sh = h / scale;
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); ctx.translate(x + (input.mirror ? w : 0), y); if (input.mirror) ctx.scale(-1, 1);
      ctx.drawImage(input.video, (input.video.videoWidth - sw) / 2, (input.video.videoHeight - sh) / 2, sw, sh, 0, 0, w, h); ctx.restore();
    });
  }
  private publish(generation: number) {
    if (generation !== this.generation || !this.config || this.disposed) return;
    if (this.target.width !== this.stage.width || this.target.height !== this.stage.height) { this.target.width = this.stage.width; this.target.height = this.stage.height; }
    const ctx = this.target.getContext("2d")!; ctx.clearRect(0, 0, this.target.width, this.target.height); ctx.drawImage(this.stage, 0, 0);
  }
  async renderFrame(): Promise<void> {
    if (this.busy || inferenceActive || !this.config || this.disposed) return;
    const config = this.config, generation = this.generation;
    const available = config.intendedRoles.flatMap(role => { const input = config.inputs.find(item => item.role === role); return input && input.video.readyState >= 2 && input.video.paused !== true && input.video.ended !== true && input.video.videoWidth > 0 && input.video.videoHeight > 0 ? [input] : []; });
    const missing = config.intendedRoles.filter(role => !available.some(input => input.role === role));
    const size = previewSourceSize(640, 640 / config.aspectRatio!); this.stage.width = size.width; this.stage.height = size.height;
    if (missing.length || !config.scene || this.degraded) {
      const local = available.find(input => input.role === config.localRole), shown = missing.length && local ? [local] : available;
      this.originalTiles(config, shown); this.publish(generation);
      this.emit(!shown.length ? "waiting" : missing.length && local ? "local-only" : "originals", shown, missing, missing.length ? "missing-peer" : this.degraded ?? "no-scene"); return;
    }
    this.busy = true; inferenceActive = true;
    try {
      if (!this.warm) { this.originalTiles(config, available); this.publish(generation); this.emit("warming", available, [], undefined); }
      if (generation !== this.generation || !this.config || this.disposed) return;
      const model = await this.segmenter(generation);
      if (generation !== this.generation || !this.config) return;
      const started = this.now(), trial = !this.warm && available.length > 2;
      const inputs = trial ? available.slice(0, 2) : available;
      for (const input of inputs) {
        let frame = this.frames.get(input.role); if (!frame) { frame = this.createCanvas(); this.frames.set(input.role, frame); }
        const bounded = previewSourceSize(input.video.videoWidth, input.video.videoHeight, this.warm && this.delay === MIN_DELAY ? EDGE : 320);
        frame.width = bounded.width; frame.height = bounded.height;
        const ctx = frame.getContext("2d")!;
        ctx.save(); if (input.mirror) { ctx.translate(frame.width, 0); ctx.scale(-1, 1); } ctx.drawImage(input.video, 0, 0, frame.width, frame.height); ctx.restore();
        await model.segment(frame, this.mask);
        if (generation !== this.generation || !this.config) return;
        ctx.globalCompositeOperation = "destination-in"; ctx.drawImage(this.mask, 0, 0, frame.width, frame.height); ctx.globalCompositeOperation = "source-over";
        if (this.now() - started > 500) { this.degraded = "slow-segmentation"; break; }
      }
      this.inferenceMs = Math.max(0, this.now() - started);
      if (trial && this.inferenceMs > 100) this.degraded = "slow-segmentation";
      if (this.degraded) { this.originalTiles(config, available); this.publish(generation); this.emit("originals", available, [], this.degraded); return; }
      this.warm = true; this.delay = Math.max(MIN_DELAY, Math.min(500, this.inferenceMs));
      if (trial) return;
      const ctx = this.stage.getContext("2d")!; this.background(config, ctx);
      available.forEach((input, index) => { const frame = this.frames.get(input.role)!, rect = sharedPersonRect(this.stage.width, this.stage.height, frame.width, frame.height, index, available.length, config.places?.[input.role]); ctx.drawImage(frame, rect.x, rect.y, rect.width, rect.height); });
      this.publish(generation); this.emit("together", available, []);
    } catch {
      if (generation === this.generation && this.config && !this.disposed) { this.degraded = "segmentation-unavailable"; this.originalTiles(config, available); this.publish(generation); this.emit("originals", available, [], this.degraded); }
    } finally {
      this.busy = false; inferenceActive = false;
      if (!this.config || this.disposed) this.releaseOwned();
      this.resolveDisposal?.(); this.resolveDisposal = null;
    }
  }
  private releaseOwned() {
    this.model?.close(); this.model = null;
    for (const canvas of [this.mask, this.stage, ...this.frames.values()]) canvas.width = canvas.height = 0;
    this.frames.clear();
  }
  stop(): void {
    this.config = null; this.generation++;
    if (this.timer) (this.options.cancel ?? clearTimeout)(this.timer); this.timer = null;
    if (!this.busy) this.releaseOwned();
    this.target.getContext("2d")?.clearRect(0, 0, this.target.width, this.target.height);
    this.emit("stopped", [], []);
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.stop(); this.disposed = true;
    this.disposal = this.busy ? new Promise(resolve => { this.resolveDisposal = resolve; }) : Promise.resolve();
    return this.disposal;
  }
}
