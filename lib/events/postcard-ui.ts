import { eventGuestError } from "./guest-runtime";

export function postcardError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (["journal_unavailable", "journal_blocked", "journal_invalid"].includes(String(code))) return "Device recovery could not be updated. An earlier request may already have succeeded. Check the postcard’s status before sending again. You can still withdraw your contribution.";
  return eventGuestError(error);
}
