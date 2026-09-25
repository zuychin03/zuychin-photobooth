import { validateStoryPlan, type StoryPlan } from "../stories/model";
import { validateExportSettings, type ProjectExportSettings } from "../exports/settings";
import { validateThenNowPlan, type ThenNowPlan } from "../memories/then-and-now";
import { FRAMES, STICKER_PACKS, STICKER_STYLES, type StickerStyle } from "../decor";
import { FILTERS } from "../filters";
import { LAYOUTS, ROLES, type Role } from "../layouts";
import { PATTERNS } from "../patterns";
import { SCENES } from "../scenes";
import { THEMES } from "../themes";
import type { StickerInstance, TogetherPlacement } from "../compose";
import { validateCellEdit, type PhotoCellEdit } from "./transforms";
import { RESOURCE_LIMITS, validateMediaResource, type MediaResource } from "./resource-bounds";
import { getCuratedAsset } from "../assets/registry";
import { validateTemplateDesign, type TemplateDesign } from "../templates/model";

export const PROJECT_SCHEMA_VERSION = 4;
export const PROJECT_HISTORY_LIMIT = 20;
export type ProjectScope = { readonly kind: "device" } | { readonly kind: "account"; readonly ownerId: string };
export interface ProjectParticipant { readonly id: string; readonly role: Role }
export interface ProjectMedia extends MediaResource { readonly participantId: string | null }
export type ProjectSourceOrder = Readonly<Record<Role, readonly (string | null)[]>>;
export interface ProjectCaptureSettings {
  readonly style: "classic" | "flexible";
  readonly timerSeconds: 3 | 5 | 10;
  readonly requiredShots: 1 | 2 | 3 | 4;
  readonly cameraId: string | null;
  readonly mirror: boolean;
  readonly fillLight: boolean;
}
export interface ProjectEditorSettings {
  readonly frameId: string;
  readonly layoutId: string;
  readonly filterId: string;
  readonly caption: string;
  readonly showDate: boolean;
  readonly patternId: string;
  readonly themeId: string | null;
  readonly sceneId: string | null;
  readonly stickerStyle: StickerStyle;
  readonly places: Readonly<Partial<Record<Role, Readonly<TogetherPlacement>>>>;
  readonly stickers: readonly Readonly<StickerInstance>[];
  readonly cellEdits: Readonly<Record<string, Readonly<PhotoCellEdit>>>;
  readonly template?: TemplateDesign | null;
  readonly materialId?: string | null;
  readonly story?: StoryPlan | null;
  readonly thenNow?: ThenNowPlan | null;
  readonly exportSettings?: ProjectExportSettings;
}
export interface ProjectEditSnapshot {
  readonly sourceOrder: ProjectSourceOrder;
  readonly editor: ProjectEditorSettings;
}
export interface PhotoProject extends ProjectEditSnapshot {
  readonly schemaVersion: 3 | 4;
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly scope: ProjectScope;
  readonly createdAt: string;
  readonly capturedAt: string | null;
  readonly captureTimeZone: string;
  readonly updatedAt: string;
  readonly mode: "solo" | "duo" | "group";
  readonly role: Role;
  readonly participants: readonly ProjectParticipant[];
  readonly media: readonly ProjectMedia[];
  readonly capture: ProjectCaptureSettings;
  readonly history: { readonly past: readonly ProjectEditSnapshot[]; readonly future: readonly ProjectEditSnapshot[] };
}
export type ProjectParseResult = { readonly kind: "current"; readonly project: PhotoProject; readonly readOnly: false }
  | { readonly kind: "unsupported"; readonly schemaVersion: number; readonly rawJson: string; readonly readOnly: true };
export interface CreateProjectInput {
  id?: string; name?: string; scope?: ProjectScope; createdAt?: string; captureTimeZone?: string;
  mode?: PhotoProject["mode"]; role?: Role; participants?: readonly ProjectParticipant[];
  capture?: Partial<ProjectCaptureSettings>; editor?: Partial<ProjectEditorSettings>;
}
export class ProjectValidationError extends Error {
  constructor(readonly path: string, message: string) { super(`${path}: ${message}`); this.name = "ProjectValidationError"; }
}

