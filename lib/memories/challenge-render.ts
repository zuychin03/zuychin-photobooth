import { composeStrip, type ComposeInput, type ShotSet } from "../compose";
import { FRAMES } from "../decor";
import { LAYOUTS, type Role } from "../layouts";
import { THEMES } from "../themes";
import { createAssetLoader, type ReadyAsset } from "../assets/loader";
import { getStickerImage, preloadStickers } from "../sticker-assets";
import { createExportCanvas, releaseExportCanvas } from "../exports/still";
import { exportGeometry, sourceResolution } from "../exports/geometry";
import { inspectImageHeader, type ProjectImageInfo } from "../projects/images";
import { RESOURCE_LIMITS, validateMediaResource } from "../projects/resource-bounds";
import { cloudUuid, type CloudProjectAsset, type CloudProjectView } from "../projects/cloud-contract";
import type { CloudProjectClient } from "../projects/cloud-client";
import type { TemplateDesign } from "../templates/model";
import { parseChallengeResponse, type ChallengeClient } from "./challenge-client";
import { challengeHash, parsePartialDetail, type ChallengeView } from "./challenge-contract";

export type ChallengeRenderCode = "not_ready" | "access_lost" | "unsupported" | "resource_limit" | "cancelled" | "timeout" | "integrity_failed" | "account_changed" | "busy" | "unavailable";
export class ChallengeRenderError extends Error { constructor(readonly code: ChallengeRenderCode) { super(code); this.name = "ChallengeRenderError"; } }
export interface ChallengePng {
  challengeId: string; recipeHash: string; blob: Blob; mime: "image/png"; extension: "png";
  bytes: number; width: number; height: number; warnings: string[];
}
export interface ChallengeRenderOptions {
  challenges: Pick<ChallengeClient, "ownerId" | "assertActive" | "view">;
  projects: Pick<CloudProjectClient, "ownerId" | "assertActive" | "view" | "download">;
  challengeId: string; signal?: AbortSignal; timeoutMs?: number;
}
export interface PartialChallengeRenderOptions {
  challenges: Pick<ChallengeClient, "ownerId" | "assertActive" | "partialDetail">;
  projects: ChallengeRenderOptions["projects"];
  partialId: string; digest: string; signal?: AbortSignal; timeoutMs?: number;
}
export interface PartialChallengePng extends ChallengePng { partialId: string; digest: string }
export interface ChallengeRenderPorts {
  decode(blob: Blob, expected: ProjectImageInfo, signal: AbortSignal): Promise<HTMLCanvasElement>;
  prepare(design: TemplateDesign, signal: AbortSignal): Promise<{ resources: ReadonlyMap<string, ReadyAsset>; warnings: string[]; release(): void }>;
  render(input: ComposeInput, signal: AbortSignal): Promise<{ blob: Blob; width: number; height: number; warnings: string[] }>;
}
const fail = (code: ChallengeRenderCode): never => { throw new ChallengeRenderError(code); };
const checkSignal = (signal: AbortSignal) => { if (signal.aborted) fail("cancelled"); };
const production: ChallengeRenderPorts = {
  async decode(blob, expected, signal) {
    checkSignal(signal);
    let info: ProjectImageInfo;
    try { info = inspectImageHeader(new Uint8Array(await blob.arrayBuffer())); } catch { return fail("integrity_failed"); }
    if (info.mime !== expected.mime || info.width !== expected.width || info.height !== expected.height) return fail("integrity_failed");
    checkSignal(signal);
    if (typeof createImageBitmap !== "function") return fail("unsupported");
    // The job keeps its slot until native decode settles, including after cancellation.
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    let canvas: HTMLCanvasElement | undefined;
    try {
      checkSignal(signal);
      if (bitmap.width !== expected.width || bitmap.height !== expected.height) return fail("integrity_failed");
      canvas = createExportCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d"); if (!context) return fail("unsupported");
      context.drawImage(bitmap, 0, 0); return canvas;
    } catch (error) { if (canvas) releaseExportCanvas(canvas); throw error; }
    finally { bitmap.close(); }
  },
  async prepare(design, signal) {
    checkSignal(signal);
    if (typeof document === "undefined") return fail("unsupported");
    const loader = createAssetLoader(), resources = new Map<string, ReadyAsset>(), warnings: string[] = [];
    const release = () => loader.dispose(); signal.addEventListener("abort", release, { once: true });
    try {
      await document.fonts.ready; checkSignal(signal);
      if (design.look.materialId) {
        const material = await loader.preload(design.look.materialId); checkSignal(signal);
        if (material.kind !== "ready") return fail("unavailable"); resources.set(material.asset.id, material);
      }
      const theme = THEMES.find(item => item.id === design.look.themeId);
      const stickers = [...design.layers.flatMap(layer => layer.kind === "sticker" ? [{ slug: layer.slug, style: layer.style }] : []), ...(theme?.decor.map(item => ({ slug: item.slug, style: theme.stickerStyle })) ?? [])];
      for (const style of ["flat", "3d"] as const) {
        const slugs = [...new Set(stickers.filter(item => item.style === style).map(item => item.slug))];
        if (slugs.length) { await preloadStickers(style, slugs); checkSignal(signal); if (slugs.some(slug => !getStickerImage(style, slug))) warnings.push("Some sticker artwork is unavailable; the renderer used its built-in glyph fallback."); }
      }
      return { resources, warnings, release: () => { signal.removeEventListener("abort", release); release(); } };
    } catch (error) { signal.removeEventListener("abort", release); release(); throw error; }
  },
  async render(input, signal) {
    checkSignal(signal);
    const geometry = exportGeometry(input.template!.canvas, "original", { format: "png" }), canvas = createExportCanvas();
    try {
      composeStrip(canvas, input, geometry.raster.scale); checkSignal(signal);
      const width = canvas.width, height = canvas.height;
      // Keep accounting live until the encoding callback, even if the caller has left.
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new ChallengeRenderError("unavailable")), "image/png"));
      checkSignal(signal);
      return { blob, width, height, warnings: sourceResolution(input, geometry).warnings };
    } finally { releaseExportCanvas(canvas); }
  },
};

