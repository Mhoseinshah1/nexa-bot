import { describe, expect, it } from 'vitest';
import { PAYMENT_AMOUNT_MAX_MINOR } from '@nexa/contracts';
import { parseTypedAmount } from '../../apps/api/src/modules/commerce/payments/application/typed-amount.js';

/**
 * The one place a reviewer's free text becomes money (Payment File 02 §12). Everything it
 * refuses is answered with a re-prompt, so the refusals below are cheap; everything it
 * accepts is credited, so the acceptances are exact.
 */
describe('an amount a reviewer typed', () => {
  const toman = (text: string) => parseTypedAmount(text, 'IRT')?.amountMinor ?? null;

  it.each([
    ['250000', 250_000n],
    ['1,000,000', 1_000_000n],
    ['  1,000,000  ', 1_000_000n],
    ['۲۵۰۰۰۰', 250_000n],
    ['۱٬۰۰۰٬۰۰۰', 1_000_000n],
    ['١٬٥٠٠٬٠٠٠', 1_500_000n],
    ['۱،۰۰۰،۰۰۰', 1_000_000n],
    ['1 000 000', 1_000_000n],
    ['1\u00a0000', 1_000n],
    ['۱2٣', 123n],
    ['\u200f۵۰۰۰۰\u200e', 50_000n],
    ['1', 1n],
  ])('reads %j as %s', (text, expected) => {
    expect(toman(text)).toBe(expected);
  });

  it('keeps the currency it was asked for', () => {
    expect(parseTypedAmount('5', 'IRR')).toEqual({ amountMinor: 5n, currency: 'IRR' });
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['zero', '0'],
    ['zero in Persian', '۰'],
    ['negative', '-5000'],
    ['signed', '+5000'],
    ['a word', 'هزار'],
    ['a unit word', '250000 تومان'],
    ['an exponent', '1e6'],
    ['a fraction Toman cannot hold', '250000.5'],
    ['a Persian decimal Toman cannot hold', '۲۵۰۰۰۰٫۵'],
    ['grouping that is not thousands', '1,00'],
    ['a four-digit first group', '1000,000'],
    ['a trailing separator', '1,000,'],
    ['a leading separator', ',100'],
    ['European grouping', '1.000.000'],
    ['two numbers', '100 200 3000'],
    ['past the ledger bound', (PAYMENT_AMOUNT_MAX_MINOR + 1n).toString()],
    ['absurdly long', '9'.repeat(80)],
  ])('refuses %s', (_label, text) => {
    expect(parseTypedAmount(text, 'IRT')).toBeNull();
  });

  it('accepts the ledger bound itself', () => {
    expect(toman(PAYMENT_AMOUNT_MAX_MINOR.toString())).toBe(PAYMENT_AMOUNT_MAX_MINOR);
  });

  it('scales a decimal only for a currency that has minor units, and never rounds', () => {
    expect(parseTypedAmount('12.5', 'USD')?.amountMinor).toBe(1250n);
    expect(parseTypedAmount('1,234.56', 'USD')?.amountMinor).toBe(123_456n);
    expect(parseTypedAmount('۱۲٫۵', 'USD')?.amountMinor).toBe(1250n);
    expect(parseTypedAmount('12.345', 'USD')).toBeNull();
  });
});
