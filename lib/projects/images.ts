import { RESOURCE_LIMITS, type StillImageMime } from "./resource-bounds";

export interface ProjectImageInfo {
  mime: StillImageMime;
  width: number;
  height: number;
}

function invalid(message = "This image is incomplete or unsupported"): never { throw new Error(message); }
const ascii = (bytes: Uint8Array, start: number, count: number) => String.fromCharCode(...bytes.subarray(start, start + count));

function dimensions(mime: StillImageMime, width: number, height: number, orientation = 1): ProjectImageInfo {
  if (orientation >= 5) [width, height] = [height, width];
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > RESOURCE_LIMITS.photoEdge || height > RESOURCE_LIMITS.photoEdge || width * height > RESOURCE_LIMITS.photoPixels) {
    invalid("Choose an image up to 4096 pixels per side and 12 megapixels");
  }
  return { mime, width, height };
}

function exifOrientation(bytes: Uint8Array): number {
  const start = ascii(bytes, 0, 6) === "Exif\0\0" ? 6 : 0;
  if (bytes.length < start + 8) invalid();
  const order = ascii(bytes, start, 2);
  if (order !== "II" && order !== "MM") invalid();
  const little = order === "II";
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, bytes.byteLength - start);
  if (view.getUint16(2, little) !== 42) invalid();
  const offset = view.getUint32(4, little);
  if (offset < 8 || offset + 2 > view.byteLength) invalid();
  const count = view.getUint16(offset, little);
  if (count > 2048 || offset + 2 + count * 12 + 4 > view.byteLength) invalid();
  let orientation = 1;
  let found = false;
  for (let index = 0; index < count; index++) {
    const entry = offset + 2 + index * 12;
    if (view.getUint16(entry, little) !== 0x112) continue;
    if (found || view.getUint16(entry + 2, little) !== 3 || view.getUint32(entry + 4, little) !== 1) invalid();
    orientation = view.getUint16(entry + 8, little);
    if (orientation < 1 || orientation > 8) invalid();
    found = true;
  }
  return orientation;
}

export function inspectImageHeader(bytes: Uint8Array): ProjectImageInfo {
  return imageHeader(bytes, RESOURCE_LIMITS.photoBytes);
}

export function inspectRetainedPngHeader(bytes: Uint8Array): ProjectImageInfo {
  if (bytes.length < 33 || ascii(bytes, 0, 8) !== "\x89PNG\r\n\x1a\n") invalid("This retained photograph is not a supported PNG");
  return imageHeader(bytes, 16 * 1024 * 1024);
}

