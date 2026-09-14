import { LEDGER_DIRECTIONS, WALLET_ALLOWS_NEGATIVE_BALANCE } from '@nexa/contracts';
import type { LedgerDirection } from '@nexa/contracts';

/**
 * The ledger's arithmetic. ONE statement of it, and it is deliberately tiny.
 *
 * A ledger entry's amount is POSITIVE and its direction is a separate column —
 * `ledger.ts` says so and `wallet_entries_amount_check` enforces it. That means the
 * sign is applied HERE, at the one place that knows what a direction means, rather
 * than by each caller.
 *
 * The legacy system is what happens when that is spread out: `RSV2-BR-019` records a
 * report that ADDS administrative debits to the wallet top-up total instead of
 * subtracting them, and the resulting per-user statement leaves a residual of 916,550
 * against a balance of 2,659,767 that nobody can explain. One function, one direction
 * table, no second opinion.
 */
export function signedMinor(direction: LedgerDirection, amountMinor: bigint): bigint {
  /*
   * Exhaustive over the FROZEN vocabulary rather than an `=== 'CREDIT'` and an else.
   *
   * A third direction added to `LEDGER_DIRECTIONS` would make this throw on the day it
   * was introduced, in a test, instead of being silently treated as a debit by an
   * `else` branch — which is a sign error on somebody's money.
   */
  switch (direction) {
    case 'CREDIT':
      return amountMinor;
    case 'DEBIT':
      return -amountMinor;
    default: {
      const unreachable: never = direction;
      throw new Error(
        `unknown ledger direction ${String(unreachable)}; ` +
          `the frozen vocabulary is ${LEDGER_DIRECTIONS.join(', ')}`,
      );
    }
  }
}

/**
 * How much more is needed to cover an amount, or zero when it is covered.
 *
 * The SHORTFALL rather than a boolean, because that is what the customer is told:
 * `bot.wallet.insufficient` declares exactly one placeholder and it is `{shortfall}`.
 * Its frozen description says why — *"Carries the shortfall rather than the balance,
 * because the shortfall is what the customer has to act on."*
 */
export function shortfallMinor(balanceMinor: bigint, requiredMinor: bigint): bigint {
  const missing = requiredMinor - balanceMinor;
  return missing > 0n ? missing : 0n;
}

/**
 * Whether a debit of this size may be taken.
 *
 * Reads `WALLET_ALLOWS_NEGATIVE_BALANCE` rather than hard-coding the comparison, which
 * is the point of that constant existing: `payment.ts` says it is a constant *"so that
 * the reseller credit line in 4F has to change data rather than code"*. When a
 * per-customer allowance arrives it is an argument here, not a second code path.
 *
 * The legacy system cannot answer whether its balance goes below zero (`UNK-UM-005`),
 * which is another way of saying nothing stops it.
 */
export function canCover(balanceMinor: bigint, requiredMinor: bigint): boolean {
  if (WALLET_ALLOWS_NEGATIVE_BALANCE) return true;
  return balanceMinor >= requiredMinor;
}
