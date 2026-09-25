import { openChallengeDraftJournal, type ChallengeDraftJournal } from "../memories/challenge-drafts";
import { CLOUD_PROJECT_LIMITS, PROJECT_BUCKET, validateCloudAsset, type CloudAssetInput, type CloudProjectSummary, type CloudProjectMember, type ProjectFinalisationStatus } from "./cloud-contract";
import { createCloudProjectClient, cloudSha256, type CloudIdentity, type CloudProjectClient } from "./cloud-client";
import { createCloudUploadManager, openCloudUploadJournal, type CloudUploadManager, type CloudUploadJournal } from "./cloud-upload";
import { inspectProjectImage } from "./images";
import { createChallengeClient, type ChallengeClient } from "../memories/challenge-client";
import { createChallengeUIFixture } from "../memories/challenge-ui-fixture";
import { createCloudDesignUIFixture } from "./cloud-design-ui-fixture";
import { openCloudDesignJournal, type CloudDesignJournal } from "./cloud-design-journal";
import { createCloudDesignSaveCoordinator, type CloudDesignSaveCoordinator } from "./cloud-design-save";
import { openProjectRepository, type ProjectRepository } from "./storage";
import { appendProjectMedia, createProject, validatePhotoProject } from "./model";
import { cloudFixturePeople, type CloudFixturePeopleCount, type CloudFixturePersonIndex } from "./cloud-fixture-people";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const storageOrigin = "https://synthetic-storage.invalid";
interface FixtureProject { summary: CloudProjectSummary; members: CloudProjectMember[] }
interface FixtureAsset { input: CloudAssetInput; projectId: string; ownerId: string; reservedUntil: string; blob: Blob | null; queued: boolean; status: "reserved" | "ready" | "deleted" | "expired"; failure: ProjectFinalisationStatus["failure"] }
export interface CloudFixtureSession { key: string; name: string; ownerId: string; projectId: string; client: CloudProjectClient; uploads: CloudUploadManager; challenges: ChallengeClient; drafts: ChallengeDraftJournal; designs: CloudDesignSaveCoordinator }
export interface CloudUIFixture {
  readonly databaseName: string; readonly sample: File; readonly diagnostics: readonly string[];
  readonly people: ReturnType<typeof cloudFixturePeople>;
  mount(person: CloudFixturePersonIndex): Promise<CloudFixtureSession>; unmount(): void; close(): Promise<void>;
  holdVerification(held: boolean): void; failNext(): void;
  losePartialAcknowledgement(): void; expireContributions(projectId: string): number;
  setStorySupport(supported: boolean): void;
  openRepository: typeof openProjectRepository;
  loseDesignAcknowledgement(): void; advanceDesignHead(projectId: string): Promise<void>; revokeDesignSource(projectId: string): void;
}

