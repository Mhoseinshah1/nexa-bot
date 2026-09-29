import { quietHoursContains } from '@nexa/contracts';
import {
  addDays,
  civilDateOf,
  localInstant,
  localInstants,
  wallTimeOf,
} from './report-calendar.js';

/**
 * A tenant's quiet window, resolved: two local minutes of the day and the zone they are
 * read in (HF-A9).
 */
export interface QuietWindow {
  /** Minute of the local day the window begins, `0`–`1439`. */
  readonly startMinute: number;
  /** Minute of the local day the window ends (exclusive), `0`–`1439`. */
  readonly endMinute: number;
  /** An IANA zone — `tenants.display_timezone`. */
  readonly timezone: string;
}

/**
 * The instant the quiet window holding `now` ends, or `null` when `now` is not inside it.
 *
 * The wall clock is ICU's, through the same helpers every report period uses
 * (`report-calendar.ts`), so "23:00 in Asia/Tehran" is the instant the tenant's own dates
 * are rendered against. Nothing here reads a clock: `now` is the caller's, from the `Clock`
 * port.
 *
 * The end is the FIRST INSTANT AFTER `now` at which the tenant's wall clock reads the end
 * time — looked for on the local date of `now` and the next one:
 *
 * - Inside a same-day window (`01:00`–`06:00`), that is today's.
 * - Inside a window that crosses midnight (`23:00`–`08:00`), it is tomorrow's when the
 *   clock is at or after the start, and today's when it is before the end.
 * - On a fall-back night the end time can occur TWICE (01:30 in New York on 1 November).
 *   During the repeated hour the clock has already read it once, so the answer is the
 *   later occurrence — never the earlier one, which is in the past and would send a
 *   reminder in a minute the window calls quiet (Codex review of PR #107).
 * - A minute is inside or outside as a whole: at `07:59:30` against an `08:00` end it is
 *   still quiet, and the answer is `08:00:00` local, thirty seconds away.
 *
 * A wall time a spring-forward gap swallows has no exact instant; it resolves as
 * `localInstant` resolves it, to the first instant after the gap. `null` when even that is
 * not after `now`: the reminder is sent now rather than deferred to an instant already
 * passed, which would bring it straight back on the next pass anyway.
 */
export function quietHoursEnd(now: Date, window: QuietWindow): Date | null {
  const { hour, minute } = wallTimeOf(now, window.timezone);
  const minuteOfDay = hour * 60 + minute;
  if (!quietHoursContains(minuteOfDay, window.startMinute, window.endMinute)) return null;

  const presentation = { timezone: window.timezone, calendar: 'gregorian' as const };
  const today = civilDateOf(now, presentation);
  const endHour = Math.floor(window.endMinute / 60);
  const endMinuteOfHour = window.endMinute % 60;
  const after = [today, addDays(today, 1, 'gregorian')]
    .flatMap((date) => {
      const exact = localInstants(date, endHour, presentation, endMinuteOfHour);
      return exact.length > 0
        ? exact
        : [localInstant(date, endHour, presentation, endMinuteOfHour)];
    })
    .filter((end) => end.getTime() > now.getTime())
    .sort((a, b) => a.getTime() - b.getTime());
  return after[0] ?? null;
}
