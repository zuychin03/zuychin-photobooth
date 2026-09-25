import { CHALLENGE_LIMITS, prepareChallengeCreate, validateChallengeSubmission, type ChallengeCreate, type ChallengeView } from "./challenge-contract";
import type { CloudAssetInput } from "../projects/cloud-contract";
import { createPartialUIFixture } from "./challenge-partial-ui-fixture";

interface Asset { input: CloudAssetInput; ownerId: string; projectId: string; status: string }
interface Ports { project(id: string): { ownerId: string; members: { userId: string; status: string }[] } | null; accept(projectId: string, ownerId: string): void; asset(id: string): Asset | undefined; assets(): Asset[] }
interface State { input: ChallengeCreate; view: ChallengeView; createdAt: string; submissions: Map<string, string> }

export function createChallengeUIFixture(ports: Ports) {
  const states = new Map<string, State>();
  let loseProposalResponse = false;
  let storySupported = true;
  const partials = createPartialUIFixture({ view: id => states.get(id)?.view, accepted: (id, owner) => Boolean(ports.project(id)?.members.some(member => member.userId === owner && member.status === "accepted")), ready: (id, projectId, ownerId, challengeId) => { const asset = ports.asset(id); return Boolean(asset && asset.status === "ready" && asset.projectId === projectId && asset.ownerId === ownerId && asset.input.protection.id === challengeId); } });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  const denied = () => json({ error: "access_denied" }, 403);
  const available = (state: State) => state.view.members.every(member => member.status === "accepted" && ports.project(state.view.projectId)?.members.some(person => person.userId === member.userId && person.status === "accepted"));
  const canView = (state: State, owner: string) => state.view.members.some(person => person.userId === owner) && ports.project(state.view.projectId)?.members.some(person => person.userId === owner && (person.status === "accepted" || person.status === "invited" && state.view.members.some(person => person.userId === owner && person.status === "invited")));
  const project = (state: State, owner: string): ChallengeView => {
    const view = state.view, sourcesAvailable = view.visibleSources.every(source => ports.asset(source.assetId)?.status === "ready");
    const lost = !available(state) && view.status !== "draft" || !sourcesAvailable;
    const visible = !lost && (view.status === "revealed" || view.policy === "immediate" && view.status === "open" && Date.parse(view.expiresAt) > Date.now());
    return { ...view, accessLost: lost, visibleSources: view.visibleSources.filter(source => source.userId === owner || visible) };
  };
  return {
    setStorySupport(supported: boolean) { storySupported = supported; },
    loseNextProposalAcknowledgement() { loseProposalResponse = true; },
    expireContributions(projectId: string) {
      let count = 0;
      for (const state of states.values()) if (state.view.projectId === projectId && ["draft", "open"].includes(state.view.status)) {
        state.view.status = "expired"; count++;
      }
      return count;
    },
    canUpload(asset: Asset, owner: string) {
      if (asset.input.protection.kind === "none") return true;
      const state = states.get(asset.input.protection.id!);
      return Boolean(state && state.view.projectId === asset.projectId && state.view.status === "open" && Date.parse(state.view.expiresAt) > Date.now() && available(state) && state.view.members.some(person => person.userId === owner && person.status === "accepted" && !person.submitted));
    },
    canRead(asset: Asset, owner: string) {
      if (asset.input.protection.kind === "none" || asset.ownerId === owner) return true;
      const state = states.get(asset.input.protection.id!);
      return Boolean(state && canView(state, owner) && (project(state, owner).visibleSources.some(source => source.assetId === asset.input.id) || partials.canRead(state.view.id, asset.input.id, owner)));
    },
    async request(body: Record<string, unknown>, owner: string) {
      const op = body.operation;
      const partial = await partials.request(body, owner);
      if (partial) {
        if (op === "proposePartial" && partial.ok && loseProposalResponse) { loseProposalResponse = false; return json({ error: "unavailable" }, 503); }
        return partial;
      }
      if (op === "capabilities") return json({ enabled: true, version: CHALLENGE_LIMITS.version, limits: CHALLENGE_LIMITS, storyVersion: storySupported ? 1 : 0 });
      if (op === "list") {
        const scope = ports.project(String(body.projectId)); if (!scope?.members.some(member => member.userId === owner && member.status !== "revoked")) return denied();
        const all = [...states.values()].filter(state => state.view.projectId === body.projectId && canView(state, owner) && (!body.after || state.view.id > String(body.after))).sort((a, b) => a.view.id.localeCompare(b.view.id));
        const limit = Number(body.limit ?? 20), page = all.slice(0, limit);
        return json({ version: 1, challenges: page.map(state => ({ id: state.view.id, projectId: state.view.projectId, status: state.view.status, policy: state.view.policy, membership: state.view.members.find(member => member.userId === owner)!.status, createdAt: state.createdAt, expiresAt: state.view.expiresAt, unsupported: false })), nextCursor: all.length > limit ? page.at(-1)!.view.id : null });
      }
      if (op === "create") {
        const scope = ports.project(String(body.projectId)); if (scope?.ownerId !== owner) return denied();
        const input = prepareChallengeCreate(body.challenge);
        if (input.story && !storySupported) return json({ error: "update_required" }, 409);
        const old = states.get(input.id); if (old) return JSON.stringify(old.input) === JSON.stringify(input) ? json(project(old, owner)) : json({ error: "conflict" }, 409);
        if (states.size >= 32 || input.members.some(member => !scope.members.some(person => person.userId === member.userId && person.status !== "revoked"))) return denied();
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(input.story ? { design: input.design, members: input.members, assignments: input.assignments, story: input.story } : input.design)))), byte => byte.toString(16).padStart(2, "0")).join("");
        const state: State = { input, createdAt: new Date().toISOString(), submissions: new Map(), view: { id: input.id, projectId: String(body.projectId), design: input.design, policy: input.policy, status: "draft", recipeHash: hash, expiresAt: input.expiresAt, revealedAt: null, revealHash: null, accessLost: false, members: input.members.map(member => ({ ...member, status: member.userId === owner ? "accepted" : "invited", submitted: false })), assignments: input.assignments, visibleSources: [], ...(input.story ? { story: input.story } : {}) } };
        states.set(input.id, state); return json(project(state, owner), 201);
      }
      const state = states.get(String(body.challengeId)); if (!state || !canView(state, owner)) return denied();
      const view = state.view, mine = view.members.find(member => member.userId === owner)!;
      if (op === "view") return json(project(state, owner));
      if (op === "listUploads") {
        if (!ports.project(view.projectId)?.members.some(member => member.userId === owner && member.status === "accepted")) return denied();
        const all = ports.assets().filter(asset => asset.projectId === view.projectId && asset.ownerId === owner && asset.status === "ready" && asset.input.kind === "photo" && asset.input.protection.id === view.id && (!body.after || asset.input.id > String(body.after))).sort((a, b) => a.input.id.localeCompare(b.input.id));
        const limit = Number(body.limit ?? 20), page = all.slice(0, limit);
        return json({ version: 1, uploads: page.map(({ input, ownerId }) => ({ id: input.id, ownerId, kind: input.kind, mime: input.mime, bytes: input.bytes, width: input.width, height: input.height, sha256: input.sha256 })), nextCursor: all.length > limit ? page.at(-1)!.input.id : null });
      }
      if (op === "manage") {
        const action = body.action;
        if (action === "accept" || action === "decline") {
          if (view.status !== "draft" || Date.parse(view.expiresAt) <= Date.now()) return json({ error: "expired" }, 409);
          if (mine.status !== "invited" && mine.status !== (action === "accept" ? "accepted" : "declined")) return denied();
          mine.status = action === "accept" ? "accepted" : "declined"; if (action === "accept") ports.accept(view.projectId, owner);
        } else if (action === "open") {
          if (ports.project(view.projectId)?.ownerId !== owner) return denied();
          if ((view.status !== "draft" && view.status !== "open") || !available(state) || Date.parse(view.expiresAt) <= Date.now()) return json({ error: "not_ready" }, 409);
          view.status = "open";
        } else if (action === "cancel") {
          if (ports.project(view.projectId)?.ownerId !== owner) return denied();
          if (view.status === "revealed") return json({ error: "conflict" }, 409); view.status = "cancelled";
        } else if (action === "withdraw") { mine.status = "withdrawn"; if (view.status === "draft" || view.status === "open") view.status = "cancelled"; }
        else return json({ error: "invalid_request" }, 400);
        return json(project(state, owner));
      }
      if (op === "submit") {
        const submission = validateChallengeSubmission(body.submission), fingerprint = JSON.stringify(submission), old = state.submissions.get(owner);
        if (old) return old === fingerprint ? json(project(state, owner)) : json({ error: "conflict" }, 409);
        if (view.status !== "open" || !available(state) || Date.parse(view.expiresAt) <= Date.now()) return json({ error: "expired" }, 409);
        const assigned = view.assignments.filter(item => item.userId === owner);
        if (assigned.length !== submission.sources.length || assigned.some(item => !submission.sources.some(source => source.sourceIndex === item.sourceIndex))) return denied();
        if (submission.sources.some(source => { const asset = ports.asset(source.assetId); return !asset || asset.ownerId !== owner || asset.projectId !== view.projectId || asset.status !== "ready" || asset.input.protection.id !== view.id; })) return denied();
        state.submissions.set(owner, fingerprint); mine.submitted = true; view.visibleSources.push(...submission.sources.map(source => ({ ...source, userId: owner })));
        if (view.members.every(member => member.submitted)) { view.status = "revealed"; view.revealedAt = new Date().toISOString(); view.revealHash = view.recipeHash; }
        return json(project(state, owner));
      }
      return json({ error: "unavailable" }, 503);
    },
    clear() { states.clear(); partials.clear(); loseProposalResponse = false; },
  };
}
