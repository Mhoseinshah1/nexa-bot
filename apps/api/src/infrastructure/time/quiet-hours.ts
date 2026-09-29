import { quietHoursContains } from '@nexa/contracts';
import { addDays, civilDateOf, localInstant, wallTimeOf } from './report-calendar.js';

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
 * are rendered against, and a daylight-saving change is resolved the way the day-of expiry
 * rung and every report resolve it. Nothing here reads a clock: `now` is the caller's, from
 * the `Clock` port.
 *
 * - Inside a same-day window (`01:00`–`06:00`), the end is today's.
 * - Inside a window that crosses midnight (`23:00`–`08:00`), the end is TOMORROW's when the
 *   clock is at or after the start, and today's when it is before the end.
 * - A minute is inside or outside as a whole: at `07:59:30` against an `08:00` end it is
 *   still quiet, and the answer is `08:00:00` local, thirty seconds away.
 *
 * `null` too when the computed end is not after `now`. That can only happen on a
 * daylight-saving change that swallows the end's wall time; answering `null` sends the
 * reminder now rather than deferring it to an instant already passed, which would bring it
 * straight back on the next pass anyway.
 */
export function quietHoursEnd(now: Date, window: QuietWindow): Date | null {
  const { hour, minute } = wallTimeOf(now, window.timezone);
  const minuteOfDay = hour * 60 + minute;
  if (!quietHoursContains(minuteOfDay, window.startMinute, window.endMinute)) return null;

  const presentation = { timezone: window.timezone, calendar: 'gregorian' as const };
  const today = civilDateOf(now, presentation);
  const crossesMidnight = window.startMinute > window.endMinute;
  const endsTomorrow = crossesMidnight && minuteOfDay >= window.startMinute;
  const endDate = endsTomorrow ? addDays(today, 1, 'gregorian') : today;
  const end = localInstant(
    endDate,
    Math.floor(window.endMinute / 60),
    presentation,
    window.endMinute % 60,
  );
  return end.getTime() > now.getTime() ? end : null;
}
