import { inspectProjectImage, type ProjectImageInfo } from "../projects/images";
import { assertDecodedImageDimensions, assertEncodedMediaMatches, RESOURCE_LIMITS } from "../projects/resource-bounds";
import { parseTemplateRecipe, portableTemplate, validateTemplateRecipe, type TemplateRecipe } from "./model";

export type TemplateImageInspector = (blob: Blob) => Promise<ProjectImageInfo>;
export type TemplateDecorationBlobs = ReadonlyMap<string, Blob>;
export const TEMPLATE_BUNDLE_MIME = "application/x-photobooth-template";
export const TEMPLATE_BUNDLE_LIMIT = RESOURCE_LIMITS.totalEncodedBytes + RESOURCE_LIMITS.manifestBytes + RESOURCE_LIMITS.files * 101 + 18;
const MAGIC = new Uint8Array([80, 66, 84, 77, 80, 76, 13, 10]);
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
function reject(message: string): never { throw new Error(message); }

export async function templateBlobHash(blob: Blob): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function validateTemplateDecorations(recipe: TemplateRecipe, blobs: TemplateDecorationBlobs, inspect: TemplateImageInspector = inspectProjectImage): Promise<void> {
  if (blobs.size !== recipe.decorations.length) reject("Decoration inventory differs from the recipe");
  for (const declaration of recipe.decorations) {
    const blob = blobs.get(declaration.id);
    assertEncodedMediaMatches(blob, declaration);
    const actual = await inspect(blob!);
    if (actual.mime !== "image/png") reject("Decoration is not a still PNG image");
    assertDecodedImageDimensions(actual.width, actual.height, declaration);
  }
}

export async function exportTemplateBundle(recipe: TemplateRecipe, decorations: TemplateDecorationBlobs, options: { includeText?: boolean; inspect?: TemplateImageInspector } = {}): Promise<Blob> {
  const portable = portableTemplate(recipe, options.includeText ?? false);
  await validateTemplateDecorations(portable, decorations, options.inspect);
  const manifest = encoder.encode(JSON.stringify(portable)), header = new Uint8Array(18), view = new DataView(header.buffer);
  header.set(MAGIC); view.setUint16(8, 1); view.setUint32(10, manifest.length); view.setUint32(14, portable.decorations.length);
  const parts: BlobPart[] = [header, manifest];
  for (const declaration of portable.decorations) {
    const blob = decorations.get(declaration.id)!, id = encoder.encode(declaration.id), entry = new Uint8Array(1 + id.length + 4 + 32);
    entry[0] = id.length; entry.set(id, 1); new DataView(entry.buffer).setUint32(1 + id.length, blob.size);
    entry.set(Uint8Array.from((await templateBlobHash(blob)).match(/.{2}/g)!, hex => parseInt(hex, 16)), 1 + id.length + 4);
    parts.push(entry, blob);
  }
  const result = new Blob(parts, { type: TEMPLATE_BUNDLE_MIME });
  if (result.size > TEMPLATE_BUNDLE_LIMIT) reject("Template bundle size exceeds the supported budget");
  return result;
}

export async function importTemplateBundle(bundle: Blob, options: { inspect?: TemplateImageInspector; newId?: () => string; now?: () => string } = {}): Promise<{ recipe: TemplateRecipe; decorations: Map<string, Blob> }> {
  if (!(bundle instanceof Blob) || bundle.size < 18 || bundle.size > TEMPLATE_BUNDLE_LIMIT) reject("Invalid template bundle size");
  let offset = 0;
  const take = async (length: number): Promise<Uint8Array<ArrayBuffer>> => {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > bundle.size) reject("Truncated template bundle");
    const result = new Uint8Array(await bundle.slice(offset, offset + length).arrayBuffer()); offset += length; return result;
  };
  const header = await take(18), view = new DataView(header.buffer);
  if (!MAGIC.every((byte, index) => header[index] === byte)) reject("Invalid template bundle signature");
  if (view.getUint16(8) !== 1) reject("Unsupported bundle version; retain the original file");
  const length = view.getUint32(10), count = view.getUint32(14);
  if (length < 2 || length > RESOURCE_LIMITS.manifestBytes || count > RESOURCE_LIMITS.decorations) reject("Template bundle bounds exceeded");
  const parsed = parseTemplateRecipe(decoder.decode(await take(length)));
  if (parsed.kind !== "current") reject("Unsupported template version; retain the original file for read-only recovery");
  const original = parsed.recipe;
  if (original.decorations.length !== count) reject("Decoration inventory differs from the recipe");
  const byId = new Map(original.decorations.map(item => [item.id, item])), decorations = new Map<string, Blob>();
  for (let index = 0; index < count; index++) {
    const idLength = (await take(1))[0];
    if (idLength < 1 || idLength > 64) reject("Invalid decoration identifier length");
    const id = decoder.decode(await take(idLength)), declaration = byId.get(id);
    if (!declaration || decorations.has(id)) reject("Unknown or duplicate decoration identifier");
    const size = new DataView((await take(4)).buffer).getUint32(0);
    if (size !== declaration.bytes) reject("Decoration length differs from the recipe");
    const hash = Array.from(await take(32), byte => byte.toString(16).padStart(2, "0")).join("");
    if (offset + size > bundle.size) reject("Truncated decoration");
    const blob = bundle.slice(offset, offset + size, "image/png"); offset += size;
    if (await templateBlobHash(blob) !== hash) reject("Decoration integrity check failed");
    decorations.set(id, blob);
  }
  if (offset !== bundle.size) reject("Unexpected trailing template data");
  await validateTemplateDecorations(original, decorations, options.inspect);
  const now = (options.now ?? (() => new Date().toISOString()))();
  const recipe = validateTemplateRecipe({ ...original, id: (options.newId ?? (() => crypto.randomUUID()))(), scope: { kind: "device" }, revision: 0, createdAt: now, updatedAt: now });
  return { recipe, decorations };
}
