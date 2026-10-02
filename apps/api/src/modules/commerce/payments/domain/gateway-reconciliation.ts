import type { PaymentGatewayProvider } from '@nexa/contracts';

/**
 * What a RECORDED inquiry must show before an operator may resolve an UNKNOWN gateway
 * payment (`docs/tonpays-telegram-gateway-audit.md` §9.6.4, `docs/nowpayments-gateway-audit.md`
 * §5.5), per provider vocabulary — one table, so a new gateway adds a row rather than a
 * branch in the settlement code.
 *
 * - CONFIRMED needs the provider's approving status AND `provider_paid === true`, which the
 *   lane records only when the adapter's pure mapping said APPROVED (for NOWPayments:
 *   `finished` for exactly the invoiced price).
 * - FAILED needs one of the provider's "did not complete" statuses. For NOWPayments that
 *   includes `partially_paid`: the money that arrived is not what was invoiced, the order
 *   is not paid by it, and the operator settles the difference with the customer out of
 *   band (a refund at the provider, or a wallet credit through its own audited path).
 *   For NOWPayments only, an approving status recorded WITHOUT `paid === true` (a
 *   `finished` for another price) may be failed for the same reason.
 */
const RECONCILIATION_EVIDENCE: Readonly<
  Partial<
    Record<
      PaymentGatewayProvider,
      {
        readonly confirmed: readonly string[];
        readonly failed: readonly string[];
        /** An approving status recorded without `paid === true` may be failed (MISMATCH). */
        readonly failsUnpaidApproval: boolean;
      }
    >
  >
> = {
  /*
   * TonPays: `completed` without `paid === true` is still OPEN (the provider may yet say it
   * paid), so it is never grounds for failing — exactly as before NOWPayments existed.
   */
  TONPAYS: {
    confirmed: ['completed'],
    failed: ['rejected', 'expired', 'canceled'],
    failsUnpaidApproval: false,
  },
  TONPAYS_TELEGRAM: {
    confirmed: ['completed'],
    failed: ['rejected', 'expired', 'canceled'],
    failsUnpaidApproval: false,
  },
  NOWPAYMENTS: {
    confirmed: ['finished'],
    failed: ['failed', 'expired', 'refunded', 'partially_paid'],
    failsUnpaidApproval: true,
  },
  /*
   * CentralPay (`docs/centralpay-gateway-audit.md` §5.5): `verified` with `paid` is the
   * only confirmation — recorded only when the amount, the customer and a reference bound to
   * this attempt all matched. A `verified` recorded UNPAID (a MISMATCH) or an `unverified`
   * may be failed: neither is a payment of this order.
   */
  CENTRALPAY: {
    confirmed: ['verified'],
    failed: ['unverified'],
    failsUnpaidApproval: true,
  },
};

/**
 * The routes whose settlement REQUIRES the provider's reference for the money to be bound to
 * the attempt first (CentralPay's `referenceId`): `confirmGatewayPayment` refuses one without
 * it, under the payment's lock, whatever its caller passed.
 */
const REFERENCE_BOUND_PROVIDERS: ReadonlySet<PaymentGatewayProvider> = new Set(['CENTRALPAY']);

export function requiresProviderReference(provider: PaymentGatewayProvider): boolean {
  return REFERENCE_BOUND_PROVIDERS.has(provider);
}

/** Whether the recorded inquiry supports resolving the payment to `to`. */
export function reconciliationEvidenceAllows(
  provider: PaymentGatewayProvider,
  to: 'CONFIRMED' | 'FAILED',
  recorded: { readonly status: string | null; readonly paid: boolean | null },
): boolean {
  const vocabulary = RECONCILIATION_EVIDENCE[provider];
  if (vocabulary === undefined || recorded.status === null) return false;
  const approving = vocabulary.confirmed.includes(recorded.status);
  if (to === 'CONFIRMED') return approving && recorded.paid === true;
  /*
   * An approving status the lane did NOT record as paid (NOWPayments: `finished` for another
   * price — a MISMATCH) is not a payment of this order either, so it may be failed; without
   * this an UNKNOWN payment holding it would have no terminal exit.
   */
  return (
    vocabulary.failed.includes(recorded.status) ||
    (vocabulary.failsUnpaidApproval && approving && recorded.paid !== true)
  );
}
