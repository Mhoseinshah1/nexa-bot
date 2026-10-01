import type {
  Money,
  ResellerCreditState,
  ResellerLimitSource,
  ResellerStatus,
} from '@nexa/contracts';

/**
 * Reseller credit, REMOVED (owner decision, 2026-10-01: no reseller debt, no credit
 * purchases; `docs/reseller-phase3-closure.md` §3).
 *
 * WP9-B R8 let an ACTIVE reseller's wallet purchase take the balance below zero, down to a
 * configured limit. That is gone. This file is still the ONE statement of the allowance —
 * settlement (`ResellerService.creditAllowance`, under the customer's wallet lock), the
 * operator's credit view and the resellers report all read it — and its answer is zero for
 * every reseller, whatever limit a row stored before the decision still holds.
 *
 * A balance already below zero is a legacy debt: left exactly as it is, never collected,
 * repaid only by the same top-ups and credits as any balance.
 */

export interface CreditTerms {
  readonly status: ResellerStatus;
  /** The reseller's own STORED limit, or null for the tier's. Grants nothing. */
  readonly ownLimit: Money | null;
  readonly tierLimit: Money;
}

/** The STORED limit — the reseller's own, else the tier's — and which one it is. */
export function effectiveLimitOf(terms: CreditTerms): {
  readonly limit: Money;
  readonly source: ResellerLimitSource;
} {
  return terms.ownLimit === null
    ? { limit: terms.tierLimit, source: 'TIER' }
    : { limit: terms.ownLimit, source: 'RESELLER' };
}

/**
 * Why credit does not apply: `NO_LIMIT`, for every reseller. The removal is stated with an
 * EXISTING value rather than a new one, so a browser bundle from before the decision still
 * parses the answer during a rolling update; and since migration
 * `0155_reseller_credit_removed` every stored limit is zero, so it is also literally true.
 */
export function creditStateOf(): ResellerCreditState {
  return 'NO_LIMIT';
}

/**
 * The allowance below zero for a wallet debit: ZERO, always. A stored positive limit, an
 * ACTIVE status and a matching currency no longer grant anything.
 */
export function creditAllowanceOf(): bigint {
  return 0n;
}

/**
 * The derivations an operator reads, from a balance and an allowance in one currency.
 *
 * Nothing here is a new rule: credit in use is the negative part of the balance — a legacy
 * debt from before credit was removed (`OQ-WP9-04`); available to spend is the frontier
 * `canCover` applies (`balance − amount ≥ −allowance`), so the balance itself now; over-limit
 * is the debt the (zero) allowance does not cover, so all of it.
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
