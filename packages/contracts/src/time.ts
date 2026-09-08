import { z } from 'zod';

/**
 * Time.
 *
 * Every instant is stored as `timestamptz` in UTC. Display timezone and
 * calendar are presentation concerns carried on the tenant.
 *
 * Every reporting interval is HALF-OPEN: `[start, end)`. The legacy system has
 * three separate date-boundary defects — a previous-month range that drops its
 * own final day, comparison presets that overlap by a day, and custom ranges
 * that stop at 23:59:00 — and all three are closed-interval arithmetic done
 * independently in different places. No module computes its own date range.
 */

export type Instant = Date;

/**
 * Whether PostgreSQL's `timestamptz` would accept this instant.
 *
 * ONE place, because the rule has now been written three times and been wrong
 * in all three. A JavaScript `Date` spans ±271821 years and `timestamptz` does
 * not, so a caller-controlled instant that merely PARSES still reaches the
 * driver and raises `22008` — a 500 on a bad request. Three cursors each grew
 * their own version of the guard:
 *
 *   - `/ops-log` had none at all and answered 500 for five shapes.
 *   - `/panels` had `^\d{4}-` on the cursor's text.
 *   - `/notifications` had `z.iso.datetime()`, which is not a range check.
 *
 * And the round that fixed the first two copied `^\d{4}-` into the third,
 * with a docblock asserting it "covers both directions and every spelling".
 * It does not: `new Date('0000-01-01T00:00:00Z').toISOString()` is
 * `'0000-01-01T00:00:00.000Z'` — FOUR DIGITS, not the expanded `±YYYYYY` form
 * — and PostgreSQL has no year zero:
 *
 *     ERROR:  date/time field value out of range: "0000-01-01T00:00:00.000Z"
 *
 * That is a ~366-day window of caller-controlled values that answered 500 on
 * all three cursors, INCLUDING the two the fix cited as correct prior art.
 *
 * So the predicate lives here, in the frozen contract, beside the type it
 * bounds — a rule three surfaces need is not a rule any one of them owns. The
 * bound is year 0001-9999: `toISOString` renders everything outside it in the
 * expanded form, and year 0000 is the single four-digit rendering PostgreSQL
 * refuses. Narrower than `timestamptz`'s true range (4713 BC - 294276 AD) and
 * deliberately so: no correct caller of this API sends a BC instant, and a
 * bound that is easy to state is a bound that stays right.
 */
export function isStorableInstant(at: Instant): boolean {
  if (Number.isNaN(at.getTime())) return false;
  const iso = at.toISOString();
  // Anchored, and `0000` excluded explicitly rather than by arithmetic on the
  // year: the expanded form carries a leading `+` or `-`, so a plain
  // four-digit prefix is exactly "inside 0001-9999 or year zero", and year
  // zero is the one this has to subtract.
  return /^\d{4}-/.test(iso) && !iso.startsWith('0000-');
}

/**
 * The instant this text denotes, or null if it is not one this API can store.
 *
 * The text form of `isStorableInstant`, for the surfaces that receive a query
 * parameter rather than a `Date`.
 */
export function storableInstantOrNull(value: string): Instant | null {
  const at = new Date(value);
  return isStorableInstant(at) ? at : null;
}

export const instantSchema = z
  .union([z.iso.datetime({ offset: true }), z.iso.datetime()])
  .transform((value) => new Date(value));

/** A half-open interval `[start, end)`. `end` is never included. */
export interface TimePeriod {
  readonly start: Instant;
  readonly end: Instant;
}

export const timePeriodSchema = z
  .object({ start: instantSchema, end: instantSchema })
  .refine((p) => p.start.getTime() < p.end.getTime(), {
    message: 'start must be strictly before end',
  });

export class TimePeriodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimePeriodError';
  }
}

export function timePeriod(start: Instant, end: Instant): TimePeriod {
  if (!(start.getTime() < end.getTime())) {
    throw new TimePeriodError(
      `A period must satisfy start < end; received ${start.toISOString()} .. ${end.toISOString()}.`,
    );
  }
  return { start, end };
}

/** `[start, end)` — the end instant itself is outside the period. */
export function contains(period: TimePeriod, at: Instant): boolean {
  const t = at.getTime();
  return t >= period.start.getTime() && t < period.end.getTime();
}

/** Two half-open periods overlap only if they share at least one instant. */
export function overlaps(a: TimePeriod, b: TimePeriod): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

export function durationMs(period: TimePeriod): number {
  return period.end.getTime() - period.start.getTime();
}

export const NAMED_PERIODS = [
  'TODAY',
  'YESTERDAY',
  'LAST_7_DAYS',
  'LAST_30_DAYS',
  'THIS_MONTH',
  'PREVIOUS_MONTH',
  'THIS_YEAR',
  'ALL_TIME',
] as const;
export type NamedPeriod = (typeof NAMED_PERIODS)[number];

export const CALENDARS = ['gregorian', 'jalali'] as const;
export type Calendar = (typeof CALENDARS)[number];

/**
 * Resolves named periods into half-open intervals in a tenant's display
 * timezone and calendar. Implemented in infrastructure; declared here so that
 * exactly one implementation exists and every report shares it.
 */
export interface TimePeriodResolver {
  resolve(named: NamedPeriod, options: { timezone: string; calendar: Calendar }): TimePeriod;
  /**
   * Builds a half-open period from inclusive local calendar dates. The end date
   * is expanded to the start of the following day, so a range ending "today"
   * includes all of today.
   */
  fromLocalDates(
    startDate: string,
    endDateInclusive: string,
    options: { timezone: string; calendar: Calendar },
  ): TimePeriod;
}

/**
 * The clock port.
 *
 * Domain and application code never reads the wall clock directly; a lint rule
 * rejects `new Date()` and `Date.now()` in those layers. Infrastructure supplies
 * a system clock; tests supply a fixed one.
 */
export interface Clock {
  now(): Instant;
}
