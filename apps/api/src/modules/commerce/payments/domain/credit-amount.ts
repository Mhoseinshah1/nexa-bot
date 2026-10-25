import type { Money } from '@nexa/contracts';
import { tomanAmountOf } from './tonpays.js';

/**
 * R9 C1 — the provider's webhook `credit_amount` (TonPays, both routes), and the one thing
 * Nexa does with it: SHOW it, and flag it for an operator when it matches nothing Nexa asked
 * for. Pure: no clock, no database.
 *
 * ## Why it is never credited (the lead's decision on the round prompt's item 7)
 *
 * The round prompt asked to "use it as the amount actually credited". The first TonPays rule
 * (`docs/project-status.md`) says the opposite: only the inquiry decides, and the provider's
 * amounts are metadata. A webhook is a hint whose figure no inquiry confirms — the inquiry's
 * answer has no `credit_amount` — so crediting it would let one unverified number move money,
 * and a partial credit is exactly what the underpayment rule forbids. The wallet is therefore
 * credited with the payment's principal, by the inquiry, as before; `credit_amount` is
 * recorded, shown on the payment's detail and history, and raised to the operations log when
 * it differs (`GatewayPaymentAttentionRaised`, `CREDIT_AMOUNT_MISMATCH`).
 */

/**
 * The payment's principal in the provider's unit, or null when it has no exact value there
 * (a different currency, or Rial that does not divide into Toman). Only a unit change — Toman
 * is ten Rial by definition — never an exchange rate.
 */
export function principalInProviderUnit(principal: Money, providerUnit: string): bigint | null {
  if (principal.currency === providerUnit) return principal.amountMinor;
  if (providerUnit === 'IRT') return tomanAmountOf(principal);
  if (providerUnit === 'IRR' && principal.currency === 'IRT') return principal.amountMinor * 10n;
  return null;
}

/**
 * Whether a reported `credit_amount` matches NOTHING this attempt was invoiced for: not the
 * principal, not what Nexa asked the provider for (`sentAmount`: the payable, which includes a
 * customer fee when one was added), and not the exact figure the provider itself had the
 * customer transfer (`final_amount`, the requested amount plus TonPays' unique tail — R8 A1),
 * which is what the website route's webhook reports as `credit_amount` in the ordinary case.
 * False when nothing was reported. Every comparison is in the provider's own unit.
 */
export function creditAmountDiffers(input: {
  readonly creditAmount: bigint | null;
  readonly sentAmount: bigint;
  readonly principalInProviderUnit: bigint | null;
  readonly providerFinalAmount?: bigint | null;
}): boolean {
  const credit = input.creditAmount;
  if (credit === null) return false;
  const matches = [input.sentAmount, input.principalInProviderUnit, input.providerFinalAmount];
  return !matches.some((one) => one !== null && one !== undefined && one === credit);
}
