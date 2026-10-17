import {
  COMMERCE_ERROR_CODES,
  errors,
  type CurrencyCode,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { WalletRepository } from './ports.js';

/** What the gate reads: the derived balance, never a column. */
export type WalletBalanceReader = Pick<WalletRepository, 'balanceOf' | 'hasMigrationDebitOpening'>;

/**
 * A wallet below zero buys nothing until it is topped up (owner decision 2026-10-17).
 *
 * Today only the one-time Mirza import's DEBIT opening takes a wallet below zero: every other
 * debit passes `canCover`. So a wallet purchase already fails on an insufficient balance;
 * this gate is what stops the OTHER rails — a gateway, a receipt, Stars — selling to a
 * customer who still owes the carried-over balance. It is checked where a purchase is
 * committed to (an order's confirmation, a commercial action's), inside that transaction.
 * A top-up is never refused by it: topping up is how the balance is settled.
 *
 * Only a wallet the Mirza import took below zero is gated. A reseller's legacy debt from the
 * removed credit line (owner decision 2026-10-01) is a different, older rule — left exactly
 * as it is and never collected, so a purchase paid by another rail stays possible — and this
 * gate must not turn it into a collection (`docs/reseller-phase3-closure.md`).
 */
export async function assertWalletNotNegative(
  wallet: WalletBalanceReader,
  scope: TenantContext,
  customerId: UserId,
  currency: CurrencyCode,
  tx: unknown,
): Promise<void> {
  const balance = await wallet.balanceOf(scope, customerId, currency, tx);
  if (balance.amountMinor < 0n && (await wallet.hasMigrationDebitOpening(scope, customerId, tx))) {
    throw errors.conflict(
      COMMERCE_ERROR_CODES.WALLET_NEGATIVE_TOP_UP_REQUIRED,
      'This wallet’s balance is below zero: it must be topped up before anything is bought.',
    );
  }
}
