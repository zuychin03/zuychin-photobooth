import { ArrowLeft } from "lucide-react";

export const cloudControl = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50";
export const cloudInput = "min-h-11 w-full rounded-xl border border-border bg-card px-3 text-base outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
export const cloudSize = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toLocaleString("en-AU", { maximumFractionDigits: 1 })} KiB` : `${(bytes / 1024 / 1024).toLocaleString("en-AU", { maximumFractionDigits: 1 })} MiB`;
export function cloudError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : "";
  if (code === "account_changed") return "Your active account changed. Sign in with the same account and refresh before continuing.";
  if (code === "access_denied") return "This project or original is no longer available to this account. Refresh the library to check your current access.";
  if (code === "rate_limited") return "There have been too many requests. Wait a minute, then try again.";
  if (code === "capacity") return "There is not enough cloud space for this action. Keep your local copy and try a smaller project.";
  if (code === "conflict") return "This project changed while you were working. Refresh to see its current state.";
  if (code === "invalid_request") return "The file or project details could not be accepted. Check them before trying again.";
  return "The cloud connection could not finish. Keep your local files and try again.";
}
export function CloudBack({ disabled, onBack }: { disabled: boolean; onBack(): void }) {
  return <button className={`${cloudControl} -ml-4 mb-4`} disabled={disabled} onClick={onBack}><ArrowLeft size={16} aria-hidden /> Cloud library</button>;
}
