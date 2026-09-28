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
    access_denied: "You don't have access to this challenge anymore. Go back to the project and refresh.",
    access_lost: "Someone left or a photo was removed, so this result can't be made.",
    expired: "The deadline has passed. Refresh to see the result.",
    not_ready: "The challenge isn't ready for that yet. Refresh to see who has joined and added photos.",
    conflict: "The challenge has changed. Refresh before you continue.",
    capacity: "This project is out of space or has too many challenges.",
    account_changed: "You switched accounts. Go back to the library and sign in again.",
    rate_limited: "Too many requests. Wait a minute before trying again.",
    update_required: "This challenge isn't supported on this server yet.",
    unsupported: "This design can't be exported in this browser yet.",
    file_required: "Choose the same file to resume this upload.",
    file_mismatch: "That's a different file. Choose the one you started with.",
    invalid_image: "Choose a JPEG, PNG or WebP within 10 MiB, 4096 pixels per side and 12 megapixels.",
    resource_limit: "This result is too big for your browser to export.",
  };
  return messages[String(code)] ?? "No reply from the server. Refresh before trying again, as it may have worked.";
}
