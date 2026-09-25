import { CLOUD_DESIGN_LIMITS, designObject, designRevision, validateCloudDesign, type CloudDesignBinding, type CloudDesignParticipant, type CloudDesignRecord, type CloudDesignSnapshot } from "./cloud-design";
import { cloudSha256 } from "./cloud-client";
import { cloudUuid, type CloudProjectAsset } from "./cloud-contract";

interface FixtureDesign { current: CloudDesignRecord & { unsupported: false }; previous: CloudDesignRecord | null; bindings: CloudDesignBinding[]; participants: CloudDesignParticipant[]; receipts: Map<string, { fingerprint: string; record: CloudDesignRecord }> }
export interface DesignFixturePorts {
  project(id: string): { ownerId: string; members: { userId: string; status: string }[] } | null;
  asset(id: string, actor: string): (CloudProjectAsset & { projectId: string }) | null;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
const reject = (error: string, status = 409): never => { throw { error, status }; };
const receipt = ({ version, projectId, requestId, revision, contentHash, savedAt }: CloudDesignRecord) => ({ version, projectId, requestId, revision, contentHash, savedAt });
export function createCloudDesignUIFixture(ports: DesignFixturePorts) {
  const designs = new Map<string, FixtureDesign>(); let lostAck = false;
  function authority(projectId: string, actor: string, owner = false) {
    const project = ports.project(projectId);
    if (!project || !project.members.some(m => m.userId === actor && m.status === "accepted") || owner && project.ownerId !== actor) return reject("access_denied", 403);
    return project;
  }
  function sources(projectId: string, actor: string, snapshot: CloudDesignSnapshot) {
    const project = authority(projectId, actor);
    if (snapshot.participants.some(p => !project.members.some(m => m.userId === p.ownerId && m.status === "accepted"))) return reject("access_denied", 403);
    for (const binding of snapshot.bindings) {
      const asset = ports.asset(binding.assetId, actor), media = snapshot.project.media.find(m => m.id === binding.mediaId)!;
      if (!asset || asset.projectId !== projectId || asset.ownerId !== binding.ownerId || asset.sha256 !== binding.sha256 || (["kind", "mime", "bytes", "width", "height"] as const).some(key => asset[key] !== media[key])) return reject("access_denied", 403);
    }
  }
  async function request(body: Record<string, unknown>, actor: string): Promise<Response> {
    try {
      const op = body.operation;
      if (!["capabilities", "head", "read", "save", "status"].includes(op as string)) return reject("invalid_request", 400);
      designObject(body, op === "capabilities" ? ["operation"] : op === "head" ? ["operation", "projectId"] : op === "read" ? ["operation", "projectId", "checkpoint"] : op === "status" ? ["operation", "projectId", "requestId"] : ["operation", "projectId", "requestId", "expectedRevision", "snapshot"]);
      if (op === "capabilities") return json({ designVersion: 1, retirementVersion: 1, limits: CLOUD_DESIGN_LIMITS, referenceAssets: true });
      const projectId = cloudUuid(body.projectId); authority(projectId, actor, op !== "read");
      let saved = designs.get(projectId);
      if (op === "head") return json({ receipt: saved ? receipt(saved.current) : null });
      if (op === "status") return json({ receipt: saved?.receipts.get(cloudUuid(body.requestId))?.record ? receipt(saved.receipts.get(body.requestId as string)!.record) : null });
      if (op === "read") {
        if (!["current", "previous"].includes(body.checkpoint as string)) return reject("invalid_request", 400);
        const design = (body.checkpoint === "previous" ? saved?.previous : saved?.current) ?? null;
        if (design && !design.unsupported) sources(projectId, actor, design.snapshot);
        return json({ design });
      }
      const snapshot = validateCloudDesign(body.snapshot), expected = designRevision(body.expectedRevision), requestId = cloudUuid(body.requestId);
      const fingerprint = JSON.stringify({ expected, snapshot }), contentHash = await cloudSha256(new TextEncoder().encode(JSON.stringify(snapshot)).buffer);
      authority(projectId, actor, true); saved = designs.get(projectId);
      const previousRequest = saved?.receipts.get(requestId);
      if (previousRequest) { if (previousRequest.fingerprint !== fingerprint) return reject("conflict"); return json(receipt(previousRequest.record)); }
      if ((saved?.current.revision ?? null) !== expected) return reject("conflict");
      if ((saved?.receipts.size ?? 0) >= 100 || !saved && designs.size >= 8) return reject("capacity");
      sources(projectId, actor, snapshot);
      if (saved) {
        const before = saved.current.snapshot.project, next = snapshot.project;
        if (before.id !== next.id || before.createdAt !== next.createdAt || before.captureTimeZone !== next.captureTimeZone || before.capturedAt !== null && before.capturedAt !== next.capturedAt) return reject("conflict");
      }
      const bindings = [...saved?.bindings ?? []], participants = [...saved?.participants ?? []];
      for (const binding of snapshot.bindings) {
        const prior = bindings.find(b => b.mediaId === binding.mediaId || b.assetId === binding.assetId);
        if (prior && !same(prior, binding)) return reject("conflict"); if (!prior) bindings.push(binding);
      }
      for (const participant of snapshot.participants) { const prior = participants.find(p => p.participantId === participant.participantId); if (prior && !same(prior, participant)) return reject("conflict"); if (!prior) participants.push(participant); }
      if (bindings.length > 24 || participants.length > 4) return reject("capacity");
      const current: CloudDesignRecord & { unsupported: false } = { version: 1, projectId, requestId, revision: expected === null ? 0 : expected + 1, contentHash, savedAt: new Date().toISOString(), unsupported: false, snapshot };
      const receipts = new Map(saved?.receipts); receipts.set(requestId, { fingerprint, record: current });
      designs.set(projectId, { current, previous: saved?.current ?? null, receipts, bindings, participants });
      if (lostAck) { lostAck = false; throw new TypeError("Synthetic lost design acknowledgement"); }
      return json(receipt(current));
    } catch (error) {
      if (error instanceof TypeError) throw error;
      const failure = error && typeof error === "object" && "error" in error ? error as { error: string; status: number } : { error: "invalid_request", status: 400 };
      return json({ error: failure.error }, failure.status);
    }
  }
  return {
    request, loseNextAcknowledgement() { lostAck = true; },
    async advanceHead(projectId: string, actor: string) {
      const saved = designs.get(projectId); if (!saved) throw new Error("Save a synthetic design first");
      const project = saved.current.snapshot.project;
      const response = await request({ operation: "save", projectId, requestId: crypto.randomUUID(), expectedRevision: saved.current.revision, snapshot: { ...saved.current.snapshot, project: { ...project, name: "Synthetic edit from another device", revision: project.revision + 1, updatedAt: new Date().toISOString() } } }, actor);
      if (!response.ok) throw new Error("Synthetic head could not advance");
    },
    firstSource(projectId: string) { return designs.get(projectId)?.current.snapshot.bindings[0]?.assetId ?? null; },
    clear() { designs.clear(); },
  };
}
