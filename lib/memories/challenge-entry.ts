import { cloudUuid, type CloudProjectView } from "../projects/cloud-contract";
import type { CloudProjectClient } from "../projects/cloud-client";
import type { ChallengeClient } from "./challenge-client";
import type { ChallengeUnavailableView, ChallengeView } from "./challenge-contract";

export type ChallengeEntryState = { kind: "invitation"; view: ChallengeView } | { kind: "unsupported"; view: ChallengeUnavailableView } | { kind: "ready"; view: ChallengeView; project: CloudProjectView };
interface EntryClients { client: Pick<CloudProjectClient, "ownerId" | "assertActive" | "view">; challenges: Pick<ChallengeClient, "ownerId" | "assertActive" | "view"> }
export function challengePath(id: string) { return `/challenges/${cloudUuid(id)}`; }
export function challengeSignInPath(id: string) { return `/login?next=${encodeURIComponent(challengePath(id))}`; }
export async function loadChallengeEntry(id: string, { client, challenges }: EntryClients, signal?: AbortSignal): Promise<ChallengeEntryState> {
  cloudUuid(id);
  const check = () => {
    client.assertActive(signal); challenges.assertActive(signal);
    if (client.ownerId !== challenges.ownerId) throw { code: "account_changed" };
  };
  check(); const view = await challenges.view(id, signal); check();
  if (view.id !== id) throw { code: "invalid_response" };
  if ("unsupported" in view) return { kind: "unsupported", view };
  const member = view.members.find(person => person.userId === client.ownerId);
  if (!member) throw { code: "access_denied" };
  // Invitations expose the frozen challenge, never an unaccepted project's media.
  if (member.status === "invited" || member.status === "declined") return { kind: "invitation", view };
  const project = await client.view(view.projectId, signal); check();
  if (project.project.id !== view.projectId || project.project.status !== "active" || !project.members.some(person => person.userId === client.ownerId && person.status === "accepted")) throw { code: "access_denied" };
  const current = await challenges.view(id, signal); check();
  if (current.id !== id || current.projectId !== project.project.id) throw { code: "invalid_response" };
  if ("unsupported" in current) return { kind: "unsupported", view: current };
  const currentMember = current.members.find(person => person.userId === client.ownerId);
  if (!currentMember) throw { code: "access_denied" };
  if (currentMember.status === "invited" || currentMember.status === "declined") return { kind: "invitation", view: current };
  return { kind: "ready", view: current, project };
}
