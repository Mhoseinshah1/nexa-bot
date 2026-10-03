import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type {
  ActorType,
  AuditResult,
  CurrencyCode,
  CustomerNotificationKind,
  CustomerNotificationState,
  GatewayInvoiceCreationState,
  GatewayInvoiceOutcome,
  LedgerDirection,
  OperationState,
  OperationType,
  OrderPurpose,
  PaymentGatewayProvider,
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
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  auditLogs,
  customerNotifications,
  gatewayInvoices,
  orders,
  paymentReceipts,
  payments,
  provisioningOperations,
  receiptCredits,
  refunds,
  walletEntries,
} from '../../../../infrastructure/persistence/schema.js';
import { PURCHASED_AS } from '../../provisioning/application/provisioner.service.js';
import { PAYMENT_LOSE_TRACK_ACTION } from '../application/gateway-payment.service.js';
import { RECONCILE_INQUIRY_ACTION } from '../application/payment.service.js';
import type {
  PaymentTimelineFacts,
  TimelineAuditFacts,
  TimelineGatewayFacts,
  TimelineLoseTrackFacts,
  TimelineNotificationFacts,
  TimelineOrderFacts,
  TimelineReinquireFacts,
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
  'GATEWAY_PAYMENT_FAILED',
];

/**
 * A payment's history, in PostgreSQL (WP17). Reads only; there is no write here.
 *
 * Every query is tenant-scoped, and every section below the payment row is keyed on the
 * payment id and, where a customer is involved, on the payment's OWN customer.
 */

export class DrizzlePaymentTimelineReader implements PaymentTimelineReader {
  constructor(private readonly db: Database) {}

