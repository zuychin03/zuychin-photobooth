export const RESOURCE_LIMITS = Object.freeze({
  manifestBytes: 64 * 1024,
  participants: 4,
  sourcesPerParticipant: 4,
  photoSlots: 16,
  textLayers: 16,
  textCodePoints: 500,
  stickerLayers: 32,
  files: 24,
  decorations: 8,
  photoBytes: 10 * 1024 * 1024,
  decorationBytes: 4 * 1024 * 1024,
  totalEncodedBytes: 64 * 1024 * 1024,
  photoEdge: 4096,
  photoPixels: 12 * 1024 * 1024,
  decorationEdge: 2048,
  decorationPixels: 4 * 1024 * 1024,
  totalPixels: 48 * 1024 * 1024,
});

export type StillImageMime = "image/jpeg" | "image/png" | "image/webp";

export interface MediaResource {
  readonly id: string;
  readonly kind: "photo" | "decoration" | "reference";
  readonly mime: StillImageMime;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
}

export interface ResourceManifest {
  readonly version: 1;
  readonly mode: "solo" | "shared";
  readonly participants: readonly { readonly id: string; readonly sourceIds: readonly string[] }[];
  readonly media: readonly MediaResource[];
  readonly slots: readonly { readonly id: string; readonly sourceIds: readonly string[] }[];
  readonly textLayers: readonly { readonly id: string; readonly text: string }[];
  readonly stickerLayers: readonly { readonly id: string; readonly asset: { readonly kind: "builtin" | "media"; readonly id: string } }[];
}

export class ResourceValidationError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ResourceValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new ResourceValidationError(path, message);
}

function record(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "Expected a plain object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, "Expected a plain object");
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) {
    fail(path, "Unexpected or missing fields");
  }
  if (ownKeys.some(key => !("value" in Object.getOwnPropertyDescriptor(value, key)!))) fail(path, "Accessors are not data fields");
  return value as Record<string, unknown>;
}

function list(value: unknown, min: number, max: number, path: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max) {
    fail(path, `Expected ${min} to ${max} entries`);
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) fail(path, "Sparse arrays and extra properties are unsupported");
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !("value" in descriptor)) fail(path, "Expected data entries");
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    fail(path, "Expected a local identifier of 1 to 64 letters, digits, underscores or hyphens");
  }
  return value;
}

function integer(value: unknown, max: number, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    fail(path, `Expected an integer from 1 to ${max}`);
  }
  return value;
}

function unique(id: string, seen: Set<string>, path: string): string {
  if (seen.has(id)) fail(path, "Duplicate identifier");
  seen.add(id);
  return id;
}

function sourceIds(value: unknown, path: string): readonly string[] {
  const seen = new Set<string>();
  return Object.freeze(list(value, 1, RESOURCE_LIMITS.sourcesPerParticipant, path)
    .map((id, index) => unique(identifier(id, `${path}[${index}]`), seen, path)));
}

function mediaResource(value: unknown, path: string): MediaResource {
  const item = record(value, ["id", "kind", "mime", "bytes", "width", "height"], path);
  const id = identifier(item.id, `${path}.id`);
  if (item.kind !== "photo" && item.kind !== "decoration" && item.kind !== "reference") fail(`${path}.kind`, "Unsupported media kind");
  const decoration = item.kind === "decoration";
  if (item.mime !== "image/png" && (decoration || (item.mime !== "image/jpeg" && item.mime !== "image/webp"))) {
    fail(`${path}.mime`, decoration ? "Decorations must be PNG" : "Supported still formats are JPEG, PNG and WebP");
  }
  const bytes = integer(item.bytes, decoration ? RESOURCE_LIMITS.decorationBytes : RESOURCE_LIMITS.photoBytes, `${path}.bytes`);
  const edge = decoration ? RESOURCE_LIMITS.decorationEdge : RESOURCE_LIMITS.photoEdge;
  const width = integer(item.width, edge, `${path}.width`);
  const height = integer(item.height, edge, `${path}.height`);
  if (width * height > (decoration ? RESOURCE_LIMITS.decorationPixels : RESOURCE_LIMITS.photoPixels)) fail(path, "Decoded pixel budget exceeded");
  return Object.freeze({ id, kind: item.kind, mime: item.mime, bytes, width, height });
}

export function validateMediaResource(value: unknown, path = "media"): MediaResource {
  return mediaResource(value, path);
}

function plainText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length > RESOURCE_LIMITS.textCodePoints * 2 || Array.from(value).length > RESOURCE_LIMITS.textCodePoints) {
    fail(path, `Expected at most ${RESOURCE_LIMITS.textCodePoints} Unicode code points`);
  }
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point === 127 || (point < 32 && ![9, 10, 13].includes(point))) {
      fail(path, "Non-text control characters are unsupported");
    }
  }
  return value;
}