function fail(path: string, message: string): never { throw new ProjectValidationError(path, message); }
function object(value: unknown, keys: readonly string[] | null, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, "Expected plain data");
  const own = Reflect.ownKeys(value);
  if (own.some(key => typeof key !== "string" || (keys && !keys.includes(key)) || !("value" in Object.getOwnPropertyDescriptor(value, key)!)) || (keys && own.length !== keys.length)) fail(path, "Unexpected, missing or accessor fields");
  return value as Record<string, unknown>;
}
function array(value: unknown, max: number, path: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) fail(path, "Invalid or oversized array");
  for (let i = 0; i < value.length; i++) if (!Object.getOwnPropertyDescriptor(value, i) || !("value" in Object.getOwnPropertyDescriptor(value, i)!)) fail(path, "Sparse or accessor entries");
  return value;
}
function id(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) fail(path, "Invalid identifier");
  return value;
}
function number(value: unknown, min: number, max: number, path: string, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) fail(path, "Number outside supported bounds");
  return value;
}
function bool(value: unknown, path: string): boolean { if (typeof value !== "boolean") fail(path, "Expected boolean"); return value; }
function text(value: unknown, max: number, path: string): string {
  if (typeof value !== "string" || value.length > max * 2 || Array.from(value).length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(path, "Invalid or oversized text");
  return value;
}
function choice<T extends string | number>(value: unknown, choices: readonly T[], path: string): T {
  if (!choices.includes(value as T)) fail(path, "Unsupported value"); return value as T;
}
function date(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length !== 24 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(path, "Expected canonical UTC timestamp");
  return value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const entry of Object.values(value)) freeze(entry); Object.freeze(value); }
  return value;
}
function bytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
const editorKeys = ["frameId", "layoutId", "filterId", "caption", "showDate", "patternId", "themeId", "sceneId", "stickerStyle", "places", "stickers", "cellEdits"];
const stickerDefinitions = new Map(STICKER_PACKS.flatMap(pack => pack.stickers.map(sticker => [sticker.slug, sticker.emoji] as const)));
const filters = FILTERS.map(item => item.id);

