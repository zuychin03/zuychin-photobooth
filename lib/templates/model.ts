import { getCuratedAsset } from "../assets/registry";
import { FRAMES, STICKER_PACKS, STICKER_STYLES, type StickerStyle } from "../decor";
import { FILTERS } from "../filters";
import { ROLES, type Role } from "../layouts";
import { PATTERNS } from "../patterns";
import { SCENES } from "../scenes";
import { THEMES } from "../themes";
import { RESOURCE_LIMITS, validateMediaResource, type MediaResource } from "../projects/resource-bounds";

export const TEMPLATE_SCHEMA_VERSION = 1;
export type TemplateScope = { readonly kind: "device" } | { readonly kind: "account"; readonly ownerId: string };
export interface TemplateBounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface TemplateCrop { readonly zoom: number; readonly offsetX: number; readonly offsetY: number; readonly rotation: 0 | 90 | 180 | 270; readonly mirror: boolean }
export interface TemplatePhotoSource { readonly role: Role; readonly sourceIndex: number; readonly crop: TemplateCrop; readonly sliceX?: readonly [number, number]; readonly filterId?: string | null }
export interface TemplatePhotoSlot extends TemplateBounds, TemplatePhotoSource { readonly id: string; readonly companions?: readonly TemplatePhotoSource[]; readonly splitFallback?: boolean }
export interface TemplatePlacement { readonly dx: number; readonly dy: number; readonly scale: number }
interface LayerBase extends TemplateBounds { readonly id: string; readonly rotation: number }
export interface TemplateTextLayer extends LayerBase { readonly kind: "text"; readonly text: string; readonly personal: boolean; readonly font: "sans" | "serif" | "mono"; readonly fontSize: number; readonly colour: string; readonly align: "left" | "center" | "right" }
export interface TemplateStickerLayer extends LayerBase { readonly kind: "sticker"; readonly slug: string; readonly style: StickerStyle }
export interface TemplateDecorationLayer extends LayerBase { readonly kind: "decoration"; readonly mediaId: string; readonly fit: "contain" | "cover" }
export type TemplateLayer = TemplateTextLayer | TemplateStickerLayer | TemplateDecorationLayer;
export interface TemplateLook { readonly frameId: string; readonly filterId: string; readonly patternId: string; readonly themeId: string | null; readonly sceneId: string | null; readonly materialId: string | null }
export interface TemplateRecipe {
  readonly schemaVersion: 1; readonly id: string; readonly name: string; readonly revision: number; readonly scope: TemplateScope;
  readonly createdAt: string; readonly updatedAt: string;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly requiredSources: Readonly<Partial<Record<Role, 1 | 2 | 3 | 4>>>;
  readonly slots: readonly TemplatePhotoSlot[]; readonly layers: readonly TemplateLayer[];
  readonly decorations: readonly MediaResource[]; readonly look: TemplateLook;
  readonly defaults: { readonly caption: string; readonly showDate: boolean };
  readonly places?: Readonly<Partial<Record<Role, TemplatePlacement>>>;
}
export type TemplateDesign = Pick<TemplateRecipe, "canvas" | "requiredSources" | "slots" | "layers" | "decorations" | "look" | "defaults" | "places">;
export type TemplateParseResult = { kind: "current"; recipe: TemplateRecipe; readOnly: false }
  | { kind: "unsupported"; schemaVersion: number; rawJson: string; readOnly: true };
