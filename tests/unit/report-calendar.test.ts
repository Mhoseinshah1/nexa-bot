import { describe, expect, it } from 'vitest';
import {
  IntlTimePeriodResolver,
  addDays,
  civilDateOf,
  formatLocalDate,
  localInstant,
  resolveReportPeriod,
  type ReportPresentation,
} from '../../apps/api/src/infrastructure/time/report-calendar';

/**
 * WP12 periods in the tenant's timezone and calendar (`docs/wp12-business-analytics-audit.md` §3).
 *
 * Tehran is UTC+03:30 with no daylight saving, so local midnight is 20:30 UTC the day
 * before. 1 Mehr 1405 is 23 September 2026; Mehr has 30 days and Shahrivar 31.
 */
const TEHRAN: ReportPresentation = { timezone: 'Asia/Tehran', calendar: 'jalali' };
const at = (iso: string): Date => new Date(iso);
const iso = (d: Date): string => d.toISOString();

describe('tenant calendar', () => {
  it('names the Jalali date of an instant in the tenant zone, not in UTC', () => {
    // 20:00 UTC is 23:30 in Tehran, still the 3rd of Mehr.
    expect(formatLocalDate(civilDateOf(at('2026-09-25T20:00:00Z'), TEHRAN))).toBe('1405/07/03');
    // 21:00 UTC is 00:30 on the 4th in Tehran, while it is still the 25th in UTC.
    expect(formatLocalDate(civilDateOf(at('2026-09-25T21:00:00Z'), TEHRAN))).toBe('1405/07/04');
  });

  it('finds local midnight of a Jalali date', () => {
    expect(iso(localInstant({ year: 1405, month: 7, day: 1 }, 0, TEHRAN))).toBe(
      '2026-09-22T20:30:00.000Z',
    );
    expect(iso(localInstant({ year: 1405, month: 1, day: 1 }, 0, TEHRAN))).toBe(
      '2026-03-20T20:30:00.000Z',
    );
  });

  it('moves across month and year ends in the calendar it was given', () => {
    expect(formatLocalDate(addDays({ year: 1405, month: 6, day: 31 }, 1, 'jalali'))).toBe(
      '1405/07/01',
    );
    expect(formatLocalDate(addDays({ year: 1405, month: 1, day: 1 }, -1, 'jalali'))).toBe(
      '1404/12/29',
    );
  });
});

