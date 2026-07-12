export type Facing = "user" | "environment";

export type CameraError = "denied" | "no-camera" | "in-use" | "unknown";

export interface CameraResult {
  stream: MediaStream | null;
  error: CameraError | null;
}

export async function startCamera(facing: Facing): Promise<CameraResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { stream: null, error: "no-camera" };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: facing,
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
  if (!navigator.mediaDevices?.enumerateDevices) return false;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput").length > 1;
  } catch {
    return false;
  }
}
