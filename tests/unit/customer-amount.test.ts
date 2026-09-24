import { describe, expect, it } from 'vitest';
import { MAX_MONEY_AMOUNT_MINOR } from '@nexa/contracts';
import { parseCustomerAmount } from '../../apps/api/src/modules/commerce/payments/domain/customer-amount.js';

/**
 * The one place a CUSTOMER's free text becomes money (customer UX completion §F). A
 * refusal is answered with a re-prompt, so the refusals below are cheap; an acceptance is
 * an amount the customer is asked to transfer, so the acceptances are exact.
 */
describe('an amount a customer typed', () => {
  const toman = (text: string) => {
    const parsed = parseCustomerAmount(text, 'IRT');
    return parsed.ok ? parsed.amount.amountMinor : null;
  };

  it.each([
    ['250000', 250_000n],
    ['1,000,000', 1_000_000n],
    ['  1,000,000  ', 1_000_000n],
    ['۲۵۰۰۰۰', 250_000n],
    ['۱٬۰۰۰٬۰۰۰', 1_000_000n],
    ['١٬٥٠٠٬٠٠٠', 1_500_000n],
    ['۱،۰۰۰،۰۰۰', 1_000_000n],
    ['1 000 000', 1_000_000n],
    ['1 000', 1_000n],
    ['۱2٣', 123n],
    ['‏۵۰۰۰۰‎', 50_000n],
    // A customer's grouping is not audited: an odd grouping is still the digits it holds.
    ['1,00', 100n],
    ['1000,000', 1_000_000n],
    ['1', 1n],
    ['007', 7n],
  ])('reads %j as %s', (text, expected) => {
    expect(toman(text)).toBe(expected);
  });

  it('converts MAJOR units to minor with the currency exponent', () => {
    // Toman has no minor unit: the figure is the amount.
    expect(parseCustomerAmount('5', 'IRT')).toEqual({
      ok: true,
      amount: { amountMinor: 5n, currency: 'IRT' },
    });
    expect(parseCustomerAmount('5', 'IRR')).toEqual({
      ok: true,
      amount: { amountMinor: 5n, currency: 'IRR' },
    });
    // A currency with two: five major units are five hundred minor.
    expect(parseCustomerAmount('5', 'USD')).toEqual({
      ok: true,
      amount: { amountMinor: 500n, currency: 'USD' },
    });
    expect(parseCustomerAmount('5', 'USDT')).toEqual({
      ok: true,
      amount: { amountMinor: 5_000_000n, currency: 'USDT' },
    });
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['zero', '0'],
    ['zero in Persian', '۰'],
    ['zero with grouping', '0,000'],
    ['negative', '-5000'],
    ['signed', '+5000'],
    ['a word', 'هزار'],
    ['a unit word', '250000 تومان'],
    ['an exponent', '1e6'],
    ['a decimal', '250000.5'],
    ['a Persian decimal', '۲۵۰۰۰۰٫۵'],
    ['European grouping with points', '1.000.000'],
    ['letters among digits', '12a'],
    ['only separators', ',,,'],
    ['past the money bound', (MAX_MONEY_AMOUNT_MINOR + 1n).toString()],
    ['absurdly long', '9'.repeat(80)],
  ])('refuses %s', (_label, text) => {
    expect(parseCustomerAmount(text, 'IRT')).toEqual({ ok: false });
  });

  it('accepts the money bound itself, and refuses it once the exponent pushes it past', () => {
    expect(toman(MAX_MONEY_AMOUNT_MINOR.toString())).toBe(MAX_MONEY_AMOUNT_MINOR);
    // The same digits in a two-exponent currency are a hundred times the bound.
    expect(parseCustomerAmount(MAX_MONEY_AMOUNT_MINOR.toString(), 'USD')).toEqual({ ok: false });
  });
});
