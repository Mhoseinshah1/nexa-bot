import { CURRENCY_EXPONENT, isValidLedgerAmount, money } from '@nexa/contracts';
import type { CurrencyCode, Money } from '@nexa/contracts';

/**
 * The amount a reviewer TYPED, or null when the message is not one (Payment File 02 §12).
 *
 * The one place a person's free text becomes money in this product, so it is strict about
 * what it accepts and total about what it refuses — a refusal is answered with a re-prompt,
 * never swallowed (INCIDENT-FIN-001), so being strict costs a reviewer one more message and
 * being lenient could cost a customer the wrong credit.
 *
 * Accepted:
 *
 * - Latin `0-9`, Persian `۰-۹` and Arabic-Indic `٠-٩` digits, in any mix — a Persian
 *   keyboard produces the second and a pasted bank figure often the third;
 * - thousands separators — `,` `٬` `،`, a space, a no-break space — but only where
 *   thousands ARE: a first group of one to three digits and then groups of exactly three.
 *   `1,000,000` and `۱٬۰۰۰٬۰۰۰` are a million; `1,00` is refused, because it is either a
 *   typo or a decimal written the other way round, and guessing which is the failure;
 * - a decimal point (`.` or `٫`) only for a currency that HAS minor units, with no more
 *   fraction digits than it has — Toman and Rial have none, so `250000.5` is refused rather
 *   than rounded;
 * - bidirectional marks around the figure, which copying a number out of Persian text
 *   attaches invisibly.
 *
 * Refused: anything else — a sign, a unit word, an exponent, words, an empty message — and
 * zero, and anything past `PAYMENT_AMOUNT_MAX_MINOR` (`isValidLedgerAmount`, the bound the
 * credit command itself enforces).
 */
export function parseTypedAmount(text: string, currency: CurrencyCode): Money | null {
  const cleaned = toLatinDigits(text.replace(BIDI_MARKS, '')).trim();
  if (cleaned.length === 0 || cleaned.length > MAX_TYPED_LENGTH) return null;

  const decimal = /^([^.\u066b]*)(?:[.\u066b](\d+))?$/u.exec(cleaned);
  if (decimal === null) return null;
  const whole = decimal[1] ?? '';
  const fraction = decimal[2] ?? '';

  const exponent = CURRENCY_EXPONENT[currency];
  if (fraction.length > exponent) return null;

  const digits = groupedDigits(whole);
  if (digits === null) return null;

  const minor = BigInt(digits) * 10n ** BigInt(exponent) + scaledFraction(fraction, exponent);
  return isValidLedgerAmount(minor) ? money(minor, currency) : null;
}

/** Longer than any amount that could pass the bound, so nothing absurd reaches BigInt. */
const MAX_TYPED_LENGTH = 64;

/** LRM, RLM, ALM, the embeddings and overrides, and the isolates. */
const BIDI_MARKS = /[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/gu;

const SEPARATORS = /[,\u066c\u060c \u00a0\u202f]/u;

/**
 * Persian and Arabic-Indic digits as Latin ones, everything else untouched.
 *
 * Exported for `parseCustomerAmount`, which reads a CUSTOMER's figure under stricter
 * rules than a reviewer's and must not carry a second copy of this table: the two would
 * agree until somebody added a digit range to one of them.
 */
export function toLatinDigits(text: string): string {
  return text.replace(/[\u06f0-\u06f9\u0660-\u0669]/gu, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/** `1,234,567` to `1234567`; null unless the groups are real thousands. */
function groupedDigits(whole: string): string | null {
  if (/^\d+$/.test(whole)) return whole;
  const groups = whole.split(SEPARATORS);
  if (groups.length < 2) return null;
  const [head, ...tail] = groups;
  if (head === undefined || !/^\d{1,3}$/.test(head)) return null;
  if (!tail.every((group) => /^\d{3}$/.test(group))) return null;
  return groups.join('');
}

function scaledFraction(fraction: string, exponent: number): bigint {
  if (fraction.length === 0) return 0n;
  return BigInt(fraction.padEnd(exponent, '0'));
}
