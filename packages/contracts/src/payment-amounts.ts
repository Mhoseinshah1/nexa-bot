import { z } from 'zod';
import { CURRENCY_CODES } from './money.js';
import type { PaymentMethod, PaymentState } from './payment.js';

/**
 * One payment's money, as ONE breakdown (roadmap E4, `docs/payment-fees-fx.md`).
 *
 * Every figure an operator reads about a payment's money — what the order cost or the
 * wallet receives, the gateway fee, what the customer paid, what reached the wallet, what
 * may be refunded — is computed HERE, from the payment's own frozen snapshot, by one pure
 * function. The server sends its answer; the Web Admin renders it and never computes a
 * percentage, a sum or a difference. The financial report reads the same snapshot columns
 * (`payments.amount`, `customer_fee_amount`, `payable_amount`), and an integration test
 * holds the report's lines to the sum of these breakdowns.
 *
 * The rules it states are WP18's, unchanged:
 *
 * - `principal` is `payments.amount`: the order's total or the top-up's amount. It is the
 *   revenue basis, the wallet credit of a top-up and the refund ceiling.
 * - `customerFee` is the gateway fee snapshotted on the attempt (0 when none). It is never
 *   revenue, never credited, never refundable.
 * - `customerPaid` is the payable snapshot — principal plus fee — or the principal when the
 *   payment carries no fee snapshot.
 *
 * And it names, rather than invents, the one figure no record holds: **merchant net**. What
 * the provider kept for itself and paid out is not recorded by any adapter (a provider's
 * final or credited amount is diagnostic metadata, never evidence). It is `null` with the
 * reason `NOT_RECORDED`, and no surface may derive it.
 */
export const MERCHANT_NET_UNAVAILABLE_REASONS = ['NOT_RECORDED'] as const;
export type MerchantNetUnavailableReason = (typeof MERCHANT_NET_UNAVAILABLE_REASONS)[number];

export interface PaymentAmountsInput {
  readonly state: PaymentState;
  readonly method: PaymentMethod;
  /** True for a payment that names no order: a wallet top-up. */
  readonly topup: boolean;
  readonly principalMinor: bigint;
  /** The WP18 snapshot, or null for a payment without one (read as fee 0). */
  readonly customerFee: {
    readonly basisPoints: number;
    readonly feeMinor: bigint;
    readonly payableMinor: bigint;
  } | null;
  /** What a reviewer credited to the wallet instead of approving (D2), or null. */
  readonly receiptCreditMinor: bigint | null;
}

export interface PaymentAmounts {
  readonly principalMinor: bigint;
  readonly customerFeeMinor: bigint;
  /** Null when the payment carries no fee snapshot: no rate was ever applied. */
  readonly customerFeeBasisPoints: number | null;
  readonly customerPaidMinor: bigint;
  /** Money that arrived from OUTSIDE and was confirmed: the customer paid amount, or 0. */
  readonly receivedMinor: bigint;
  /** What this payment put on the customer's wallet: a top-up's principal, a receipt credit. */
  readonly walletCreditMinor: bigint;
  /** What this payment took FROM the wallet: a wallet settlement's principal. */
  readonly walletDebitMinor: bigint;
  /** What may ever be refunded against it: the principal of a confirmed payment. */
  readonly refundCeilingMinor: bigint;
  readonly merchantNetMinor: null;
  readonly merchantNetReason: MerchantNetUnavailableReason;
}

/** The ONE breakdown. Pure, `bigint` throughout; never a float. */
export function paymentAmountsOf(input: PaymentAmountsInput): PaymentAmounts {
  const confirmed = input.state === 'CONFIRMED';
  const fee = input.customerFee?.feeMinor ?? 0n;
  const paid = input.customerFee?.payableMinor ?? input.principalMinor;
  const external = input.method !== 'WALLET';
  return {
    principalMinor: input.principalMinor,
    customerFeeMinor: fee,
    customerFeeBasisPoints: input.customerFee?.basisPoints ?? null,
    customerPaidMinor: paid,
    receivedMinor: confirmed && external ? paid : 0n,
    walletCreditMinor:
      confirmed && input.topup && external
        ? input.principalMinor
        : (input.receiptCreditMinor ?? 0n),
    walletDebitMinor: confirmed && input.method === 'WALLET' ? input.principalMinor : 0n,
    refundCeilingMinor: confirmed ? input.principalMinor : 0n,
    merchantNetMinor: null,
    merchantNetReason: 'NOT_RECORDED',
  };
}

const minor = z.string().regex(/^[0-9]{1,19}$/u);

/** The breakdown on the wire, inside a payment detail. Decimal strings of minor units. */
export const paymentAmountsViewSchema = z.object({
  currency: z.enum(CURRENCY_CODES),
  principal: minor,
  customerFee: minor,
  customerFeeBasisPoints: z.number().int().nullable(),
  customerPaid: minor,
  received: minor,
  walletCredit: minor,
  walletDebit: minor,
  refundCeiling: minor,
  merchantNet: z.null(),
  merchantNetReason: z.enum(MERCHANT_NET_UNAVAILABLE_REASONS),
});
export type PaymentAmountsView = z.infer<typeof paymentAmountsViewSchema>;
