import { describe, expect, it } from 'vitest';
import {
  dayNumberToGregorian,
  dayNumberToJalali,
  plainDigits,
  formatIsoDay,
  gregorianToDayNumber,
  isJalaliLeapYear,
  jalaliMonthLength,
  jalaliToDayNumber,
  latinDigits,
  parseIsoDay,
  parseTime,
  toGregorian,
  toJalali,
  weekdayOf,
} from '../../apps/web/src/ui/jalali';

/**
 * W1.1 — the in-house Jalali calendar. The date field shows and picks Jalali days while the
 * wire keeps Gregorian `YYYY-MM-DD`, so every conversion here is a day the server receives.
 */

const PAIRS: readonly [string, [number, number, number]][] = [
  // Nowruz 1405, the pair the owner named.
  ['2026-03-21', [1405, 1, 1]],
  ['2025-03-21', [1404, 1, 1]],
  ['2024-03-20', [1403, 1, 1]],
  // The last day of a common year and of a leap year.
  ['2026-03-20', [1404, 12, 29]],
  ['2025-03-20', [1403, 12, 30]],
  ['2021-03-20', [1399, 12, 30]],
  // The prompt's own example, «۲۴ مهر ۱۴۰۵».
  ['2026-10-16', [1405, 7, 24]],
  // jalaali-js's published fixtures.
  ['1981-08-17', [1360, 5, 26]],
  ['2013-01-10', [1391, 10, 21]],
  ['2014-08-04', [1393, 5, 13]],
  ['1979-02-11', [1357, 11, 22]],
  // The first day of the second half (31-day months end after Shahrivar).
  ['2026-09-23', [1405, 7, 1]],
  ['2026-09-22', [1405, 6, 31]],
];

describe('Jalali conversion', () => {
  it.each(PAIRS)('%s is %j', (iso, [jy, jm, jd]) => {
    const g = parseIsoDay(iso);
    expect(g).not.toBeNull();
    if (g === null) return;
    expect(toJalali(g)).toEqual({ jy, jm, jd });
    expect(formatIsoDay(toGregorian({ jy, jm, jd }))).toBe(iso);
  });

  it('knows the leap years around now, including the five-year gap (1403 → 1408)', () => {
    const leaps: number[] = [];
    for (let year = 1390; year < 1420; year += 1) if (isJalaliLeapYear(year)) leaps.push(year);
    expect(leaps).toEqual([1391, 1395, 1399, 1403, 1408, 1412, 1416]);
  });

  it('gives Esfand 29 days in a common year and 30 in a leap year', () => {
    expect(jalaliMonthLength(1404, 12)).toBe(29);
    expect(jalaliMonthLength(1403, 12)).toBe(30);
    expect(jalaliMonthLength(1408, 12)).toBe(30);
    expect(jalaliMonthLength(1407, 12)).toBe(29);
    expect(jalaliMonthLength(1405, 6)).toBe(31);
    expect(jalaliMonthLength(1405, 7)).toBe(30);
  });

  it('steps from the last day of every year into Farvardin 1 of the next', () => {
    for (let year = 1300; year < 1500; year += 1) {
      const last = jalaliToDayNumber({ jy: year, jm: 12, jd: jalaliMonthLength(year, 12) });
      expect(dayNumberToJalali(last + 1)).toEqual({ jy: year + 1, jm: 1, jd: 1 });
    }
  });

  it('round-trips every day from 1900 to 2100, in order and without gaps', () => {
    const start = gregorianToDayNumber({ gy: 1900, gm: 1, gd: 1 });
    const end = gregorianToDayNumber({ gy: 2100, gm: 12, gd: 31 });
    let previous = dayNumberToJalali(start - 1);
    for (let day = start; day <= end; day += 1) {
      const j = dayNumberToJalali(day);
      expect(jalaliToDayNumber(j)).toBe(day);
      const g = dayNumberToGregorian(day);
      expect(gregorianToDayNumber(g)).toBe(day);
      // the next day is the next Jalali day
      const sameMonth = j.jy === previous.jy && j.jm === previous.jm && j.jd === previous.jd + 1;
      const nextMonth =
        j.jd === 1 && (j.jm === previous.jm + 1 || (j.jm === 1 && previous.jm === 12));
      if (!sameMonth && !nextMonth) throw new Error(`gap at ${formatIsoDay(g)}`);
      previous = j;
    }
  });

  it('starts the week on Saturday, so a Friday is 6', () => {
    expect(weekdayOf(gregorianToDayNumber({ gy: 2026, gm: 10, gd: 16 }))).toBe(6); // Friday
    expect(weekdayOf(gregorianToDayNumber({ gy: 2026, gm: 10, gd: 17 }))).toBe(0); // Saturday
  });

  it('refuses a year outside the table rather than inventing a date', () => {
    expect(() => isJalaliLeapYear(4000)).toThrow(RangeError);
  });
});

describe('the wire values', () => {
  it('reads only real days', () => {
    expect(parseIsoDay('2026-02-29')).toBeNull();
    expect(parseIsoDay('2024-02-29')).toEqual({ gy: 2024, gm: 2, gd: 29 });
    expect(parseIsoDay('2026-13-01')).toBeNull();
    expect(parseIsoDay('2026-1-01')).toBeNull();
    expect(parseIsoDay('')).toBeNull();
  });

  it('reads 24-hour times only', () => {
    expect(parseTime('23:59')).toEqual({ h: 23, m: 59 });
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('9:00')).toBeNull();
  });

  it('writes Latin digits without grouping, and reads typed Persian digits back', () => {
    expect(plainDigits(1405)).toBe('1405');
    expect(plainDigits('۱۴۰۵')).toBe('1405');
    expect(latinDigits(plainDigits('09:30'))).toBe('09:30');
  });
});