describe('report periods', () => {
  it('bounds TODAY by tenant midnight and cuts both sides like for like', () => {
    const now = at('2026-09-25T08:30:00Z'); // 12:00 in Tehran on 1405/07/03
    const p = resolveReportPeriod({ range: 'TODAY' }, now, TEHRAN);
    expect(iso(p.current.start)).toBe('2026-09-24T20:30:00.000Z');
    expect(iso(p.current.end)).toBe('2026-09-25T20:30:00.000Z');
    expect(iso(p.current.effectiveEnd)).toBe(iso(now));
    expect(iso(p.previous.start)).toBe('2026-09-23T20:30:00.000Z');
    // Yesterday up to the same wall time: twelve hours in.
    expect(iso(p.previous.effectiveEnd)).toBe('2026-09-24T08:30:00.000Z');
    expect(p.granularity).toBe('HOUR');
    expect(p.current.buckets).toHaveLength(24);
    expect(p.previous.buckets).toHaveLength(24);
    expect(p.current.buckets[0]?.label).toBe('00:00');
    expect(p.lengthsDiffer).toBe(false);
  });

  it('moves TODAY at tenant midnight, not at UTC midnight', () => {
    const before = resolveReportPeriod({ range: 'TODAY' }, at('2026-09-25T20:29:59Z'), TEHRAN);
    const after = resolveReportPeriod({ range: 'TODAY' }, at('2026-09-25T20:30:00Z'), TEHRAN);
    expect(formatLocalDate(before.current.startLocal)).toBe('1405/07/03');
    expect(formatLocalDate(after.current.startLocal)).toBe('1405/07/04');
    expect(iso(after.current.start)).toBe(iso(before.current.end));
  });

  it('compares a whole past period with the whole previous one', () => {
    const p = resolveReportPeriod({ range: 'YESTERDAY' }, at('2026-09-25T08:30:00Z'), TEHRAN);
    expect(iso(p.current.effectiveEnd)).toBe(iso(p.current.end));
    expect(iso(p.previous.effectiveEnd)).toBe(iso(p.previous.end));
    expect(iso(p.previous.end)).toBe(iso(p.current.start));
  });

  it('shifts LAST_7_DAYS back seven days, today included, daily buckets aligned', () => {
    const p = resolveReportPeriod({ range: 'LAST_7_DAYS' }, at('2026-09-25T08:30:00Z'), TEHRAN);
    expect(formatLocalDate(p.current.startLocal)).toBe('1405/06/28');
    expect(formatLocalDate(p.current.endLocalInclusive)).toBe('1405/07/03');
    expect(formatLocalDate(p.previous.startLocal)).toBe('1405/06/21');
    expect(formatLocalDate(p.previous.endLocalInclusive)).toBe('1405/06/27');
    expect(p.granularity).toBe('DAY');
    expect(p.current.buckets.map((b) => b.label)).toEqual([
      '1405/06/28',
      '1405/06/29',
      '1405/06/30',
      '1405/06/31',
      '1405/07/01',
      '1405/07/02',
      '1405/07/03',
    ]);
    expect(p.previous.buckets).toHaveLength(7);
  });

  it('uses the Jalali month for THIS_MONTH and says when the lengths differ', () => {
    const p = resolveReportPeriod({ range: 'THIS_MONTH' }, at('2026-09-25T08:30:00Z'), TEHRAN);
    expect(formatLocalDate(p.current.startLocal)).toBe('1405/07/01');
    expect(formatLocalDate(p.current.endLocalInclusive)).toBe('1405/07/30');
    expect(formatLocalDate(p.previous.startLocal)).toBe('1405/06/01');
    expect(formatLocalDate(p.previous.endLocalInclusive)).toBe('1405/06/31');
    expect(p.current.buckets).toHaveLength(30);
    expect(p.previous.buckets).toHaveLength(31);
    expect(p.lengthsDiffer).toBe(true);
    // Month to date against the same elapsed span of last month.
    const elapsed = p.current.effectiveEnd.getTime() - p.current.start.getTime();
    expect(p.previous.effectiveEnd.getTime() - p.previous.start.getTime()).toBe(elapsed);
  });

  it('buckets THIS_YEAR by Jalali month', () => {
    const p = resolveReportPeriod({ range: 'THIS_YEAR' }, at('2026-09-25T08:30:00Z'), TEHRAN);
    expect(p.granularity).toBe('MONTH');
    expect(p.current.buckets.map((b) => b.label)).toEqual(
      Array.from({ length: 12 }, (_, i) => `1405/${String(i + 1).padStart(2, '0')}`),
    );
    expect(iso(p.current.start)).toBe('2026-03-20T20:30:00.000Z');
  });

  it('accepts a custom range in the tenant calendar and shifts it back by its own length', () => {
    const p = resolveReportPeriod(
      { range: 'CUSTOM', from: '1405-07-01', to: '1405-07-10' },
      at('2026-12-01T00:00:00Z'),
      TEHRAN,
    );
    expect(p.current.localDays).toBe(10);
    expect(formatLocalDate(p.previous.startLocal)).toBe('1405/06/22');
    expect(formatLocalDate(p.previous.endLocalInclusive)).toBe('1405/06/31');
    expect(p.granularity).toBe('DAY');
  });

  it('chooses weekly and monthly buckets for longer custom ranges', () => {
    const weekly = resolveReportPeriod(
      { range: 'CUSTOM', from: '1405-01-01', to: '1405-03-31' },
      at('2026-12-01T00:00:00Z'),
      TEHRAN,
    );
    expect(weekly.granularity).toBe('WEEK');
    expect(weekly.current.buckets).toHaveLength(14); // 93 days: thirteen weeks and two days
    expect(weekly.current.buckets.at(-1)?.label).toBe('1405/03/30–1405/03/31');
    const monthly = resolveReportPeriod(
      { range: 'CUSTOM', from: '1404-10-15', to: '1405-06-10' },
      at('2026-12-01T00:00:00Z'),
      TEHRAN,
    );
    expect(monthly.granularity).toBe('MONTH');
    // A partial first month starts at the range, not at the month.
    expect(iso(monthly.current.buckets[0]!.start)).toBe(iso(monthly.current.start));
    expect(iso(monthly.current.buckets.at(-1)!.end)).toBe(iso(monthly.current.end));
  });

  it('refuses a date the calendar does not have, a backwards range and an oversized one', () => {
    const now = at('2026-12-01T00:00:00Z');
    expect(() =>
      resolveReportPeriod({ range: 'CUSTOM', from: '1405-07-31', to: '1405-08-02' }, now, TEHRAN),
    ).toThrow(/not a date/);
    expect(() =>
      resolveReportPeriod({ range: 'CUSTOM', from: '1405-07-10', to: '1405-07-01' }, now, TEHRAN),
    ).toThrow(/runs forward/);
    expect(() =>
      resolveReportPeriod({ range: 'CUSTOM', from: '1400-01-01', to: '1405-01-01' }, now, TEHRAN),
    ).toThrow(/runs forward/);
  });

  it('keeps buckets contiguous across a daylight-saving change', () => {
    const berlin: ReportPresentation = { timezone: 'Europe/Berlin', calendar: 'gregorian' };
    const p = resolveReportPeriod({ range: 'TODAY' }, at('2026-03-29T12:00:00Z'), berlin);
    const b = p.current.buckets;
    expect(iso(b[0]!.start)).toBe(iso(p.current.start));
    expect(iso(b.at(-1)!.end)).toBe(iso(p.current.end));
    for (let i = 1; i < b.length; i += 1) expect(iso(b[i]!.start)).toBe(iso(b[i - 1]!.end));
    // 23 real hours, 24 slots: 02:00 never happened, so its slot is zero-width.
    expect(b).toHaveLength(24);
    expect(b[2]!.start.getTime()).toBe(b[2]!.end.getTime());
  });

  it('keeps hour i in slot i on a day a DST gap shortened, so each side pairs the same local hour', () => {
    const berlin: ReportPresentation = { timezone: 'Europe/Berlin', calendar: 'gregorian' };
    // The day after the change: a normal day compared with the 23-hour one before it.
    const p = resolveReportPeriod({ range: 'TODAY' }, at('2026-03-30T12:00:00Z'), berlin);
    expect(p.current.buckets).toHaveLength(24);
    expect(p.previous.buckets).toHaveLength(24);
    for (let i = 0; i < 24; i += 1) {
      const label = `${String(i).padStart(2, '0')}:00`;
      expect(p.current.buckets[i]!.label).toBe(label);
      expect(p.previous.buckets[i]!.label).toBe(label);
    }
    // 03:00 on the short day is 01:00Z, and it is slot 3 — not slot 2, where 02:00 is.
    expect(iso(p.previous.buckets[3]!.start)).toBe('2026-03-29T01:00:00.000Z');
  });

  it('starts a day whose midnight falls in a spring-forward gap at the first instant after it, never on the day before', () => {
    // Santiago skipped 2025-09-07 00:00–01:00: the day begins at 01:00 local, 04:00Z.
    const santiago: ReportPresentation = { timezone: 'America/Santiago', calendar: 'gregorian' };
    expect(iso(localInstant({ year: 2025, month: 9, day: 7 }, 0, santiago))).toBe(
      '2025-09-07T04:00:00.000Z',
    );
    // The day before still ends where this one begins, and is 23 hours long.
    const p = resolveReportPeriod({ range: 'TODAY' }, at('2025-09-06T12:00:00Z'), santiago);
    expect(iso(p.current.end)).toBe('2025-09-07T04:00:00.000Z');
    // An ordinary midnight and a fall-back day are untouched.
    expect(iso(localInstant({ year: 2025, month: 9, day: 8 }, 0, santiago))).toBe(
      '2025-09-08T03:00:00.000Z',
    );
  });

  it('serves the contracts TimePeriodResolver from the same arithmetic', () => {
    const resolver = new IntlTimePeriodResolver({ now: () => at('2026-09-25T08:30:00Z') });
    const month = resolver.resolve('THIS_MONTH', TEHRAN);
    expect(iso(month.start)).toBe('2026-09-22T20:30:00.000Z');
    const custom = resolver.fromLocalDates('1405-07-01', '1405-07-01', TEHRAN);
    expect(custom.end.getTime() - custom.start.getTime()).toBe(86_400_000);
  });
});
