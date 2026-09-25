import { LAYOUTS, ROLES, type Role } from "../layouts";
import { createProject, validatePhotoProject, type PhotoProject, type ProjectEditorSettings } from "../projects/model";
import { validateCellEdit, type PhotoCellEdit } from "../projects/transforms";
import { validateTemplateDesign, type TemplateDesign, type TemplatePhotoSource } from "../templates/model";
import type { StickerInstance, TogetherPlacement } from "../compose";

export const RECIPE_SCHEMA_VERSION = 1;
export const RECIPE_LIMITS = Object.freeze({ proposalBytes: 16 * 1024, commitBytes: 64 * 1024, queue: 16, receipts: 128 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHARED = ["frameId", "layoutId", "filterId", "caption", "showDate", "patternId", "themeId", "sceneId", "stickerStyle", "template", "materialId", "story"] as const;
type SharedKey = typeof SHARED[number];
export type SharedRecipePatch = Partial<Pick<ProjectEditorSettings, SharedKey>>;
export type RecipeEdit =
  | { readonly kind: "shared"; readonly patch: SharedRecipePatch }
  | { readonly kind: "cell"; readonly role: Role; readonly cellIndex: number; readonly value: PhotoCellEdit | null }
  | { readonly kind: "template-cell"; readonly role: Role; readonly slotId: string; readonly value: PhotoCellEdit }
  | { readonly kind: "placement"; readonly role: Role; readonly value: TogetherPlacement | null }
  | { readonly kind: "sticker"; readonly role: Role; readonly key: number; readonly value: StickerInstance | null };
export interface RecipeProposal { readonly schemaVersion: 1; readonly id: string; readonly baseRevision: number; readonly edit: RecipeEdit }
export interface CollaborativeRecipe {
  readonly editor: ProjectEditorSettings;
  readonly owners: Readonly<Partial<Record<Role, string>>>;
  readonly stickerOwners: Readonly<Record<string, string>>;
}
export interface RecipeCommit {
  readonly schemaVersion: 1; readonly revision: number; readonly proposalId: string | null;
  readonly authorId: string; readonly recipeHash: string; readonly recipe: CollaborativeRecipe;
}
export interface RecipeContext {
  readonly project: PhotoProject;
  readonly hostId: string;
  readonly members: readonly { readonly id: string; readonly role: Role }[];
  readonly availableMediaIds: ReadonlySet<string>;
}
export class RecipeError extends Error {
  constructor(readonly code: "invalid_recipe" | "update_required" | "ownership_denied" | "recovery_required" | "media_unavailable" | "queue_full" | "closed") { super(code); this.name = "RecipeError"; }
}
function fail(code: RecipeError["code"] = "invalid_recipe"): never { throw new RecipeError(code); }
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const isRole = (value: unknown): value is Role => ROLES.includes(value as Role);
function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const result = value as Record<string, unknown>;
  if (keys && (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key)))) fail();
  return result;
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
// Reject executable properties before either the model validator or JSON serialisation reads them.
function plainData(value: unknown, limit: number): unknown {
  let nodes = 0;
  const active = new Set<object>();
  function clone(input: unknown, depth: number): unknown {
    if (++nodes > 10000 || depth > 20) fail();
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") { if (!Number.isFinite(input)) fail(); return input; }
    if (typeof input === "string") { if (input.length > 4096) fail(); return input; }
    if (!input || typeof input !== "object" || active.has(input)) return fail();
    const array = Array.isArray(input);
    if (array ? Object.getPrototypeOf(input) !== Array.prototype || input.length > 64 : ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail();
    active.add(input);
    const output: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    const keys = Reflect.ownKeys(input).filter(key => !(array && key === "length"));
    if (array && keys.length !== input.length) fail();
    for (const key of keys) {
      if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) fail();
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      if (!("value" in descriptor) || !descriptor.enumerable || (array && !/^(0|[1-9][0-9]*)$/.test(key))) fail();
      if (array && Number(key) >= input.length) fail();
      (output as Record<string, unknown>)[key] = clone(descriptor.value, depth + 1);
    }
    active.delete(input); return output;
  }
  const result = clone(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > limit) fail();
  return result;
}
function modelEditor(value: unknown): ProjectEditorSettings {
  const input = record(value), layout = LAYOUTS.find(item => item.id === input.layoutId);
  if (!layout) return fail();
  try {
    const template = input.template == null ? null : validateTemplateDesign(input.template);
    const roles = layout.mode === "solo" ? ["A"] as const : layout.mode === "duo" ? ["A", "B"] as const : ROLES;
    const project = createProject({ id: "recipe-validation", mode: layout.mode, createdAt: "2026-01-01T00:00:00.000Z", captureTimeZone: "UTC", participants: roles.map(role => ({ id: `participant-${role}`, role })) });
    return validatePhotoProject({ ...project, editor: input, media: (template?.decorations ?? []).map(item => ({ ...item, participantId: null })) }).editor;
  } catch { return fail(); }
}
function blankEditor(mode: PhotoProject["mode"] = "group"): ProjectEditorSettings {
  return createProject({ id: "recipe-validation", mode, createdAt: "2026-01-01T00:00:00.000Z", captureTimeZone: "UTC", participants: [{ id: "participant-A", role: "A" }] }).editor;
}
function placement(value: unknown): TogetherPlacement | null {
  if (value === null) return null;
  const item = record(value, ["dx", "dy", "scale"]);
  if (typeof item.dx !== "number" || item.dx < -.5 || item.dx > .5 || typeof item.dy !== "number" || item.dy < -.25 || item.dy > .25 || typeof item.scale !== "number" || item.scale < .5 || item.scale > 1.6) return fail();
  return item as unknown as TogetherPlacement;
}
function cell(value: unknown): PhotoCellEdit {
  try { return validateCellEdit(value); } catch { return fail(); }
}
function proposal(input: unknown): RecipeProposal {
  const raw = record(input, ["schemaVersion", "id", "baseRevision", "edit"]);
  if (raw.schemaVersion !== RECIPE_SCHEMA_VERSION) fail("update_required");
  if (!isUuid(raw.id) || !integer(raw.baseRevision)) fail();
  const edit = record(raw.edit);
  if (edit.kind === "shared") {
    record(edit, ["kind", "patch"]); const patch = record(edit.patch);
    if (!Object.keys(patch).length || Object.keys(patch).some(key => !SHARED.includes(key as SharedKey))) fail();
    const layoutId = patch.layoutId ?? LAYOUTS.find(layout => layout.mode === "group")!.id;
    const base = modelEditor({ ...blankEditor(), layoutId });
    modelEditor({ ...base, ...patch });
  } else {
    if (!isRole(edit.role)) fail();
    if (edit.kind === "cell") {
      record(edit, ["kind", "role", "cellIndex", "value"]);
      if (!integer(edit.cellIndex, 15)) fail(); if (edit.value !== null) cell(edit.value);
    } else if (edit.kind === "template-cell") {
      record(edit, ["kind", "role", "slotId", "value"]);
      if (typeof edit.slotId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(edit.slotId)) fail(); cell(edit.value);
    } else if (edit.kind === "placement") {
      record(edit, ["kind", "role", "value"]); placement(edit.value);
    } else if (edit.kind === "sticker") {
      record(edit, ["kind", "role", "key", "value"]); if (!integer(edit.key)) fail();
      if (edit.value !== null) {
        const sticker = record(edit.value);
        if (sticker.key !== edit.key) fail();
        modelEditor({ ...blankEditor(), stickers: [sticker] });
      }
    } else fail();
  }
  return frozen(raw as unknown as RecipeProposal);
}
export function validateRecipeProposal(value: unknown): RecipeProposal { return proposal(plainData(value, RECIPE_LIMITS.proposalBytes)); }
function recipe(value: unknown): CollaborativeRecipe {
  const raw = record(value, ["editor", "owners", "stickerOwners"]);
  const editor = modelEditor(raw.editor), owners = record(raw.owners), stickers = record(raw.stickerOwners);
  if (editor.stickers.length + (editor.template?.layers.filter(layer => layer.kind === "sticker").length ?? 0) > 32) fail();
  if (!Object.keys(owners).length || Object.keys(owners).length > 4 || Object.entries(owners).some(([role, member]) => !isRole(role) || !isUuid(member)) || new Set(Object.values(owners)).size !== Object.keys(owners).length) fail();
  if (Object.keys(stickers).length !== editor.stickers.length || editor.stickers.some(item => !Object.hasOwn(stickers, String(item.key)) || !Object.values(owners).includes(stickers[String(item.key)]))) fail();
  if (Object.keys(editor.places).some(role => !Object.hasOwn(owners, role)) || Object.keys(editor.cellEdits).some(key => !Object.hasOwn(owners, key.split(":")[1])) || (editor.template && Object.keys(editor.template.requiredSources).some(role => !Object.hasOwn(owners, role)))) fail();
  return frozen({ editor, owners, stickerOwners: stickers } as CollaborativeRecipe);
}
export function validateRecipeCommit(value: unknown): RecipeCommit {
  const raw = record(plainData(value, RECIPE_LIMITS.commitBytes), ["schemaVersion", "revision", "proposalId", "authorId", "recipeHash", "recipe"]);
  if (raw.schemaVersion !== RECIPE_SCHEMA_VERSION) fail("update_required");
  if (!integer(raw.revision) || (raw.proposalId !== null && !isUuid(raw.proposalId)) || !isUuid(raw.authorId) || typeof raw.recipeHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.recipeHash)) fail();
  const validated = recipe(raw.recipe);
  if (!Object.values(validated.owners).includes(raw.authorId)) fail();
  return frozen({ ...raw, recipe: validated } as unknown as RecipeCommit);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function canonicalRecipe(value: CollaborativeRecipe): string { return canonical(recipe(plainData(value, RECIPE_LIMITS.commitBytes))); }
