// Supabase Storage keeps a couple's strips for one week, then a cron purge
// (app/api/retention) removes them to keep storage small. Two escapes: a strip
// the owner marks "kept", and weekly recaps (the whole-week keepsake).

export const RETENTION_DAYS = 7;

const DAY_MS = 86_400_000;

export function retentionCutoffIso(now: Date = new Date()): string {
  return new Date(now.getTime() - RETENTION_DAYS * DAY_MS).toISOString();
}

type RetainFields = { kept: boolean; layout_id: string | null };

/** A strip the purge must never touch. */
export function isRetained(s: RetainFields): boolean {
  return s.kept || s.layout_id === "recap";
}

/** Whole days until a strip is purged; null when it is retained, 0 when due. */
export function daysUntilPurge(
  s: RetainFields & { created_at: string },
  now: Date = new Date(),
): number | null {
  if (isRetained(s)) return null;
  const ms = new Date(s.created_at).getTime() + RETENTION_DAYS * DAY_MS - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS);
}
