import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type {
  CurrencyCode,
  CustomerNotificationKind,
  CustomerNotificationState,
  LedgerDirection,
  LedgerReason,
  PaymentEvidenceKind,
  PaymentId,
  PaymentMethod,
  PaymentReceiptKind,
  PaymentState,
  RefundChannel,
  RefundState,
  TenantContext,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  customerNotifications,
  paymentReceipts,
  payments,
  receiptCredits,
  refunds,
  walletEntries,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  PaymentTimelineFacts,
  TimelineNotificationFacts,
} from '../domain/payment-timeline.js';
import type {
  PaymentTimelineReader,
  TimelineSectionsIncluded,
} from '../application/timeline-ports.js';

/**
 * The notification kinds whose subject is `payments.id` (`customer-notifications.ts`).
 * Read under `payments.view`: each is a fact about this payment the customer was told.
 */
const PAYMENT_SUBJECT_KINDS: readonly CustomerNotificationKind[] = [
  'PAYMENT_REJECTED',
  'PAYMENT_EXPIRED',
  'PAYMENT_TRANSFER_RECORDED',
  'WALLET_TOPUP_CREDITED',
  'RECEIPT_CREDITED_TO_WALLET',
  'WALLET_TOPUP_GIFT_CREDITED',
];

/**
 * A payment's history, in PostgreSQL (WP17). Reads only; there is no write here.
 *
 * Every query is tenant-scoped, and every section below the payment row is keyed on the
 * payment id and, where a customer is involved, on the payment's OWN customer.
 */
export class DrizzlePaymentTimelineReader implements PaymentTimelineReader {
  constructor(private readonly db: Database) {}

