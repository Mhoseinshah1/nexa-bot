import {
  DEFAULT_TEMPLATE_PRESENTATION,
  formatDateOnly,
  formatDateTime,
  formatMoney,
  formatTrafficLimit,
  formatBytes,
} from '@nexa/i18n';
import {
  CURRENCY_EXPONENT,
  MAX_MONEY_AMOUNT_MINOR,
  fromWire,
  type CurrencyCode,
  type MoneyWire,
} from '@nexa/contracts';

/**
 * Figures as the bot shows them — the same `@nexa/i18n` formatters, so a price, a traffic
 * figure and a date read the same in the chat and in the mini app. Missing data is drawn as
 * an em dash, never as zero.
 */
export const DASH = '—';

export function money(value: MoneyWire | null | undefined): string {
  return value === null || value === undefined ? DASH : formatMoney(fromWire(value));
}

/** A traffic allowance (unlimited is the word, never «0»). */
export function trafficLimit(bytes: string | null | undefined): string {
  return bytes === null || bytes === undefined ? DASH : formatTrafficLimit(BigInt(bytes));
}

/** A traffic quantity (used, left). */
export function traffic(bytes: string | bigint | null | undefined): string {
  if (bytes === null || bytes === undefined) return DASH;
  return formatBytes(typeof bytes === 'bigint' ? bytes : BigInt(bytes));
}

export function dateTime(iso: string | null | undefined): string {
  return iso === null || iso === undefined
    ? DASH
    : formatDateTime(new Date(iso), DEFAULT_TEMPLATE_PRESENTATION);
}

/** A day without its clock time (a join date), in the same calendar and digits as `dateTime`. */
export function dateOnly(iso: string | null | undefined): string {
  return iso === null || iso === undefined
    ? DASH
    : formatDateOnly(new Date(iso), DEFAULT_TEMPLATE_PRESENTATION);
}

/** Whole days from `now` to `iso`, never below zero. */
export function daysUntil(iso: string, now: Date): number {
  const ms = new Date(iso).getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/** The used share of an allowance, 0..1, for the usage bar; null when unlimited or unknown. */
export function usedShare(used: string, limit: string): number | null {
  const total = BigInt(limit);
  if (total <= 0n) return null;
  const part = BigInt(used);
  // Thousandths in bigint, then a number: never a float of a byte count.
  const permille = (part * 1000n) / total;
  return Math.min(1, Number(permille) / 1000);
}

const BIDI_MARKS = /[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/gu;
const SEPARATORS = /[,\u066c\u060c\s]/gu;
const PERSIAN_ZERO = 0x06f0;
const ARABIC_ZERO = 0x0660;

/**
 * An amount a person typed, in MAJOR units of the wallet's currency, as a wire amount — or
 * null when it is not a plain positive whole number. The same reading the bot gives a typed
 * top-up (Latin, Persian and Arabic-Indic digits in any mix, grouping marks ignored, no
 * sign, no decimal point); the server still applies the floor, the ceiling and the routes.
 */
export function parseAmountInput(text: string, currency: CurrencyCode): MoneyWire | null {
  const cleaned = text
    .replace(BIDI_MARKS, '')
    .replace(/[\u06f0-\u06f9\u0660-\u0669]/gu, (digit) => {
      const code = digit.charCodeAt(0);
      return String(code >= PERSIAN_ZERO ? code - PERSIAN_ZERO : code - ARABIC_ZERO);
    })
    .replace(SEPARATORS, '');
  if (cleaned.length === 0 || cleaned.length > 64 || !/^[0-9]+$/u.test(cleaned)) return null;
  const major = BigInt(cleaned);
  if (major === 0n) return null;
  const minor = major * 10n ** BigInt(CURRENCY_EXPONENT[currency]);
  if (minor > MAX_MONEY_AMOUNT_MINOR) return null;
  return { amountMinor: minor.toString(), currency };
}

/** A ledger amount with its direction as a sign: a credit adds, a debit takes. */
export function signedMoney(direction: 'CREDIT' | 'DEBIT', value: MoneyWire): string {
  return `${direction === 'CREDIT' ? '+' : '\u2212'}${money(value)}`;
}