function editor(value: unknown, mode: PhotoProject["mode"], path: string, sourceVersion: number): ProjectEditorSettings {
  const item = object(value, null, path);
  const allowed = sourceVersion === 1 ? editorKeys : [...editorKeys, "template", "materialId", ...(sourceVersion >= 3 ? ["story", "thenNow"] : []), ...(sourceVersion >= 4 ? ["exportSettings"] : [])];
  if (Object.keys(item).some(key => !allowed.includes(key)) || editorKeys.some(key => !Object.hasOwn(item, key))) fail(path, "Unexpected or missing editor fields");
  const story = item.story == null ? null : validateStoryPlan(item.story);
  const thenNow = item.thenNow == null ? null : validateThenNowPlan(item.thenNow);
  const exportSettings = Object.hasOwn(item, "exportSettings") ? validateExportSettings(item.exportSettings) : undefined;
  const template = item.template == null ? null : validateTemplateDesign(item.template);
  const materialId = item.materialId == null ? null : id(item.materialId, `${path}.materialId`);
  if (materialId && getCuratedAsset(materialId)?.kind !== "material") fail(path, "Unknown frame material");
  const layoutId = choice(item.layoutId, LAYOUTS.filter(layout => layout.mode === mode).map(layout => layout.id), `${path}.layoutId`);
  const layout = LAYOUTS.find(layout => layout.id === layoutId)!;
  const places: Partial<Record<Role, TogetherPlacement>> = {};
  for (const [key, value] of Object.entries(object(item.places, null, `${path}.places`))) {
    const role = choice(key, ROLES, `${path}.places`);
    const place = object(value, ["dx", "dy", "scale"], `${path}.places.${role}`);
    places[role] = { dx: number(place.dx, -0.5, 0.5, path), dy: number(place.dy, -0.25, 0.25, path), scale: number(place.scale, 0.5, 1.6, path) };
  }
  const stickerKeys = new Set<number>();
  const stickers = array(item.stickers, RESOURCE_LIMITS.stickerLayers, `${path}.stickers`).map((value, index) => {
    const p = `${path}.stickers[${index}]`;
    const sticker = object(value, ["key", "emoji", "slug", "x", "y", "scale", "rotation"], p);
    const key = number(sticker.key, 0, Number.MAX_SAFE_INTEGER, p, true);
    if (stickerKeys.has(key)) fail(p, "Duplicate sticker key"); stickerKeys.add(key);
    const slug = id(sticker.slug, p);
    if (!stickerDefinitions.has(slug) || sticker.emoji !== stickerDefinitions.get(slug)) fail(p, "Unknown sticker or mismatched emoji");
    return { key, slug, emoji: sticker.emoji as string, x: number(sticker.x, 0, 1, p), y: number(sticker.y, 0, 1, p), scale: number(sticker.scale, 0.4, 3, p), rotation: number(sticker.rotation, -Math.PI * 2, Math.PI * 2, p) };
  });
  const cellEdits: Record<string, PhotoCellEdit> = {};
  const cells = object(item.cellEdits, null, `${path}.cellEdits`);
  if (Object.keys(cells).length > RESOURCE_LIMITS.photoSlots * RESOURCE_LIMITS.participants) fail(path, "Too many cell edits");
  for (const [key, value] of Object.entries(cells)) {
    if (!/^(0|[1-9][0-9]?):[ABCD]$/.test(key) || Number(key.split(":")[0]) >= layout.rows * layout.cols) fail(path, "Invalid cell key");
    const edit = object(value, ["sourceIndex", "zoom", "offsetX", "offsetY", "rotation", "mirror", "filterId"], `${path}.cellEdits.${key}`);
    try { cellEdits[key] = validateCellEdit(edit); } catch { fail(`${path}.cellEdits.${key}`, "Photo adjustment is out of bounds"); }
  }
  const sceneId = item.sceneId === null ? null : id(item.sceneId, `${path}.sceneId`);
  if (sceneId && !SCENES.some(scene => scene.id === sceneId) && getCuratedAsset(sceneId)?.kind !== "scene") fail(path, "Unknown scene");
  return { frameId: choice(item.frameId, FRAMES.map(frame => frame.id), path), layoutId, filterId: choice(item.filterId, filters, path), caption: text(item.caption, RESOURCE_LIMITS.textCodePoints, path), showDate: bool(item.showDate, path), patternId: choice(item.patternId, ["none", ...PATTERNS.map(pattern => pattern.id)], path), themeId: item.themeId === null ? null : choice(item.themeId, THEMES.map(theme => theme.id), path), sceneId, stickerStyle: choice(item.stickerStyle, STICKER_STYLES.map(style => style.id), path), places, stickers, cellEdits, ...(template ? { template } : {}), ...(materialId ? { materialId } : {}), ...(story ? { story } : {}), ...(thenNow ? { thenNow } : {}), ...(exportSettings ? { exportSettings } : {}) };
}

