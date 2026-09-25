// Paints "you, cut out, standing in the scene" onto a preview canvas at
// ~15fps so partners can pose into the shared backdrop before the shot.
import { SceneDef } from "./scenes";
import { segmentVideoMask } from "./segmentation";
import { getAssetCrop } from "./assets/registry";
import type { ReadyAsset } from "./assets/loader";

const FPS = 15;
const PREVIEW_W = 480;

export class LiveScenePainter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private lastTs = 0;
  private maskCanvas: HTMLCanvasElement;
  private frameCanvas: HTMLCanvasElement;
  private generation = 0;
  private resource: ReadyAsset | null = null;
  scene: SceneDef | null = null;

  constructor(
    private video: HTMLVideoElement,
    private target: HTMLCanvasElement,
    private mirror: boolean,
    private dependencies: { createCanvas?: () => HTMLCanvasElement; segment?: typeof segmentVideoMask } = {},
  ) {
    const createCanvas = dependencies.createCanvas ?? (() => document.createElement("canvas"));
    this.maskCanvas = createCanvas(); this.frameCanvas = createCanvas();
  }

  start(scene: SceneDef, resource: ReadyAsset | null = null): void {
    this.generation++;
    this.scene = scene;
    this.resource = resource?.asset.id === scene.assetId ? resource : null;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 1000 / FPS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.scene = null;
    this.resource = null;
    this.generation++;
    this.maskCanvas.width = this.maskCanvas.height = this.frameCanvas.width = this.frameCanvas.height = 0;
    this.target.getContext("2d")?.clearRect(0, 0, this.target.width, this.target.height);
  }

  private async tick(): Promise<void> {
    const { video, target, scene, resource, generation } = this;
    if (this.busy || !scene || video.videoWidth === 0 || video.videoHeight === 0) return;
    this.busy = true;
    try {
      // segmentForVideo requires strictly increasing timestamps
      const ts = Math.max(performance.now(), this.lastTs + 1);
      this.lastTs = ts;
      await (this.dependencies.segment ?? segmentVideoMask)(video, ts, this.maskCanvas);
      if (generation !== this.generation || !this.scene) return;

      const aspect = video.videoWidth / video.videoHeight;
      const w = PREVIEW_W;
      const h = Math.min(960, Math.max(1, Math.round(w / aspect)));
      if (target.width !== w || target.height !== h) {
        target.width = w;
        target.height = h;
      }

      // masked person frame at preview size
      this.frameCanvas.width = w;
      this.frameCanvas.height = h;
      const fctx = this.frameCanvas.getContext("2d")!;
      fctx.save();
      if (this.mirror) {
        fctx.translate(w, 0);
        fctx.scale(-1, 1);
      }
      fctx.drawImage(video, 0, 0, w, h);
      fctx.restore();
      fctx.globalCompositeOperation = "destination-in";
      fctx.save();
      if (this.mirror) {
        fctx.translate(w, 0);
        fctx.scale(-1, 1);
      }
      fctx.drawImage(this.maskCanvas, 0, 0, w, h);
      fctx.restore();
      fctx.globalCompositeOperation = "source-over";

      const ctx = target.getContext("2d")!;
      if (resource) {
        const crop = getAssetCrop(resource.asset, w, h);
        ctx.drawImage(resource.image, crop.x, crop.y, crop.width, crop.height, 0, 0, w, h);
      } else scene.draw(ctx, 0, 0, w, h);
      ctx.drawImage(this.frameCanvas, 0, 0);
    } catch {
      // painter is best-effort; capture and compose have their own paths
    } finally {
      this.busy = false;
      if (!this.scene) this.maskCanvas.width = this.maskCanvas.height = this.frameCanvas.width = this.frameCanvas.height = 0;
    }
  }
}