  /**
   * Every section is read inside ONE repeatable-read, read-only transaction. The facts
   * are several statements over several tables, and a payment confirmed between two of
   * them would otherwise be read PENDING beside the debit and the notification committed
   * with its confirmation: a history no moment ever had. One snapshot shows the payment
   * as it stood, with exactly the rows that stood beside it.
   */
  async facts(
    scope: TenantContext,
    paymentId: PaymentId,
    include: TimelineSectionsIncluded,
    limit: number,
  ): Promise<PaymentTimelineFacts | null> {
    return this.db.transaction((q) => this.read(q, scope, paymentId, include, limit), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }

  private async read(
    q: Executor,
    scope: TenantContext,
    paymentId: PaymentId,
    include: TimelineSectionsIncluded,
    limit: number,
  ): Promise<PaymentTimelineFacts | null> {
    const tenantId = requireTenantId(scope);
    const [payment] = await q
      .select()
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.id, paymentId)))
      .limit(1);
    if (payment === undefined) return null;

    const [credit] = await q
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
    const paymentNotifications = await q
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
      ? await q
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
     *
     * By the payment, through `wallet_entries_payment_idx` (`online-indexes.ts`), bounded on
     * both sides by the payment itself (Codex review of #81). An earlier version bounded the
     * read below by the payment's creation, less a day for a clock stepped back, because no
     * index led with `payment_id`: the range still ran to the end of the customer's ledger,
     * and the floor could hide a movement stamped by a clock stepped back further. With the
     * index there is no floor to tolerate.
     */
    const walletRows = include.wallet
      ? await q
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
      ? await q
          .select()
          .from(refunds)
          .where(and(eq(refunds.tenantId, tenantId), eq(refunds.paymentId, paymentId)))
          .orderBy(asc(refunds.createdAt), asc(refunds.id))
          .limit(limit)
      : [];

    const refundNotifications = include.refunds
      ? await this.refundNotifications(
          q,
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

    const gateway = await this.gateway(q, tenantId, paymentId);
    const loseTrack = await this.loseTrack(q, tenantId, paymentId, limit);
    const reinquireRequests = await this.reinquireRequests(q, tenantId, paymentId, limit);
    const order =
      include.order && payment.orderId !== null && payment.state === 'CONFIRMED'
        ? await this.order(q, tenantId, payment.orderId, limit)
        : null;
    const audit = include.audit ? await this.audit(q, tenantId, paymentId, limit) : [];

    return {
      gateway,
      loseTrack,
      reinquireRequests,
      order,
      audit,
      payment: {
        providerReviewStartedAt: payment.providerReviewStartedAt,
        providerReviewUntil: payment.providerReviewUntil,
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

  /** The payment's gateway invoice: ids, states, codes and times — never a link or a card. */
  private async gateway(
    q: Executor,
    tenantId: string,
    paymentId: PaymentId,
  ): Promise<TimelineGatewayFacts | null> {
    const [row] = await q
      .select({
        provider: gatewayInvoices.provider,
        createdAt: gatewayInvoices.createdAt,
        creationState: gatewayInvoices.creationState,
        creationErrorCode: gatewayInvoices.creationErrorCode,
        creationSentAt: gatewayInvoices.creationSentAt,
        createdInvoiceAt: gatewayInvoices.createdInvoiceAt,
        providerInvoiceId: gatewayInvoices.providerInvoiceId,
        lastWebhookAt: gatewayInvoices.lastWebhookAt,
        webhookStatusHint: gatewayInvoices.webhookStatusHint,
        webhookCount: gatewayInvoices.webhookCount,
        lastInquiryAt: gatewayInvoices.lastInquiryAt,
        providerStatus: gatewayInvoices.providerStatus,
        providerPaid: gatewayInvoices.providerPaid,
        lastInquiryErrorCode: gatewayInvoices.lastInquiryErrorCode,
        outcome: gatewayInvoices.outcome,
        outcomeAt: gatewayInvoices.outcomeAt,
        lateCompletionObservedAt: gatewayInvoices.lateCompletionObservedAt,
      })
      .from(gatewayInvoices)
      .where(and(eq(gatewayInvoices.tenantId, tenantId), eq(gatewayInvoices.paymentId, paymentId)))
      .limit(1);
    if (row === undefined) return null;
    return {
      ...row,
      provider: row.provider as PaymentGatewayProvider,
      creationState: row.creationState as GatewayInvoiceCreationState,
      outcome: row.outcome as GatewayInvoiceOutcome | null,
    };
  }

  /**
   * The lane's `PENDING -> UNKNOWN` moves, from their audit rows: the mismatch reason and the
   * provider status it recorded, and nothing else of `after`. Under `payments.view`: it is
   * the payment's own state change, which the detail already shows as UNKNOWN.
   */
  private async loseTrack(
    q: Executor,
    tenantId: string,
    paymentId: PaymentId,
    limit: number,
  ): Promise<TimelineLoseTrackFacts[]> {
    const rows = await q
      .select({ id: auditLogs.id, at: auditLogs.occurredAt, after: auditLogs.after })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, tenantId),
          eq(auditLogs.entityType, 'Payment'),
          eq(auditLogs.entityId, paymentId),
          eq(auditLogs.action, PAYMENT_LOSE_TRACK_ACTION),
          eq(auditLogs.result, 'SUCCESS'),
        ),
      )
      .orderBy(asc(auditLogs.occurredAt), asc(auditLogs.id))
      .limit(limit);
    return rows.map((row) => {
      const after = (row.after ?? {}) as Record<string, unknown>;
      const text = (value: unknown) => (typeof value === 'string' ? value : null);
      return {
        id: row.id,
        at: row.at,
        reason: text(after['reason']),
        providerStatus: text(after['providerStatus']),
      };
    });
  }

  /**
   * Each recorded operator "ask the provider again", from its audit row — the durable record;
   * the invoice's `reconcile_inquiry_requested_at` is cleared by the inquiry that answers it.
   * Only `requested = true`: a request inside the spacing minute recorded nothing.
   *
   * Under `payments.view`, like `loseTrack`, and NOT gated by `audit.view`: before this read
   * the entry came from the invoice row under `payments.view`, and an operator who may press
   * "ask again" (`payments.reconcile`) must see that it was pressed without being granted
   * the whole audit section. Only the time is carried — no actor, no `before`/`after`.
   */
  private async reinquireRequests(
    q: Executor,
    tenantId: string,
    paymentId: PaymentId,
    limit: number,
  ): Promise<TimelineReinquireFacts[]> {
    return q
      .select({ id: auditLogs.id, at: auditLogs.occurredAt })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, tenantId),
          eq(auditLogs.entityType, 'Payment'),
          eq(auditLogs.entityId, paymentId),
          eq(auditLogs.action, RECONCILE_INQUIRY_ACTION),
          eq(auditLogs.result, 'SUCCESS'),
          sql`(${auditLogs.after} ->> 'requested') = 'true'`,
        ),
      )
      .orderBy(asc(auditLogs.occurredAt), asc(auditLogs.id))
      .limit(limit);
  }

  /**
   * The order this CONFIRMED payment settled: its settlement and refund times, and the
   * operations that deliver what it bought — `PURCHASED_AS`, the table the cashback and
   * commission earners read, so "fulfilled" means here what it means there.
   */
  private async order(
    q: Executor,
    tenantId: string,
    orderId: string,
    limit: number,
  ): Promise<TimelineOrderFacts | null> {
    const [row] = await q
      .select({
        id: orders.id,
        purpose: orders.purpose,
        settledAt: orders.settledAt,
        refundedAt: orders.refundedAt,
      })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
      .limit(1);
    if (row === undefined) return null;
    const type = PURCHASED_AS[row.purpose as OrderPurpose];
    const ops = await q
      .select({
        id: provisioningOperations.id,
        type: provisioningOperations.type,
        state: provisioningOperations.state,
        createdAt: provisioningOperations.createdAt,
        completedAt: provisioningOperations.completedAt,
      })
      .from(provisioningOperations)
      .where(
        and(
          eq(provisioningOperations.tenantId, tenantId),
          eq(provisioningOperations.orderId, orderId),
          eq(provisioningOperations.type, type),
        ),
      )
      .orderBy(asc(provisioningOperations.createdAt), asc(provisioningOperations.id))
      .limit(limit);
    return {
      id: row.id,
      settledAt: row.settledAt,
      refundedAt: row.refundedAt,
      fulfilment: ops.map((op) => ({
        id: op.id,
        type: op.type as OperationType,
        state: op.state as OperationState,
        createdAt: op.createdAt,
        completedAt: op.completedAt,
      })),
    };
  }

  /** Every audit row on the payment, under `audit.view`: who, what, when and the result. */
  private async audit(
    q: Executor,
    tenantId: string,
    paymentId: PaymentId,
    limit: number,
  ): Promise<TimelineAuditFacts[]> {
    const rows = await q
      .select({
        id: auditLogs.id,
        at: auditLogs.occurredAt,
        action: auditLogs.action,
        actorType: auditLogs.actorType,
        actorId: auditLogs.actorId,
        result: auditLogs.result,
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, tenantId),
          eq(auditLogs.entityType, 'Payment'),
          eq(auditLogs.entityId, paymentId),
        ),
      )
      .orderBy(asc(auditLogs.occurredAt), asc(auditLogs.id))
      .limit(limit);
    return rows.map((row) => ({
      ...row,
      actorType: row.actorType as ActorType,
      result: row.result as AuditResult,
    }));
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
    q: Executor,
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
        ...(await q
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
        ...(await q
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