export function validateResourceManifest(value: unknown, builtinStickerIds: ReadonlySet<string> = new Set()): ResourceManifest {
  const input = record(value, ["version", "mode", "participants", "media", "slots", "textLayers", "stickerLayers"], "resources");
  if (input.version !== 1) fail("resources.version", "Unsupported resource version; preserve the input for read-only or export handling");
  if (input.mode !== "solo" && input.mode !== "shared") fail("resources.mode", "Expected solo or shared");
  const mediaIds = new Set<string>();
  const media = list(input.media, 1, RESOURCE_LIMITS.files, "resources.media").map((value, index) => {
    const item = mediaResource(value, `resources.media[${index}]`);
    unique(item.id, mediaIds, `resources.media[${index}].id`);
    return item;
  });
  if (media.filter(item => item.kind === "decoration").length > RESOURCE_LIMITS.decorations) fail("resources.media", "Decoration file budget exceeded");
  if (media.reduce((sum, item) => sum + item.bytes, 0) > RESOURCE_LIMITS.totalEncodedBytes) fail("resources.media", "Total encoded byte budget exceeded");
  if (media.reduce((sum, item) => sum + item.width * item.height, 0) > RESOURCE_LIMITS.totalPixels) fail("resources.media", "Total decoded pixel budget exceeded");
  const byId = new Map(media.map(item => [item.id, item]));
  const participantIds = new Set<string>();
  const ownedSources = new Set<string>();
  const participants = list(input.participants, input.mode === "solo" ? 1 : 2, input.mode === "solo" ? 1 : RESOURCE_LIMITS.participants, "resources.participants")
    .map((value, index) => {
      const path = `resources.participants[${index}]`;
      const item = record(value, ["id", "sourceIds"], path);
      const id = unique(identifier(item.id, `${path}.id`), participantIds, `${path}.id`);
      const sources = sourceIds(item.sourceIds, `${path}.sourceIds`);
      for (const sourceId of sources) {
        if (byId.get(sourceId)?.kind !== "photo") fail(`${path}.sourceIds`, "Source must reference a declared photo");
        unique(sourceId, ownedSources, `${path}.sourceIds`);
      }
      return Object.freeze({ id, sourceIds: sources });
    });
  if (media.some(item => item.kind === "photo" && !ownedSources.has(item.id))) fail("resources.media", "Each photo must belong to exactly one participant");
  const layerIds = new Set<string>();
  const slots = list(input.slots, 1, RESOURCE_LIMITS.photoSlots, "resources.slots").map((value, index) => {
    const path = `resources.slots[${index}]`;
    const item = record(value, ["id", "sourceIds"], path);
    const id = unique(identifier(item.id, `${path}.id`), layerIds, `${path}.id`);
    const sources = sourceIds(item.sourceIds, `${path}.sourceIds`);
    if (sources.some(sourceId => !ownedSources.has(sourceId))) fail(`${path}.sourceIds`, "Slot references a missing source");
    return Object.freeze({ id, sourceIds: sources });
  });
  const textLayers = list(input.textLayers, 0, RESOURCE_LIMITS.textLayers, "resources.textLayers").map((value, index) => {
    const path = `resources.textLayers[${index}]`;
    const item = record(value, ["id", "text"], path);
    return Object.freeze({ id: unique(identifier(item.id, `${path}.id`), layerIds, `${path}.id`), text: plainText(item.text, `${path}.text`) });
  });
  const stickerLayers = list(input.stickerLayers, 0, RESOURCE_LIMITS.stickerLayers, "resources.stickerLayers").map((value, index) => {
    const path = `resources.stickerLayers[${index}]`;
    const item = record(value, ["id", "asset"], path);
    const id = unique(identifier(item.id, `${path}.id`), layerIds, `${path}.id`);
    const asset = record(item.asset, ["kind", "id"], `${path}.asset`);
    const assetId = identifier(asset.id, `${path}.asset.id`);
    if (asset.kind === "builtin") {
      if (!builtinStickerIds.has(assetId)) fail(`${path}.asset.id`, "Unknown built-in sticker");
    } else if (asset.kind === "media") {
      if (byId.get(assetId)?.kind !== "decoration") fail(`${path}.asset.id`, "Sticker must reference a declared PNG decoration");
    } else fail(`${path}.asset.kind`, "Expected builtin or media");
    return Object.freeze({ id, asset: Object.freeze({ kind: asset.kind, id: assetId }) });
  });
  return Object.freeze({ version: 1, mode: input.mode, participants: Object.freeze(participants), media: Object.freeze(media), slots: Object.freeze(slots), textLayers: Object.freeze(textLayers), stickerLayers: Object.freeze(stickerLayers) });
}

export function parseResourceManifest(json: string, builtinStickerIds?: ReadonlySet<string>): ResourceManifest {
  if (typeof json !== "string" || json.length > RESOURCE_LIMITS.manifestBytes || new TextEncoder().encode(json).byteLength > RESOURCE_LIMITS.manifestBytes) {
    fail("resources", "Manifest exceeds the UTF-8 byte limit");
  }
  let value: unknown;
  try { value = JSON.parse(json); } catch { fail("resources", "Invalid JSON"); }
  return validateResourceManifest(value, builtinStickerIds);
}

export function assertEncodedMediaMatches(blob: unknown, declaration: MediaResource): void {
  const expected = mediaResource(declaration, "media");
  if (!(blob instanceof Blob) || blob.size !== expected.bytes || blob.type !== expected.mime) {
    fail("media", "Blob byte length or MIME differs from its declaration");
  }
}

export function assertDecodedImageDimensions(width: unknown, height: unknown, declaration: MediaResource): void {
  const expected = mediaResource(declaration, "media");
  if (width !== expected.width || height !== expected.height) fail("media", "Decoded dimensions differ from the validated declaration");
}
