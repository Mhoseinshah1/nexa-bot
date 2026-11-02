import type { SupportContextMoney, SupportContextPayload } from '@nexa/contracts';
import type { OutputPriceFamily } from './output-policy.js';

/**
 * Phase 4 PR-2 — the LIVE PRICE FAMILY the output validator (`output-policy.ts`) reads through
 * its `OutputPriceFamily` plug-in: every amount a reply may quote, and nothing else.
 *
 * Its members are the amounts of the payload the model was given: the catalogue's prices and
 * renewal prices (priced at the checkout's boundary for THIS customer, personal discount
 * included), the packages, the customer's own services' renewal prices, and the customer's own
 * orders and payments. Never a figure the payload does not hold.
 *
 * Each amount is admitted in the forms a person writes the SAME amount in: its minor units as
 * stored, and — for the Iranian units — the other unit (a toman figure ×10 as rials, a rial
 * figure ÷10 as tomans) and the thousands («150 هزار») of each. A different amount in any unit
 * is not a member, so an invented price fails the validator's number rule.
 */
export function livePriceFamily(payload: SupportContextPayload): OutputPriceFamily {
  const members = new Set<string>();
  const add = (value: SupportContextMoney | null): void => {
    if (value === null) return;
    const minor = value.amountMinor.replace(/^-/u, '');
    for (const form of amountForms(minor, value.currency)) members.add(form);
  };
  for (const plan of payload.catalogue) {
    add(plan.price);
    add(plan.renewalPrice);
  }
  for (const addon of payload.addons) add(addon.price);
  for (const service of payload.services) add(service.renewalPrice);
  for (const order of payload.orders) add(order.total);
  for (const payment of payload.payments) add(payment.amount);
  return {
    has: (digits: string) => members.has(digits.replace(/^0+(?=\d)/u, '')),
  };
}

/** The digit strings one amount may be written as (see `livePriceFamily`). */
export function amountForms(minor: string, currency: string): readonly string[] {
  const forms = new Set<string>([minor]);
  if (currency === 'IRT') forms.add(`${minor}0`);
  if (currency === 'IRR' && minor.endsWith('0') && minor.length > 1) forms.add(minor.slice(0, -1));
  for (const form of [...forms]) {
    if (form.length > 3 && form.endsWith('000')) forms.add(form.slice(0, -3));
  }
  return [...forms];
}
