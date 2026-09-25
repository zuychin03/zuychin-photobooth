import type { ChallengeView, PartialComposition, PartialSummary } from "./challenge-contract";
import type { TemplateDesign, TemplatePhotoSlot } from "../templates/model";

interface Ports {
  view(id: string): ChallengeView | undefined;
  accepted(projectId: string, ownerId: string): boolean;
  ready(assetId: string, projectId: string, ownerId: string, challengeId: string): boolean;
}
interface Proposal {
  id: string; challengeId: string; proposerId: string; digest: string; status: "pending" | "rejected" | "revealed";
  createdAt: string; revealedAt: string | null; members: Map<string, boolean | null>; sources: PartialComposition["sources"];
}

function designFor(view: ChallengeView, people: readonly string[]): TemplateDesign {
  const roles = view.members.filter(member => people.includes(member.userId)).map(member => member.role), design = view.design;
  const slots = design.slots.flatMap(slot => {
    const sources = [slot, ...(slot.companions ?? [])].filter(source => roles.includes(source.role)); if (!sources.length) return [];
    const first = sources[0], next: TemplatePhotoSlot = { id: slot.id, x: slot.x, y: slot.y, width: slot.width, height: slot.height, role: first.role, sourceIndex: first.sourceIndex, crop: first.crop, ...(first.sliceX ? { sliceX: first.sliceX } : {}), ...(first.filterId !== undefined ? { filterId: first.filterId } : {}), ...(sources.length > 1 ? { companions: sources.slice(1), splitFallback: slot.splitFallback } : {}) };
    return [next];
  });
  return { ...design, slots, requiredSources: Object.fromEntries(Object.entries(design.requiredSources).filter(([role]) => roles.includes(role))), layers: design.layers.filter(layer => layer.kind !== "text" || !layer.personal), defaults: { ...design.defaults, caption: "" }, ...(design.places ? { places: Object.fromEntries(Object.entries(design.places).filter(([role]) => roles.includes(role))) } : {}) };
}

