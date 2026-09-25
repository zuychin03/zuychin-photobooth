import assert from "node:assert/strict";
import test from "node:test";
import { ChallengeRenderError, renderChallengePng, renderPartialChallengePng, type ChallengeRenderOptions, type ChallengeRenderPorts, type PartialChallengeRenderOptions } from "../lib/memories/challenge-render";
import { CloudClientError } from "../lib/projects/cloud-client";
import { prepareChallengeCreate, type ChallengeView, type PartialDetail } from "../lib/memories/challenge-contract";
import type { CloudProjectView } from "../lib/projects/cloud-contract";
import { validateTemplateDesign } from "../lib/templates/model";
import { templateFixture, templatePixel } from "./helpers/template-fixture";
import type { ComposeInput } from "../lib/compose";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor = id(1), guest = id(2), challengeId = id(3), projectId = id(4);
function fixture() {
  const base = templateFixture(), blob = templatePixel();
  const design = validateTemplateDesign({ canvas: base.canvas, requiredSources: { A: 3, B: 4 }, slots: [{ ...base.slots[0], sourceIndex: 2, splitFallback: true, companions: [{ role: "B", sourceIndex: 3, crop: { zoom: 2, offsetX: .1, offsetY: -.1, rotation: 90, mirror: true } }] }, { ...base.slots[0], id: "repeat", sourceIndex: 2 }], layers: base.layers, decorations: [], look: base.look, defaults: base.defaults });
  const prepared = prepareChallengeCreate({ id: challengeId, design, policy: "all_submitted", expiresAt: "2030-01-01T00:00:00Z", members: [{ userId: actor, role: "A" }, { userId: guest, role: "B" }] });
  let view: ChallengeView = { id: challengeId, projectId, status: "revealed", policy: prepared.policy, recipeHash: "a".repeat(64), design, expiresAt: prepared.expiresAt, revealedAt: "2029-01-01T00:00:00Z", revealHash: "b".repeat(64), accessLost: false, members: prepared.members.map(member => ({ ...member, status: "accepted", submitted: true })), assignments: prepared.assignments, visibleSources: [{ userId: actor, sourceIndex: 2, assetId: id(5) }, { userId: guest, sourceIndex: 3, assetId: id(6) }] };
  let project: CloudProjectView = { project: { id: projectId, ownerId: actor, kind: "friend", title: "Fixture", maxBytes: 67108864, status: "active", createdAt: "2029-01-01T00:00:00Z" }, members: [{ userId: actor, status: "accepted" }, { userId: guest, status: "accepted" }], assets: [actor, guest].map((ownerId, index) => ({ id: id(index + 5), ownerId, kind: "photo", mime: "image/png", bytes: blob.size, width: 1, height: 1, sha256: "c".repeat(64) })) };
  const calls: string[] = [], canvases: HTMLCanvasElement[] = [], inputs: ComposeInput[] = []; let changed = false, released = 0;
  const assertActive = (signal?: AbortSignal) => { if (changed) throw new CloudClientError("account_changed"); if (signal?.aborted) throw new CloudClientError("cancelled"); };
  const options: ChallengeRenderOptions = { challengeId, challenges: { ownerId: actor, assertActive, view: async () => { calls.push("challenge"); return structuredClone(view); } }, projects: { ownerId: actor, assertActive, view: async () => { calls.push("project"); return structuredClone(project); }, download: async asset => { calls.push(`download:${asset.id}`); return blob; } } };
  const ports: ChallengeRenderPorts = {
    decode: async (_blob, expected) => { calls.push("decode"); const canvas = { width: expected.width, height: expected.height } as HTMLCanvasElement; canvases.push(canvas); return canvas; },
    prepare: async () => ({ resources: new Map(), warnings: [], release: () => { released++; } }),
    render: async input => { calls.push("render"); inputs.push(input); return { blob, width: 1072, height: 3200, warnings: [] }; },
  };
  return { options, ports, calls, canvases, inputs, blob, view: () => view, project: () => project, setView: (next: ChallengeView) => { view = next; }, setProject: (next: CloudProjectView) => { project = next; }, change: () => { changed = true; }, released: () => released };
}
const code = (value: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === value;
test("PNG assembly preserves sparse source positions, repeated cells and companion crop without duplicate downloads", async () => {
  const f = fixture(), original = structuredClone(f.view().design);
  const result = await renderChallengePng(f.options, f.ports);
  assert.equal(result.mime, "image/png"); assert.equal(result.bytes, f.blob.size); assert.equal(result.recipeHash, f.view().recipeHash);
  assert.deepEqual(f.calls, ["challenge", "project", `download:${id(5)}`, "decode", `download:${id(6)}`, "decode", "render", "challenge", "project"]);
  const input = f.inputs[0]; assert.deepEqual(input.template, original); assert.equal(input.shots.A?.[2], f.canvases[0]); assert.equal(input.shots.B?.[3], f.canvases[1]); assert.equal(input.shots.A?.[0], null); assert.equal(input.shots.B?.[2], null);
  assert.equal(input.style.showDate, false); assert(result.warnings.some(warning => warning.includes("no shared capture date")));
  assert(f.canvases.every(canvas => canvas.width === 0 && canvas.height === 0)); assert.equal(f.released(), 1);
});
test("concealed, incomplete, withdrawn and unsupported companion inputs trigger no original fetch", async () => {
  for (const reason of ["concealed", "missing", "withdrawn", "companions"] as const) {
    const f = fixture(), v = f.view();
    if (reason === "concealed") f.setView({ ...v, status: "open" });
    if (reason === "missing") f.setView({ ...v, visibleSources: v.visibleSources.slice(0, 1) });
    if (reason === "withdrawn") f.setView({ ...v, accessLost: true });
    if (reason === "companions") f.setView({ ...v, design: { ...v.design, slots: v.design.slots.map(slot => slot.companions ? { ...slot, splitFallback: false } : slot) } });
    await assert.rejects(renderChallengePng(f.options, f.ports), code(reason === "withdrawn" ? "access_lost" : reason === "companions" ? "unsupported" : "not_ready"));
    assert(!f.calls.some(call => call.startsWith("download"))); assert(!f.calls.includes("render"));
  }
});
test("scene export uses original-photo fallback without segmentation and states the limitation", async () => {
  const f = fixture(); f.setView({ ...f.view(), design: { ...f.view().design, look: { ...f.view().design.look, sceneId: "studio-cream" } } });
  const result = await renderChallengePng(f.options, f.ports); assert.equal(f.inputs[0].together, null); assert(result.warnings.some(warning => warning.includes("cutouts were not generated")));
});
test("decorations require matching authorised metadata and are downloaded only once into decoration mapping", async () => {
  const f = fixture(), decoration = { id: id(7), kind: "decoration" as const, mime: "image/png" as const, bytes: f.blob.size, width: 1, height: 1 };
  f.setView({ ...f.view(), design: { ...f.view().design, decorations: [decoration], layers: [...f.view().design.layers, { id: "decoration", kind: "decoration", mediaId: decoration.id, fit: "contain", x: 0, y: 0, width: .1, height: .1, rotation: 0 }] } });
  await assert.rejects(renderChallengePng(f.options, f.ports), code("access_lost")); assert(!f.calls.some(call => call.startsWith("download")));
  f.setProject({ ...f.project(), assets: [...f.project().assets, { ...decoration, ownerId: actor, sha256: "d".repeat(64) }] });
  await renderChallengePng(f.options, f.ports); assert.equal(f.inputs[0].decorations?.get(id(7)), f.canvases[2]); assert.equal(f.canvases.length, 3);
});
test("source integrity and decode failure cannot export and release all earlier canvases", async () => {
  const f = fixture(); let downloads = 0;
  f.options.projects.download = async () => { if (++downloads === 2) throw new CloudClientError("integrity_failed"); return f.blob; };
  await assert.rejects(renderChallengePng(f.options, f.ports), code("integrity_failed")); assert.equal(f.canvases[0].width, 0); assert(!f.calls.includes("render"));
});
test("post-render withdrawal or changed original assertions suppress the finished PNG", async () => {
  for (const change of ["access", "hash"] as const) {
    const f = fixture(), render = f.ports.render;
    f.ports.render = async (...args) => { const result = await render(...args); if (change === "access") f.setView({ ...f.view(), accessLost: true }); else f.setProject({ ...f.project(), assets: f.project().assets.map(asset => ({ ...asset, sha256: "e".repeat(64) })) }); return result; };
    await assert.rejects(renderChallengePng(f.options, f.ports), code("access_lost")); assert.equal(f.inputs.length, 1); assert(f.canvases.every(canvas => canvas.width === 0)); assert.equal(f.released(), 1);
  }
});
test("resource preflight rejects oversized sources before download or native decode", async () => {
  const f = fixture(); f.setProject({ ...f.project(), assets: f.project().assets.map(asset => ({ ...asset, width: 4096, height: 4096 })) });
  await assert.rejects(renderChallengePng(f.options, f.ports), code("resource_limit")); assert(!f.calls.some(call => call.startsWith("download")));
});
test("account changes after decode discard the result and release its newly allocated canvas", async () => {
  const f = fixture(), decode = f.ports.decode;
  f.ports.decode = async (...args) => { const canvas = await decode(...args); f.change(); return canvas; };
  await assert.rejects(renderChallengePng(f.options, f.ports), code("account_changed")); assert.equal(f.canvases.length, 1); assert.equal(f.canvases[0].width, 0); assert(!f.calls.includes("render"));
});
test("an already-stale account fails through the public error contract without accessing cloud data", async () => {
  const f = fixture(); f.change();
  await assert.rejects(renderChallengePng(f.options, f.ports), error => error instanceof ChallengeRenderError && error.code === "account_changed");
  assert.deepEqual(f.calls, []);
});
test("cancelled native decode holds the single-job slot until its late canvas is released", async () => {
  const f = fixture(), abort = new AbortController(); let finish: (canvas: HTMLCanvasElement) => void = () => {}; let started: () => void = () => {};
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.ports.decode = async () => { started(); return new Promise(resolve => { finish = resolve; }); };
  const task = renderChallengePng({ ...f.options, signal: abort.signal }, f.ports); await entered; abort.abort();
  await assert.rejects(task, code("cancelled")); await assert.rejects(renderChallengePng(f.options, f.ports), code("busy"));
  const late = { width: 1, height: 1 } as HTMLCanvasElement; finish(late); await new Promise(resolve => setImmediate(resolve)); assert.equal(late.width, 0);
  const retry = fixture(); await renderChallengePng(retry.options, retry.ports);
});
test("encoding timeout returns promptly but retains accounting until its callback settles", async () => {
  const f = fixture(); let finish: () => void = () => {};
  f.ports.render = async () => new Promise(resolve => { finish = () => resolve({ blob: f.blob, width: 100, height: 100, warnings: [] }); });
  await assert.rejects(renderChallengePng({ ...f.options, timeoutMs: 25 }, f.ports), code("timeout"));
  await assert.rejects(renderChallengePng(f.options, f.ports), code("busy")); finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.released(), 1); assert(f.canvases.every(canvas => canvas.width === 0));
});

