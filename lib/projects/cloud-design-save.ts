import { CloudClientError, cloudSha256, type CloudProjectClient } from "./cloud-client";
import { cloudUuid, validateCloudAsset, type CloudProjectAsset } from "./cloud-contract";
import { validatePhotoProject, type PhotoProject } from "./model";
import { portableProject } from "./bundle";
import { inspectProjectImage, type ProjectImageInfo } from "./images";
import { designRevision, parseCloudDesignReceipt, validateCloudDesign, type CloudDesignBinding, type CloudDesignParticipant, type CloudDesignReceipt } from "./cloud-design";
import { CloudDesignSaveError, validateDesignSaveRecord, type CloudDesignJournal, type CloudDesignSaveRecord } from "./cloud-design-journal";
import type { CloudUploadJournal } from "./cloud-upload-journal";
import type { CloudUploadManager } from "./cloud-upload";
import type { CloudDesignOpenResult } from "./cloud-design-open";

type SaveClient = Pick<CloudProjectClient, "ownerId" | "assertActive" | "designCapabilities" | "view" | "read" | "saveDesign" | "designSaveStatus">;
export interface CloudDesignSaveInput {
  projectId: string; project: PhotoProject; expectedRevision: number | null;
  participants: CloudDesignParticipant[]; bindings?: CloudDesignBinding[];
  canonicalIdentity?: Pick<PhotoProject, "id" | "createdAt" | "capturedAt" | "captureTimeZone">;
}
export interface CloudDesignSaveOptions {
  client: SaveClient; uploads: Pick<CloudUploadManager, "run">; uploadJournal: CloudUploadJournal; journal: CloudDesignJournal;
  loadBlob(localProjectId: string, mediaId: string, signal: AbortSignal): Promise<Blob | null>;
  inspect?: (blob: Blob) => Promise<ProjectImageInfo>; now?: () => string; newId?: () => string;
}
export type CloudDesignSaveResult = { kind: "complete"; record: CloudDesignSaveRecord; receipt: CloudDesignReceipt } | { kind: "pending"; record: CloudDesignSaveRecord; assetId: string };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code: ConstructorParameters<typeof CloudDesignSaveError>[0]): never => { throw new CloudDesignSaveError(code); };
export function createCloudDesignSaveCoordinator(options: CloudDesignSaveOptions) {
  const { client, journal, uploads, uploadJournal } = options, now = options.now ?? (() => new Date().toISOString()), newId = options.newId ?? (() => crypto.randomUUID());
  const lifetime = new AbortController(); let running = false;
  if (journal.ownerId !== client.ownerId || uploadJournal.ownerId !== client.ownerId) throw new CloudClientError("account_changed");
  function active(signal?: AbortSignal) { client.assertActive(signal); if (lifetime.signal.aborted || signal?.aborted) throw new CloudClientError("cancelled"); }
  async function checked<T>(work: Promise<T>, signal: AbortSignal): Promise<T> { const result = await work; active(signal); return result; }
  async function exclusive<T>(external: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    active(external); if (running) return fail("busy"); running = true;
    const signal = AbortSignal.any([lifetime.signal, ...(external ? [external] : [])]);
    try { return await work(signal); } finally { running = false; }
  }
  async function update(record: CloudDesignSaveRecord, changes: Partial<CloudDesignSaveRecord>, signal: AbortSignal) {
    active(signal); return checked(journal.put(validateDesignSaveRecord({ ...record, ...changes, revision: record.revision + 1, updatedAt: now() }), record.revision), signal);
  }
  async function describe(record: CloudDesignSaveRecord, media: PhotoProject["media"][number], signal: AbortSignal) {
    const blob = await checked(options.loadBlob(record.localProjectId, media.id, signal), signal);
    if (!blob || blob.size !== media.bytes) return fail("file_mismatch");
    const info = await checked((options.inspect ?? inspectProjectImage)(blob), signal);
    if (info.mime !== media.mime || info.width !== media.width || info.height !== media.height) return fail("file_mismatch");
    const bytes = await checked(blob.arrayBuffer(), signal), sha256 = await checked(cloudSha256(bytes), signal);
    return { blob, sha256 };
  }
  async function finishPreparation(record: CloudDesignSaveRecord, signal: AbortSignal) {
    const bindings = [...record.bindings], plans = [...record.uploads];
    for (const media of record.project.media) {
      const { sha256 } = await describe(record, media, signal), existing = bindings.find(b => b.mediaId === media.id), planIndex = plans.findIndex(p => p.mediaId === media.id);
      if (existing && existing.sha256 !== sha256) return fail("file_mismatch");
      if (planIndex < 0) continue;
      const plan = plans[planIndex], asset = validateCloudAsset({ id: plan.assetId, requestId: plan.requestId, kind: media.kind, mime: media.mime, bytes: media.bytes, width: media.width, height: media.height, sha256, protection: { kind: "none", id: null } });
      const upload = { id: asset.id, ownerId: client.ownerId, projectId: record.cloudProjectId, asset, state: "prepared" as const, createdAt: record.createdAt, updatedAt: record.createdAt, reservedUntil: null };
      if (plan.record && !same(plan.record, upload)) return fail("file_mismatch");
      const priorUpload = await checked(uploadJournal.get(asset.id), signal);
      if (priorUpload && (!same(priorUpload.asset, asset) || priorUpload.projectId !== record.cloudProjectId || priorUpload.ownerId !== client.ownerId || priorUpload.createdAt !== record.createdAt)) return fail("file_mismatch");
      if (!priorUpload) await checked(uploadJournal.put(upload), signal);
      plans[planIndex] = { ...plan, record: upload };
      if (!existing) bindings.push({ mediaId: media.id, assetId: asset.id, ownerId: client.ownerId, sha256 });
    }
    return update(record, { phase: "prepared", bindings, uploads: plans }, signal);
  }
  async function requireAssets(record: CloudDesignSaveRecord, signal: AbortSignal, complete: boolean) {
    const view = await checked(client.view(record.cloudProjectId, signal), signal);
    if (view.project.ownerId !== client.ownerId || view.project.status !== "active" || !view.members.some(member => member.userId === client.ownerId && member.status === "accepted") || record.participants.some(person => !view.members.some(member => member.userId === person.ownerId && member.status === "accepted"))) return fail("access_changed");
    for (const binding of record.bindings) {
      const media = record.project.media.find(m => m.id === binding.mediaId)!, asset = view.assets.find(a => a.id === binding.assetId);
      if (!asset && !complete && record.uploads.some(plan => plan.assetId === binding.assetId)) continue;
      if (!asset || asset.ownerId !== binding.ownerId || asset.sha256 !== binding.sha256 || (["kind", "mime", "bytes", "width", "height"] as const).some(key => asset[key] !== media[key])) return fail("access_changed");
      await checked(client.read({ id: asset.id, ownerId: asset.ownerId, projectId: record.cloudProjectId }, signal), signal);
    }
    return view.assets;
  }
  async function complete(record: CloudDesignSaveRecord, receipt: CloudDesignReceipt, signal: AbortSignal): Promise<CloudDesignSaveResult> {
    const verified = parseCloudDesignReceipt(receipt, record.cloudProjectId, record.requestId);
    if (verified.revision !== (record.expectedRevision === null ? 0 : record.expectedRevision + 1)) return fail("conflict");
    const saved = await update(record, { phase: "complete", receipt: verified }, signal);
    return { kind: "complete", record: saved, receipt: verified };
  }
  return {
    ownerId: client.ownerId,
    async list() { active(); return checked(journal.list(), lifetime.signal); },
    prepare(input: CloudDesignSaveInput, external?: AbortSignal) { return exclusive(external, async signal => {
      const local = validatePhotoProject(input.project), projectId = cloudUuid(input.projectId), expected = designRevision(input.expectedRevision);
      if (local.scope.kind !== "account" || local.scope.ownerId !== client.ownerId) throw new CloudClientError("account_changed");
      const records = await checked(journal.list(), signal), prior = records.find(r => !("readOnly" in r) && r.localProjectId === local.id && r.cloudProjectId === projectId);
      if (prior && "readOnly" in prior) return fail("readonly");
      if (prior && prior.phase !== "complete") return fail("pending");
      const identity = input.canonicalIdentity ?? (prior ? { id: prior.project.id, createdAt: prior.project.createdAt, capturedAt: prior.project.capturedAt, captureTimeZone: prior.project.captureTimeZone } : null);
      if (prior && identity && !same(identity, { id: prior.project.id, createdAt: prior.project.createdAt, capturedAt: prior.project.capturedAt, captureTimeZone: prior.project.captureTimeZone })) return fail("conflict");
      const project = validatePhotoProject({ ...portableProject(local), ...(identity ? { ...identity, capturedAt: identity.capturedAt ?? local.capturedAt } : {}) });
      const supplied = input.bindings ?? [], bindings: CloudDesignBinding[] = [];
      for (const media of project.media) {
        const old = prior?.bindings.find(b => b.mediaId === media.id), proposed = supplied.find(b => b.mediaId === media.id);
        if (old && proposed && !same(old, proposed)) return fail("conflict");
        if (old ?? proposed) bindings.push((old ?? proposed)!);
      }
      if (supplied.some(b => !project.media.some(m => m.id === b.mediaId)) || input.participants.some(p => prior?.participants.some(old => old.participantId === p.participantId && old.ownerId !== p.ownerId))) return fail("conflict");
      const timestamp = now(), record = validateDesignSaveRecord({ version: 1, id: prior?.id ?? newId(), ownerId: client.ownerId, localProjectId: local.id, cloudProjectId: projectId, revision: prior ? prior.revision + 1 : 0, createdAt: prior?.createdAt ?? timestamp, updatedAt: timestamp, phase: "preparing", requestId: newId(), expectedRevision: expected, project, participants: input.participants, bindings,
        uploads: project.media.filter(m => !bindings.some(b => b.mediaId === m.id)).map(media => ({ mediaId: media.id, assetId: newId(), requestId: newId(), record: null })), receipt: null });
      const saved = await checked(journal.put(record, prior?.revision ?? null), signal);
      return finishPreparation(saved, signal);
    }); },
    run(id: string, external?: AbortSignal) { return exclusive(external, async (signal): Promise<CloudDesignSaveResult> => {
      let record = await checked(journal.get(cloudUuid(id)), signal); if (!record) return fail("missing");
      if (record.phase === "complete") return { kind: "complete", record, receipt: record.receipt! };
      if (record.phase === "preparing") record = await finishPreparation(record, signal);
      await checked(client.designCapabilities(signal), signal);
      if (record.phase === "saving") { const receipt = await checked(client.designSaveStatus(record.cloudProjectId, record.requestId, signal), signal); if (receipt) return complete(record, receipt, signal); }
      const assets: CloudProjectAsset[] = await requireAssets(record, signal, false);
      if (record.phase !== "saving") record = await update(record, { phase: "uploading" }, signal);
      for (const plan of record.uploads) {
        if (assets.some(asset => asset.id === plan.assetId)) {
          const tracking = await checked(uploadJournal.get(plan.assetId), signal);
          if (tracking) {
            if (!plan.record || !same(tracking.asset, plan.record.asset) || tracking.projectId !== record.cloudProjectId || tracking.ownerId !== client.ownerId || tracking.createdAt !== plan.record.createdAt) return fail("file_mismatch");
            if (tracking.state !== "ready") {
              const reconciled = await checked(uploads.run(plan.assetId, undefined, signal), signal);
              if (reconciled.state === "failed") return fail("upload_failed");
              if (reconciled.state !== "ready") return { kind: "pending", record, assetId: plan.assetId };
            }
          }
          continue;
        }
        const media = record.project.media.find(m => m.id === plan.mediaId)!, { blob, sha256 } = await describe(record, media, signal);
        if (!plan.record || sha256 !== plan.record.asset.sha256) return fail("file_mismatch");
        const tracking = await checked(uploadJournal.get(plan.assetId), signal);
        if (!tracking) await checked(uploadJournal.put(plan.record), signal);
        else if (!same(tracking.asset, plan.record.asset) || tracking.projectId !== record.cloudProjectId || tracking.ownerId !== client.ownerId) return fail("file_mismatch");
        const uploaded = await checked(uploads.run(plan.assetId, blob, signal), signal);
        if (uploaded.state === "failed") return fail("upload_failed");
        if (uploaded.state !== "ready") return { kind: "pending", record, assetId: plan.assetId };
      }
      await requireAssets(record, signal, true);
      if (record.phase !== "saving") record = await update(record, { phase: "saving" }, signal);
      const snapshot = validateCloudDesign({ version: 1, project: record.project, bindings: record.bindings, participants: record.participants });
      return complete(record, await checked(client.saveDesign(record.cloudProjectId, record.expectedRevision, record.requestId, snapshot, signal), signal), signal);
    }); },
    adoptOpen(opened: Extract<CloudDesignOpenResult, { kind: "opened" }>, external?: AbortSignal) { return exclusive(external, async signal => {
      const local = validatePhotoProject(opened.project); if (local.scope.kind !== "account" || local.scope.ownerId !== client.ownerId) throw new CloudClientError("account_changed");
      const source = opened.source, receipt = parseCloudDesignReceipt(opened.receipt, source.projectId);
      const project = validatePhotoProject({ ...portableProject(local), ...source.canonicalIdentity }), snapshot = validateCloudDesign({ version: 1, project, bindings: source.bindings, participants: source.participants });
      const existing = (await checked(journal.list(), signal)).find(r => !("readOnly" in r) && r.localProjectId === local.id && r.cloudProjectId === source.projectId);
      if (existing) { if (!("readOnly" in existing) && existing.phase === "complete" && same(existing.receipt, receipt) && same(existing.bindings, snapshot.bindings) && same(existing.project, snapshot.project)) return existing; return fail("conflict"); }
      const timestamp = now();
      return checked(journal.put(validateDesignSaveRecord({ version: 1, id: newId(), ownerId: client.ownerId, localProjectId: local.id, cloudProjectId: source.projectId, revision: 0, createdAt: timestamp, updatedAt: timestamp, phase: "complete", requestId: receipt.requestId, expectedRevision: receipt.revision === 0 ? null : receipt.revision - 1, project: snapshot.project, participants: snapshot.participants, bindings: snapshot.bindings, uploads: [], receipt }), null), signal);
    }); },
    forget(id: string, expectedRevision: number, external?: AbortSignal) { return exclusive(external, signal => checked(journal.forget(cloudUuid(id), expectedRevision), signal)); },
    close() { lifetime.abort(); journal.close(); },
  };
}
export type CloudDesignSaveCoordinator = ReturnType<typeof createCloudDesignSaveCoordinator>;
