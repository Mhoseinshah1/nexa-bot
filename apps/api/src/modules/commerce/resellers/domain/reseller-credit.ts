import type {
  CurrencyCode,
  Money,
  ResellerCreditState,
  ResellerLimitSource,
  ResellerStatus,
} from '@nexa/contracts';

/**
 * R8, stated once (`docs/wp9-reseller-audit.md` R8, `docs/wp14-reseller-phase2-audit.md` D1).
 *
 * The ONE statement of the credit allowance. Settlement (`ResellerService.creditAllowance`,
 * under the customer's wallet lock) and the operator's credit view both call it, so what an
 * operator is shown as available is what a purchase would actually be allowed. A second
 * copy of this rule would be a second answer to "how much may this reseller owe".
 */

export interface CreditTerms {
  readonly status: ResellerStatus;
  /** The reseller's own limit, or null for the tier's. */
  readonly ownLimit: Money | null;
  readonly tierLimit: Money;
}

/** The effective limit — the reseller's own, else the tier's — and which one it is. */
export function effectiveLimitOf(terms: CreditTerms): {
  readonly limit: Money;
  readonly source: ResellerLimitSource;
} {
  return terms.ownLimit === null
    ? { limit: terms.tierLimit, source: 'TIER' }
    : { limit: terms.ownLimit, source: 'RESELLER' };
}

/** Whether credit applies to a debit in `currency`, and if not, the first reason why. */
export function creditStateOf(terms: CreditTerms, currency: CurrencyCode): ResellerCreditState {
  if (terms.status !== 'ACTIVE') return 'RESELLER_SUSPENDED';
  const { limit } = effectiveLimitOf(terms);
  if (limit.amountMinor <= 0n) return 'NO_LIMIT';
  if (limit.currency !== currency) return 'CURRENCY_MISMATCH';
  return 'CREDIT_APPLIES';
}

/**
 * The allowance below zero for a debit in `currency`: the effective limit when credit
 * applies, zero otherwise. Zero means no debt.
 */
export function creditAllowanceOf(terms: CreditTerms, currency: CurrencyCode): bigint {
  return creditStateOf(terms, currency) === 'CREDIT_APPLIES'
    ? effectiveLimitOf(terms).limit.amountMinor
    : 0n;
}

/**
 * The derivations an operator reads, from a balance and an allowance in one currency.
 *
 * Nothing here is a new rule: credit in use is the negative part of the balance
 * (`OQ-WP9-04`: "the debt is simply a negative balance"); available to spend is the
 * frontier `canCover` applies (`balance − amount ≥ −allowance`); over-limit is the debt a
 * lowered limit or a suspension no longer covers, which R8 allows and leaves where it is.
 */
export function creditFigures(
  balanceMinor: bigint,
  allowanceMinor: bigint,
): {
  readonly creditInUse: bigint;
  readonly availableToSpend: bigint;
  readonly overLimitBy: bigint;
} {
  const allowance = allowanceMinor > 0n ? allowanceMinor : 0n;
  const creditInUse = balanceMinor < 0n ? -balanceMinor : 0n;
  const over = creditInUse - allowance;
  return {
    creditInUse,
    availableToSpend: balanceMinor + allowance,
    overLimitBy: over > 0n ? over : 0n,
  };
}
