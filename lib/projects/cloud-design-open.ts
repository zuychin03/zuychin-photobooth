import { cloudSha256, type CloudProjectClient } from "./cloud-client";
import { cloudUuid, type CloudProjectAsset, type CloudProjectView } from "./cloud-contract";
import { parseCloudDesignView, type CloudDesignBinding, type CloudDesignParticipant, type CloudDesignReceipt, type CloudDesignRecord } from "./cloud-design";
import { portableProject } from "./bundle";
import { inspectImageHeader } from "./images";
import { validatePhotoProject, type PhotoProject, type ProjectScope } from "./model";
import { openProjectRepository, type ProjectRepository } from "./storage";
import { registerRoomScopeCloser, roomScopeEpoch } from "../rtc/scope-lifecycle";

type OpenClient = Pick<CloudProjectClient, "ownerId" | "assertActive" | "designCapabilities" | "readDesign" | "view" | "read" | "download">;
type OpenRepository = Pick<ProjectRepository, "scope" | "save" | "delete" | "close">;
export interface CloudDesignOpenOptions {
  client: OpenClient;
  projectId: string;
  checkpoint?: "current" | "previous";
  expectedReceipt?: CloudDesignReceipt;
  signal?: AbortSignal;
  openRepository?: (scope: ProjectScope) => Promise<OpenRepository>;
  newId?: () => string;
  now?: () => string;
}
export type CloudDesignOpenResult =
  | { kind: "unsupported"; record: CloudDesignRecord & { unsupported: true } }
  | { kind: "opened"; project: PhotoProject; receipt: CloudDesignReceipt; source: { projectId: string; checkpoint: "current" | "previous"; bindings: CloudDesignBinding[]; participants: CloudDesignParticipant[]; canonicalIdentity: Pick<PhotoProject, "id" | "createdAt" | "capturedAt" | "captureTimeZone"> } };

export class CloudDesignOpenError extends Error {
  constructor(readonly code: "busy" | "missing_design" | "design_changed" | "source_unavailable" | "integrity_failed" | "cancelled" | "timeout" | "account_changed" | "cleanup_failed", readonly recovery?: { projectId: string; scope: ProjectScope }) { super(code); this.name = "CloudDesignOpenError"; }
}
let occupied = false;
const fail = (code: CloudDesignOpenError["code"]): never => { throw new CloudDesignOpenError(code); };
function receipt(record: CloudDesignReceipt): CloudDesignReceipt {
  return { version: record.version, projectId: record.projectId, requestId: record.requestId, revision: record.revision, contentHash: record.contentHash, savedAt: record.savedAt };
}
const sameReceipt = (left: CloudDesignReceipt, right: CloudDesignReceipt) => JSON.stringify(receipt(left)) === JSON.stringify(receipt(right));