export class TemplateValidationError extends Error {
  constructor(readonly path: string, message: string) { super(`${path}: ${message}`); this.name = "TemplateValidationError"; }
}
function fail(path: string, message: string): never { throw new TemplateValidationError(path, message); }
function object(value: unknown, keys: readonly string[] | null, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, "Expected plain data");
  const own = Reflect.ownKeys(value);
  if (own.some(key => typeof key !== "string" || (keys && !keys.includes(key)) || !("value" in Object.getOwnPropertyDescriptor(value, key)!)) || (keys && own.length !== keys.length)) fail(path, "Unexpected, missing or accessor fields");
  return value as Record<string, unknown>;
}
function array(value: unknown, maximum: number, path: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) fail(path, "Invalid or oversized array");
  for (let i = 0; i < value.length; i++) if (!("value" in (Object.getOwnPropertyDescriptor(value, i) ?? {}))) fail(path, "Sparse or accessor entries");
  return value;
}
export function templateId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) fail("id", "Invalid identifier");
  return value;
}
function number(value: unknown, min: number, max: number, path: string, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) fail(path, "Number outside supported bounds");
  return value;
}
function bool(value: unknown, path: string): boolean { if (typeof value !== "boolean") fail(path, "Expected boolean"); return value; }
function text(value: unknown, maximum: number, path: string): string {
  if (typeof value !== "string" || value.length > maximum * 2 || Array.from(value).length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(path, "Invalid or oversized text");
  return value;
}
function choice<T extends string | number>(value: unknown, choices: readonly T[], path: string): T { if (!choices.includes(value as T)) fail(path, "Unsupported value"); return value as T; }
function date(value: unknown): string {
  if (typeof value !== "string" || value.length !== 24 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail("date", "Expected canonical UTC timestamp");
  return value;
}
export function validateTemplateScope(value: unknown): TemplateScope {
  const raw = object(value, null, "scope");
  if (raw.kind === "device") { object(raw, ["kind"], "scope"); return { kind: "device" }; }
  object(raw, ["kind", "ownerId"], "scope");
  if (raw.kind !== "account") fail("scope", "Unsupported scope");
  return { kind: "account", ownerId: templateId(raw.ownerId) };
}
export function templateScopeKey(value: TemplateScope): string { const scope = validateTemplateScope(value); return scope.kind === "device" ? "device" : `account:${scope.ownerId}`; }
function bounds(raw: Record<string, unknown>, path: string): TemplateBounds {
  const x = number(raw.x, 0, 1, `${path}.x`), y = number(raw.y, 0, 1, `${path}.y`);
  const width = number(raw.width, 0.001, 1, `${path}.width`), height = number(raw.height, 0.001, 1, `${path}.height`);
  if (x + width > 1 + Number.EPSILON || y + height > 1 + Number.EPSILON) fail(path, "Bounds extend beyond canvas");
  return { x, y, width, height };
}
function crop(value: unknown): TemplateCrop {
  const raw = object(value, ["zoom", "offsetX", "offsetY", "rotation", "mirror"], "crop");
  return { zoom: number(raw.zoom, 1, 4, "zoom"), offsetX: number(raw.offsetX, -1, 1, "offsetX"), offsetY: number(raw.offsetY, -1, 1, "offsetY"), rotation: choice(raw.rotation, [0, 90, 180, 270], "rotation"), mirror: bool(raw.mirror, "mirror") };
}
function look(value: unknown): TemplateLook {
  const raw = object(value, ["frameId", "filterId", "patternId", "themeId", "sceneId", "materialId"], "look");
  const sceneId = raw.sceneId === null ? null : text(raw.sceneId, 80, "sceneId");
  const materialId = raw.materialId === null ? null : text(raw.materialId, 80, "materialId");
  if (sceneId !== null && !SCENES.some(item => item.id === sceneId) && getCuratedAsset(sceneId)?.kind !== "scene") fail("sceneId", "Unknown scene");
  if (materialId !== null && getCuratedAsset(materialId)?.kind !== "material") fail("materialId", "Unknown material");
  return { frameId: choice(raw.frameId, FRAMES.map(item => item.id), "frameId"), filterId: choice(raw.filterId, FILTERS.map(item => item.id), "filterId"), patternId: choice(raw.patternId, ["none", ...PATTERNS.map(item => item.id)], "patternId"), themeId: raw.themeId === null ? null : choice(raw.themeId, THEMES.map(item => item.id), "themeId"), sceneId, materialId };
}
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }

export function validateTemplateRecipe(value: unknown): TemplateRecipe {
  const raw = object(value, null, "recipe");
  object(raw, ["schemaVersion", "id", "name", "revision", "scope", "createdAt", "updatedAt", "canvas", "requiredSources", "slots", "layers", "decorations", "look", "defaults", ...(Object.hasOwn(raw, "places") ? ["places"] : [])], "recipe");
  if (raw.schemaVersion !== TEMPLATE_SCHEMA_VERSION) fail("schemaVersion", "Unsupported template version");
  const canvas = object(raw.canvas, ["width", "height"], "canvas");
  const width = number(canvas.width, 128, 4096, "canvas.width", true), height = number(canvas.height, 128, 4096, "canvas.height", true);
  if (width * height > RESOURCE_LIMITS.photoPixels) fail("canvas", "Canvas exceeds 12 megapixels");
  const requirements = object(raw.requiredSources, null, "requiredSources");
  const requiredSources: Partial<Record<Role, 1 | 2 | 3 | 4>> = {};
  if (Object.keys(requirements).length < 1 || Object.keys(requirements).length > 4) fail("requiredSources", "Expected one to four roles");
  for (const [role, count] of Object.entries(requirements)) requiredSources[choice(role, ROLES, "role")] = choice(count, [1, 2, 3, 4] as const, "source count");
  const ids = new Set<string>(), used = new Map<Role, Set<number>>();
  const unique = (value: unknown) => { const id = templateId(value); if (ids.has(id)) fail("id", "Duplicate slot or layer identifier"); ids.add(id); return id; };
  const source = (slot: Record<string, unknown>): TemplatePhotoSource => {
    const role = choice(slot.role, ROLES, "role"), sourceIndex = number(slot.sourceIndex, 0, 3, "sourceIndex", true);
    if (!requiredSources[role] || sourceIndex >= requiredSources[role]!) fail("sourceIndex", "Slot exceeds declared source requirement");
    if (!used.has(role)) used.set(role, new Set()); used.get(role)!.add(sourceIndex);
    let sliceX: readonly [number, number] | undefined;
    if (Object.hasOwn(slot, "sliceX")) {
      const slice = array(slot.sliceX, 2, "sliceX");
      if (slice.length !== 2) fail("sliceX", "Expected start and end");
      const start = number(slice[0], 0, 1, "sliceX.start"), end = number(slice[1], 0, 1, "sliceX.end");
      if (start >= end) fail("sliceX", "Slice start must precede its end");
      sliceX = [start, end];
    }
    const filter = Object.hasOwn(slot, "filterId") ? { filterId: slot.filterId === null ? null : choice(slot.filterId, FILTERS.map(item => item.id), "slot.filterId") } : {};
    return { role, sourceIndex, crop: crop(slot.crop), ...(sliceX ? { sliceX } : {}), ...filter };
  };
  const sourceKeys = (raw: Record<string, unknown>) => ["role", "sourceIndex", "crop", ...(Object.hasOwn(raw, "sliceX") ? ["sliceX"] : []), ...(Object.hasOwn(raw, "filterId") ? ["filterId"] : [])];
  const slots = array(raw.slots, RESOURCE_LIMITS.photoSlots, "slots").map((value): TemplatePhotoSlot => {
    const slot = object(value, null, "slot");
    object(slot, ["id", "x", "y", "width", "height", ...sourceKeys(slot), ...(Object.hasOwn(slot, "companions") ? ["companions"] : []), ...(Object.hasOwn(slot, "splitFallback") ? ["splitFallback"] : [])], "slot");
    const primary = source(slot), roles = new Set([primary.role]);
    const companions = Object.hasOwn(slot, "companions") ? array(slot.companions, 3, "companions").map(value => {
      const companion = object(value, null, "companion"); object(companion, sourceKeys(companion), "companion");
      const checked = source(companion);
      if (roles.has(checked.role)) fail("companions", "Each companion must have a different participant role");
      roles.add(checked.role); return checked;
    }) : undefined;
    if (companions && !companions.length) fail("companions", "Expected at least one companion");
    const fallback = Object.hasOwn(slot, "splitFallback") ? { splitFallback: bool(slot.splitFallback, "splitFallback") } : {};
    if (Object.hasOwn(slot, "splitFallback") && !companions) fail("splitFallback", "A split fallback requires companions");
    return { id: unique(slot.id), ...primary, ...bounds(slot, "slot"), ...(companions ? { companions } : {}), ...fallback };
  });
  for (const role of ROLES) if (requiredSources[role] && Math.max(...(used.get(role) ?? [])) + 1 !== requiredSources[role]) fail("requiredSources", "Declared count must equal the highest source index plus one");
  const decorations = array(raw.decorations, RESOURCE_LIMITS.decorations, "decorations").map(value => {
    const media = validateMediaResource(value);
    if (media.kind !== "decoration") fail("decorations", "Recipes cannot contain source photos");
    return media;
  });
  const mediaIds = new Set(decorations.map(item => item.id));
  if (mediaIds.size !== decorations.length) fail("decorations", "Duplicate decoration identifier");
  if (decorations.reduce((sum, item) => sum + item.bytes, 0) > RESOURCE_LIMITS.totalEncodedBytes || decorations.reduce((sum, item) => sum + item.width * item.height, 0) > RESOURCE_LIMITS.totalPixels) fail("decorations", "Decoration budget exceeded");
  const counts = { text: 0, sticker: 0, decoration: 0 }, referenced = new Set<string>();
  const layers = array(raw.layers, RESOURCE_LIMITS.textLayers + RESOURCE_LIMITS.stickerLayers + RESOURCE_LIMITS.decorations, "layers").map((value): TemplateLayer => {
    const raw = object(value, null, "layer"), kind = choice(raw.kind, ["text", "sticker", "decoration"], "layer.kind");
    const extra = kind === "text" ? ["text", "personal", "font", "fontSize", "colour", "align"] : kind === "sticker" ? ["slug", "style"] : ["mediaId", "fit"];
    object(raw, ["kind", "id", "x", "y", "width", "height", "rotation", ...extra], "layer");
    const base = { id: unique(raw.id), ...bounds(raw, "layer"), rotation: number(raw.rotation, -180, 180, "rotation") };
    counts[kind]++;
    if (kind === "text") {
      const colour = text(raw.colour, 7, "colour");
      if (!/^#[a-fA-F0-9]{6}$/.test(colour)) fail("colour", "Expected a six-digit hex colour");
      return { ...base, kind, text: text(raw.text, RESOURCE_LIMITS.textCodePoints, "text"), personal: bool(raw.personal, "personal"), font: choice(raw.font, ["sans", "serif", "mono"], "font"), fontSize: number(raw.fontSize, 0.005, 0.25, "fontSize"), colour, align: choice(raw.align, ["left", "center", "right"], "align") };
    }
    if (kind === "sticker") return { ...base, kind, slug: choice(raw.slug, STICKER_PACKS.flatMap(pack => pack.stickers.map(item => item.slug)), "slug"), style: choice(raw.style, STICKER_STYLES.map(item => item.id), "style") };
    const mediaId = templateId(raw.mediaId);
    if (!mediaIds.has(mediaId)) fail("mediaId", "Missing PNG decoration");
    referenced.add(mediaId);
    return { ...base, kind, mediaId, fit: choice(raw.fit, ["contain", "cover"], "fit") };
  });
  if (counts.text > RESOURCE_LIMITS.textLayers || counts.sticker > RESOURCE_LIMITS.stickerLayers || counts.decoration > RESOURCE_LIMITS.decorations) fail("layers", "Layer count exceeded");
  if (referenced.size !== decorations.length) fail("decorations", "Unreferenced decoration files are not allowed");
  const defaults = object(raw.defaults, ["caption", "showDate"], "defaults");
  const places: Partial<Record<Role, TemplatePlacement>> = {};
  if (Object.hasOwn(raw, "places")) for (const [key, value] of Object.entries(object(raw.places, null, "places"))) {
    const role = choice(key, ROLES, "places.role");
    if (!requiredSources[role]) fail("places", "Placement references an undeclared participant");
    const place = object(value, ["dx", "dy", "scale"], "place");
    places[role] = { dx: number(place.dx, -0.5, 0.5, "place.dx"), dy: number(place.dy, -0.25, 0.25, "place.dy"), scale: number(place.scale, 0.5, 1.6, "place.scale") };
  }
  const recipe: TemplateRecipe = { schemaVersion: 1, id: templateId(raw.id), name: text(raw.name, 100, "name"), revision: number(raw.revision, 0, Number.MAX_SAFE_INTEGER, "revision", true), scope: validateTemplateScope(raw.scope), createdAt: date(raw.createdAt), updatedAt: date(raw.updatedAt), canvas: { width, height }, requiredSources, slots, layers, decorations, look: look(raw.look), defaults: { caption: text(defaults.caption, RESOURCE_LIMITS.textCodePoints, "caption"), showDate: bool(defaults.showDate, "showDate") }, ...(Object.hasOwn(raw, "places") ? { places } : {}) };
  if (!recipe.name.trim() || recipe.updatedAt < recipe.createdAt) fail("recipe", "Invalid name or timestamps");
  if (new TextEncoder().encode(JSON.stringify(recipe)).length > RESOURCE_LIMITS.manifestBytes) fail("recipe", "Manifest exceeds 64 KiB");
  return freeze(recipe);
}

export function parseTemplateRecipe(rawJson: string): TemplateParseResult {
  if (typeof rawJson !== "string" || rawJson.length > RESOURCE_LIMITS.manifestBytes || new TextEncoder().encode(rawJson).length > RESOURCE_LIMITS.manifestBytes) fail("recipe", "Manifest exceeds 64 KiB");
  const raw = object(JSON.parse(rawJson), null, "recipe");
  if (typeof raw.schemaVersion === "number" && Number.isSafeInteger(raw.schemaVersion) && raw.schemaVersion > TEMPLATE_SCHEMA_VERSION) return { kind: "unsupported", schemaVersion: raw.schemaVersion, rawJson, readOnly: true };
  return { kind: "current", recipe: validateTemplateRecipe(raw), readOnly: false };
}

export function validateTemplateDesign(value: unknown): TemplateDesign {
  const raw = object(value, null, "design");
  object(raw, ["canvas", "requiredSources", "slots", "layers", "decorations", "look", "defaults", ...(Object.hasOwn(raw, "places") ? ["places"] : [])], "design");
  const { canvas, requiredSources, slots, layers, decorations, look, defaults, places } = validateTemplateRecipe({ ...raw, schemaVersion: 1, id: "embedded", name: "Embedded template", revision: 0, scope: { kind: "device" }, createdAt: "2000-01-01T00:00:00.000Z", updatedAt: "2000-01-01T00:00:00.000Z" });
  return Object.freeze({ canvas, requiredSources, slots, layers, decorations, look, defaults, ...(places ? { places } : {}) });
}

export function portableTemplate(recipe: TemplateRecipe, includeText = false): TemplateRecipe {
  const checked = validateTemplateRecipe(recipe);
  return validateTemplateRecipe({ ...checked, scope: { kind: "device" }, defaults: { ...checked.defaults, caption: includeText ? checked.defaults.caption : "" }, layers: checked.layers.map(layer => layer.kind === "text" && !includeText ? { ...layer, text: "" } : layer) });
}
