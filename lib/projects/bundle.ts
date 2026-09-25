import { inspectProjectImage, type ProjectImageInfo } from "./images";
import { parsePhotoProject, validatePhotoProject, type PhotoProject, type ProjectMedia } from "./model";
import { assertDecodedImageDimensions, assertEncodedMediaMatches, RESOURCE_LIMITS } from "./resource-bounds";

export type ProjectImageInspector = (blob: Blob) => Promise<ProjectImageInfo>;
export type ProjectMediaBlobs = ReadonlyMap<string, Blob>;
export const PROJECT_BUNDLE_MIME = "application/x-photobooth-project";
export const PROJECT_BUNDLE_LIMIT = RESOURCE_LIMITS.totalEncodedBytes + RESOURCE_LIMITS.manifestBytes + RESOURCE_LIMITS.files * 101 + 18;
const MAGIC = new Uint8Array([80, 66, 80, 82, 79, 74, 13, 10]);
const HEADER_BYTES = 18;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class ProjectBundleError extends Error {
  constructor(message: string) { super(message); this.name = "ProjectBundleError"; }
}
function reject(message: string): never { throw new ProjectBundleError(message); }

export function projectMediaResource({ id, kind, mime, bytes, width, height }: ProjectMedia) {
  return { id, kind, mime, bytes, width, height };
}

export async function projectBlobHash(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function validateProjectMedia(project: PhotoProject, blobs: ProjectMediaBlobs, inspect: ProjectImageInspector = inspectProjectImage): Promise<void> {
  if (blobs.size !== project.media.length) reject("Media inventory differs from the manifest");
  for (const declaration of project.media) {
    const blob = blobs.get(declaration.id);
    const resource = projectMediaResource(declaration);
    assertEncodedMediaMatches(blob, resource);
    const actual = await inspect(blob!);
    if (actual.mime !== declaration.mime) reject("Image signature differs from the declared MIME");
    assertDecodedImageDimensions(actual.width, actual.height, resource);
  }
}

export function portableProject(project: PhotoProject): PhotoProject {
  const checked = validatePhotoProject(project);
  return validatePhotoProject({ ...checked, scope: { kind: "device" }, capture: { ...checked.capture, cameraId: null } });
}

export async function exportProjectBundle(project: PhotoProject, blobs: ProjectMediaBlobs): Promise<Blob> {
  const portable = portableProject(project);
  const manifest = encoder.encode(JSON.stringify(portable));
  if (manifest.length > RESOURCE_LIMITS.manifestBytes || blobs.size !== portable.media.length) reject("Invalid manifest or media inventory");
  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC);
  const view = new DataView(header.buffer);
  view.setUint16(8, 1);
  view.setUint32(10, manifest.length);
  view.setUint32(14, portable.media.length);
  const parts: BlobPart[] = [header, manifest];
  let size = header.length + manifest.length;
  for (const declaration of portable.media) {
    const blob = blobs.get(declaration.id);
    assertEncodedMediaMatches(blob, projectMediaResource(declaration));
    const id = encoder.encode(declaration.id);
    size += 1 + id.length + 4 + 32 + blob!.size;
    if (size > PROJECT_BUNDLE_LIMIT) reject("Portable project exceeds its bounded media and manifest allowance");
    const entry = new Uint8Array(1 + id.length + 4 + 32);
    entry[0] = id.length;
    entry.set(id, 1);
    new DataView(entry.buffer).setUint32(1 + id.length, blob!.size);
    const hash = await projectBlobHash(blob!);
    entry.set(Uint8Array.from(hash.match(/../g)!, byte => parseInt(byte, 16)), 1 + id.length + 4);
    parts.push(entry, blob!);
  }
  return new Blob(parts, { type: PROJECT_BUNDLE_MIME });
}

export async function importProjectBundle(bundle: Blob, options: { inspect?: ProjectImageInspector; newId?: () => string; now?: () => string } = {}): Promise<{ project: PhotoProject; media: Map<string, Blob> }> {
  if (!(bundle instanceof Blob) || bundle.size < HEADER_BYTES || bundle.size > PROJECT_BUNDLE_LIMIT) reject("Invalid portable project size");
  let offset = 0;
  const take = async (length: number): Promise<Uint8Array> => {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > bundle.size) reject("Truncated portable project");
    const bytes = new Uint8Array(await bundle.slice(offset, offset + length).arrayBuffer());
    offset += length;
    return bytes;
  };
  const header = await take(HEADER_BYTES);
  if (!MAGIC.every((byte, index) => header[index] === byte)) reject("Invalid portable project signature");
  const view = new DataView(header.buffer);
  if (view.getUint16(8) !== 1) reject("Unsupported bundle version; retain the original file");
  const manifestLength = view.getUint32(10), count = view.getUint32(14);
  if (manifestLength < 2 || manifestLength > RESOURCE_LIMITS.manifestBytes || count > RESOURCE_LIMITS.files) reject("Portable project bounds exceeded");
  let parsed;
  try { parsed = parsePhotoProject(decoder.decode(await take(manifestLength))); }
  catch (error) { reject(`Invalid project manifest: ${error instanceof Error ? error.message : "invalid data"}`); }
  if (parsed.kind !== "current") reject("Unsupported project version; retain the original file for read-only recovery");
  const original = parsed.project;
  if (original.media.length !== count) reject("Media inventory differs from the manifest");
  const byId = new Map(original.media.map(item => [item.id, item]));
  const media = new Map<string, Blob>();
  for (let index = 0; index < count; index++) {
    const length = (await take(1))[0];
    if (length < 1 || length > 64) reject("Invalid media identifier length");
    const id = decoder.decode(await take(length));
    const declaration = byId.get(id);
    if (!declaration || media.has(id)) reject("Unknown or duplicate media identifier");
    const bytes = new DataView((await take(4)).buffer).getUint32(0);
    if (bytes !== declaration.bytes) reject("Media length differs from the manifest");
    const expectedHash = Array.from(await take(32), byte => byte.toString(16).padStart(2, "0")).join("");
    if (offset + bytes > bundle.size) reject("Truncated media");
    const blob = bundle.slice(offset, offset + bytes, declaration.mime);
    offset += bytes;
    if (await projectBlobHash(blob) !== expectedHash) reject("Media integrity check failed");
    media.set(id, blob);
  }
  if (offset !== bundle.size) reject("Unexpected trailing bundle data");
  await validateProjectMedia(original, media, options.inspect);
  const now = (options.now ?? (() => new Date().toISOString()))();
  const project = validatePhotoProject({ ...portableProject(original), id: (options.newId ?? (() => crypto.randomUUID()))(), revision: 0, createdAt: now, updatedAt: now });
  return { project, media };
}
