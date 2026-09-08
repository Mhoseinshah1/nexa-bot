import { describe, expect, it } from 'vitest';
import {
  contains,
  durationMs,
  instantSchema,
  isStorableInstant,
  overlaps,
  storableInstantOrNull,
  timePeriod,
  TimePeriodError,
} from '@nexa/contracts';

const at = (iso: string) => new Date(iso);

describe('TimePeriod', () => {
  it('is half-open: the end instant is outside the period', () => {
    // The legacy system has three separate date-boundary defects, all from
    // closed-interval arithmetic done independently in different places.
    const period = timePeriod(at('2026-01-01T00:00:00Z'), at('2026-02-01T00:00:00Z'));
    expect(contains(period, at('2026-01-01T00:00:00Z'))).toBe(true);
    expect(contains(period, at('2026-01-31T23:59:59.999Z'))).toBe(true);
    expect(contains(period, at('2026-02-01T00:00:00Z'))).toBe(false);
  });

  it('includes the final day of a month, unlike a closed range ending at 23:59:00', () => {
    const january = timePeriod(at('2026-01-01T00:00:00Z'), at('2026-02-01T00:00:00Z'));
    expect(contains(january, at('2026-01-31T23:59:30Z'))).toBe(true);
  });

  it('treats adjacent periods as non-overlapping', () => {
    const january = timePeriod(at('2026-01-01T00:00:00Z'), at('2026-02-01T00:00:00Z'));
    const february = timePeriod(at('2026-02-01T00:00:00Z'), at('2026-03-01T00:00:00Z'));
    // Comparison presets that overlap by a day double-count a day of revenue.
    expect(overlaps(january, february)).toBe(false);
  });

  it('detects genuine overlap in both directions', () => {
    const a = timePeriod(at('2026-01-01T00:00:00Z'), at('2026-02-01T00:00:00Z'));
    const b = timePeriod(at('2026-01-15T00:00:00Z'), at('2026-02-15T00:00:00Z'));
    expect(overlaps(a, b)).toBe(true);
    expect(overlaps(b, a)).toBe(true);
  });

  it('rejects an empty or inverted period', () => {
    const instant = at('2026-01-01T00:00:00Z');
    expect(() => timePeriod(instant, instant)).toThrow(TimePeriodError);
    expect(() => timePeriod(at('2026-02-01T00:00:00Z'), instant)).toThrow(TimePeriodError);
  });

  it('reports duration', () => {
    const period = timePeriod(at('2026-01-01T00:00:00Z'), at('2026-01-02T00:00:00Z'));
    expect(durationMs(period)).toBe(86_400_000);
  });
});

/**
 * The one range rule, and its boundaries.
 *
 * Three cursors each grew a private copy of this and each was wrong somewhere:
 * `/ops-log` had none, `/panels` had `^\d{4}-` on the cursor text, and
 * `/notifications` had `z.iso.datetime()`, which is a shape check. All three
 * accepted year 0000 — four digits, and PostgreSQL has no year zero — and
 * answered 500 for it. The integration suite pins the three endpoints; this
 * pins the RULE, at every boundary that decides it, because an endpoint test
 * proves the wiring and a boundary is what the wiring gets wrong.
 *
 * WHICH assertions discriminate, stated rather than implied: all ten values
 * discriminate for `isStorableInstant` and `storableInstantOrNull`. For
 * `instantSchema` only the two year-zero spellings do — the rest are refused
 * by the `z.iso.datetime()` union in front of the refinement and survive its
 * removal. They are there as the boundary either side, not as evidence for it,
 * and saying so is the difference between thirty assertions and fourteen plus
 * sixteen that cannot fail.
 */
describe('the storable-instant bound', () => {
  const accepted = [
    // The first instant PostgreSQL will take from this API, and the last.
    '0001-01-01T00:00:00.000Z',
    '9999-12-31T23:59:59.999Z',
    '2026-09-08T12:00:00.000Z',
  ];
  const refused = [
    // Year zero: FOUR digits, so a `^\d{4}-` check passes it, and
    // `date/time field value out of range` from PostgreSQL.
    '0000-01-01T00:00:00.000Z',
    '0000-12-31T23:59:59.999Z',
    // `+000000-…` normalises to `0000-…` rather than being rejected as
    // expanded, so it reaches the same hole by a second spelling.
    '+000000-01-01T00:00:00.000Z',
    // The expanded form, both directions, including the extremes of `Date`.
    '+275760-09-13T00:00:00.000Z',
    '-271821-04-20T00:00:00.000Z',
    '-005000-01-01T00:00:00.000Z',
    '+010000-01-01T00:00:00.000Z',
    '-000001-01-01T00:00:00.000Z',
    // Not an instant at all.
    'yesterday',
    '',
  ];

  it('accepts what PostgreSQL can store', () => {
    for (const value of accepted) {
      expect(isStorableInstant(new Date(value)), value).toBe(true);
      expect(storableInstantOrNull(value)?.toISOString(), value).toBe(
        new Date(value).toISOString(),
      );
      expect(instantSchema.safeParse(value).success, value).toBe(true);
    }
  });

  it('refuses what it cannot, including the four-digit year that is not a year', () => {
    for (const value of refused) {
      expect(isStorableInstant(new Date(value)), value).toBe(false);
      expect(storableInstantOrNull(value), value).toBeNull();
      expect(instantSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it('refuses an invalid Date rather than throwing on it', () => {
    // `toISOString()` throws on an Invalid Date, so the NaN guard has to come
    // first. A rule that throws where it should return false is a 500 by a
    // different route.
    expect(() => isStorableInstant(new Date('not a date'))).not.toThrow();
    expect(isStorableInstant(new Date(NaN))).toBe(false);
  });
});
