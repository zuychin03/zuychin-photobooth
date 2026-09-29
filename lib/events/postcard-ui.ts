import { eventGuestError } from "./guest-runtime";

export function postcardError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (["journal_unavailable", "journal_blocked", "journal_invalid"].includes(String(code))) return "This browser couldn't save your progress. Your last request may have worked, so check the postcard before you send again.";
  return eventGuestError(error);
}
