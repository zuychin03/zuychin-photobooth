import { v2 as cloudinary } from "cloudinary";

// Server-only. Uses the SAME Cloudinary account as zuychin-gallery, so kept
// strips land in one media library that the Gallery Photobooth view reads.
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
 *  (private, matching Gallery's private albums; served via signed URLs there). */
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
  });
  return { publicId: res.public_id, url: res.secure_url };
}

/** Best-effort removal when a strip is un-kept. */
export async function destroyStrip(publicId: string): Promise<void> {
  try {
    await cloudinary.uploader.destroy(publicId, {
      type: "authenticated",
      resource_type: "image",
      invalidate: true,
    });
  } catch {
    // Orphaned asset is a cost issue, not a correctness one.
  }
}