function imageHeader(bytes: Uint8Array, maximumBytes: number): ProjectImageInfo {
  if (!bytes.length || bytes.length > maximumBytes) invalid(`Choose an image smaller than ${maximumBytes / (1024 * 1024)} MiB`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 33 && ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n") {
    let width = 0, height = 0, offset = 8, data = false, orientation = 1, exif = false;
    while (offset + 12 <= bytes.length) {
      const size = view.getUint32(offset);
      const type = ascii(bytes, offset + 4, 4);
      if (size > bytes.length - offset - 12) invalid();
      if (offset === 8) {
        if (type !== "IHDR" || size !== 13) invalid();
        width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
        dimensions("image/png", width, height);
      } else if (type === "IHDR") invalid();
      if (["acTL", "fcTL", "fdAT"].includes(type)) invalid("Animated images are not supported here; choose a still photo");
      if (type === "eXIf") {
        if (exif) invalid();
        orientation = exifOrientation(bytes.subarray(offset + 8, offset + 8 + size));
        exif = true;
      }
      if (type === "IDAT") data = true;
      if (type === "IEND") {
        if (size !== 0 || !data || offset + 12 !== bytes.length) invalid();
        return dimensions("image/png", width, height, orientation);
      }
      offset += size + 12;
    }
    invalid();
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2, width = 0, height = 0, orientation = 1, exif = false;
    while (offset + 2 <= bytes.length) {
      if (bytes[offset++] !== 0xff) invalid();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda) {
        if (!width || !height || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) invalid();
        return dimensions("image/jpeg", width, height, orientation);
      }
      if (marker === 0xd9 || marker === 0 || offset + 2 > bytes.length) invalid();
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) invalid();
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (width || size < 8) invalid();
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5);
        dimensions("image/jpeg", width, height);
      } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) invalid();
      if (marker === 0xe1 && ascii(bytes, offset + 2, 6) === "Exif\0\0") {
        if (exif) invalid();
        orientation = exifOrientation(bytes.subarray(offset + 2, offset + size));
        exif = true;
      }
      offset += size;
    }
    invalid();
  }
  if (bytes.length >= 20 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    if (view.getUint32(4, true) + 8 !== bytes.length) invalid();
    let offset = 12, width = 0, height = 0, canvasWidth = 0, canvasHeight = 0, orientation = 1, exif = false;
    while (offset + 8 <= bytes.length) {
      const type = ascii(bytes, offset, 4), size = view.getUint32(offset + 4, true), start = offset + 8;
      if (size > bytes.length - start) invalid();
      if (type === "ANIM" || type === "ANMF") invalid("Animated images are not supported here; choose a still photo");
      if (type === "VP8X") {
        if (offset !== 12 || size !== 10 || (bytes[start] & 2)) invalid("Animated or malformed WebP is not supported");
        canvasWidth = 1 + bytes[start + 4] + bytes[start + 5] * 256 + bytes[start + 6] * 65536;
        canvasHeight = 1 + bytes[start + 7] + bytes[start + 8] * 256 + bytes[start + 9] * 65536;
        dimensions("image/webp", canvasWidth, canvasHeight);
      }
      if (type === "VP8 ") {
        if (width || size < 10 || (bytes[start] & 1) || ascii(bytes, start + 3, 3) !== "\x9d\x01\x2a") invalid();
        width = view.getUint16(start + 6, true) & 0x3fff; height = view.getUint16(start + 8, true) & 0x3fff;
      }
      if (type === "VP8L") {
        if (width || size < 5 || bytes[start] !== 0x2f) invalid();
        const bits = view.getUint32(start + 1, true);
        if ((bits >>> 29) !== 0) invalid();
        width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
      }
      if (type === "EXIF") {
        if (exif) invalid();
        orientation = exifOrientation(bytes.subarray(start, start + size)); exif = true;
      }
      offset = start + size + (size % 2);
    }
    if (offset !== bytes.length || (canvasWidth && (canvasWidth !== width || canvasHeight !== height))) invalid();
    return dimensions("image/webp", width, height, orientation);
  }
  invalid("Choose a still JPEG, PNG or WebP image");
}

async function decode(blob: Blob): Promise<ImageBitmap> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const bitmap = createImageBitmap(blob, { imageOrientation: "from-image" }).then(value => {
    if (expired) { value.close(); throw new Error("Image decoding timed out"); }
    return value;
  });
  try {
    return await Promise.race([bitmap, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error("Image decoding timed out")); }, 10_000);
    })]);
  } finally { clearTimeout(timer!); }
}

export async function inspectProjectImage(blob: Blob): Promise<ProjectImageInfo> {
  if (blob.size > RESOURCE_LIMITS.photoBytes) invalid("Choose an image smaller than 10 MiB");
  const info = inspectImageHeader(new Uint8Array(await blob.arrayBuffer()));
  const bitmap = await decode(blob.slice(0, blob.size, info.mime));
  try {
    if (bitmap.width !== info.width || bitmap.height !== info.height) invalid("Image dimensions could not be verified");
    return info;
  } finally { bitmap.close(); }
}

export async function projectImageToCanvas(blob: Blob, expected?: ProjectImageInfo): Promise<HTMLCanvasElement> {
  if (blob.size > RESOURCE_LIMITS.photoBytes) invalid("Choose an image smaller than 10 MiB");
  const info = inspectImageHeader(new Uint8Array(await blob.arrayBuffer()));
  if (expected && (info.mime !== expected.mime || info.width !== expected.width || info.height !== expected.height)) invalid("The original photo does not match this project");
  const bitmap = await decode(blob.slice(0, blob.size, info.mime));
  try {
    if (bitmap.width !== info.width || bitmap.height !== info.height) invalid("Image dimensions could not be verified");
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) invalid("Image canvas is unavailable");
    try { context.drawImage(bitmap, 0, 0); } catch (error) { canvas.width = canvas.height = 0; throw error; }
    return canvas;
  } finally { bitmap.close(); }
}
