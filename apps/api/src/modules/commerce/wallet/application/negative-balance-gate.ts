import {
  COMMERCE_ERROR_CODES,
  errors,
  type CurrencyCode,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { WalletRepository } from './ports.js';

/** What the gate reads: the derived balance, never a column. */
export type WalletBalanceReader = Pick<WalletRepository, 'balanceOf'>;

/**
 * A wallet below zero buys nothing until it is topped up (owner decisions 2026-10-17 and
 * 2026-10-18).
 *
 * The rule is the same for every wallet, a reseller's included. A negative balance carried
 * over by the one-time Mirza import (its `MIGRATION_OPENING_BALANCE` DEBIT) blocks a purchase.
 * So does a reseller's legacy negative balance from the credit line removed on 2026-10-01: that
 * debt is no longer "never collected", it is a negative wallet like any other. Nothing new can
 * take a wallet below zero (`canCover`, no reseller credit), so this gate only ever meets a
 * balance that was already negative.
 *
 * A wallet purchase would fail `canCover` anyway. This gate is what stops the OTHER rails (a
 * gateway, a receipt, Stars) from selling while the balance is negative. It is checked where a
 * purchase is committed to (an order's confirmation, a commercial action's), inside that
 * transaction. A top-up is never refused by it: topping up is how the balance is settled.
 */
export async function assertWalletNotNegative(
  wallet: WalletBalanceReader,
  scope: TenantContext,
  customerId: UserId,
  currency: CurrencyCode,
  tx: unknown,
): Promise<void> {
  const balance = await wallet.balanceOf(scope, customerId, currency, tx);
  if (balance.amountMinor < 0n) {
    throw errors.conflict(
      COMMERCE_ERROR_CODES.WALLET_NEGATIVE_TOP_UP_REQUIRED,
      'This wallet’s balance is below zero: it must be topped up before anything is bought.',
    );
  }
}
