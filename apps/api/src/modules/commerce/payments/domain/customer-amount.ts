import { CURRENCY_EXPONENT, MAX_MONEY_AMOUNT_MINOR, money } from '@nexa/contracts';
import type { CurrencyCode, Money } from '@nexa/contracts';
import { toLatinDigits } from '../application/typed-amount.js';

/**
 * The top-up amount a CUSTOMER typed, or a refusal (customer UX completion §F).
 *
 * Stricter than `parseTypedAmount`, which reads a reviewer's figure, and deliberately
 * so: a reviewer types an amount off a bank statement and may need a decimal for a
 * currency that has one; a customer types the number they want to transfer, in MAJOR
 * units of the installation's currency, and anything that is not a plain whole number is
 * more likely a slipped key than an intention. A refusal costs them one re-prompt; an
 * acceptance is money they are asked to send.
 *
 * Accepted: Latin `0-9`, Persian `۰-۹` and Arabic-Indic `٠-٩` digits in any mix, with
 * thousands separators — `,` `٬` `،` and any space — stripped wherever they appear, and
 * bidirectional marks around the figure, which copying a number out of Persian text
 * attaches invisibly. The result is converted to minor units with the currency's
 * exponent; Toman and Rial have none, so the figure is the amount.
 *
 * Refused: a sign, a decimal point, letters, an empty or blank message, zero — a top-up
 * of nothing is not a payment, and `payments_amount_check` would meet it as a 500 — and
 * anything above `MAX_MONEY_AMOUNT_MINOR`, the largest amount a money column stores. The
 * installation's own floor and ceiling and the route's bounds are the service's to apply;
 * this only decides whether the text is a number at all.
 */
export type ParsedCustomerAmount =
  { readonly ok: true; readonly amount: Money } | { readonly ok: false };

export function parseCustomerAmount(text: string, currency: CurrencyCode): ParsedCustomerAmount {
  const cleaned = toLatinDigits(text.replace(BIDI_MARKS, '')).replace(SEPARATORS, '');
  // Longer than any figure that could pass the bound, so nothing absurd reaches BigInt.
  if (cleaned.length === 0 || cleaned.length > MAX_TYPED_LENGTH) return REFUSED;
  if (!/^[0-9]+$/u.test(cleaned)) return REFUSED;

  const major = BigInt(cleaned);
  if (major === 0n) return REFUSED;
  const minor = major * 10n ** BigInt(CURRENCY_EXPONENT[currency]);
  if (minor > MAX_MONEY_AMOUNT_MINOR) return REFUSED;
  return { ok: true, amount: money(minor, currency) };
}

const REFUSED: ParsedCustomerAmount = { ok: false };

/** Twenty digits is already past the bound; the rest is headroom for separators. */
const MAX_TYPED_LENGTH = 64;

/** LRM, RLM, ALM, the embeddings and overrides, and the isolates. */
const BIDI_MARKS = /[‎‏؜‪-‮⁦-⁩]/gu;

/** `,` `٬` `،` and any space, wherever they appear: a customer's grouping is not audited. */
const SEPARATORS = /[,٬،\s]/gu;
