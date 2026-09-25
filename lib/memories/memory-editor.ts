import type { MemoryActivity } from "./activity-contract";

export const memoryAvailability = {
  available: "Photo available", archived: "Archived photo available", archive_pending: "Archive being checked",
  expired: "Photo expired", deleted: "Photo deleted", unknown: "Availability not confirmed", access_lost: "Photo access ended",
} as const;
export function memorySelectable(item: MemoryActivity) { return Boolean(item.source && ["available", "archived"].includes(item.availability)); }
export function memoryDate(item: MemoryActivity, timeZone: string) { return new Intl.DateTimeFormat("en-AU", { timeZone, day: "numeric", month: "short", year: "numeric" }).format(new Date(item.occurredAt)); }
export function memoryProvenance(item: MemoryActivity) { return item.provenance === "saved_at" ? "Saved" : item.provenance === "verified_at" ? "Upload verified" : "Original record created"; }
export function memoryError(failure: unknown) {
  const code = failure && typeof failure === "object" && "code" in failure ? String(failure.code) : "";
  const errors: Record<string, string> = {
    conflict: "This memory or chapter changed elsewhere. Refresh to see the current details before editing again.",
    chapter_not_empty: "This chapter still has memories. Remove their chapter labels before deleting it.",
    capacity: "The saved label limit has been reached. Remove an unused label or chapter before adding another.",
    access_denied: "Your access could not be confirmed. Sign in again, then refresh your memories.",
    account_changed: "Your account changed. Return to your memories to check the current account.",
    unavailable: "Memories could not be loaded. Try again when the service and your connection are available.",
    invalid_request: "Check the year, timezone and labels, then try again.",
    source_unavailable: "This photo is no longer available. Refresh your memories and choose another photo.",
    access_changed: "Photo access changed. Refresh your memories before continuing.",
    busy: "An image is still being processed. Give it a moment, then try again.",
    invalid_image: "This photo could not be decoded. Refresh your memories and choose another photo.",
    timeout: "Image processing took too long. Try again with fewer photos.",
    render_failed: "This browser could not prepare the image. Try again or choose fewer photos.",
    invalid_selection: "Choose 1 to 12 different available photos and check the recap title.",
    cancelled: "This operation was cancelled.",
  };
  if (code === "rate_limited") return "Too many requests arrived together. Wait a minute, then try again.";
  return errors[code] ?? "The operation could not be confirmed. Check your connection and refresh before trying again.";
}