function validate(value: unknown, enforceBudget: boolean, sourceVersion?: number): PhotoProject {
  const item = object(value, ["schemaVersion", "id", "name", "revision", "scope", "createdAt", "capturedAt", "captureTimeZone", "updatedAt", "mode", "role", "participants", "media", "capture", "sourceOrder", "editor", "history"], "project");
  const version = sourceVersion ?? number(item.schemaVersion, 1, 4, "project.schemaVersion", true);
  if (![1, 2, 3, 4].includes(version) || item.schemaVersion !== version) fail("project.schemaVersion", "Unsupported project version");
  const scopeData = object(item.scope, null, "project.scope");
  const scope: ProjectScope = scopeData.kind === "device" ? (object(scopeData, ["kind"], "project.scope"), { kind: "device" }) : (object(scopeData, ["kind", "ownerId"], "project.scope"), { kind: choice(scopeData.kind, ["account"] as const, "project.scope"), ownerId: id(scopeData.ownerId, "project.scope.ownerId") });
  const mode = choice(item.mode, ["solo", "duo", "group"] as const, "project.mode");
  const role = choice(item.role, ROLES, "project.role");
  const participantIds = new Set<string>(), participantRoles = new Set<Role>();
  const participants = array(item.participants, mode === "solo" ? 1 : mode === "duo" ? 2 : 4, "project.participants").map(value => {
    const person = object(value, ["id", "role"], "project.participants");
    const participant = { id: id(person.id, "project.participants.id"), role: choice(person.role, mode === "solo" ? ["A"] : mode === "duo" ? ["A", "B"] : ROLES, "project.participants.role") as Role };
    if (participantIds.has(participant.id) || participantRoles.has(participant.role)) fail("project.participants", "Duplicate participant or role");
    participantIds.add(participant.id); participantRoles.add(participant.role); return participant;
  });
  if (!participantRoles.has(role)) fail("project.role", "Current role must have a persistent participant");
  const mediaIds = new Set<string>();
  const media = array(item.media, RESOURCE_LIMITS.files, "project.media").map(value => {
    const entry = object(value, ["id", "kind", "mime", "bytes", "width", "height", "participantId"], "project.media");
    const { participantId, ...declaration } = entry;
    const resource = validateMediaResource(declaration);
    if (version < 3 && resource.kind === "reference") fail("project.media", "Reference images need project schema 3");
    if (mediaIds.has(resource.id)) fail("project.media", "Duplicate media identifier"); mediaIds.add(resource.id);
    if (resource.kind === "photo" ? typeof participantId !== "string" || !participantIds.has(participantId) : participantId !== null) fail("project.media", "Media participant ownership is invalid");
    return { ...resource, participantId: participantId as string | null };
  });
  if (media.reduce((sum, entry) => sum + entry.bytes, 0) > RESOURCE_LIMITS.totalEncodedBytes || media.reduce((sum, entry) => sum + entry.width * entry.height, 0) > RESOURCE_LIMITS.totalPixels || media.filter(entry => entry.kind === "decoration").length > RESOURCE_LIMITS.decorations) fail("project.media", "Media inventory quota exceeded; original captures are preserved");
  const byId = new Map(media.map(entry => [entry.id, entry]));
  function snapshot(value: unknown, path: string): ProjectEditSnapshot {
    const snap = object(value, ["sourceOrder", "editor"], path);
    const order = object(snap.sourceOrder, ROLES, `${path}.sourceOrder`);
    const sourceOrder = {} as Record<Role, (string | null)[]>;
    for (const role of ROLES) {
      const owner = participants.find(person => person.role === role)?.id;
      const seen = new Set<string>();
      sourceOrder[role] = array(order[role], 4, `${path}.sourceOrder.${role}`).map(value => {
        if (value === null) return null;
        const sourceId = id(value, path), source = byId.get(sourceId);
        if (!source || source.kind !== "photo" || !owner || source.participantId !== owner || seen.has(sourceId)) fail(path, "Missing, duplicate or foreign source reference");
        seen.add(sourceId); return sourceId;
      });
      if (!owner && sourceOrder[role].length) fail(path, "Unmapped role has source positions");
    }
    const settings = editor(snap.editor, mode, `${path}.editor`, version);
    if (settings.thenNow) {
      const source = byId.get(settings.thenNow.reference.mediaId), crop = settings.thenNow.reference.crop;
      if (source?.kind !== "reference") fail(path, "The then-and-now reference is missing from this project");
      if (crop && (crop.width * source.width < 1 || crop.height * source.height < 1)) fail(path, "Select at least one source pixel in each crop dimension");
    }
    if (settings.template) {
      if (Object.keys(settings.template.requiredSources).some(role => !participantRoles.has(role as Role))) fail(path, "Template needs a participant who is not in this project");
      for (const decoration of settings.template.decorations) {
        const source = byId.get(decoration.id);
        if (!source || source.kind !== "decoration" || source.mime !== decoration.mime || source.bytes !== decoration.bytes || source.width !== decoration.width || source.height !== decoration.height) fail(path, "Template decoration is missing or differs from its original");
      }
    }
    return { sourceOrder, editor: settings };
  }
  const current = snapshot({ sourceOrder: item.sourceOrder, editor: item.editor }, "project");
  const historyData = object(item.history, ["past", "future"], "project.history");
  const history = { past: array(historyData.past, PROJECT_HISTORY_LIMIT, "project.history.past").map(value => snapshot(value, "project.history.past")), future: array(historyData.future, PROJECT_HISTORY_LIMIT, "project.history.future").map(value => snapshot(value, "project.history.future")) };
  if (history.past.length + history.future.length > PROJECT_HISTORY_LIMIT) fail("project.history", "History limit exceeded");
  const captureData = object(item.capture, ["style", "timerSeconds", "requiredShots", "cameraId", "mirror", "fillLight"], "project.capture");
  const capture: ProjectCaptureSettings = { style: choice(captureData.style, ["classic", "flexible"] as const, "project.capture"), timerSeconds: choice(captureData.timerSeconds, [3, 5, 10] as const, "project.capture"), requiredShots: choice(captureData.requiredShots, [1, 2, 3, 4] as const, "project.capture"), cameraId: captureData.cameraId === null ? null : text(captureData.cameraId, 256, "project.capture.cameraId"), mirror: bool(captureData.mirror, "project.capture"), fillLight: bool(captureData.fillLight, "project.capture") };
  const createdAt = date(item.createdAt, "project.createdAt"), updatedAt = date(item.updatedAt, "project.updatedAt"), capturedAt = item.capturedAt === null ? null : date(item.capturedAt, "project.capturedAt");
  if (createdAt > updatedAt || (capturedAt !== null && capturedAt > updatedAt) || (version < 4 && media.some(entry => entry.kind === "photo") && capturedAt === null)) fail("project", "Invalid capture or update timestamps");
  const captureTimeZone = text(item.captureTimeZone, 100, "project.captureTimeZone");
  if (!/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(captureTimeZone)) fail("project.captureTimeZone", "Expected an IANA timezone");
  try { new Intl.DateTimeFormat("en", { timeZone: captureTimeZone }).format(0); } catch { fail("project.captureTimeZone", "Unknown IANA timezone"); }
  const result: PhotoProject = { schemaVersion: version >= 4 ? 4 : 3, id: id(item.id, "project.id"), name: text(item.name, 100, "project.name"), revision: number(item.revision, 0, Number.MAX_SAFE_INTEGER, "project.revision", true), scope, createdAt, capturedAt, captureTimeZone, updatedAt, mode, role, participants, media, capture, ...current, history };
  if (enforceBudget && bytes(result) > RESOURCE_LIMITS.manifestBytes) fail("project", "Project exceeds the UTF-8 manifest byte limit");
  return freeze(result);
}

