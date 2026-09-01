import { describe, expect, it } from 'vitest';
import { contains, durationMs, overlaps, timePeriod, TimePeriodError } from '@nexa/contracts';

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