  async facts(
    scope: TenantContext,
    paymentId: PaymentId,
    include: TimelineSectionsIncluded,
    limit: number,
  ): Promise<PaymentTimelineFacts | null> {
    const tenantId = requireTenantId(scope);
    const [payment] = await this.db
      .select()
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.id, paymentId)))
      .limit(1);
    if (payment === undefined) return null;

    const [credit] = await this.db
      .select()
      .from(receiptCredits)
      .where(and(eq(receiptCredits.tenantId, tenantId), eq(receiptCredits.paymentId, paymentId)))
      .limit(1);

    const notificationColumns = {
      id: customerNotifications.id,
      kind: customerNotifications.kind,
      state: customerNotifications.state,
      createdAt: customerNotifications.createdAt,
      resolvedAt: customerNotifications.resolvedAt,
    };
    const paymentNotifications = await this.db
      .select(notificationColumns)
      .from(customerNotifications)
      .where(
        and(
          eq(customerNotifications.tenantId, tenantId),
          eq(customerNotifications.customerId, payment.customerId),
          eq(customerNotifications.subjectId, paymentId),
          inArray(customerNotifications.kind, [...PAYMENT_SUBJECT_KINDS]),
        ),
      )
      .orderBy(asc(customerNotifications.createdAt), asc(customerNotifications.id))
      .limit(limit);

    const receiptRows = include.receipts
      ? await this.db
          .select({
            id: paymentReceipts.id,
            kind: paymentReceipts.kind,
            createdAt: paymentReceipts.createdAt,
          })
          .from(paymentReceipts)
          .where(
            and(eq(paymentReceipts.tenantId, tenantId), eq(paymentReceipts.paymentId, paymentId)),
          )
          .orderBy(asc(paymentReceipts.createdAt), asc(paymentReceipts.id))
          .limit(limit)
      : [];

    /*
     * The payment's OWN customer's ledger only. A referral commission names the referee's
     * payment but is written to the REFERRER's wallet: that is another customer's ledger,
     * and showing it here would put one customer's money on another's payment.
     *
     * `REFUND` entries are left to the refund section, which shows the same money under
     * `refunds.view`; repeating it here would show a refund to a viewer without that key.
     */
    const walletRows = include.wallet
      ? await this.db
          .select({
            id: walletEntries.id,
            direction: walletEntries.direction,
            reason: walletEntries.reason,
            amount: walletEntries.amount,
            currency: walletEntries.currency,
            createdAt: walletEntries.createdAt,
          })
          .from(walletEntries)
          .where(
            and(
              eq(walletEntries.tenantId, tenantId),
              eq(walletEntries.paymentId, paymentId),
              eq(walletEntries.customerId, payment.customerId),
              ne(walletEntries.reason, 'REFUND'),
            ),
          )
          .orderBy(asc(walletEntries.createdAt), asc(walletEntries.id))
          .limit(limit)
      : [];

    const refundRows = include.refunds
      ? await this.db
          .select()
          .from(refunds)
          .where(and(eq(refunds.tenantId, tenantId), eq(refunds.paymentId, paymentId)))
          .orderBy(asc(refunds.createdAt), asc(refunds.id))
          .limit(limit)
      : [];

    const refundNotifications = include.refunds
      ? await this.refundNotifications(
          tenantId,
          payment.customerId,
          payment.orderId,
          refundRows.map((r) => r.id),
          refundRows.some((r) => r.requestedByAdminId === null),
          notificationColumns,
          limit,
        )
      : [];

    const notifications: TimelineNotificationFacts[] = [
      ...paymentNotifications,
      ...refundNotifications,
    ].map((n) => ({
      id: n.id,
      kind: n.kind as CustomerNotificationKind,
      state: n.state as CustomerNotificationState,
      createdAt: n.createdAt,
      resolvedAt: n.resolvedAt,
    }));

    return {
      payment: {
        method: payment.method as PaymentMethod,
        state: payment.state as PaymentState,
        amountMinor: payment.amount,
        currency: payment.currency as CurrencyCode,
        createdAt: payment.createdAt,
        customerSignalledAt: payment.customerSignalledAt,
        confirmedAt: payment.confirmedAt,
        evidenceKind: payment.evidenceKind as PaymentEvidenceKind | null,
        confirmedByAdminId: payment.confirmedByAdminId,
        resolvedAt: payment.resolvedAt,
        resolvedByAdminId: payment.resolvedByAdminId,
      },
      receiptCredit:
        credit === undefined
          ? null
          : {
              amountMinor: credit.amount,
              currency: credit.currency as CurrencyCode,
              decidedAt: credit.decidedAt,
              decidedByAdminId: credit.decidedByAdminId,
            },
      notifications,
      receipts: receiptRows.map((r) => ({
        id: r.id,
        kind: r.kind as PaymentReceiptKind,
        createdAt: r.createdAt,
      })),
      walletEntries: walletRows.map((w) => ({
        id: w.id,
        direction: w.direction as LedgerDirection,
        reason: w.reason as LedgerReason,
        amountMinor: w.amount,
        currency: w.currency as CurrencyCode,
        createdAt: w.createdAt,
      })),
      refunds: refundRows.map((r) => ({
        id: r.id,
        state: r.state as RefundState,
        channel: r.channel as RefundChannel,
        amountMinor: r.amount,
        currency: r.currency as CurrencyCode,
        requestedByAdminId: r.requestedByAdminId,
        completedByAdminId: r.completedByAdminId,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
        updatedAt: r.updatedAt,
      })),
    };
  }

  /**
   * What the customer was told about this payment's refunds.
   *
   * `REFUND_COMPLETED` has the refund as its subject, one per refund. `ORDER_REFUNDED_TO_WALLET`
   * has the ORDER as its subject; it belongs on this payment's history only when this
   * payment carries the automatic refund (the one with no requesting administrator),
   * because an order can have had an earlier payment that expired, and that one was
   * never refunded.
   */
  private async refundNotifications(
    tenantId: string,
    customerId: string,
    orderId: string | null,
    refundIds: readonly string[],
    carriesAutomaticRefund: boolean,
    columns: {
      readonly id: typeof customerNotifications.id;
      readonly kind: typeof customerNotifications.kind;
      readonly state: typeof customerNotifications.state;
      readonly createdAt: typeof customerNotifications.createdAt;
      readonly resolvedAt: typeof customerNotifications.resolvedAt;
    },
    limit: number,
  ) {
    const rows = [];
    if (refundIds.length > 0) {
      rows.push(
        ...(await this.db
          .select(columns)
          .from(customerNotifications)
          .where(
            and(
              eq(customerNotifications.tenantId, tenantId),
              eq(customerNotifications.customerId, customerId),
              eq(customerNotifications.kind, 'REFUND_COMPLETED'),
              inArray(customerNotifications.subjectId, [...refundIds]),
            ),
          )
          .orderBy(asc(customerNotifications.createdAt), asc(customerNotifications.id))
          .limit(limit)),
      );
    }
    if (orderId !== null && carriesAutomaticRefund) {
      rows.push(
        ...(await this.db
          .select(columns)
          .from(customerNotifications)
          .where(
            and(
              eq(customerNotifications.tenantId, tenantId),
              eq(customerNotifications.customerId, customerId),
              eq(customerNotifications.kind, 'ORDER_REFUNDED_TO_WALLET'),
              eq(customerNotifications.subjectId, orderId),
            ),
          )
          .limit(1)),
      );
    }
    return rows;
  }
}
