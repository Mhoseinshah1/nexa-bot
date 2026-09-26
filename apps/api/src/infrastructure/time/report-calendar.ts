import {
  CONTROL_ERROR_CODES,
  REPORT_CUSTOM_RANGE_MAX_DAYS,
  errors,
  reportGranularityFor,
  timePeriod,
  type Calendar,
  type NamedPeriod,
  type ReportGranularity,
  type ReportRange,
  type TimePeriod,
  type TimePeriodResolver,
} from '@nexa/contracts';

/**
 * Report periods in a tenant's timezone and calendar (`docs/wp12-business-analytics-audit.md` §3).
 *
 * The ONE implementation of `TimePeriodResolver` (`time.ts`: "No module computes its own
 * date range"), plus the reporting shape built on it: the previous period, the
 * like-for-like comparison cut, and the aligned chart buckets.
 *
 * The calendar arithmetic is ICU's, through `Intl` — the same `-u-ca-persian` calendar
 * `@nexa/i18n` renders every Jalali date with — and none of it is hand-written: a Jalali
 * date is found by asking ICU which Gregorian day it names, and a local midnight by asking
 * ICU what the wall clock reads at an instant. The only arithmetic here is on whole UTC
 * days, where there is no calendar to get wrong.
 *
 * Every instant this returns is a half-open boundary `[start, end)` in UTC. Nothing
 * downstream applies a time zone again: SQL compares `timestamptz` against these values.
 */

const DAY_MS = 86_400_000;

/** A date as a calendar names it. `month` is 1-based in both calendars. */
export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface ReportPresentation {
  readonly timezone: string;
  readonly calendar: Calendar;
}

export interface ReportBucketBounds {
  readonly index: number;
  readonly start: Date;
  readonly end: Date;
  readonly label: string;
}

export interface ReportPeriodSide {
  readonly start: Date;
  readonly end: Date;
  /** Where figures stop: `end`, or the like-for-like cut for a period still running. */
  readonly effectiveEnd: Date;
  readonly startLocal: CivilDate;
  readonly endLocalInclusive: CivilDate;
  readonly localDays: number;
  readonly buckets: readonly ReportBucketBounds[];
}

export interface ResolvedReportPeriod {
  readonly range: ReportRange;
  readonly timezone: string;
  readonly calendar: Calendar;
  readonly granularity: ReportGranularity;
  readonly current: ReportPeriodSide;
  readonly previous: ReportPeriodSide;
  readonly lengthsDiffer: boolean;
  readonly now: Date;
}