export function validatePhotoProject(value: unknown): PhotoProject {
  const version = object(value, null, "project").schemaVersion;
  if (version !== 3 && version !== 4) fail("project.schemaVersion", "Unsupported project version");
  return validate(value, true, version);
}
export function parsePhotoProject(rawJson: string): ProjectParseResult {
  if (typeof rawJson !== "string" || rawJson.length > RESOURCE_LIMITS.manifestBytes || new TextEncoder().encode(rawJson).byteLength > RESOURCE_LIMITS.manifestBytes) fail("project", "Project exceeds the UTF-8 manifest byte limit");
  let value: unknown;
  try { value = JSON.parse(rawJson); } catch { fail("project", "Invalid JSON"); }
  const envelope = object(value, null, "project");
  const version = number(envelope.schemaVersion, 1, Number.MAX_SAFE_INTEGER, "project.schemaVersion", true);
  return version > PROJECT_SCHEMA_VERSION ? Object.freeze({ kind: "unsupported", schemaVersion: version, rawJson, readOnly: true }) : Object.freeze({ kind: "current", project: validate(value, true, version), readOnly: false });
}
export function serializePhotoProject(project: PhotoProject): string { return JSON.stringify(validatePhotoProject(project)); }
export function isProjectVisibleTo(project: PhotoProject, ownerId: string | null): boolean { return project.scope.kind === "device" || (ownerId !== null && project.scope.ownerId === ownerId); }
export function createProject(input: CreateProjectInput = {}): PhotoProject {
  const mode = input.mode ?? "solo", role = input.role ?? "A", createdAt = input.createdAt ?? new Date().toISOString();
  const layoutId = input.editor?.layoutId ?? LAYOUTS.find(layout => layout.mode === mode)!.id;
  return validatePhotoProject({ schemaVersion: PROJECT_SCHEMA_VERSION, id: input.id ?? crypto.randomUUID(), name: input.name ?? "Untitled project", revision: 0, scope: input.scope ?? { kind: "device" }, createdAt, capturedAt: null, captureTimeZone: input.captureTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, updatedAt: createdAt, mode, role, participants: input.participants ?? [{ id: crypto.randomUUID(), role }], media: [], capture: { style: "classic", timerSeconds: 3, requiredShots: LAYOUTS.find(layout => layout.id === layoutId)?.shots ?? 4, cameraId: null, mirror: true, fillLight: false, ...input.capture }, sourceOrder: { A: [], B: [], C: [], D: [] }, editor: { frameId: "film", layoutId, filterId: "none", caption: "", showDate: true, patternId: "none", themeId: null, sceneId: null, stickerStyle: "flat", places: {}, stickers: [], cellEdits: {}, ...input.editor }, history: { past: [], future: [] } });
}
function currentSnapshot(project: PhotoProject): ProjectEditSnapshot { return { sourceOrder: project.sourceOrder, editor: project.editor }; }
function update(project: PhotoProject, changes: Partial<PhotoProject>, updatedAt: string): PhotoProject {
  if (date(updatedAt, "project.updatedAt") < project.updatedAt) fail("project.updatedAt", "Update time cannot move backwards");
  const candidate = { ...project, ...changes, revision: project.revision + 1, updatedAt };
  if (candidate.editor.exportSettings) candidate.schemaVersion = 4;
  const past = [...candidate.history.past], future = [...candidate.history.future];
  while (past.length + future.length > PROJECT_HISTORY_LIMIT) { if (past.length) past.shift(); else future.pop(); }
  let result = validate({ ...candidate, history: { past, future } }, false);
  while (bytes(result) > RESOURCE_LIMITS.manifestBytes && (past.length || future.length)) {
    if (past.length) past.shift(); else future.pop();
    result = validate({ ...candidate, history: { past, future } }, false);
  }
  return validatePhotoProject(result);
}
export function applyProjectEdit(project: PhotoProject, snapshot: ProjectEditSnapshot, updatedAt = new Date().toISOString()): PhotoProject {
  const previous = validatePhotoProject(project);
  object(snapshot, ["sourceOrder", "editor"], "edit");
  return update(previous, { sourceOrder: snapshot.sourceOrder, editor: snapshot.editor, history: { past: [...previous.history.past, currentSnapshot(previous)], future: [] } }, updatedAt);
}
export function configureProjectCapture(project: PhotoProject, patch: Partial<ProjectCaptureSettings>, editorPatch?: Partial<ProjectEditorSettings>, updatedAt = new Date().toISOString()): PhotoProject {
  const previous = validatePhotoProject(project), capture = { ...previous.capture, ...patch }, editor = { ...previous.editor, ...editorPatch };
  if ((previous.capturedAt !== null || previous.media.some(item => item.kind === "photo")) && capture.requiredShots !== previous.capture.requiredShots) throw new Error("Start a new round to change the number of source shots");
  if (editor.story && capture.requiredShots !== 4) throw new Error("A story needs four photo positions");
  return update(previous, { capture, editor, ...(editorPatch ? { history: { past: [...previous.history.past, currentSnapshot(previous)], future: [] } } : {}) }, updatedAt);
}
export function attachProjectReference(project: PhotoProject, media: ProjectMedia, plan: ThenNowPlan, updatedAt = new Date().toISOString()): PhotoProject {
  const previous = validatePhotoProject(project), checked = validateThenNowPlan(plan);
  if (media.kind !== "reference" || media.participantId !== null || checked.reference.mediaId !== media.id) throw new Error("Reference media does not match this guide");
  return update(previous, { media: [...previous.media, media], editor: { ...previous.editor, thenNow: checked }, history: { past: [...previous.history.past, currentSnapshot(previous)], future: [] } }, updatedAt);
}
export function createReferencedProject(input: CreateProjectInput, media: ProjectMedia, plan: ThenNowPlan): PhotoProject {
  const initial = createProject(input), attached = attachProjectReference(initial, media, plan, initial.createdAt);
  return validatePhotoProject({ ...attached, revision: 0, history: { past: [], future: [] } });
}
export function undoProject(project: PhotoProject, updatedAt = new Date().toISOString()): PhotoProject {
  const previous = validatePhotoProject(project), target = previous.history.past.at(-1);
  return target ? update(previous, { ...target, capture: historyCapture(previous, target), history: { past: previous.history.past.slice(0, -1), future: [currentSnapshot(previous), ...previous.history.future] } }, updatedAt) : previous;
}
export function redoProject(project: PhotoProject, updatedAt = new Date().toISOString()): PhotoProject {
  const previous = validatePhotoProject(project), target = previous.history.future[0];
  return target ? update(previous, { ...target, capture: historyCapture(previous, target), history: { past: [...previous.history.past, currentSnapshot(previous)], future: previous.history.future.slice(1) } }, updatedAt) : previous;
}
function historyCapture(project: PhotoProject, target: ProjectEditSnapshot): ProjectCaptureSettings {
  if (project.capturedAt !== null || project.media.some(item => item.kind === "photo")) return project.capture;
  const requiredShots = target.editor.template ? Math.max(...Object.values(target.editor.template.requiredSources)) : LAYOUTS.find(layout => layout.id === target.editor.layoutId)!.shots;
  return { ...project.capture, requiredShots: requiredShots as 1 | 2 | 3 | 4 };
}
export function appendProjectMedia(project: PhotoProject, declarations: readonly ProjectMedia[], sourceOrder: ProjectSourceOrder, capturedAt: string, updatedAt = new Date().toISOString()): PhotoProject {
  const previous = validatePhotoProject(project);
  array(declarations, RESOURCE_LIMITS.files, "project.media");
  return update(previous, { media: [...previous.media, ...declarations], sourceOrder, capturedAt: previous.capturedAt !== null || previous.media.some(item => item.kind === "photo") ? previous.capturedAt : date(capturedAt, "project.capturedAt"), history: { past: [...previous.history.past, currentSnapshot(previous)], future: [] } }, updatedAt);
}

export function applyTemplateToProject(project: PhotoProject, design: TemplateDesign, decorations: readonly ProjectMedia[], updatedAt = new Date().toISOString()): PhotoProject {
  const previous = validatePhotoProject(project), template = validateTemplateDesign(design);
  if (decorations.some(item => item.kind !== "decoration" || item.participantId !== null)) fail("template", "Only decoration files can be added with a template");
  const capture = previous.capturedAt !== null || previous.media.some(item => item.kind === "photo") ? previous.capture : { ...previous.capture, requiredShots: Math.max(...Object.values(template.requiredSources)) as 1 | 2 | 3 | 4 };
  const editor: ProjectEditorSettings = { ...previous.editor, ...template.look, ...template.defaults, template, ...(Object.values(template.requiredSources).some(count => count !== 4) ? { story: null } : {}), places: template.places ?? {}, cellEdits: {}, stickers: [] };
  return update(previous, { capture, media: [...previous.media, ...decorations], editor, history: { past: [...previous.history.past, currentSnapshot(previous)], future: [] } }, updatedAt);
}