export async function createCloudUIFixture(appOrigin: string, peopleCount: CloudFixturePeopleCount = 2): Promise<CloudUIFixture> {
  if (process.env.NODE_ENV !== "development") throw new Error("Development fixture unavailable");
  const people = cloudFixturePeople(peopleCount);
  const databaseName = `pb-cloud-ui-fixture-${crypto.randomUUID()}`, projects = new Map<string, FixtureProject>(), assets = new Map<string, FixtureAsset>();
  const projectDatabaseName = `${databaseName}-projects`, repositories = new Set<ProjectRepository>();
  const diagnostics: string[] = [];
  let identity: CloudIdentity | null = null, epoch = 0, session: CloudFixtureSession | null = null, held = false, failNext = false, closed = false;
  const log = (value: string) => { diagnostics.push(value); if (diagnostics.length > 20) diagnostics.shift(); };
  for (const person of people) projects.set(person.projectId, { summary: { id: person.projectId, ownerId: person.ownerId, kind: "personal", title: `${person.name}'s synthetic originals`, maxBytes: CLOUD_PROJECT_LIMITS.projectBytes, status: "active", createdAt: new Date().toISOString() }, members: [{ projectId: person.projectId, userId: person.ownerId, status: "accepted" }] });
  projects.set(id(30), { summary: { id: id(30), ownerId: people[1].ownerId, kind: "friend", title: "Synthetic friendship invitation", maxBytes: CLOUD_PROJECT_LIMITS.projectBytes, status: "active", createdAt: new Date().toISOString() }, members: people.map(person => ({ projectId: id(30), userId: person.ownerId, status: person.index === 1 ? "accepted" : "invited" })) });
  const canvas = document.createElement("canvas"); canvas.width = 192; canvas.height = 128;
  let sample: File;
  try {
    const context = canvas.getContext("2d"); if (!context) throw new Error("Canvas unavailable");
    for (const [colour, x, y] of [["#df8497", 0, 0], ["#765994", 96, 0], ["#faf4ed", 0, 64], ["#332b34", 96, 64]] as const) { context.fillStyle = colour; context.fillRect(x, y, 96, 64); }
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Sample encoding failed")), "image/png"));
    sample = new File([blob], "synthetic-cloud-original.png", { type: "image/png" });
  } finally { canvas.width = canvas.height = 1; }
  const info = await inspectProjectImage(sample), sha256 = await cloudSha256(await sample.arrayBuffer());
  const eraseDatabase = (name: string) => new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(new Error("Fixture database cleanup failed")); request.onblocked = () => reject(new Error("Fixture database cleanup blocked")); });
  try {
    for (const person of people) {
      const repository = await openProjectRepository({ kind: "account", ownerId: person.ownerId }, { databaseName: projectDatabaseName });
      try {
        const project = appendProjectMedia(createProject({ id: `synthetic-${person.name.toLowerCase()}`, name: `${person.name}'s saved synthetic design`, scope: { kind: "account", ownerId: person.ownerId }, participants: [{ id: "person", role: "A" }] }), [{ id: "synthetic-photo", kind: "photo", participantId: "person", ...info, bytes: sample.size }], { A: ["synthetic-photo"], B: [], C: [], D: [] }, new Date().toISOString());
        await repository.save(validatePhotoProject({ ...project, revision: 0 }), new Map([["synthetic-photo", sample]]), null);
      } finally { repository.close(); }
    }
  } catch (error) { await eraseDatabase(projectDatabaseName); throw error; }
  const openFixtureRepository: typeof openProjectRepository = async scope => {
    const captured = identity;
    if (closed || !captured || scope.kind !== "account" || scope.ownerId !== captured.ownerId) throw new Error("Fixture account changed");
    const repository = await openProjectRepository(scope, { databaseName: projectDatabaseName });
    if (closed || identity?.epoch !== captured.epoch) { repository.close(); throw new Error("Fixture account changed"); }
    const close = repository.close;
    repository.close = () => { repositories.delete(repository); close(); };
    repositories.add(repository); return repository;
  };
  const seed: CloudAssetInput = { id: id(100), requestId: id(101), kind: "photo", ...info, bytes: sample.size, sha256, protection: { kind: "none", id: null } };
  assets.set(seed.id, { input: seed, projectId: people[0].projectId, ownerId: people[0].ownerId, reservedUntil: new Date(Date.now() + 600000).toISOString(), blob: sample, queued: true, status: "ready", failure: null });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  const denied = () => json({ error: "access_denied" }, 403);
  const member = (project: FixtureProject | undefined, owner: string) => project?.summary.status === "active" && project.members.some(m => m.userId === owner && m.status === "accepted");
  const assetPublic = (a: FixtureAsset) => ({ id: a.input.id, ownerId: a.ownerId, kind: a.input.kind, mime: a.input.mime, bytes: a.input.bytes, width: a.input.width, height: a.input.height, sha256: a.input.sha256 });
  const challenges = createChallengeUIFixture({ project: id => { const p = projects.get(id); return p?.summary.status === "active" ? { ownerId: p.summary.ownerId, members: p.members } : null; }, accept: (id, owner) => { const member = projects.get(id)?.members.find(member => member.userId === owner); if (member?.status === "invited") member.status = "accepted"; }, asset: id => assets.get(id), assets: () => [...assets.values()] });
  const designs = createCloudDesignUIFixture({ project: id => { const p = projects.get(id); return p?.summary.status === "active" ? { ownerId: p.summary.ownerId, members: p.members } : null; }, asset: (id, actor) => { const a = assets.get(id); return a?.status === "ready" && member(projects.get(a.projectId), actor) && challenges.canRead(a, actor) ? { ...assetPublic(a), projectId: a.projectId } : null; } });
  async function finalisation(a: FixtureAsset): Promise<ProjectFinalisationStatus> {
    if (a.status === "reserved" && Date.parse(a.reservedUntil) <= Date.now()) { a.status = "expired"; a.failure = "deadline"; }
    if (a.queued && a.status === "reserved" && a.blob && !held && !a.failure) {
      try {
        const metadata = await inspectProjectImage(a.blob), hash = await cloudSha256(await a.blob.arrayBuffer());
        if (hash !== a.input.sha256 || a.blob.size !== a.input.bytes || metadata.mime !== a.input.mime || metadata.width !== a.input.width || metadata.height !== a.input.height) throw new Error();
        a.status = "ready";
      } catch { a.failure = "invalid_image"; }
    }
    return { assetId: a.input.id, status: a.failure || a.status === "deleted" || a.status === "expired" ? "failed" : a.status === "ready" ? "complete" : a.queued ? "queued" : "not_queued", assetStatus: a.status, attempts: a.status === "ready" ? 1 : 0, reservedUntil: a.reservedUntil, failure: a.failure };
  }
  const transport: typeof fetch = async (input, init) => {
    const captured = identity;
    if (!captured || closed || init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
      const timer = setTimeout(() => { init?.signal?.removeEventListener("abort", cancel); resolve(); }, 120);
      init?.signal?.addEventListener("abort", cancel, { once: true });
    });
    if (identity?.epoch !== captured.epoch || closed || init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (failNext) { failNext = false; log("Injected one unavailable response before mutation"); return json({ error: "unavailable" }, 503); }
    const url = new URL(String(input)), owner = captured.ownerId;
    if (url.origin === storageOrigin) {
      const prefix = `/storage/v1/object/${init?.method === "PUT" ? "upload/sign" : "sign"}/${PROJECT_BUCKET}/`;
      if (!url.pathname.startsWith(prefix) || url.searchParams.get("token") !== "synthetic-only") return denied();
      const [projectId, ownerId, assetId] = url.pathname.slice(prefix.length).split("/"), a = assets.get(assetId);
      if (!a || a.projectId !== projectId || a.ownerId !== ownerId || !member(projects.get(projectId), owner)) return denied();
      if (init?.method === "PUT") {
        if (owner !== ownerId || a.status !== "reserved" || Date.parse(a.reservedUntil) <= Date.now() || !(init.body instanceof Blob)) return denied();
        if (a.blob) return json({ error: "already_exists" }, 409);
        const totalBytes = [...assets.values()].reduce((sum, asset) => sum + (asset.blob?.size ?? 0), 0);
        if (init.body.size > CLOUD_PROJECT_LIMITS.assetBytes || totalBytes + init.body.size > CLOUD_PROJECT_LIMITS.projectBytes) return json({ error: "capacity" }, 413);
        a.blob = init.body; log("Original PUT retained in fixture memory"); return json({ stored: true });
      }
      if (a.status !== "ready" || !a.blob || !challenges.canRead(a, owner)) return denied();
      return new Response(a.blob, { headers: { "Content-Type": a.input.mime, "Content-Length": String(a.blob.size) } });
    }
    if (url.origin !== appOrigin || !["/api/projects", "/api/projects/design", "/api/challenges"].includes(url.pathname) || init?.method !== "POST" || typeof init.body !== "string") return denied();
    const body = JSON.parse(init.body) as Record<string, unknown>, op = body.operation;
    log(`Synthetic ${String(op)} request`);
    if (url.pathname === "/api/challenges") return challenges.request(body, owner);
    if (url.pathname === "/api/projects/design") return designs.request(body, owner);
    if (op === "capabilities") return json({ enabled: true, version: 1, limits: CLOUD_PROJECT_LIMITS });
    if (op === "list") {
      const all = [...projects.values()].filter(p => p.summary.status === "active" && p.members.some(m => m.userId === owner && m.status !== "revoked") && (!body.after || p.summary.id > String(body.after))).sort((a, b) => a.summary.id.localeCompare(b.summary.id));
      const limit = Number(body.limit ?? 20), page = all.slice(0, limit);
      return json({ projects: page.map(p => ({ id: p.summary.id, ownerId: p.summary.ownerId, kind: p.summary.kind, title: p.summary.title, createdAt: p.summary.createdAt, membership: p.members.find(m => m.userId === owner)!.status })), nextCursor: all.length > limit ? page.at(-1)!.summary.id : null });
    }
    if (op === "create") {
      const previous = projects.get(String(body.id));
      if (previous) return previous.summary.ownerId === owner && previous.summary.title === body.title && previous.summary.kind === body.kind && previous.summary.status === "active" ? json(previous.summary) : json({ error: "conflict" }, 409);
      if (projects.size >= 8) return json({ error: "capacity" }, 409);
      if (body.kind !== "personal" && body.kind !== "friend") return json({ error: "invalid_request" }, 400);
      const summary: CloudProjectSummary = { id: String(body.id), ownerId: owner, title: String(body.title), kind: body.kind, maxBytes: CLOUD_PROJECT_LIMITS.projectBytes, status: "active", createdAt: new Date().toISOString() };
      projects.set(summary.id, { summary, members: [{ projectId: summary.id, userId: owner, status: "accepted" }] }); return json(summary, 201);
    }
    const a = assets.get(String(body.assetId)), p = projects.get(String(body.projectId ?? a?.projectId));
    if (op === "member" && p?.summary.status === "active" && body.action === "accept" && body.userId === owner) {
      const invitation = p.members.find(m => m.userId === owner && m.status !== "revoked"); if (!invitation) return denied(); invitation.status = "accepted"; return json(invitation);
    }
    if (op === "member" && p?.summary.status === "active" && p.summary.ownerId === owner && p.summary.kind === "friend" && body.userId !== owner) {
      if (!people.some(person => person.ownerId === body.userId)) return denied();
      let invitation = p.members.find(m => m.userId === body.userId);
      if (body.action === "invite") {
        if (invitation?.status === "revoked") return json({ error: "conflict" }, 409);
        if (!invitation) {
          if (p.members.length >= 4) return json({ error: "capacity" }, 409);
          invitation = { projectId: p.summary.id, userId: String(body.userId), status: "invited" }; p.members.push(invitation);
        }
      } else if (body.action === "revoke" && invitation) invitation.status = "revoked";
      else return denied();
      return json(invitation);
    }
    if (op === "delete" && body.assetId === undefined) {
      if (!p || p.summary.ownerId !== owner) return denied();
      p.summary.status = "deleted";
      for (const asset of assets.values()) if (asset.projectId === p.summary.id) { asset.status = "deleted"; asset.blob = null; }
      const pending = [...assets.values()].some(asset => asset.projectId === p.summary.id);
      log(pending ? "Project deleted; simulated cleanup remains pending" : "Empty project deleted");
      return json({ pending }, 202);
    }
    if (!p || !member(p, owner)) return denied();
    if (op === "view") return json({ project: p.summary, members: p.members.map(({ userId, status }) => ({ userId, status })), assets: [...assets.values()].filter(asset => asset.projectId === p.summary.id && asset.status === "ready" && challenges.canRead(asset, owner)).map(assetPublic) });
    if (op === "reserve") {
      const checked = validateCloudAsset(body.asset); if (!challenges.canUpload({ input: checked, ownerId: owner, projectId: p.summary.id, status: "reserved" }, owner)) return denied();
      let record = assets.get(checked.id);
      if (record && (record.projectId !== p.summary.id || record.ownerId !== owner || JSON.stringify(record.input) !== JSON.stringify(checked))) return json({ error: "conflict" }, 409);
      if (!record) {
        const prior = [...assets.values()].filter(asset => asset.projectId === p.summary.id);
        if (assets.size >= 24 || prior.reduce((sum, asset) => sum + (asset.status === "ready" ? asset.input.bytes : CLOUD_PROJECT_LIMITS.assetBytes), 0) + CLOUD_PROJECT_LIMITS.assetBytes > p.summary.maxBytes) return json({ error: "capacity" }, 409);
        record = { input: checked, projectId: p.summary.id, ownerId: owner, blob: null, queued: false, status: "reserved", failure: null, reservedUntil: new Date(Date.now() + 600000).toISOString() }; assets.set(checked.id, record);
      }
      return json({ ...assetPublic(record), projectId: record.projectId, requestId: checked.requestId, status: record.status, reservedUntil: record.reservedUntil }, 201);
    }
    if (!a || a.projectId !== p.summary.id) return denied();
    const path = `${a.projectId}/${a.ownerId}/${a.input.id}`;
    if (op === "read") return a.status === "ready" && challenges.canRead(a, owner) ? json({ signedUrl: `${storageOrigin}/storage/v1/object/sign/${PROJECT_BUCKET}/${path}?token=synthetic-only`, expiresIn: 300 }) : denied();
    if (op === "delete" && owner === a.ownerId) { a.status = "deleted"; a.blob = null; return json({ pending: true }, 202); }
    if (owner !== a.ownerId) return denied();
    if (op === "upload") return a.status === "reserved" && Date.parse(a.reservedUntil) > Date.now() ? json({ signedUrl: `${storageOrigin}/storage/v1/object/upload/sign/${PROJECT_BUCKET}/${path}?token=synthetic-only`, token: "synthetic-only", path }) : denied();
    if (op === "finalise") { a.queued = true; return json(await finalisation(a), 202); }
    if (op === "status") return json(await finalisation(a));
    return json({ error: "invalid_request" }, 400);
  };
  const fixture: CloudUIFixture = {
    databaseName, sample, diagnostics, people, openRepository: openFixtureRepository,
    async mount(person) {
      if (closed) throw new Error("Fixture stopped");
      if (!people[person]) throw new Error("Synthetic account unavailable");
      fixture.unmount(); const current = people[person]; identity = { ownerId: current.ownerId, epoch: ++epoch }; const openingEpoch = epoch;
      const client = createCloudProjectClient({ appOrigin, storageOrigin, identity: () => identity, accessToken: async () => "synthetic-not-a-credential", fetch: transport });
      let journal: CloudUploadJournal | undefined, drafts: ChallengeDraftJournal | undefined, designJournal: CloudDesignJournal | undefined;
      try {
        journal = await openCloudUploadJournal(current.ownerId, { databaseName, identity: () => identity });
        if (closed || identity?.epoch !== openingEpoch) { journal.close(); client.close(); throw new Error("Fixture account changed"); }
        drafts = await openChallengeDraftJournal(current.ownerId, { databaseName, identity: () => identity });
        if (closed || identity?.epoch !== openingEpoch) throw new Error("Fixture account changed");
        designJournal = await openCloudDesignJournal(current.ownerId, { databaseName, identity: () => identity });
        if (closed || identity?.epoch !== openingEpoch) throw new Error("Fixture account changed");
        const uploads = createCloudUploadManager({ client, journal });
        const coordinator = createCloudDesignSaveCoordinator({ client, uploads, uploadJournal: journal, journal: designJournal, loadBlob: async (localProjectId, mediaId, signal) => {
          client.assertActive(signal); const repository = await openFixtureRepository({ kind: "account", ownerId: current.ownerId });
          try { client.assertActive(signal); const saved = await repository.load(localProjectId); client.assertActive(signal); return saved?.kind === "current" ? saved.media.get(mediaId) ?? null : null; }
          finally { repository.close(); }
        } });
        const challengeClient = createChallengeClient({ appOrigin, identity: () => identity, accessToken: async () => "synthetic-not-a-credential", fetch: transport });
        session = { key: `${current.ownerId}:${openingEpoch}`, name: current.name, ownerId: current.ownerId, projectId: current.projectId, client, uploads, challenges: challengeClient, drafts, designs: coordinator }; return session;
      } catch (error) { client.close(); journal?.close(); drafts?.close(); designJournal?.close(); throw error; }
    },
    unmount() { identity = null; epoch++; session?.client.close(); session?.designs.close(); session?.uploads.close(); session?.challenges.close(); session?.drafts.close(); for (const repository of repositories) repository.close(); session = null; },
    holdVerification(value) { held = value; log(value ? "Verification held pending" : "Verification released; check status to verify"); },
    failNext() { failNext = true; },
    losePartialAcknowledgement() { challenges.loseNextProposalAcknowledgement(); log("Next successful partial proposal will lose its acknowledgement"); },
    expireContributions(projectId) { const count = challenges.expireContributions(projectId); log(`${count} synthetic challenges expired`); return count; },
    setStorySupport(supported) { challenges.setStorySupport(supported); log(`Synthetic guided stories ${supported ? "available" : "unavailable"}`); },
    loseDesignAcknowledgement() { designs.loseNextAcknowledgement(); log("Next design-save acknowledgement will be lost after commit"); },
    async advanceDesignHead(projectId) { if (!identity || closed) throw new Error("Mount a synthetic account first"); await designs.advanceHead(projectId, identity.ownerId); log("Another synthetic device advanced the design head"); },
    revokeDesignSource(projectId) { const assetId = designs.firstSource(projectId), asset = assetId ? assets.get(assetId) : null; if (!asset) throw new Error("Save a synthetic design with an original first"); asset.status = "deleted"; asset.blob = null; log("One bound synthetic original was revoked; local copies remain"); },
    async close() {
      closed = true; fixture.unmount(); assets.clear(); projects.clear(); challenges.clear(); designs.clear();
      await Promise.all([eraseDatabase(databaseName), eraseDatabase(projectDatabaseName)]);
    },
  };
  return fixture;
}
