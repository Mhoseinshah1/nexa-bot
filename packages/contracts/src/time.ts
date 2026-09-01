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