export interface ReportRangeInput {
  readonly range: ReportRange;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

// --- ICU access ---------------------------------------------------------------

const LOCALE: Readonly<Record<Calendar, string>> = {
  // The calendars `@nexa/i18n` presents with, Latin digits pinned so the parts parse.
  jalali: 'fa-IR-u-ca-persian-nu-latn',
  gregorian: 'fa-IR-u-ca-gregory-nu-latn',
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(calendar: Calendar, timezone: string, withTime: boolean): Intl.DateTimeFormat {
  const key = `${calendar}|${timezone}|${withTime ? 't' : 'd'}`;
  let found = formatters.get(key);
  if (found === undefined) {
    found = new Intl.DateTimeFormat(LOCALE[calendar], {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      ...(withTime
        ? { hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' as const }
        : {}),
    });
    formatters.set(key, found);
  }
  return found;
}

interface WallClock extends CivilDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function partsOf(at: Date, calendar: Calendar, timezone: string, withTime: boolean): WallClock {
  const out = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of formatter(calendar, timezone, withTime).formatToParts(at)) {
    if (part.type in out) out[part.type as keyof typeof out] = Number(part.value);
  }
  return out;
}

/** The calendar date an instant falls on, in a zone. */
export function civilDateOf(at: Date, presentation: ReportPresentation): CivilDate {
  const { year, month, day } = partsOf(at, presentation.calendar, presentation.timezone, false);
  return { year, month, day };
}

/**
 * The Gregorian day (as a UTC-midnight day number) a civil date names.
 *
 * Gregorian is direct. Jalali asks ICU: start from an estimate a day or two off (Farvardin
 * 1 falls on 20 or 21 March, and the first six months have 31 days), read back what ICU
 * calls that day, and move by the difference until ICU names the target. The loop is
 * bounded; a date ICU never names (the 31st of Mehr) is refused rather than rounded.
 */
function utcDayOf(date: CivilDate, calendar: Calendar): number {
  if (calendar === 'gregorian') {
    const day = Date.UTC(date.year, date.month - 1, date.day) / DAY_MS;
    const back = civilOfUtcDay(day, 'gregorian');
    if (!sameDate(back, date)) throw invalidDate(date);
    return day;
  }
  const offset = date.month <= 7 ? (date.month - 1) * 31 : 186 + (date.month - 7) * 30;
  let day = Date.UTC(date.year + 621, 2, 21) / DAY_MS + offset + date.day - 1;
  for (let step = 0; step < 8; step += 1) {
    const seen = civilOfUtcDay(day, calendar);
    if (sameDate(seen, date)) return day;
    const delta = ordinal(date) - ordinal(seen);
    day += delta === 0 ? 1 : delta;
  }
  throw invalidDate(date);
}

/** A comparable position within a calendar: exact inside a year, close enough across one. */
function ordinal(date: CivilDate): number {
  return date.year * 372 + (date.month - 1) * 31 + date.day;
}

function civilOfUtcDay(day: number, calendar: Calendar): CivilDate {
  // Noon UTC: the day ICU names at noon is that UTC day, whatever the calendar.
  const {
    year,
    month,
    day: dom,
  } = partsOf(new Date(day * DAY_MS + DAY_MS / 2), calendar, 'UTC', false);
  return { year, month, day: dom };
}

function sameDate(a: CivilDate, b: CivilDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function invalidDate(date: CivilDate): Error {
  return errors.validation(
    CONTROL_ERROR_CODES.INVALID_VALUE,
    `${formatLocalDate(date, '-')} is not a date in the tenant calendar.`,
    { date: formatLocalDate(date, '-') },
  );
}

/** A civil date moved by whole days, in its own calendar. */
export function addDays(date: CivilDate, days: number, calendar: Calendar): CivilDate {
  return civilOfUtcDay(utcDayOf(date, calendar) + days, calendar);
}

/** The first day of the month `months` away from this date's month. Both calendars have twelve. */
function monthStart(date: CivilDate, months: number): CivilDate {
  const index = date.year * 12 + (date.month - 1) + months;
  return { year: Math.floor(index / 12), month: (index % 12) + 1, day: 1 };
}

function daysBetween(from: CivilDate, to: CivilDate, calendar: Calendar): number {
  return utcDayOf(to, calendar) - utcDayOf(from, calendar);
}

/**
 * The instant a zone's wall clock reads `hour:00` on a civil date.
 *
 * Asked of ICU, twice: the zone's offset at a first guess, then at the corrected guess, so a
 * date on which the offset changes lands on the right side of it. A wall time that does not
 * exist (a spring-forward gap) resolves to the first instant after it.
 */
export function localInstant(
  date: CivilDate,
  hour: number,
  presentation: ReportPresentation,
): Date {
  const naive = utcDayOf(date, presentation.calendar) * DAY_MS + hour * 3_600_000;
  const wallAt = (at: number): number => {
    const wall = partsOf(new Date(at), 'gregorian', presentation.timezone, true);
    return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  };
  const offsetAt = (at: number): number => wallAt(at) - Math.floor(at / 1000) * 1000;
  // The two offsets that can apply: the one at the naive guess, and the one at the instant
  // that guess names. They differ only on a date whose offset changes near this hour.
  const candidates = [
    ...new Set([naive - offsetAt(naive), naive - offsetAt(naive - offsetAt(naive))]),
  ];
  // A wall time that exists: its earliest instant (a fall-back hour occurs twice).
  const exact = candidates.filter((at) => wallAt(at) === naive);
  if (exact.length > 0) return new Date(Math.min(...exact));
  /*
   * A wall time that does not exist — a spring-forward gap, which in some zones swallows
   * midnight itself. The first instant after the gap is the requested wall time read with
   * the offset in force BEFORE the change, which is the later candidate. The earlier one
   * reads as the previous civil day, and would move the day's start an hour early.
   */
  return new Date(Math.max(...candidates));
}

function midnight(date: CivilDate, presentation: ReportPresentation): Date {
  return localInstant(date, 0, presentation);
}

// --- Labels -------------------------------------------------------------------

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** `1405/07/03`, or with another separator `1405-07-03`. Latin digits, tenant calendar. */
export function formatLocalDate(date: CivilDate, separator = '/'): string {
  return [pad(date.year, 4), pad(date.month), pad(date.day)].join(separator);
}

/** A local date as the wire and a custom range spell it: `YYYY-MM-DD`. */
export function parseLocalDate(text: string): CivilDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) {
    throw errors.validation(CONTROL_ERROR_CODES.INVALID_VALUE, 'A date is YYYY-MM-DD.', {
      date: text,
    });
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

// --- Resolution ---------------------------------------------------------------

interface Span {
  readonly start: CivilDate;
  /** Exclusive: the day after the last one included. */
  readonly end: CivilDate;
}

function spansFor(
  input: ReportRangeInput,
  today: CivilDate,
  calendar: Calendar,
): { current: Span; previous: Span } {
  const days = (from: CivilDate, n: number): CivilDate => addDays(from, n, calendar);
  const lastDays = (n: number): { current: Span; previous: Span } => {
    const start = days(today, -(n - 1));
    return {
      current: { start, end: days(today, 1) },
      previous: { start: days(start, -n), end: start },
    };
  };
  switch (input.range) {
    case 'TODAY':
      return lastDays(1);
    case 'YESTERDAY': {
      const start = days(today, -1);
      return {
        current: { start, end: today },
        previous: { start: days(today, -2), end: start },
      };
    }
    case 'LAST_7_DAYS':
      return lastDays(7);
    case 'LAST_30_DAYS':
      return lastDays(30);
    case 'THIS_MONTH':
      return {
        current: { start: monthStart(today, 0), end: monthStart(today, 1) },
        previous: { start: monthStart(today, -1), end: monthStart(today, 0) },
      };
    case 'PREVIOUS_MONTH':
      return {
        current: { start: monthStart(today, -1), end: monthStart(today, 0) },
        previous: { start: monthStart(today, -2), end: monthStart(today, -1) },
      };
    case 'THIS_YEAR': {
      const start: CivilDate = { year: today.year, month: 1, day: 1 };
      return {
        current: { start, end: { year: today.year + 1, month: 1, day: 1 } },
        previous: { start: { year: today.year - 1, month: 1, day: 1 }, end: start },
      };
    }
    case 'CUSTOM': {
      if (input.from === undefined || input.to === undefined) {
        throw errors.validation(
          CONTROL_ERROR_CODES.INVALID_VALUE,
          'A CUSTOM range needs from and to.',
          {},
        );
      }
      const from = parseLocalDate(input.from);
      const to = parseLocalDate(input.to);
      // Round-trips through ICU, so a date the calendar does not have is refused here.
      const length = daysBetween(from, to, calendar) + 1;
      if (length < 1 || length > REPORT_CUSTOM_RANGE_MAX_DAYS) {
        throw errors.validation(
          CONTROL_ERROR_CODES.INVALID_VALUE,
          `A custom range runs forward, from 1 to ${REPORT_CUSTOM_RANGE_MAX_DAYS} days.`,
          { from: input.from, to: input.to },
        );
      }
      const end = days(to, 1);
      return {
        current: { start: from, end },
        previous: { start: days(from, -length), end: from },
      };
    }
    default: {
      const unreachable: never = input.range;
      throw new Error(`unknown report range ${String(unreachable)}`);
    }
  }
}

function buckets(
  span: Span,
  granularity: ReportGranularity,
  presentation: ReportPresentation,
): ReportBucketBounds[] {
  const { calendar } = presentation;
  const end = midnight(span.end, presentation);
  const out: ReportBucketBounds[] = [];
  const push = (start: Date, stop: Date, label: string): void => {
    if (start.getTime() < stop.getTime()) {
      out.push({ index: out.length, start, end: stop, label });
    }
  };

  switch (granularity) {
    case 'HOUR': {
      for (
        let day = span.start;
        daysBetween(day, span.end, calendar) > 0;
        day = addDays(day, 1, calendar)
      ) {
        for (let hour = 0; hour < 24; hour += 1) {
          const stop =
            hour === 23
              ? midnight(addDays(day, 1, calendar), presentation)
              : localInstant(day, hour + 1, presentation);
          push(localInstant(day, hour, presentation), stop, `${pad(hour)}:00`);
        }
      }
      return out;
    }
    case 'DAY': {
      for (
        let day = span.start;
        daysBetween(day, span.end, calendar) > 0;
        day = addDays(day, 1, calendar)
      ) {
        push(
          midnight(day, presentation),
          midnight(addDays(day, 1, calendar), presentation),
          formatLocalDate(day),
        );
      }
      return out;
    }
    case 'WEEK': {
      for (
        let day = span.start;
        daysBetween(day, span.end, calendar) > 0;
        day = addDays(day, 7, calendar)
      ) {
        const next = addDays(day, 7, calendar);
        const stopDay = daysBetween(next, span.end, calendar) < 0 ? span.end : next;
        push(
          midnight(day, presentation),
          midnight(stopDay, presentation),
          `${formatLocalDate(day)}–${formatLocalDate(addDays(stopDay, -1, calendar))}`,
        );
      }
      return out;
    }
    case 'MONTH': {
      const first = midnight(span.start, presentation);
      for (
        let month = monthStart(span.start, 0);
        daysBetween(month, span.end, calendar) > 0;
        month = monthStart(month, 1)
      ) {
        const next = monthStart(month, 1);
        const start = midnight(month, presentation);
        const stop = midnight(next, presentation);
        push(
          start.getTime() < first.getTime() ? first : start,
          stop.getTime() > end.getTime() ? end : stop,
          `${pad(month.year, 4)}/${pad(month.month)}`,
        );
      }
      return out;
    }
    default: {
      const unreachable: never = granularity;
      throw new Error(`unknown granularity ${String(unreachable)}`);
    }
  }
}

/**
 * The period, its previous equivalent and their buckets.
 *
 * The previous period is the same span one unit back (a day, N days, a calendar month or
 * year). When the current period contains `now`, both are cut like for like: the current
 * at `now`, the previous at the same elapsed duration from its own start. Buckets of both
 * use the CURRENT period's granularity, so bucket `i` is comparable with bucket `i`.
 */
export function resolveReportPeriod(
  input: ReportRangeInput,
  now: Date,
  presentation: ReportPresentation,
): ResolvedReportPeriod {
  const { calendar } = presentation;
  const today = civilDateOf(now, presentation);
  const spans = spansFor(input, today, calendar);
  const localDays = daysBetween(spans.current.start, spans.current.end, calendar);
  const previousDays = daysBetween(spans.previous.start, spans.previous.end, calendar);
  const granularity = reportGranularityFor(localDays);

  const start = midnight(spans.current.start, presentation);
  const end = midnight(spans.current.end, presentation);
  const previousStart = midnight(spans.previous.start, presentation);
  const previousEnd = midnight(spans.previous.end, presentation);

  const t = now.getTime();
  const running = t >= start.getTime() && t < end.getTime();
  const effectiveEnd = running ? now : t < start.getTime() ? start : end;
  const elapsed = effectiveEnd.getTime() - start.getTime();
  const previousEffectiveEnd = running
    ? new Date(Math.min(previousEnd.getTime(), previousStart.getTime() + elapsed))
    : previousEnd;

  const side = (span: Span, s: Date, e: Date, cut: Date, days: number): ReportPeriodSide => ({
    start: s,
    end: e,
    effectiveEnd: cut,
    startLocal: span.start,
    endLocalInclusive: addDays(span.end, -1, calendar),
    localDays: days,
    buckets: buckets(span, granularity, presentation),
  });

  return {
    range: input.range,
    timezone: presentation.timezone,
    calendar,
    granularity,
    current: side(spans.current, start, end, effectiveEnd, localDays),
    previous: side(spans.previous, previousStart, previousEnd, previousEffectiveEnd, previousDays),
    lengthsDiffer: localDays !== previousDays,
    now,
  };
}

/**
 * The contracts' `TimePeriodResolver`, over the same arithmetic.
 *
 * Declared in Phase 0 so that exactly one implementation would exist; this is it. A clock
 * is injected rather than read, for the reason `Clock` exists.
 */
export class IntlTimePeriodResolver implements TimePeriodResolver {
  constructor(private readonly clock: { now(): Date }) {}

  resolve(named: NamedPeriod, options: ReportPresentation): TimePeriod {
    const now = this.clock.now();
    if (named === 'ALL_TIME') {
      return timePeriod(
        new Date(Date.UTC(1, 0, 1)),
        midnight(addDays(civilDateOf(now, options), 1, options.calendar), options),
      );
    }
    const period = resolveReportPeriod({ range: named }, now, options);
    return timePeriod(period.current.start, period.current.end);
  }

  fromLocalDates(
    startDate: string,
    endDateInclusive: string,
    options: ReportPresentation,
  ): TimePeriod {
    const start = parseLocalDate(startDate);
    const end = addDays(parseLocalDate(endDateInclusive), 1, options.calendar);
    return timePeriod(midnight(start, options), midnight(end, options));
  }
}

/** `1405/07/03 14:05` — an instant as the tenant's wall clock and calendar read it. */
export function formatLocalDateTime(at: Date, presentation: ReportPresentation): string {
  const p = partsOf(at, presentation.calendar, presentation.timezone, true);
  return `${formatLocalDate(p)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** The reporting service's port, over the functions above. */
export class IntlReportPeriodResolver {
  resolve(
    input: ReportRangeInput,
    now: Date,
    presentation: ReportPresentation,
  ): ResolvedReportPeriod {
    return resolveReportPeriod(input, now, presentation);
  }

  formatLocalDate(date: CivilDate, separator = '/'): string {
    return formatLocalDate(date, separator);
  }

  formatLocalDateTime(at: Date, presentation: ReportPresentation): string {
    return formatLocalDateTime(at, presentation);
  }
}
