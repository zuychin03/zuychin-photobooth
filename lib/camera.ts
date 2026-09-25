export type Facing = "user" | "environment";

export type CameraError = "denied" | "no-camera" | "in-use" | "unknown";

export interface CameraResult {
  stream: MediaStream | null;
  error: CameraError | null;
}

export async function startCamera(facing: Facing, deviceId: string | null = null): Promise<CameraResult> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return { stream: null, error: "no-camera" };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: facing }),
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    return { stream, error: null };
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    if (name === "NotAllowedError" || name === "SecurityError")
      return { stream: null, error: "denied" };
    if (name === "NotFoundError" || name === "OverconstrainedError")
      return { stream: null, error: "no-camera" };
    if (name === "NotReadableError" || name === "AbortError")
      return { stream: null, error: "in-use" };
    return { stream: null, error: "unknown" };
  }
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

export async function hasMultipleCameras(): Promise<boolean> {
  return (await listCameras()).length > 1;
}

export interface CameraDevice { id: string; label: string }
export async function listCameras(): Promise<CameraDevice[]> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(device => device.kind === "videoinput").map((device, index) => ({ id: device.deviceId, label: device.label || `Camera ${index + 1}` }));
  } catch {
    return [];
  }
}

export class CameraController {
  private generation = 0;
  private current: MediaStream | null = null;
  private detachEnded: (() => void)[] = [];
  constructor(private acquire: typeof startCamera = startCamera, private onEnded: () => void = () => {}) {}
  setOnEnded(listener: () => void): void { this.onEnded = listener; }
  get stream(): MediaStream | null { return this.current; }
  stop(): void {
    this.generation++;
    this.detachEnded.forEach(detach => detach());
    this.detachEnded = [];
    stopStream(this.current);
    this.current = null;
  }
  async start(facing: Facing, deviceId: string | null = null): Promise<CameraResult | null> {
    this.stop();
    const generation = this.generation;
    const result = await this.acquire(facing, deviceId);
    if (generation !== this.generation) { stopStream(result.stream); return null; }
    this.current = result.stream;
    if (result.stream) {
      const tracks = result.stream.getTracks().filter(track => track.kind === "video");
      const ended = () => {
        if (generation !== this.generation || this.current !== result.stream) return;
        this.stop();
        this.onEnded();
      };
      if (tracks.some(track => track.readyState === "ended")) {
        ended();
        return { stream: null, error: "no-camera" };
      }
      tracks.forEach(track => {
        track.addEventListener("ended", ended);
        this.detachEnded.push(() => track.removeEventListener("ended", ended));
      });
    }
    return result;
  }
}