function partialFixture() {
  const f = fixture(), partialId = id(8), digest = "8".repeat(64);
  const design = validateTemplateDesign({ ...f.view().design, requiredSources: { A: 3 }, defaults: { caption: "", showDate: false }, slots: f.view().design.slots.map(slot => ({ id: slot.id, role: slot.role, sourceIndex: slot.sourceIndex, x: slot.x, y: slot.y, width: slot.width, height: slot.height, crop: slot.crop })) });
  let detail: PartialDetail = { version: 1, id: partialId, challengeId, projectId, digest, status: "revealed", createdAt: "2029-01-01T00:00:00Z", revealedAt: "2029-01-02T00:00:00Z", accessLost: false, actorIncluded: true, actorConsent: true, contributors: [{ userId: actor, role: "A", consent: true, status: "available" }], result: { projectionVersion: 1, recipeHash: f.view().recipeHash, design, sources: [{ userId: actor, role: "A", sourceIndex: 2, assetId: id(5) }] } };
  const options: PartialChallengeRenderOptions = { partialId, digest, projects: f.options.projects, challenges: { ownerId: actor, assertActive: f.options.challenges.assertActive, partialDetail: async (requested, exactDigest) => { assert.equal(requested, partialId); assert.equal(exactDigest, digest); f.calls.push("partial"); return structuredClone(detail); } } };
  return { ...f, options, detail: () => detail, setDetail: (value: PartialDetail) => { detail = value; } };
}
test("partial export requires only its included contributors and never fetches the full challenge or excluded photos", async () => {
  const f = partialFixture(); f.setProject({ ...f.project(), members: f.project().members.map(member => member.userId === guest ? { ...member, status: "revoked" } : member) });
  const result = await renderPartialChallengePng(f.options, f.ports);
  assert.equal(result.partialId, f.options.partialId); assert.equal(result.digest, f.options.digest); assert.equal(result.challengeId, challengeId);
  assert.deepEqual(f.calls, ["partial", "project", `download:${id(5)}`, "decode", "render", "partial", "project"]);
  assert.equal(f.inputs[0].shots.A?.[2], f.canvases[0]); assert.equal(f.inputs[0].shots.B, undefined); assert.equal(f.inputs[0].style.caption, "");
  assert(result.warnings.some(warning => warning.includes("partial result") && warning.includes("remain blank"))); assert.equal(f.canvases[0].width, 0);
});
test("pending, rejected, excluded, lost-access and unconsented partials download nothing", async () => {
  for (const state of ["pending", "rejected", "excluded", "lost", "unconsented"] as const) {
    const f = partialFixture(), detail = f.detail(); assert(!("unsupported" in detail));
    if (state === "pending" || state === "rejected") f.setDetail({ ...detail, status: state, revealedAt: null, result: null });
    if (state === "excluded") f.setDetail({ ...detail, actorIncluded: false, actorConsent: null, contributors: [{ userId: guest, role: "B", consent: true, status: "available" }], result: null });
    if (state === "lost") f.setDetail({ ...detail, accessLost: true, contributors: detail.contributors.map(c => ({ ...c, status: "access_lost" })), result: null });
    if (state === "unconsented") f.setDetail({ ...detail, actorConsent: null, contributors: detail.contributors.map(c => ({ ...c, consent: null })), result: null });
    await assert.rejects(renderPartialChallengePng(f.options, f.ports), code(state === "excluded" || state === "lost" ? "access_lost" : "not_ready"));
    assert.deepEqual(f.calls, ["partial"]);
  }
});
test("partial exact-digest and source ownership checks fail before download", async () => {
  for (const state of ["digest", "owner", "source"] as const) {
    const f = partialFixture(), detail = f.detail(); assert(!("unsupported" in detail) && detail.result);
    if (state === "digest") f.setDetail({ ...detail, digest: "9".repeat(64) });
    if (state === "owner") f.setProject({ ...f.project(), assets: f.project().assets.map(asset => asset.id === id(5) ? { ...asset, ownerId: guest } : asset) });
    if (state === "source") f.setDetail({ ...detail, result: { ...detail.result, sources: [{ ...detail.result.sources[0], sourceIndex: 1 }] } });
    await assert.rejects(renderPartialChallengePng(f.options, f.ports), code(state === "owner" ? "access_lost" : "integrity_failed"));
    assert(!f.calls.some(call => call.startsWith("download")));
  }
});
test("partial post-encode consent loss, recipe changes and project hash changes suppress output", async () => {
  for (const state of ["consent", "recipe", "hash"] as const) {
    const f = partialFixture(), render = f.ports.render;
    f.ports.render = async (...args) => {
      const result = await render(...args), detail = f.detail(); assert(!("unsupported" in detail) && detail.result);
      if (state === "consent") f.setDetail({ ...detail, actorConsent: false, contributors: detail.contributors.map(c => ({ ...c, consent: false })), result: null });
      if (state === "recipe") f.setDetail({ ...detail, result: { ...detail.result, design: { ...detail.result.design, look: { ...detail.result.design.look, filterId: "bw" } } } });
      if (state === "hash") f.setProject({ ...f.project(), assets: f.project().assets.map(asset => ({ ...asset, sha256: "e".repeat(64) })) });
      return result;
    };
    await assert.rejects(renderPartialChallengePng(f.options, f.ports), code("access_lost")); assert.equal(f.inputs.length, 1); assert.equal(f.released(), 1); assert.equal(f.canvases[0].width, 0);
  }
});
test("partial and full exports share the same late-work resource slot", async () => {
  const f = partialFixture(), abort = new AbortController(); let finish: (canvas: HTMLCanvasElement) => void = () => {}, started: () => void = () => {};
  const entered = new Promise<void>(resolve => { started = resolve; }); f.ports.decode = async () => { started(); return new Promise(resolve => { finish = resolve; }); };
  const task = renderPartialChallengePng({ ...f.options, signal: abort.signal }, f.ports); await entered; abort.abort(); await assert.rejects(task, code("cancelled"));
  const full = fixture(); await assert.rejects(renderChallengePng(full.options, full.ports), code("busy"));
  const late = { width: 1, height: 1 } as HTMLCanvasElement; finish(late); await new Promise(resolve => setImmediate(resolve)); assert.equal(late.width, 0);
  await renderChallengePng(full.options, full.ports);
});
