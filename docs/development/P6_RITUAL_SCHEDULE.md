# Ritual recurrence foundation

Recorded 23/09/2026. `lib/memories/ritual-schedule.ts` is a pure scheduling primitive. It does not create reminders, modify existing photo dates, send notifications or implement a new database schema.

`RitualSchedule` requires policy `version:1`, an immutable `anchorDate` (ISO calendar day), `localTime` (24-hour HH:mm), an explicit IANA `timeZone`, daily/weekly/monthly/yearly `frequency`, interval 1–12, `paused`, and three explicit decisions:

- `invalidDate: clamp|skip`: clamp a missing monthly/yearly day to that month's last day, or omit that cycle.
- `gap: shift-forward|skip`: shift a nonexistent wall time by the actual offset gap, or omit that cycle.
- `fold: earlier|later`: choose one occurrence of a repeated wall time, never both.

These are explicit product choices, not inferred account location or process timezone. They follow the distinction between civil time and exact instants described in the [TC39 timezone documentation](https://tc39.es/proposal-temporal/docs/timezone.html). Shifting forward preserves the minutes across the actual gap, including Lord Howe's thirty-minute transition. Calendar clamping retains the original day for subsequent cycles, consistent with the [TC39 calendar overflow explanation](https://tc39.es/proposal-temporal/docs/calendars.html). The implementation uses native `Intl.DateTimeFormat`, not assumed Temporal availability or a new dependency.

`validateRitualSchedule` rejects unknown fields, accessors, invalid calendar days, unsupported policies and invalid zones. `nextRitualOccurrence(schedule,afterISO)` returns one occurrence strictly after the supplied exact instant, or null when paused or beyond the supported 1970–2199 calendar. There is no call to the current clock. Resume does not backfill missed reminders. The result records the recurrence cycle, selected calendar date, actual local date/time, UTC instant and clamp/gap/fold adjustments. All returned data is frozen.

The resolver samples offsets hourly within 48 hours either side of a requested wall time, validates each candidate against the requested local parts, and resolves only transitions up to one civil day. Unresolvable transitions throw rather than guessing. Calendar arithmetic uses UTC only as a Gregorian date calculator; it never uses process-local date setters. Search starts near the supplied cursor and examines at most 64 anchor cycles. This is deliberately bounded application support, not a replacement for an arbitrary calendar/RRULE engine.

Future authoritative reminder integration must persist the schedule's immutable anchor and policy version separately from its next UTC occurrence. A changed rule needs its own durable revision/generation for delivery deduplication. Do not replace the anchor with the previously clamped result. Store the chosen zone until an explicit user change, and stop future deliveries when paused, revoked or unpaired according to the parent lifecycle. The scheduling primitive itself establishes no membership or notification consent. Use one server timezone database version for authoritative decisions; operating-system/browser timezone data updates can change future civil-time rules.

Ten focused Node tests cover strict input, Sydney gap/fold, Lord Howe's thirty-minute gap/fold, New York, Kathmandu and Chatham offsets, January/month-end recovery, leap-day/year-2100 behaviour, intervals, pause/resume, Samoa's skipped date without duplicate instants, and independence from the process timezone. They do not prove a hosted reminder worker, email/push delivery, recipient consent, or future timezone-law changes.
