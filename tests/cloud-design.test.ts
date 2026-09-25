import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createProject, appendProjectMedia, applyProjectEdit } from "../lib/projects/model";
import { CLOUD_DESIGN_LIMITS, validateCloudDesign, parseCloudDesignRecord, type CloudDesignSnapshot } from "../lib/projects/cloud-design";
import { createProjectDesignStore } from "../lib/server/project-design-store";
import { createProjectDesignHandler } from "../lib/server/project-design-requests";
import { createProjectStore, ProjectServerError } from "../lib/server/project-store";
import { createCloudProjectClient } from "../lib/projects/cloud-client";
import { validateCloudAsset } from "../lib/projects/cloud-contract";

const owner = randomUUID(), projectId = randomUUID(), requestId = randomUUID(), assetId = randomUUID();
const env = { PB_CLOUD_PROJECTS_ENABLED: "true", NEXT_PUBLIC_SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "nonsecret-fixture", PB_PUBLIC_ORIGIN: "https://app.example.invalid" };
const cap = { version: 1, ready: true, members: 4, files: 24, projectBytes: 67108864, readSeconds: 300, uploadSeconds: 7200, finalisationVersion: 1, apiVersion: 1 };
const designCap = { exportSettingsVersion: 1, designVersion: 1, retirementVersion: 1, snapshotBytes: 81920, bindings: 24, checkpoints: 2, receipts: 100, referenceAssets: true };
function fixture(): CloudDesignSnapshot {
  const draft = createProject({ participants: [{ id: "person", role: "A" }], captureTimeZone: "Australia/Sydney" });
  const project = appendProjectMedia(draft, [{ id: "original", kind: "photo", mime: "image/png", bytes: 100, width: 20, height: 20, participantId: "person" }], { A: ["original"], B: [], C: [], D: [] }, "2026-01-01T00:00:00.000Z");
  return { version: 1, project, bindings: [{ mediaId: "original", assetId, ownerId: owner, sha256: "a".repeat(64) }], participants: [{ participantId: "person", ownerId: owner }] };
}
const receipt = { version: 1 as const, projectId, requestId, revision: 0, contentHash: "a".repeat(64), savedAt: "2026-01-01T00:00:00.000Z" };
test("snapshot preserves original/history identity and excludes device settings", () => {
  const s = fixture(), edited = applyProjectEdit(s.project, { editor: { ...s.project.editor, caption: "Private caption" }, sourceOrder: s.project.sourceOrder });
  const result = validateCloudDesign({ ...s, project: edited });
  assert.equal(result.project.history.past.length, s.project.history.past.length + 1); assert.equal(result.project.editor.caption, "Private caption");
  assert.throws(() => validateCloudDesign({ ...s, project: { ...s.project, capture: { ...s.project.capture, cameraId: "device-secret" } } }));
  assert.throws(() => validateCloudDesign({ ...s, project: { ...s.project, scope: { kind: "account", ownerId: owner } } }));
});
test("all inventory including retired originals requires unique exact bindings", () => {
  const s = fixture(), project = appendProjectMedia(s.project, [{ ...s.project.media[0], id: "retake" }], { A: ["retake"], B: [], C: [], D: [] }, s.project.capturedAt!);
  assert.throws(() => validateCloudDesign({ ...s, project }));
  assert.throws(() => validateCloudDesign({ ...s, bindings: [{ ...s.bindings[0], ownerId: randomUUID() }] }));
  assert.throws(() => validateCloudDesign({ ...s, bindings: [{ ...s.bindings[0], url: "https://foreign.invalid" }] }));
  assert.throws(() => validateCloudDesign({ ...s, project: { ...s.project, sourceOrder: { ...s.project.sourceOrder, A: ["missing"] } } }));
});
test("reference is an explicit unprotected original kind", () => {
  const input = { id: assetId, requestId, kind: "reference", mime: "image/png", bytes: 100, width: 20, height: 20, sha256: "a".repeat(64), protection: { kind: "none", id: null } };
  assert.equal(validateCloudAsset(input).kind, "reference");
  assert.throws(() => validateCloudAsset({ ...input, protection: { kind: "challenge", id: randomUUID() } }));
});
test("future schema stays exportable read-only and is never accepted for save", () => {
  const snapshot = { ...fixture(), project: { ...fixture().project, schemaVersion: 99 } };
  const result = parseCloudDesignRecord({ record: { snapshot, receipt } }, projectId);
  assert.equal(result?.unsupported, true); if (result?.unsupported) assert.equal(JSON.parse(result.rawSnapshot).project.schemaVersion, 99);
  assert.throws(() => validateCloudDesign(snapshot));
});
test("old database keeps original methods but fails design and reference writes closed", async () => {
  const calls: string[] = [], ports = { authenticate: async () => owner, rpc: async (name: string) => { calls.push(name); return name === "pb_project_capabilities" ? { data: cap, error: null } : { data: null, error: { message: "missing function" } }; } };
  await createProjectStore("token", env, ports);
  await assert.rejects(createProjectDesignStore("token", env, ports), /unavailable/);
  const base = await createProjectStore("token", env, ports);
  await assert.rejects(base.reserve(projectId, { id: assetId, requestId, kind: "reference", mime: "image/png", bytes: 100, width: 20, height: 20, sha256: "a".repeat(64), protection: { kind: "none", id: null } }), /unavailable/);
  assert.equal(calls.includes("pb_project_reserve"), false);
});
test("store binds authenticated actor, portable snapshot and expected cloud revision", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const store = await createProjectDesignStore("token", env, { authenticate: async () => owner, rpc: async (name, args) => {
    calls.push({ name, args }); return { data: name === "pb_project_capabilities" ? cap : name === "pb_project_design_capabilities" ? designCap : receipt, error: null };
  } });
  assert.deepEqual(await store.save(projectId, null, requestId, fixture()), receipt);
  assert.equal(calls.at(-1)?.args.p_actor, owner); assert.equal(calls.at(-1)?.args.p_expected, null);
  await assert.rejects(store.save(projectId, 3, requestId, fixture()), /unavailable/);
});

