/**
 * Jalali (Solar Hijri) calendar arithmetic, in-house (no runtime dependency).
 *
 * PHASE-0 INTERFACE STUB — agent A implements the jalaali algorithm and its tests
 * (`tests/web/jalali.test.ts`). Pure functions only: no Persian text lives here (month names
 * are catalogue keys, `JALALI_MONTH_KEYS`, used by `date-field.tsx`).
 */
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

export function toJalali(_g: GregorianDate): JalaliDate {
  throw new Error('jalali: not implemented yet');
}

export function toGregorian(_j: JalaliDate): GregorianDate {
  throw new Error('jalali: not implemented yet');
}

export function isJalaliLeapYear(_jy: number): boolean {
  throw new Error('jalali: not implemented yet');
}

export function jalaliMonthLength(_jy: number, _jm: number): number {
  throw new Error('jalali: not implemented yet');
}
