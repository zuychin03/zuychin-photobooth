// The shared vault holds a couple's strips for the current ISO week only. When a
// new week starts, the retention cron (app/api/retention) clears the vault:
// kept strips and weekly recaps are archived to Cloudinary first, and
// everything else is deleted. A couple may save at most WEEKLY_STRIP_CAP
// non-recap strips per ISO week.

import { startOfIsoWeek } from "./streak";

const DAY_MS = 86_400_000;

/** Max non-recap strips a couple may save to the vault in one ISO week. */
export const WEEKLY_STRIP_CAP = 10;

/** Strips created before the current ISO week are cleared on the next pass. */
export function weeklyResetCutoffIso(now: Date = new Date()): string {
  return startOfIsoWeek(now).toISOString();
}

type RetainFields = { kept: boolean; layout_id: string | null };

/** A strip the weekly clear archives to Cloudinary instead of deleting. */
export function isRetained(s: RetainFields): boolean {
  return s.kept || s.layout_id === "recap";
}

/** Whole days until this week's vault clears; null for archived strips (kept or
 *  recap), 0 when the reset is due. Every non-archived strip shares one reset
 *  date — the start of next ISO week — so the count is the same for all. */
export function daysUntilPurge(
  s: RetainFields,
  now: Date = new Date(),
): number | null {
  if (isRetained(s)) return null;
  const nextReset = startOfIsoWeek(now).getTime() + 7 * DAY_MS;
  const ms = nextReset - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS);
}