interface RenderSnapshot {
  id: string; projectId: string; recipeHash: string; design: TemplateDesign;
  assignments: { userId: string; sourceIndex: number }[];
  members: { userId: string; role: string }[];
  visibleSources: ChallengeView["visibleSources"];
  authority: unknown; warnings: string[];
}
function supportedFallback(design: TemplateDesign) { if (design.slots.some(slot => slot.companions?.length && !slot.splitFallback)) return fail("unsupported"); }
function current(value: Awaited<ReturnType<ChallengeClient["view"]>>, expected: string, ownerId: string): RenderSnapshot {
  const view = parseChallengeResponse(value, expected);
  if ("unsupported" in view) return fail("unsupported");
  if (view.accessLost || !view.members.some(member => member.userId === ownerId && member.status === "accepted")) return fail("access_lost");
  if (view.status !== "revealed" && !(view.policy === "immediate" && view.status === "open")) return fail("not_ready");
  if (view.members.some(member => member.status !== "accepted")) return fail("access_lost");
  supportedFallback(view.design);
  return { ...view, authority: { kind: "full", status: view.status, policy: view.policy, revealHash: view.revealHash }, warnings: [] };
}
function currentPartial(value: Awaited<ReturnType<ChallengeClient["partialDetail"]>>, id: string, digest: string, actor: string): RenderSnapshot {
  let view: ReturnType<typeof parsePartialDetail>;
  try { view = parsePartialDetail(value, id, digest, actor); } catch { return fail("integrity_failed"); }
  if ("unsupported" in view) return fail("unsupported");
  if (view.accessLost || !view.actorIncluded || view.contributors.some(member => member.status !== "available")) return fail("access_lost");
  if (view.status !== "revealed" || view.actorConsent !== true || view.contributors.some(member => member.consent !== true) || !view.result) return fail("not_ready");
  supportedFallback(view.result.design);
  const { result, ...authority } = view;
  return { id: view.challengeId, projectId: view.projectId, recipeHash: result.recipeHash, design: result.design,
    assignments: result.sources.map(({ userId, sourceIndex }) => ({ userId, sourceIndex })), members: view.contributors,
    visibleSources: result.sources.map(({ userId, sourceIndex, assetId }) => ({ userId, sourceIndex, assetId })), authority,
    warnings: ["This is a partial result containing only the people who agreed to this reveal. Unused areas of the original design remain blank."] };
}
function plan(view: RenderSnapshot, project: CloudProjectView) {
  if (project.project.id !== view.projectId || project.project.status !== "active") return fail("access_lost");
  const used = new Set<string>(), photos: { role: Role; sourceIndex: number; asset: CloudProjectAsset }[] = [], decorations: CloudProjectAsset[] = [];
  for (const assignment of view.assignments) {
    const source = view.visibleSources.find(item => item.userId === assignment.userId && item.sourceIndex === assignment.sourceIndex);
    if (!source) return fail("not_ready");
    const asset = project.assets.find(item => item.id === source.assetId), member = view.members.find(item => item.userId === assignment.userId);
    if (!asset || !member || asset.kind !== "photo" || asset.ownerId !== member.userId || !project.members.some(item => item.userId === member.userId && item.status === "accepted")) return fail("access_lost");
    if (used.has(asset.id)) return fail("integrity_failed"); used.add(asset.id);
    photos.push({ role: member.role as Role, sourceIndex: assignment.sourceIndex, asset });
  }
  for (const declaration of view.design.decorations) {
    const asset = project.assets.find(item => item.id === declaration.id);
    if (!asset || asset.kind !== "decoration" || ["bytes", "mime", "width", "height"].some(key => asset[key as keyof CloudProjectAsset] !== declaration[key as keyof typeof declaration]) || !project.members.some(member => member.userId === asset.ownerId && member.status === "accepted")) return fail("access_lost");
    if (used.has(asset.id)) return fail("integrity_failed"); used.add(asset.id); decorations.push(asset);
  }
  const all = [...photos.map(item => item.asset), ...decorations];
  let bytes = 0, pixels = 0;
  for (const asset of all) {
    try { validateMediaResource({ id: asset.id, kind: asset.kind, bytes: asset.bytes, mime: asset.mime, width: asset.width, height: asset.height }); } catch { return fail("resource_limit"); }
    bytes += asset.bytes; pixels += asset.width * asset.height;
  }
  if (all.length > RESOURCE_LIMITS.files || bytes > RESOURCE_LIMITS.totalEncodedBytes || pixels > RESOURCE_LIMITS.totalPixels) return fail("resource_limit");
  return { photos, decorations, all };
}
function fingerprint(view: RenderSnapshot, assets: readonly CloudProjectAsset[]) {
  return JSON.stringify({ challengeId: view.id, projectId: view.projectId, recipeHash: view.recipeHash, design: view.design, assignments: view.assignments, members: view.members.map(({ userId, role }) => ({ userId, role })), sources: view.visibleSources, authority: view.authority, assets });
}