// This transport rehearses UI states; SQL remains the authoritative permission implementation.
export function createPartialUIFixture(ports: Ports) {
  const proposals = new Map<string, Proposal>();
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  const denied = () => json({ error: "access_denied" }, 403);
  const accepted = (view: ChallengeView, actor: string) => view.members.some(member => member.userId === actor && member.status === "accepted") && ports.accepted(view.projectId, actor);
  const available = (view: ChallengeView, p: Proposal, actor: string) => accepted(view, actor) && p.sources.filter(source => source.userId === actor).every(source => ports.ready(source.assetId, view.projectId, actor, view.id));
  const summary = (view: ChallengeView, p: Proposal, actor: string): PartialSummary => {
    const contributors = view.members.filter(member => p.members.has(member.userId)).map(member => ({ userId: member.userId, role: member.role as "A" | "B" | "C" | "D", consent: p.members.get(member.userId)!, status: available(view, p, member.userId) ? "available" as const : "access_lost" as const }));
    return { id: p.id, challengeId: view.id, projectId: view.projectId, digest: p.digest, status: p.status, createdAt: p.createdAt, revealedAt: p.revealedAt, actorIncluded: p.members.has(actor), actorConsent: p.members.get(actor) ?? null, contributors, accessLost: contributors.some(person => person.status === "access_lost") || p.revealedAt !== null && (p.status !== "revealed" || contributors.some(person => person.consent !== true)) };
  };
  const detail = (view: ChallengeView, p: Proposal, actor: string): PartialSummary & { version: 1; result: PartialComposition | null } => {
    const s = summary(view, p, actor);
    return { version: 1, ...s, result: s.status === "revealed" && !s.accessLost && s.actorIncluded && s.contributors.every(person => person.consent === true) ? { projectionVersion: 1, recipeHash: view.recipeHash, design: designFor(view, [...p.members.keys()]), sources: p.sources } : null };
  };
  const minimal = (view: ChallengeView, p: Proposal, actor: string) => { const s = summary(view, p, actor); return { id: s.id, digest: s.digest, status: s.status, contributors: [...p.members.keys()].sort(), accessLost: s.accessLost }; };
  return {
    canRead(challengeId: string, assetId: string, actor: string) {
      const view = ports.view(challengeId); if (!view || !accepted(view, actor)) return false;
      return [...proposals.values()].some(p => p.challengeId === challengeId && detail(view, p, actor).result?.sources.some(source => source.assetId === assetId));
    },
    async request(body: Record<string, unknown>, actor: string): Promise<Response | null> {
      const op = body.operation;
      if (!["listPartials", "proposePartial", "partial", "partialDetail", "consentPartial", "commitPartial"].includes(String(op))) return null;
      const existing = proposals.get(String(body.partialId)), view = ports.view(String(body.challengeId ?? existing?.challengeId));
      if (!view || !accepted(view, actor)) return denied();
      if (op === "listPartials") {
        const all = [...proposals.values()].filter(p => p.challengeId === view.id && (p.proposerId === actor || p.members.has(actor)) && (!body.after || p.id > String(body.after))).sort((a, b) => a.id.localeCompare(b.id));
        const limit = Number(body.limit ?? 20), page = all.slice(0, limit);
        return json({ version: 1, partials: page.map(p => summary(view, p, actor)), nextCursor: all.length > limit ? page.at(-1)!.id : null });
      }
      if (op === "proposePartial") {
        const people = body.contributors as string[];
        if (!Array.isArray(people) || !people.length || people.length > 4 || new Set(people).size !== people.length || view.status === "draft" || people.some(userId => !accepted(view, userId) || !view.members.some(member => member.userId === userId && member.submitted))) return json({ error: "invalid_request" }, 400);
        const sources = view.visibleSources.filter(source => people.includes(source.userId)).map(source => ({ ...source, role: view.members.find(member => member.userId === source.userId)!.role as "A" | "B" | "C" | "D" }));
        if (sources.some(source => !ports.ready(source.assetId, view.projectId, source.userId, view.id))) return json({ error: "invalid_request" }, 400);
        if (existing) return existing.challengeId === view.id && existing.proposerId === actor && JSON.stringify([...existing.members.keys()].sort()) === JSON.stringify([...people].sort()) ? json(minimal(view, existing, actor)) : json({ error: "conflict" }, 409);
        if ([...proposals.values()].filter(p => p.challengeId === view.id).length >= 20) return json({ error: "capacity" }, 409);
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([body.partialId, view.recipeHash, sources])))), byte => byte.toString(16).padStart(2, "0")).join("");
        const proposal: Proposal = { id: String(body.partialId), challengeId: view.id, proposerId: actor, digest, status: "pending", createdAt: new Date().toISOString(), revealedAt: null, members: new Map(people.map(person => [person, null])), sources };
        proposals.set(proposal.id, proposal); return json(minimal(view, proposal, actor), 201);
      }
      if (!existing || existing.challengeId !== view.id || existing.proposerId !== actor && !existing.members.has(actor)) return denied();
      if (op === "partial") return json(minimal(view, existing, actor));
      if (body.digest !== existing.digest) return denied();
      if (op === "partialDetail") return json(detail(view, existing, actor));
      if (op === "consentPartial") {
        if (!existing.members.has(actor) || typeof body.consent !== "boolean") return denied();
        if (body.consent && existing.status !== "pending") return json({ error: "conflict" }, 409);
        existing.members.set(actor, body.consent); if (!body.consent) existing.status = "rejected";
        return json(minimal(view, existing, actor));
      }
      if (existing.status === "rejected" || [...existing.members].some(([userId, consent]) => consent !== true || !available(view, existing, userId))) return json({ error: "not_ready" }, 409);
      existing.status = "revealed"; existing.revealedAt ??= new Date().toISOString(); return json(minimal(view, existing, actor));
    },
    clear() { proposals.clear(); },
  };
}
