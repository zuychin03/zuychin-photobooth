// ISO-week key (year * 100 + week) so consecutive weeks differ by 1 within a year.
export function weekKey(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return date.getUTCFullYear() * 100 + week;
}

function prevWeek(key: number): number {
  const year = Math.floor(key / 100);
  const week = key % 100;
  if (week > 1) return year * 100 + (week - 1);
  // step into the last ISO week of the previous year (52 or 53)
  const lastWeek = weekKey(new Date(Date.UTC(year - 1, 11, 28)));
  return lastWeek;
}

/**
 * Consecutive weeks (ending this week or last week) that have at least one
 * saved strip. Allowing "last week" keeps the streak alive until the week ends.
 */
export function weeklyStreak(dates: string[]): number {
  if (dates.length === 0) return 0;
  const weeks = new Set(dates.map((d) => weekKey(new Date(d))));
  const thisWeek = weekKey(new Date());
  let cursor = weeks.has(thisWeek) ? thisWeek : prevWeek(thisWeek);
  if (!weeks.has(cursor)) return 0;
  let streak = 0;
  while (weeks.has(cursor)) {
    streak++;
    cursor = prevWeek(cursor);
  }
  return streak;
}

/** Monday 00:00 (local) of the ISO week containing `d`. */
export function startOfIsoWeek(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay() || 7;
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - (day - 1));
  return date;
}

export function sameIsoWeek(a: Date, b: Date): boolean {
  return weekKey(a) === weekKey(b);
}
