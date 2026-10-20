/**
 * Persian numerals for the operations log group (Round 4 PR-D, global rule 3: «Persian digits
 * with separators»).
 *
 * Customer-facing text keeps Latin digits (`formatMoney` pins them, and one message must
 * not mix two numbering systems). The operators' log group is a different reader: the owner
 * reviewed every log type in Persian digits, so a template that declares
 * `digits: 'PERSIAN'` is rendered with them — numbers, money, dates, traffic and durations,
 * and NEVER a string value, because a string may be an id, a username, a service name or a
 * tracking code, which must stay copyable exactly as they are.
 */

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const;

/** The thousands separator and the decimal separator Persian typography uses. */
export const PERSIAN_THOUSANDS = '٬';
export const PERSIAN_DECIMAL = '٫';

/**
 * Latin digits to Persian, and the two separators with them. Anything else is untouched, so
 * a unit word, a `/` or a `:` in a date survives as written.
 */
export function toPersianDigits(text: string): string {
  let out = '';
  for (const character of text) {
    if (character >= '0' && character <= '9') {
      out += PERSIAN_DIGITS[Number(character)];
    } else if (character === ',') {
      out += PERSIAN_THOUSANDS;
    } else if (character === '.') {
      out += PERSIAN_DECIMAL;
    } else {
      out += character;
    }
  }
  return out;
}

/** A whole number grouped in thousands, in Persian digits: `12420` is `۱۲٬۴۲۰`. */
export function formatPersianInteger(value: number | bigint): string {
  const negative = value < 0;
  const digits = (negative ? -BigInt(value) : BigInt(value)).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${toPersianDigits(grouped)}`;
}

/**
 * A ratio of two non-negative whole numbers as a percentage with one decimal, in Persian
 * digits and by integer arithmetic only. `null` when the base is zero: a percentage of
 * nothing is not a number, and the caller prints no figure rather than «NaN».
 */
export function formatPersianPercent(part: bigint, base: bigint): string | null {
  if (base <= 0n) return null;
  const tenths = (part * 1000n + base / 2n) / base;
  const whole = tenths / 10n;
  const fraction = tenths % 10n;
  const text = fraction === 0n ? whole.toString() : `${whole.toString()}.${fraction.toString()}`;
  return `${toPersianDigits(text)}٪`;
}

/**
 * The change from `previous` to `current` as a signed percentage with an arrow, or `null`
 * when yesterday had nothing to compare with.
 */
export function formatPersianChange(current: bigint, previous: bigint): string | null {
  if (previous <= 0n) return null;
  const delta = current - previous;
  const magnitude = delta < 0n ? -delta : delta;
  const percent = formatPersianPercent(magnitude, previous);
  if (percent === null) return null;
  if (delta === 0n) return `▬ ${percent}`;
  return `${delta > 0n ? '▲' : '▼'} ${percent}`;
}
