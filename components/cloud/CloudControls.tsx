import { ArrowLeft } from "lucide-react";

export const cloudControl = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50";
export const cloudInput = "min-h-11 w-full rounded-xl border border-border bg-card px-3 text-base outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
export const cloudSize = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toLocaleString("en-AU", { maximumFractionDigits: 1 })} KiB` : `${(bytes / 1024 / 1024).toLocaleString("en-AU", { maximumFractionDigits: 1 })} MiB`;
export function cloudError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : "";
  if (code === "account_changed") return "You switched accounts. Sign back in to the same account and refresh.";
  if (code === "access_denied") return "You don't have access to this anymore. Refresh the library.";
  if (code === "rate_limited") return "Too many requests. Wait a minute, then try again.";
  if (code === "capacity") return "There isn't enough cloud space for this. Try something smaller.";
  if (code === "conflict") return "This project changed while you were working. Refresh to see the latest.";
  if (code === "invalid_request") return "Something's wrong with that file or project. Check it and try again.";
  return "Couldn't reach the cloud. Try again.";
}
export function CloudBack({ disabled, onBack }: { disabled: boolean; onBack(): void }) {
  return <button className={`${cloudControl} -ml-4 mb-4`} disabled={disabled} onClick={onBack}><ArrowLeft size={16} aria-hidden /> Cloud library</button>;
}
