import { v2 as cloudinary } from "cloudinary";

// Server-only. Kept strips land in one Cloudinary media library that any
// companion app with the same credentials can read.
// Never import from a client component.

cloudinary.config({
  cloud_name: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const CLOUDINARY_ROOT_FOLDER = "zuychin-photobooth";

/** Configured only when all three Cloudinary vars are present. */
export function hasCloudinary(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET,
  );
}

export interface UploadedStrip {
  publicId: string;
  url: string;
}

/** Upload a strip PNG under zuychin-photobooth/<uid>/, authenticated delivery
 *  (private; companion views serve it via signed URLs). */
export async function uploadStrip(
  bytes: Buffer,
  userId: string,
  stripId: string,
): Promise<UploadedStrip> {
  const dataUri = `data:image/png;base64,${bytes.toString("base64")}`;
  const res = await cloudinary.uploader.upload(dataUri, {
    folder: `${CLOUDINARY_ROOT_FOLDER}/${userId}`,
    public_id: stripId,
    type: "authenticated",
    resource_type: "image",
    overwrite: true,
    timeout: 10_000,
  });
  return { publicId: res.public_id, url: res.secure_url };
}

/** Missing assets are already removed; provider failures must remain retryable. */
export async function destroyStrip(publicId: string): Promise<void> {
  const options = {
    type: "authenticated",
    resource_type: "image",
    invalidate: true,
    timeout: 10_000,
  } as const;
  const result = await cloudinary.uploader.destroy(publicId, options);
  if (result.result !== "ok" && result.result !== "not found") {
    throw new Error("Archive deletion was not confirmed");
  }
}

export async function verifyStripArchive(publicId: string, url: string): Promise<boolean> {
  try {
    const asset = await cloudinary.api.resource(publicId, { type: "authenticated", resource_type: "image", timeout: 10_000 });
    return asset.public_id === publicId && asset.secure_url === url && asset.type === "authenticated" && asset.resource_type === "image" && asset.bytes > 0;
  } catch (error) {
    if (error && typeof error === "object" && "http_code" in error && error.http_code === 404) return false;
    throw error;
  }
}