let running = false;
export async function renderChallengePng(options: ChallengeRenderOptions, ports: ChallengeRenderPorts = production): Promise<ChallengePng> {
  cloudUuid(options.challengeId);
  return renderPng({ ...options, load: async signal => current(await options.challenges.view(options.challengeId, signal), options.challengeId, options.challenges.ownerId) }, ports);
}
export async function renderPartialChallengePng(options: PartialChallengeRenderOptions, ports: ChallengeRenderPorts = production): Promise<PartialChallengePng> {
  cloudUuid(options.partialId); challengeHash(options.digest);
  const result = await renderPng({ ...options, load: async signal => currentPartial(await options.challenges.partialDetail(options.partialId, options.digest, signal), options.partialId, options.digest, options.challenges.ownerId) }, ports);
  return { ...result, partialId: options.partialId, digest: options.digest };
}
interface RenderOptions {
  challenges: Pick<ChallengeClient, "ownerId" | "assertActive">;
  projects: ChallengeRenderOptions["projects"]; signal?: AbortSignal; timeoutMs?: number;
  load(signal: AbortSignal): Promise<RenderSnapshot>;
}
async function renderPng(options: RenderOptions, ports: ChallengeRenderPorts): Promise<ChallengePng> {
  const { challenges, projects } = options, timeoutMs = options.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) return fail("resource_limit");
  if (challenges.ownerId !== projects.ownerId) return fail("account_changed");
  const controller = new AbortController(), deadline = Date.now() + timeoutMs; let timedOut = false;
  const check = () => {
    if (Date.now() >= deadline) { timedOut = true; controller.abort(); }
    if (controller.signal.aborted) return fail(timedOut ? "timeout" : "cancelled");
    try { challenges.assertActive(controller.signal); projects.assertActive(controller.signal); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "account_changed") return fail("account_changed"); throw error; }
  };
  if (options.signal?.aborted) return fail("cancelled"); check();
  if (running) return fail("busy"); running = true;
  let abortReject: (reason: unknown) => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { abortReject = reject; });
  const abort = () => { controller.abort(); abortReject(new ChallengeRenderError(timedOut ? "timeout" : "cancelled")); };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  const work = (async (): Promise<ChallengePng> => {
    const canvases = new Map<string, HTMLCanvasElement>(); let prepared: Awaited<ReturnType<ChallengeRenderPorts["prepare"]>> | undefined;
    try {
      const view = await options.load(controller.signal); check();
      const project = await projects.view(view.projectId, controller.signal); check();
      const sources = plan(view, project), initial = fingerprint(view, sources.all);
      for (const asset of sources.all) {
        check(); const blob = await projects.download({ ...asset, projectId: view.projectId }, controller.signal); check();
        if (blob.size !== asset.bytes || blob.type !== asset.mime) return fail("integrity_failed");
        const canvas = await ports.decode(blob, asset, controller.signal); canvases.set(asset.id, canvas); check();
        if (canvas.width !== asset.width || canvas.height !== asset.height) return fail("integrity_failed");
      }
      prepared = await ports.prepare(view.design, controller.signal); check();
      const shots: ShotSet = {}, decorations = new Map<string, HTMLCanvasElement>();
      for (const { role, sourceIndex, asset } of sources.photos) { shots[role] ??= Array(4).fill(null); shots[role]![sourceIndex] = canvases.get(asset.id)!; }
      for (const asset of sources.decorations) decorations.set(asset.id, canvases.get(asset.id)!);
      const frame = FRAMES.find(item => item.id === view.design.look.frameId)!;
      const input: ComposeInput = { layout: LAYOUTS[0], shots, template: view.design, stickers: [], decorations, resources: prepared.resources, materialId: view.design.look.materialId,
        theme: THEMES.find(item => item.id === view.design.look.themeId) ?? null, together: null,
        style: { frameColor: frame.color, inkColor: frame.ink, patternId: view.design.look.patternId, filterId: view.design.look.filterId, caption: view.design.defaults.caption, showDate: false, stickerStyle: "flat" } };
      const result = await ports.render(input, controller.signal); check();
      if (result.blob.type !== "image/png" || !result.blob.size || result.blob.size > RESOURCE_LIMITS.totalEncodedBytes || ![result.width, result.height].every(value => Number.isInteger(value) && value > 0 && value <= RESOURCE_LIMITS.photoEdge) || result.width * result.height > RESOURCE_LIMITS.photoPixels) return fail("resource_limit");
      let latest: RenderSnapshot;
      try { latest = await options.load(controller.signal); } catch (error) { if (error instanceof ChallengeRenderError && error.code === "not_ready") return fail("access_lost"); throw error; }
      check(); const latestProject = await projects.view(latest.projectId, controller.signal); check();
      let rechecked: ReturnType<typeof plan>;
      try { rechecked = plan(latest, latestProject); } catch (error) { if (error instanceof ChallengeRenderError && error.code === "not_ready") return fail("access_lost"); throw error; }
      if (fingerprint(latest, rechecked.all) !== initial) return fail("access_lost");
      const warnings = [...view.warnings, ...prepared.warnings, ...result.warnings];
      if (view.design.defaults.showDate) warnings.push("Date text was omitted because this challenge has no shared capture date or time zone.");
      if (view.design.look.sceneId) warnings.push("Original photo backgrounds are shown using the shared renderer's fallback; Together cutouts were not generated.");
      return { challengeId: view.id, recipeHash: view.recipeHash, blob: result.blob, mime: "image/png", extension: "png", bytes: result.blob.size, width: result.width, height: result.height, warnings };
    } finally {
      try { prepared?.release(); }
      finally { for (const canvas of new Set(canvases.values())) releaseExportCanvas(canvas); canvases.clear(); running = false; }
    }
  })();
  try { return await Promise.race([work, interrupted]); }
  catch (error) {
    if (error instanceof ChallengeRenderError) throw error;
    const code = error && typeof error === "object" && "code" in error ? error.code : "";
    if (code === "account_changed") return fail("account_changed");
    if (code === "access_denied") return fail("access_lost");
    if (code === "integrity_failed" || code === "invalid_response") return fail("integrity_failed");
    return fail("unavailable");
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
}
