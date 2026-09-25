import { prepareEventPostcardPhoto } from "./postcard-photo";
export async function runPostcardPhotoProbe() {
  if (process.env.NODE_ENV !== "development") throw new Error("Development probe unavailable");
  const canvas = document.createElement("canvas"), decodedCanvas = document.createElement("canvas"); let bitmap: ImageBitmap | undefined;
  try {
    canvas.width = 240; canvas.height = 960; const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Canvas unavailable");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, 240, 960); ctx.fillStyle = "#e02020"; ctx.fillRect(0, 0, 240, 80); ctx.fillStyle = "#2040e0"; ctx.fillRect(0, 880, 240, 80);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("PNG unavailable")), "image/png"));
    const result = await prepareEventPostcardPhoto(png); bitmap = await createImageBitmap(result.blob);
    decodedCanvas.width = bitmap.width; decodedCanvas.height = bitmap.height; const output = decodedCanvas.getContext("2d"); if (!output) throw new Error("Canvas unavailable"); output.drawImage(bitmap, 0, 0);
    const top = output.getImageData(120, 20, 1, 1).data, bottom = output.getImageData(120, 940, 1, 1).data;
    const checks = [{ name: "Native JPEG preserves the complete 1:4 strip", passed: result.width === 240 && result.height === 960 && bitmap.width === 240 && bitmap.height === 960 }, { name: "Top and bottom colour bands remain uncropped", passed: top[0] > 180 && top[2] < 100 && bottom[2] > 180 && bottom[0] < 100 }, { name: "Verified JPEG size and digest meet event bounds", passed: result.bytes > 0 && result.bytes <= 2000000 && /^[a-f0-9]{64}$/.test(result.sha256) }];
    return { passed: checks.every(check => check.passed), checks };
  } finally { bitmap?.close(); canvas.width = canvas.height = 0; decodedCanvas.width = decodedCanvas.height = 0; }
}
