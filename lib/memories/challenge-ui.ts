import { LAYOUTS, ROLES } from "../layouts";
import { createProject } from "../projects/model";
import { templateFromProject } from "../templates/from-project";
import { CLOUD_PROJECT_LIMITS, cloudUuid, type CloudProjectAsset } from "../projects/cloud-contract";
import type { ChallengeClient } from "./challenge-client";
import { validateChallengeSubmission, type ChallengeSubmission } from "./challenge-contract";

export function challengeLayouts(count: number) {
  return LAYOUTS.filter(layout => count === 2 ? layout.mode === "duo" : layout.mode === "group" && layout.minMembers === count);
}
export async function challengeOwnedUploads(client: Pick<ChallengeClient, "listUploads">, challengeId: string, signal?: AbortSignal) {
  const result: CloudProjectAsset[] = []; let after: string | undefined;
  for (let page = 0; page < Math.ceil(CLOUD_PROJECT_LIMITS.files / 20); page++) {
    const next = await client.listUploads(challengeId, after, 20, signal);
    result.push(...next.uploads);
    if (result.length > CLOUD_PROJECT_LIMITS.files || new Set(result.map(item => item.id)).size !== result.length) throw new Error("Invalid challenge uploads");
    if (!next.nextCursor) return result;
    after = next.nextCursor;
  }
  throw new Error("Challenge upload limit exceeded");
}
export function challengeDesign(layoutId: string, people: string[]) {
  if (people.length < 2 || people.length > 4 || new Set(people).size !== people.length || !challengeLayouts(people.length).some(layout => layout.id === layoutId)) throw new Error("invalid_request");
  const members = people.map((userId, index) => ({ userId: cloudUuid(userId), role: ROLES[index] }));
  const project = createProject({ id: "challenge-layout", createdAt: "2026-01-01T00:00:00.000Z", captureTimeZone: "UTC", mode: people.length === 2 ? "duo" : "group", participants: members.map(member => ({ id: member.userId, role: member.role })), editor: { layoutId, showDate: false } });
  return { design: templateFromProject(project), members };
}
export async function challengeSubmission(challengeId: string, ownerId: string, sources: ChallengeSubmission["sources"]): Promise<ChallengeSubmission> {
  cloudUuid(challengeId); cloudUuid(ownerId);
  const checked = validateChallengeSubmission({ requestId: "00000000-0000-4000-8000-000000000000", sources });
  checked.sources.sort((a, b) => a.sourceIndex - b.sourceIndex);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["photobooth-challenge-submission-v1", challengeId, ownerId, checked.sources]))));
  hash[6] = (hash[6] & 15) | 0x40; hash[8] = (hash[8] & 63) | 0x80;
  const hex = Array.from(hash.slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join("");
  return { requestId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`, sources: checked.sources };
}
export function challengeError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : "";
  const messages: Record<string, string> = {
    access_denied: "This challenge is no longer available to your account. Return to the project and refresh your access.",
    access_lost: "A contributor or original is no longer available. This result cannot be prepared.",
    expired: "The contribution deadline has passed. Refresh to see the latest result.",
    not_ready: "The challenge is not ready for this action. Refresh to check invitations and submissions.",
    conflict: "The challenge changed, or this action already has a different result. Refresh before continuing.",
    capacity: "This project has reached a challenge or storage limit. Keep your original files.",
    account_changed: "Your account changed. Return to the library and sign in again.",
    rate_limited: "Too many requests. Wait a minute before trying again.",
    update_required: "This challenge needs a newer server update before it can be opened here.",
    unsupported: "This design cannot be exported in this browser yet. Your originals are unchanged.",
    file_required: "Choose the same original file to resume this upload.",
    file_mismatch: "That file does not match this upload. Choose the original file.",
    invalid_image: "Choose a JPEG, PNG or WebP within 10 MiB, 4096 pixels per side and 12 megapixels.",
    resource_limit: "This result exceeds the browser's export limits. Keep the originals for a smaller export.",
  };
  return messages[String(code)] ?? "Confirmation did not arrive. Refresh before retrying; your action may already have reached the server.";
}
