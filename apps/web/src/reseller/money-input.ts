import { CURRENCY_EXPONENT, type CurrencyCode, type MoneyWire } from '@nexa/contracts';

/** Eastern Arabic-Indic (U+06F0..) and Arabic-Indic (U+0660..) digits, as `\u` codes. */
const PERSIAN_ZERO = 0x06f0;
const ARABIC_ZERO = 0x0660;

/** Latin digits for whatever digits a keyboard produced; separators and spaces dropped. */
export function normaliseDigits(text: string): string {
  return text
    .replace(/[\u06f0-\u06f9]/gu, (digit) => String(digit.charCodeAt(0) - PERSIAN_ZERO))
    .replace(/[\u0660-\u0669]/gu, (digit) => String(digit.charCodeAt(0) - ARABIC_ZERO))
    .replace(/[\u066c,\s]/gu, '')
    .replace(/\u066b/gu, '.');
}

/**
 * What a person typed as an amount, as exact minor units in `currency` — or null when it is not a
 * positive amount in that currency's own precision. Digits only, no float: the string is scaled.
 */
export function parseAmount(text: string, currency: CurrencyCode): MoneyWire | null {
  const clean = normaliseDigits(text);
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(clean);
  if (match === null) return null;
  const exponent = CURRENCY_EXPONENT[currency];
  const fraction = match[2] ?? '';
  if (fraction.length > exponent) return null;
  const minor = BigInt(`${match[1] as string}${fraction.padEnd(exponent, '0')}`);
  return minor > 0n ? { amountMinor: minor.toString(), currency } : null;
}
