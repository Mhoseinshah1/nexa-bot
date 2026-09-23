import type { PaymentRecord } from '../application/ports.js';

/**
 * Whether the customer VOUCHED for a transfer: they said they sent it, or they sent a
 * receipt for it. `docs/wp10-payments-audit.md` P1.
 *
 * Either is enough, and neither is evidence that money arrived — that is still a
 * reviewer's to decide. What vouching changes is what the product owes the customer when
 * the window closes: a transfer nobody vouched for simply lapses, and one somebody said
 * they paid is still being looked for.
 *
 * ONE statement of the rule, read by the expiry sweep (which sentence the customer is
 * sent) and by the late-review lane (whether a reviewer may decide it). A copy in each
 * would be the "one evaluator, several callers" defect `CLAUDE.md` records for panel
 * eligibility.
 */
export function customerVouchedFor(
  payment: Pick<PaymentRecord, 'method' | 'customerSignalledAt'>,
  receiptCount: number,
): boolean {
  if (payment.method !== 'MANUAL_TRANSFER') return false;
  return payment.customerSignalledAt !== null || receiptCount > 0;
}

/**
 * Why a payment is not in the late-review lane, or `null` when it is — decision aside.
 *
 * The lane holds an EXPIRED `MANUAL_TRANSFER` the customer vouched for. Whether it has
 * already been decided is the other half of membership, and it is asked separately
 * because its answer is a different refusal: `LATE_TRANSFER_ALREADY_DECIDED` is a race
 * lost, this is a payment that was never a candidate.
 *
 * A top-up transfer (no order) is a candidate on exactly the same terms. The money
 * arrived for the wallet either way, and the credit is what the top-up would have been.
 */
export type LateReviewRefusal = 'NOT_EXPIRED' | 'NOT_A_TRANSFER' | 'NOT_VOUCHED_FOR';

export function lateReviewRefusal(
  payment: Pick<PaymentRecord, 'state' | 'method' | 'customerSignalledAt'>,
  receiptCount: number,
): LateReviewRefusal | null {
  if (payment.method !== 'MANUAL_TRANSFER') return 'NOT_A_TRANSFER';
  if (payment.state !== 'EXPIRED') return 'NOT_EXPIRED';
  if (!customerVouchedFor(payment, receiptCount)) return 'NOT_VOUCHED_FOR';
  return null;
}