export async function hashRecipe(value: CollaborativeRecipe): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRecipe(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
function contextOwners(context: RecipeContext): Partial<Record<Role, string>> {
  if (context.members.length < 1 || context.members.length > 4 || !isUuid(context.hostId)) fail("ownership_denied");
  const owners: Partial<Record<Role, string>> = {};
  for (const member of context.members) {
    if (!isUuid(member.id) || !isRole(member.role) || owners[member.role] || Object.values(owners).includes(member.id)) fail("ownership_denied");
    owners[member.role] = member.id;
  }
  if (!Object.values(owners).includes(context.hostId)) fail("ownership_denied");
  if (context.project.participants.length !== context.members.length || context.project.participants.some(person => owners[person.role] !== person.id)) fail("recovery_required");
  return owners;
}
export function validateRecipeContext(value: CollaborativeRecipe, context: RecipeContext): CollaborativeRecipe {
  const validated = recipe(plainData(value, RECIPE_LIMITS.commitBytes));
  if (canonical(contextOwners(context)) !== canonical(validated.owners)) fail("recovery_required");
  const layout = LAYOUTS.find(item => item.id === validated.editor.layoutId)!;
  const represented = new Set(validated.editor.template ? Object.keys(validated.editor.template.requiredSources) : (layout.duoPattern ?? ["A"]).flatMap(role => role === "AB" ? ["A", "B"] : [role]));
  if (context.members.some(member => !represented.has(member.role))) fail("invalid_recipe");
  try { validatePhotoProject({ ...context.project, editor: validated.editor, history: { past: [], future: [] } }); }
  catch { fail("media_unavailable"); }
  for (const decoration of validated.editor.template?.decorations ?? []) if (!context.availableMediaIds.has(decoration.id)) fail("media_unavailable");
  for (const mediaId of Object.values(context.project.sourceOrder).flat()) if (mediaId && !context.availableMediaIds.has(mediaId)) fail("media_unavailable");
  return validated;
}
function templateSources(template: TemplateDesign | null | undefined, role: Role): unknown[] {
  return template?.slots.flatMap(slot => [slot, ...(slot.companions ?? [])].filter(source => source.role === role).map(source => ({ id: slot.id, sourceIndex: source.sourceIndex, crop: source.crop, filterId: source.filterId ?? null, sliceX: source.sliceX ?? [0, 1] }))) ?? [];
}
function assertOwnedChanges(before: CollaborativeRecipe, after: CollaborativeRecipe, authorId: string, context: RecipeContext): void {
  if (canonical(before.owners) !== canonical(after.owners)) fail("ownership_denied");
  const role = context.members.find(member => member.id === authorId)?.role;
  if (!role) fail("ownership_denied");
  for (const other of ROLES.filter(item => item !== role)) {
    const ownCells = (editor: ProjectEditorSettings) => Object.fromEntries(Object.entries(editor.cellEdits).filter(([key]) => key.endsWith(`:${other}`)));
    if (canonical(ownCells(before.editor)) !== canonical(ownCells(after.editor)) || canonical(before.editor.places[other] ?? null) !== canonical(after.editor.places[other] ?? null)
      || canonical(templateSources(before.editor.template, other)) !== canonical(templateSources(after.editor.template, other))
      || canonical(before.editor.template?.places?.[other] ?? null) !== canonical(after.editor.template?.places?.[other] ?? null)) fail("ownership_denied");
  }
  const foreignStickers = (value: CollaborativeRecipe) => value.editor.stickers.filter(sticker => value.stickerOwners[String(sticker.key)] !== authorId).map(sticker => ({ sticker, owner: value.stickerOwners[String(sticker.key)] }));
  if (canonical(foreignStickers(before)) !== canonical(foreignStickers(after))) fail("ownership_denied");
  if (authorId !== context.hostId) {
    const shared = (editor: ProjectEditorSettings) => {
      const template = editor.template;
      return { ...Object.fromEntries(SHARED.filter(key => key !== "template").map(key => [key, editor[key] ?? null])), template: template ? { ...template, requiredSources: null, places: null, slots: template.slots.map(slot => {
        const strip = (source: TemplatePhotoSource) => source.role === role ? { role } : source;
        return { ...slot, ...(slot.role === role ? { sourceIndex: null, crop: null, filterId: null } : {}), companions: slot.companions?.map(strip) ?? [] };
      }) } : null };
    };
    if (canonical(shared(before.editor)) !== canonical(shared(after.editor))) fail("ownership_denied");
  }
}
function edited(before: CollaborativeRecipe, edit: RecipeEdit, authorId: string, context: RecipeContext): CollaborativeRecipe {
  let editor = before.editor; const stickerOwners = { ...before.stickerOwners };
  const role = context.members.find(member => member.id === authorId)?.role;
  if (!role || before.owners[role] !== authorId) fail("ownership_denied");
  if (edit.kind === "shared") {
    if (context.hostId !== authorId) fail("ownership_denied");
    editor = { ...editor, ...edit.patch };
  } else {
    if (edit.role !== role) fail("ownership_denied");
    if (edit.kind === "cell") {
      if (editor.template) fail("invalid_recipe");
      const cellEdits = { ...editor.cellEdits }, key = `${edit.cellIndex}:${role}`;
      if (edit.value === null) delete cellEdits[key]; else cellEdits[key] = edit.value;
      editor = { ...editor, cellEdits };
    } else if (edit.kind === "placement") {
      const places = { ...editor.places }; if (edit.value === null) delete places[role]; else places[role] = edit.value;
      editor = { ...editor, places };
    } else if (edit.kind === "sticker") {
      const key = String(edit.key);
      if (stickerOwners[key] && stickerOwners[key] !== authorId) fail("ownership_denied");
      if (edit.value === null) delete stickerOwners[key]; else stickerOwners[key] = authorId;
      const existing = editor.stickers.findIndex(sticker => sticker.key === edit.key), stickers = [...editor.stickers];
      if (existing >= 0) { if (edit.value) stickers[existing] = edit.value; else stickers.splice(existing, 1); }
      else if (edit.value) stickers.push(edit.value);
      editor = { ...editor, stickers };
    } else {
      const template = editor.template;
      if (!template) return fail();
      let changed = false;
      const adjust = (source: TemplatePhotoSource): TemplatePhotoSource => {
        if (source.role !== role) return source;
        changed = true; const { sourceIndex, filterId, ...crop } = edit.value;
        return { ...source, sourceIndex, crop, filterId };
      };
      const slots = template.slots.map(slot => slot.id !== edit.slotId ? slot : { ...slot, ...adjust(slot), ...(slot.companions ? { companions: slot.companions.map(adjust) } : {}) });
      if (!changed) return fail("ownership_denied");
      const requiredSources: Partial<Record<Role, 1 | 2 | 3 | 4>> = {};
      for (const slot of slots) for (const source of [slot, ...(slot.companions ?? [])]) requiredSources[source.role] = Math.max(requiredSources[source.role] ?? 0, source.sourceIndex + 1) as 1 | 2 | 3 | 4;
      editor = { ...editor, template: { ...template, slots, requiredSources } };
    }
  }
  const after = validateRecipeContext({ editor, owners: before.owners, stickerOwners }, context);
  assertOwnedChanges(before, after, authorId, context); return after;
}
export async function initialRecipeCommit(context: RecipeContext, stickerOwners?: Readonly<Record<string, string>>): Promise<RecipeCommit> {
  const owners = contextOwners(context);
  const recipe = validateRecipeContext({ editor: context.project.editor, owners, stickerOwners: stickerOwners ?? Object.fromEntries(context.project.editor.stickers.map(item => [String(item.key), context.hostId])) }, context);
  return validateRecipeCommit({ schemaVersion: 1, revision: 0, proposalId: null, authorId: context.hostId, recipeHash: await hashRecipe(recipe), recipe });
}
export async function acceptRecipeCommit(current: RecipeCommit, incoming: unknown, authenticatedSender: string, context: RecipeContext): Promise<RecipeCommit> {
  if (authenticatedSender !== context.hostId) fail("ownership_denied");
  const commit = validateRecipeCommit(incoming);
  validateRecipeContext(commit.recipe, context);
  if (await hashRecipe(commit.recipe) !== commit.recipeHash) fail("invalid_recipe");
  if (commit.revision === current.revision && canonical(commit) === canonical(current)) return current;
  if (commit.revision !== current.revision + 1 || !commit.proposalId) fail("recovery_required");
  assertOwnedChanges(current.recipe, commit.recipe, commit.authorId, context);
  return commit;
}
export class RecipeCoordinator {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private receipts = new Map<string, { fingerprint: string; commit: RecipeCommit }>();
  private current: RecipeCommit;
  private readonly identity: string;
  constructor(initial: RecipeCommit, private readonly context: () => RecipeContext) {
    this.current = validateRecipeCommit(initial); const current = context();
    validateRecipeContext(this.current.recipe, current); this.identity = this.contextIdentity(current);
  }
  private contextIdentity(context: RecipeContext): string { return canonical({ id: context.project.id, scope: context.project.scope, host: context.hostId, owners: contextOwners(context) }); }
  get snapshot(): RecipeCommit { return this.current; }
  close(): void { this.closed = true; this.receipts.clear(); }
  commit(authenticatedSender: string, value: unknown): Promise<RecipeCommit> {
    if (this.closed) return Promise.reject(new RecipeError("closed"));
    if (this.pending >= RECIPE_LIMITS.queue) return Promise.reject(new RecipeError("queue_full"));
    let next: RecipeProposal;
    try { next = validateRecipeProposal(value); } catch (error) { return Promise.reject(error); }
    this.pending++;
    const task = this.tail.then(async () => {
      if (this.closed) fail("closed");
      const context = this.context();
      if (this.contextIdentity(context) !== this.identity) fail("recovery_required");
      validateRecipeContext(this.current.recipe, context);
      if (!context.members.some(member => member.id === authenticatedSender)) fail("ownership_denied");
      const fingerprint = canonical({ sender: authenticatedSender, proposal: next });
      const receipt = this.receipts.get(next.id);
      if (receipt) { if (receipt.fingerprint !== fingerprint) fail("ownership_denied"); return receipt.commit; }
      if (next.baseRevision !== this.current.revision || this.current.revision >= Number.MAX_SAFE_INTEGER) fail("recovery_required");
      const recipe = edited(this.current.recipe, next.edit, authenticatedSender, context);
      const commit = validateRecipeCommit({ schemaVersion: 1, revision: this.current.revision + 1, proposalId: next.id, authorId: authenticatedSender, recipeHash: await hashRecipe(recipe), recipe });
      if (this.closed) fail("closed");
      const latest = this.context();
      if (this.contextIdentity(latest) !== this.identity) fail("recovery_required");
      validateRecipeContext(recipe, latest);
      this.current = commit; this.receipts.set(next.id, { fingerprint, commit });
      if (this.receipts.size > RECIPE_LIMITS.receipts) this.receipts.delete(this.receipts.keys().next().value!);
      return commit;
    });
    this.tail = task.catch(() => undefined).finally(() => { this.pending--; });
    return task;
  }
}
export async function chooseRecipeReconnect(localFork: CollaborativeRecipe, hostSnapshot: unknown, authenticatedSender: string, context: RecipeContext, choice: "accept-host" | "keep-local-fork") {
  const local = recipe(plainData(localFork, RECIPE_LIMITS.commitBytes));
  if (choice === "keep-local-fork") return frozen({ kind: "local-fork" as const, recipe: local, connected: false as const });
  if (choice !== "accept-host" || authenticatedSender !== context.hostId) fail("ownership_denied");
  const commit = validateRecipeCommit(hostSnapshot); validateRecipeContext(commit.recipe, context);
  if (await hashRecipe(commit.recipe) !== commit.recipeHash) fail();
  return frozen({ kind: "host" as const, commit, preservedLocalFork: local, connected: true as const });
}
