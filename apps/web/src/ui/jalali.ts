/**
 * Jalali (Solar Hijri) calendar arithmetic, in-house (no runtime dependency).
 *
 * The algorithm is the standard jalaali one (Borkowski's break years, as published by
 * jalaali-js): a Jalali year is placed by the table of "break" years at which the 33-year
 * leap cycle shifts, and both calendars are converted through the Julian Day Number. It is
 * exact over the years the table covers (-61 … 3177); `tests/web/jalali.test.tsx` pins the
 * known pairs, the leap boundaries and a round trip over every day of a wide range.
 *
 * Pure functions only. No Persian text lives here: month and weekday names are catalogue
 * keys (`JALALI_MONTH_KEYS`, `JALALI_WEEKDAY_KEYS`) that `date-field.tsx` renders.
 */
import type { WebKey } from '../i18n/web.fa';

export interface JalaliDate {
  readonly jy: number;
  /** 1–12 */
  readonly jm: number;
  /** 1–31 */
  readonly jd: number;
}

export interface GregorianDate {
  readonly gy: number;
  /** 1–12 */
  readonly gm: number;
  /** 1–31 */
  readonly gd: number;
}

/** Integer division truncating toward zero, as the published algorithm specifies. */
function div(a: number, b: number): number {
  return Math.trunc(a / b);
}
function mod(a: number, b: number): number {
  return a - Math.trunc(a / b) * b;
}

const BREAKS: readonly number[] = [
  -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394,
  2456, 3178,
];

export const JALALI_MIN_YEAR = -61;
export const JALALI_MAX_YEAR = 3177;

interface YearInfo {
  /** 0 in a leap year, otherwise the years since the last leap year (1–4). */
  readonly leap: number;
  readonly gy: number;
  /** The day of March (Gregorian year `gy`) on which Farvardin 1 falls. */
  readonly march: number;
}

function jalCal(jy: number): YearInfo {
  if (!Number.isInteger(jy) || jy < JALALI_MIN_YEAR || jy > JALALI_MAX_YEAR) {
    throw new RangeError(`jalali: year ${String(jy)} is out of range`);
  }
  const gy = jy + 621;
  let leapJ = -14;
  let jp = BREAKS[0] ?? -61;
  let jump = 0;
  for (let i = 1; i < BREAKS.length; i += 1) {
    const jm = BREAKS[i] ?? 0;
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

/** The Julian Day Number of a Gregorian date. */
export function gregorianToDayNumber(g: GregorianDate): number {
  const { gy, gm, gd } = g;
  const d =
    div((gy + div(gm - 8, 6) + 100100) * 1461, 4) +
    div(153 * mod(gm + 9, 12) + 2, 5) +
    gd -
    34840408;
  return d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
}

/** The Gregorian date of a Julian Day Number. */
export function dayNumberToGregorian(jdn: number): GregorianDate {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

/** The Julian Day Number of a Jalali date. */
export function jalaliToDayNumber(j: JalaliDate): number {
  const r = jalCal(j.jy);
  return (
    gregorianToDayNumber({ gy: r.gy, gm: 3, gd: r.march }) +
    (j.jm - 1) * 31 -
    div(j.jm, 7) * (j.jm - 7) +
    j.jd -
    1
  );
}

/** The Jalali date of a Julian Day Number. */
export function dayNumberToJalali(jdn: number): JalaliDate {
  const gy = dayNumberToGregorian(jdn).gy;
  let jy = gy - 621;
  const r = jalCal(jy);
  const first = gregorianToDayNumber({ gy, gm: 3, gd: r.march });
  let k = jdn - first;
  if (k >= 0) {
    if (k <= 185) return { jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 };
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  return { jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
}

export function toJalali(g: GregorianDate): JalaliDate {
  return dayNumberToJalali(gregorianToDayNumber(g));
}

export function toGregorian(j: JalaliDate): GregorianDate {
  return dayNumberToGregorian(jalaliToDayNumber(j));
}

export function isJalaliLeapYear(jy: number): boolean {
  return jalCal(jy).leap === 0;
}

export function jalaliMonthLength(jy: number, jm: number): number {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return isJalaliLeapYear(jy) ? 30 : 29;
}

/** The day of the week, 0 = Saturday … 6 = Friday (the Persian week). */
export function weekdayOf(jdn: number): number {
  // JDN 0 was a Monday, which is index 2 when Saturday is 0.
  return (((jdn + 2) % 7) + 7) % 7;
}

/* ------------------------------------------------------------- wire values --- */

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` → a Gregorian date, or null when the text is not a real day. */
export function parseIsoDay(value: string): GregorianDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (m === null) return null;
  const g = { gy: Number(m[1]), gm: Number(m[2]), gd: Number(m[3]) };
  if (g.gm < 1 || g.gm > 12 || g.gd < 1 || g.gd > 31) return null;
  const back = dayNumberToGregorian(gregorianToDayNumber(g));
  return back.gy === g.gy && back.gm === g.gm && back.gd === g.gd ? g : null;
}

export function formatIsoDay(g: GregorianDate): string {
  return `${String(g.gy).padStart(4, '0')}-${pad2(g.gm)}-${pad2(g.gd)}`;
}

/** `HH:MM` (24-hour) → hours and minutes, or null. */
export function parseTime(value: string): { h: number; m: number } | null {
  const m = /^(\d{2}):(\d{2})$/u.exec(value);
  if (m === null) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? { h, m: min } : null;
}

export function formatTime(time: { h: number; m: number }): string {
  return `${pad2(time.h)}:${pad2(time.m)}`;
}

/** The local calendar day of an instant, as a Julian Day Number. */
export function dayNumberOfDate(date: Date): number {
  return gregorianToDayNumber({
    gy: date.getFullYear(),
    gm: date.getMonth() + 1,
    gd: date.getDate(),
  });
}

/* ------------------------------------------------------------------- names --- */

export const JALALI_MONTH_KEYS: readonly WebKey[] = [
  'web.jalali_m1',
  'web.jalali_m2',
  'web.jalali_m3',
  'web.jalali_m4',
  'web.jalali_m5',
  'web.jalali_m6',
  'web.jalali_m7',
  'web.jalali_m8',
  'web.jalali_m9',
  'web.jalali_m10',
  'web.jalali_m11',
  'web.jalali_m12',
];

/** Saturday first. */
export const JALALI_WEEKDAY_KEYS: readonly WebKey[] = [
  'web.jalali_wd_sat',
  'web.jalali_wd_sun',
  'web.jalali_wd_mon',
  'web.jalali_wd_tue',
  'web.jalali_wd_wed',
  'web.jalali_wd_thu',
  'web.jalali_wd_fri',
];

/**
 * A number or text as the admin draws digits: Latin, never grouped (a year reads as four digits).
 * The owner's decision (R11): Latin digits everywhere; only the Jalali CALENDAR stays. Any
 * Persian digit that reaches here is normalised, so a date field never draws U+06F0-U+06F9.
 */
export function plainDigits(value: number | string): string {
  return latinDigits(String(value));
}

/** Persian or Arabic-Indic digits back to Latin ones, for typed input. */
export function latinDigits(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code >= 0x06f0 && code <= 0x06f9) out += String(code - 0x06f0);
    else if (code >= 0x0660 && code <= 0x0669) out += String(code - 0x0660);
    else out += char;
  }
  return out;
}
