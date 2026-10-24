import type { Money } from '@nexa/contracts';

/**
 * What the customer had to TRANSFER for a payment: the payable the invoice asked for, which
 * is the principal plus the customer fee when the route charged one (WP18; since R6 item 4 the
 * manual card-to-card route can too), else the principal.
 *
 * One function, because "how much did this customer owe the bank" is asked in several places —
 * the invoice, its copy button, the receipt queue, the reviewer's caption and the amount a
 * reviewer is asked to compare — and two answers to it are a reviewer approving a receipt for
 * an amount the customer was never asked to send. It reads the payment's own FROZEN snapshot,
 * never the route's current rate. It is NOT what the wallet receives or a refund returns:
 * that is `payment.amount`, the principal, always.
 */
export function amountToTransfer(payment: {
  readonly amount: Money;
  readonly customerFee: { readonly payable: Money } | null;
}): Money {
  return payment.customerFee?.payable ?? payment.amount;
}
