// Paints "you, cut out, standing in the scene" onto a preview canvas at
// ~15fps so partners can pose into the shared backdrop before the shot.
import { SceneDef } from "./scenes";
import { segmentVideoMask } from "./segmentation";

const FPS = 15;
const PREVIEW_W = 480;

export class LiveScenePainter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private lastTs = 0;
  private maskCanvas = document.createElement("canvas");
  private frameCanvas = document.createElement("canvas");
  scene: SceneDef | null = null;

  constructor(
    private video: HTMLVideoElement,
    private target: HTMLCanvasElement,
    private mirror: boolean,
  ) {}

  start(scene: SceneDef): void {
    this.scene = scene;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 1000 / FPS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.scene = null;
  }

  private async tick(): Promise<void> {
    const { video, target, scene } = this;
    if (this.busy || !scene || video.videoWidth === 0) return;
    this.busy = true;
    try {
      // segmentForVideo requires strictly increasing timestamps
      const ts = Math.max(performance.now(), this.lastTs + 1);
      this.lastTs = ts;
      await segmentVideoMask(video, ts, this.maskCanvas);

      const aspect = video.videoWidth / video.videoHeight;
      const w = PREVIEW_W;
      const h = Math.round(w / aspect);
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
      scene.draw(ctx, 0, 0, w, h);
      ctx.drawImage(this.frameCanvas, 0, 0);
    } catch {
      // painter is best-effort; capture and compose have their own paths
    } finally {
      this.busy = false;
    }
  }
}
