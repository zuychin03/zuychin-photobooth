import { EVENT_EXPORT_LIMITS, exportInteger, exportUuid } from "./export-contract";

export interface EventZipPhoto { index: number; submissionId: string; bytes: Uint8Array }
export const EVENT_ZIP_MAX_BYTES = EVENT_EXPORT_LIMITS.pageBytes + EVENT_EXPORT_LIMITS.manifestBytes + 4096;
export function eventZipPhotoName(index: number, submissionId: string) { return `photos/${String(exportInteger(index, 0, 99)).padStart(3, "0")}-${exportUuid(submissionId)}.jpg`; }
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; return c >>> 0; });
export function eventZipCrc32(bytes: Uint8Array) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8; return (crc ^ 0xffffffff) >>> 0; }
export function writeEventExportZip(photos: EventZipPhoto[], manifest: unknown, failures: unknown, notes = ""): Blob {
  if (photos.length > 10 || new Set(photos.map(x => x.index)).size !== photos.length || new Set(photos.map(x => x.submissionId)).size !== photos.length) throw new Error("Invalid ZIP inventory");
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n"), manifestBytes = encode(manifest), failureBytes = encode(failures);
  const noteBytes = new TextEncoder().encode(notes);
  if (noteBytes.length > 49152) throw new Error("ZIP notes too large");
  if (noteBytes.length + manifestBytes.length + failureBytes.length > EVENT_EXPORT_LIMITS.manifestBytes) throw new Error("ZIP metadata too large");
  const files = [...photos.map(photo => {
    if (!(photo.bytes instanceof Uint8Array) || photo.bytes.length < 1 || photo.bytes.length > 2000000) throw new Error("Invalid ZIP photo");
    return { name: eventZipPhotoName(photo.index, photo.submissionId), bytes: photo.bytes };
  }), { name: "manifest.json", bytes: manifestBytes }, { name: "failures.json", bytes: failureBytes }, ...(notes ? [{ name: "guestbook.txt", bytes: noteBytes }] : [])];
  const parts: BlobPart[] = [], central: Uint8Array[] = []; let offset = 0, centralSize = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name), crc = eventZipCrc32(file.bytes), header = new Uint8Array(30 + name.length), h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(12, 33, true); h.setUint32(14, crc, true); h.setUint32(18, file.bytes.length, true); h.setUint32(22, file.bytes.length, true); h.setUint16(26, name.length, true); header.set(name, 30);
    const record = new Uint8Array(46 + name.length), c = new DataView(record.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(14, 33, true); c.setUint32(16, crc, true); c.setUint32(20, file.bytes.length, true); c.setUint32(24, file.bytes.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true); record.set(name, 46);
    parts.push(header, new Uint8Array(file.bytes)); central.push(record); offset += header.length + file.bytes.length; centralSize += record.length;
    if (offset + centralSize + 22 > EVENT_ZIP_MAX_BYTES) throw new Error("ZIP too large");
  }
  const end = new Uint8Array(22), e = new DataView(end.buffer); e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, centralSize, true); e.setUint32(16, offset, true);
  parts.push(...central.map(bytes => new Uint8Array(bytes)), end); return new Blob(parts, { type: "application/zip" });
}