test("schema 4 saves require migration 028 while frozen schema 3 retries remain accepted", async () => {
  const calls: string[] = [];
  const { exportSettingsVersion, ...oldCap } = designCap; void exportSettingsVersion;
  const store = await createProjectDesignStore("token", env, { authenticate: async () => owner, rpc: async name => {
    calls.push(name); return { data: name === "pb_project_capabilities" ? cap : name === "pb_project_design_capabilities" ? oldCap : receipt, error: null };
  } });
  await assert.rejects(store.save(projectId, null, requestId, fixture()), /unavailable/);
  assert.equal(calls.includes("pb_project_design_save"), false);
  const snapshot = fixture();
  assert.deepEqual(await store.save(projectId, null, requestId, { ...snapshot, project: { ...snapshot.project, schemaVersion: 3 } }), receipt);
});
test("store denies malformed projections and propagates source access loss", async () => {
  const store = await createProjectDesignStore("token", env, { authenticate: async () => owner, rpc: async name => ({ data: name === "pb_project_capabilities" ? cap : name === "pb_project_design_capabilities" ? designCap : null, error: name === "pb_project_design_read" ? { message: "PB_PROJECT_DENIED" } : null }) });
  await assert.rejects(store.read(projectId), (error: unknown) => error instanceof ProjectServerError && error.status === 403);
  await assert.rejects(store.status(projectId, requestId), /unavailable/);
});
const request = (value: unknown, origin = env.PB_PUBLIC_ORIGIN) => new Request(`${env.PB_PUBLIC_ORIGIN}/api/projects/design`, { method: "POST", headers: { Origin: origin, Authorization: "Bearer fixture", "Content-Type": "application/json" }, body: JSON.stringify(value) });
test("HTTP disabled/forged origin/shape denial has zero store effects", async () => {
  let calls = 0; const create = async () => { calls++; throw new Error(); };
  assert.equal((await createProjectDesignHandler(create, () => ({}))(request({ operation: "capabilities" }))).status, 503);
  const handler = createProjectDesignHandler(create, () => env);
  assert.equal((await handler(request({ operation: "capabilities" }, "https://foreign.invalid"))).status, 403);
  assert.equal((await handler(request({ operation: "save", projectId, requestId, expectedRevision: null, snapshot: fixture(), actor: owner }))).status, 400);
  assert.equal(calls, 0);
});
test("HTTP rate gate precedes writes and retains private response headers", async () => {
  let writes = 0;
  const handler = createProjectDesignHandler(async () => ({ capabilities: () => ({ designVersion: 1, retirementVersion: 1, limits: CLOUD_DESIGN_LIMITS, referenceAssets: true }), rate: async () => { throw new ProjectServerError("rate_limited", 429, 17); }, save: async () => { writes++; return receipt; }, read: async () => null, head: async () => null, status: async () => null }), () => env);
  const result = await handler(request({ operation: "save", projectId, requestId, expectedRevision: null, snapshot: fixture() }));
  assert.equal(result.status, 429); assert.equal(result.headers.get("Retry-After"), "17"); assert.match(result.headers.get("Cache-Control")!, /no-store/); assert.equal(writes, 0);
});
test("HTTP caps bytes and adversarial tiny chunks before authentication work", async () => {
  let calls = 0;
  const handler = createProjectDesignHandler(async () => { calls++; throw new Error(); }, () => env);
  const large = await handler(request({ operation: "save", data: "x".repeat(CLOUD_DESIGN_LIMITS.requestBytes) })); assert.equal(large.status, 413);
  const stream = new ReadableStream({ start(controller) { for (let i = 0; i < 4097; i++) controller.enqueue(new Uint8Array([32])); controller.close(); } });
  const req = new Request(`${env.PB_PUBLIC_ORIGIN}/api/projects/design`, { method: "POST", headers: { Origin: env.PB_PUBLIC_ORIGIN, Authorization: "Bearer fixture", "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
  assert.equal((await handler(req)).status, 413); assert.equal(calls, 0);
});
test("browser design methods use isolated endpoint and reject stale account replies", async () => {
  let epoch = 1; const urls: string[] = [];
  const client = createCloudProjectClient({ appOrigin: env.PB_PUBLIC_ORIGIN, storageOrigin: env.NEXT_PUBLIC_SUPABASE_URL, identity: () => ({ ownerId: owner, epoch }), accessToken: async () => "fixture", fetch: async (url) => { urls.push(String(url)); epoch++; return Response.json(receipt); } });
  await assert.rejects(client.saveDesign(projectId, null, requestId, fixture()), /account_changed/);
  assert.deepEqual(urls, [`${env.PB_PUBLIC_ORIGIN}/api/projects/design`]);
});
test("browser checks exact save identity and reads only validated complete snapshots", async () => {
  let output: unknown = { ...receipt, projectId: randomUUID() };
  const client = createCloudProjectClient({ appOrigin: env.PB_PUBLIC_ORIGIN, storageOrigin: env.NEXT_PUBLIC_SUPABASE_URL, identity: () => ({ ownerId: owner, epoch: 1 }), accessToken: async () => "fixture", fetch: async () => Response.json(output) });
  await assert.rejects(client.saveDesign(projectId, null, requestId, fixture()), /invalid_response/);
  output = { design: { ...receipt, unsupported: false, snapshot: fixture() } }; assert.equal((await client.readDesign(projectId))?.revision, 0);
  output = { design: { ...receipt, unsupported: false, snapshot: { ...fixture(), bindings: [] } } }; await assert.rejects(client.readDesign(projectId));
});

test("retirement repair still requires removing every obsolete current and history reference", () => {
  const original = fixture(), p = original.project;
  const repaired = { ...original, project: { ...p, media: [], sourceOrder: { A: [], B: [], C: [], D: [] }, history: { past: [], future: [] } }, bindings: [] };
  assert.equal(validateCloudDesign(repaired).bindings.length, 0);
  assert.throws(() => validateCloudDesign({ ...repaired, project: { ...repaired.project, history: { past: [{ sourceOrder: p.sourceOrder, editor: p.editor }], future: [] } } }));
  assert.throws(() => validateCloudDesign({ ...repaired, project: { ...repaired.project, sourceOrder: p.sourceOrder } }));
});

test("pre-retirement schema cannot masquerade as a repair-capable store", async () => {
  const { retirementVersion: ignored, ...old } = designCap; void ignored;
  await assert.rejects(createProjectDesignStore("token", env, { authenticate: async () => owner, rpc: async name => ({ data: name === "pb_project_capabilities" ? cap : old, error: null }) }), /unavailable/);
});

test("real client and HTTP head expose only the exact owner-bound receipt and rate once", async () => {
  let charges = 0, reads = 0;
  const handler = createProjectDesignHandler(async () => ({ capabilities: () => ({ designVersion: 1, retirementVersion: 1, limits: CLOUD_DESIGN_LIMITS, referenceAssets: true }), rate: async operation => { assert.equal(operation, "read"); charges++; }, head: async id => { assert.equal(id, projectId); reads++; return receipt; }, read: async () => { throw new Error("Old snapshot must not be read"); }, save: async () => receipt, status: async () => null }), () => env);
  const client = createCloudProjectClient({ appOrigin: env.PB_PUBLIC_ORIGIN, storageOrigin: env.NEXT_PUBLIC_SUPABASE_URL, identity: () => ({ ownerId: owner, epoch: 1 }), accessToken: async () => "fixture", fetch: async (url, init) => handler(new Request(String(url), { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), Origin: env.PB_PUBLIC_ORIGIN } })) });
  assert.deepEqual(await client.designHead(projectId), receipt); assert.equal(charges, 1); assert.equal(reads, 1);
  assert.equal((await handler(request({ operation: "head", projectId, actor: owner }))).status, 400);
});

test("head rejects forged content extras and foreign receipt identities", async () => {
  let output: unknown = { receipt: { ...receipt, projectId: randomUUID() } };
  const client = createCloudProjectClient({ appOrigin: env.PB_PUBLIC_ORIGIN, storageOrigin: env.NEXT_PUBLIC_SUPABASE_URL, identity: () => ({ ownerId: owner, epoch: 1 }), accessToken: async () => "fixture", fetch: async () => Response.json(output) });
  await assert.rejects(client.designHead(projectId), /invalid_response/);
  output = { receipt, snapshot: fixture() }; await assert.rejects(client.designHead(projectId), /invalid_response/);
  output = { receipt: null }; assert.equal(await client.designHead(projectId), null);
});