export async function openCloudDesignCopy(options: CloudDesignOpenOptions): Promise<CloudDesignOpenResult> {
  if (occupied) return fail("busy");
  const { client } = options, projectId = cloudUuid(options.projectId), checkpoint = options.checkpoint ?? "current";
  if (checkpoint !== "current" && checkpoint !== "previous") throw new Error("invalid_request");
  const scope: ProjectScope = { kind: "account", ownerId: cloudUuid(client.ownerId) }, epoch = roomScopeEpoch(scope);
  client.assertActive(options.signal);
  occupied = true;
  const lifetime = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
  let timedOut = false, repository: OpenRepository | null = null, saved: PhotoProject | null = null;
  const timer = setTimeout(() => { timedOut = true; lifetime.abort(); }, 120_000);
  const active = () => {
    if (roomScopeEpoch(scope) !== epoch) fail("account_changed");
    if (timedOut) fail("timeout");
    if (signal.aborted) fail("cancelled");
    client.assertActive(signal);
  };
  const blobs = new Map<string, Blob>();
  const unregister = registerRoomScopeCloser(scope, () => { lifetime.abort(); return pending.then(() => {}, () => {}); });
  const pending = Promise.resolve().then(async (): Promise<CloudDesignOpenResult> => {
    try {
      active(); await client.designCapabilities(signal); active();
      const initial = parseCloudDesignView({ design: await client.readDesign(projectId, checkpoint, signal) }, projectId); active();
      if (!initial) return fail("missing_design");
      if (options.expectedReceipt && !sameReceipt(initial, options.expectedReceipt)) return fail("design_changed");
      if (initial.unsupported) return { kind: "unsupported", record: initial };
      const snapshot = initial.snapshot;
      function assets(view: CloudProjectView): CloudProjectAsset[] {
        if (view.project.id !== projectId || view.project.status !== "active" || !view.members.some(member => member.userId === client.ownerId && member.status === "accepted")) return fail("source_unavailable");
        return snapshot.bindings.map(binding => {
          const asset = view.assets.find(item => item.id === binding.assetId), media = snapshot.project.media.find(item => item.id === binding.mediaId)!;
          if (!asset || asset.ownerId !== binding.ownerId || asset.sha256 !== binding.sha256
            || asset.kind !== media.kind || asset.mime !== media.mime || asset.bytes !== media.bytes || asset.width !== media.width || asset.height !== media.height) return fail("source_unavailable");
          return asset;
        });
      }
      const inventory = assets(await client.view(projectId, signal)); active();
      for (let index = 0; index < inventory.length; index++) {
        active();
        const asset = inventory[index], blob = await client.download({ ...asset, projectId }, signal); active();
        if (blob.size !== asset.bytes || blob.type !== asset.mime) return fail("integrity_failed");
        const bytes = await blob.arrayBuffer(); active();
        const header = inspectImageHeader(new Uint8Array(bytes));
        if (header.mime !== asset.mime || header.width !== asset.width || header.height !== asset.height || await cloudSha256(bytes) !== asset.sha256) return fail("integrity_failed");
        active(); blobs.set(snapshot.bindings[index].mediaId, blob);
      }
      const opened = await (options.openRepository ?? openProjectRepository)(scope);
      repository = opened; active();
      if (opened.scope.kind !== "account" || opened.scope.ownerId !== client.ownerId) return fail("account_changed");
      assets(await client.view(projectId, signal)); active();
      for (const asset of inventory) { await client.read({ ...asset, projectId }, signal); active(); }
      const final = parseCloudDesignView({ design: await client.readDesign(projectId, checkpoint, signal) }, projectId); active();
      if (!final || final.unsupported || !sameReceipt(initial, final) || JSON.stringify(final.snapshot) !== JSON.stringify(snapshot)) return fail("design_changed");
      const now = (options.now ?? (() => new Date().toISOString()))();
      const project = validatePhotoProject({ ...portableProject(snapshot.project), id: (options.newId ?? (() => crypto.randomUUID()))(), scope, revision: 0, createdAt: now, updatedAt: now });
      active(); saved = await opened.save(project, blobs, null); active();
      const { id, createdAt, capturedAt, captureTimeZone } = snapshot.project;
      return { kind: "opened", project: saved, receipt: receipt(initial), source: { projectId, checkpoint, bindings: snapshot.bindings, participants: snapshot.participants, canonicalIdentity: { id, createdAt, capturedAt, captureTimeZone } } };
    } catch (error) {
      if (saved && repository) {
        try { await repository.delete(saved.id, 0); }
        catch { throw new CloudDesignOpenError("cleanup_failed", { projectId: saved.id, scope }); }
      }
      if (roomScopeEpoch(scope) !== epoch) return fail("account_changed");
      if (timedOut) return fail("timeout");
      if (signal.aborted) return fail("cancelled");
      throw error;
    } finally {
      blobs.clear(); repository?.close(); clearTimeout(timer); unregister(); occupied = false;
    }
  });
  return pending;
}
