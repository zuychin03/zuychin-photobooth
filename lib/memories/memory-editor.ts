import type { MemoryActivity } from "./activity-contract";

export const memoryAvailability = {
  available: "Photo available", archived: "Archived photo", archive_pending: "Archiving",
  expired: "Photo expired", deleted: "Photo deleted", unknown: "Status unknown", access_lost: "No longer shared",
} as const;
export function memorySelectable(item: MemoryActivity) { return Boolean(item.source && ["available", "archived"].includes(item.availability)); }
export function memoryDate(item: MemoryActivity, timeZone: string) { return new Intl.DateTimeFormat("en-AU", { timeZone, day: "numeric", month: "short", year: "numeric" }).format(new Date(item.occurredAt)); }
export function memoryProvenance(item: MemoryActivity) { return item.provenance === "saved_at" ? "Saved" : item.provenance === "verified_at" ? "Uploaded" : "Added"; }
export function memoryError(failure: unknown) {
  const code = failure && typeof failure === "object" && "code" in failure ? String(failure.code) : "";
  const errors: Record<string, string> = {
    conflict: "This changed somewhere else. Refresh before editing again.",
    chapter_not_empty: "This chapter still has memories in it. Move them out first.",
    capacity: "You've hit the label limit. Remove a label or chapter to add another.",
    access_denied: "Couldn't confirm your access. Sign in again and refresh.",
    account_changed: "You switched accounts. Go back to your memories to check.",
    unavailable: "Couldn't load memories. Try again later.",
    invalid_request: "Check the year, timezone and labels, then try again.",
    source_unavailable: "This photo isn't available anymore. Refresh and choose another.",
    access_changed: "Photo access changed. Refresh before you continue.",
    busy: "An image is still processing. Wait a moment, then try again.",
    invalid_image: "Couldn't open this photo. Refresh and choose another.",
    timeout: "Image processing took too long. Try again with fewer photos.",
    render_failed: "Your browser couldn't make the image. Try again or choose fewer photos.",
    invalid_selection: "Choose 1 to 12 photos and check the recap title.",
    cancelled: "Cancelled.",
  };
  if (code === "rate_limited") return "Too many requests. Wait a minute, then try again.";
  return errors[code] ?? "No reply from the server. Check your connection and refresh before trying again.";
}
