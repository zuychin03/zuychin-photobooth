import { ROOM_LIMITS, type RoomDeliveryProfile } from "../server/room-contract";

export function roomCaptureProfile(members: number, shots: number): RoomDeliveryProfile {
  if (!Number.isInteger(members) || members < 2 || members > 4 || !Number.isInteger(shots) || shots < 1 || shots > 4) throw new Error("Invalid capture size");
  return { shotsPerMember: shots, maxPhotoBytes: Math.min(10 * 1024 * 1024, Math.floor(ROOM_LIMITS.totalPhotoBytes / (members * shots))), maxPhotoPixels: Math.min(12 * 1024 * 1024, Math.floor(ROOM_LIMITS.totalPhotoPixels / (members * shots))) };
}

export function roomPhotoSize(width: number, height: number, maxPixels: number) {
  if (![width, height, maxPixels].every(value => Number.isFinite(value) && value > 0)) throw new Error("Camera is not ready");
  const scale = Math.min(1, 4096 / width, 4096 / height, Math.sqrt(maxPixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

export async function captureRoomOriginal(video: HTMLVideoElement, profile: RoomDeliveryProfile, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  if (video.readyState < 2 || video.paused || video.ended) throw new Error("Camera is not ready");
  const size = roomPhotoSize(video.videoWidth, video.videoHeight, profile.maxPhotoPixels);
  const canvas = document.createElement("canvas");
  canvas.width = size.width; canvas.height = size.height;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Camera capture is unavailable");
    context.translate(size.width, 0); context.scale(-1, 1);
    context.drawImage(video, 0, 0, size.width, size.height);
    for (const quality of [.92, .82, .7]) {
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Photo could not be encoded")), "image/jpeg", quality));
      signal.throwIfAborted();
      if (blob.size <= profile.maxPhotoBytes) return blob;
    }
    throw new Error("Photo exceeds this room’s capture budget. Choose fewer shots and retry.");
  } finally { canvas.width = canvas.height = 0; }
}

export function roomIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
  const urls = (process.env.NEXT_PUBLIC_TURN_URL ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (urls.length) servers.push({ urls, username: process.env.NEXT_PUBLIC_TURN_USERNAME ?? "", credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL ?? "" });
  return servers;
}
