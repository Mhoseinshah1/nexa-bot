import {
  PAYMENT_TIMELINE_KINDS,
  PAYMENT_TIMELINE_MAX_ENTRIES,
  type ActorType,
  type AuditResult,
  type CurrencyCode,
  type CustomerNotificationKind,
  type CustomerNotificationState,
  type GatewayInvoiceCreationState,
  type GatewayInvoiceOutcome,
  type LedgerDirection,
  type OperationState,
  type OperationType,
  type PaymentGatewayProvider,
  type LedgerReason,
  type PaymentEvidenceKind,
  type PaymentMethod,
  type PaymentReceiptKind,
  type PaymentResolvedState,
  type PaymentState,
  type PaymentTimelineEntry,
  type PaymentTimelineKind,
  type RefundChannel,
  type RefundState,
} from '@nexa/contracts';

/**
 * One payment's history, assembled from facts other flows have already written (WP17,
 * `docs/wp17-payment-phase3-audit.md` F4).
 *
 * Pure: no clock, no database, no permission. The reader fetches only the sections the
 * viewer may see, and this turns whatever it was handed into ordered entries. Nothing
 * here decides an amount or a state — every field is copied from a row, and the only
 * judgement made is ORDER.
 */

export interface TimelinePaymentFacts {
  readonly method: PaymentMethod;
  readonly state: PaymentState;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly createdAt: Date;
  readonly customerSignalledAt: Date | null;
  readonly confirmedAt: Date | null;
  readonly evidenceKind: PaymentEvidenceKind | null;
  readonly confirmedByAdminId: string | null;
  readonly resolvedAt: Date | null;
  readonly resolvedByAdminId: string | null;
  /** The provider review window (TonPays Telegram, NOWPayments), when one was opened. */
  readonly providerReviewStartedAt?: Date | null;
  readonly providerReviewUntil?: Date | null;
}

/**
 * The payment's `gateway_invoices` row (Payment Operations Center). It keeps the LATEST
 * inquiry and webhook, not a log of each, so each becomes one "last at" entry.
 */
export interface TimelineGatewayFacts {
  readonly provider: PaymentGatewayProvider;
  readonly createdAt: Date;
  readonly creationState: GatewayInvoiceCreationState;
  readonly creationErrorCode: string | null;
  readonly creationSentAt: Date | null;
  readonly createdInvoiceAt: Date | null;
  readonly providerInvoiceId: string | null;
  readonly lastWebhookAt: Date | null;
  readonly webhookStatusHint: string | null;
  readonly webhookCount: number;
  readonly lastInquiryAt: Date | null;
  readonly providerStatus: string | null;
  readonly providerPaid: boolean | null;
  readonly lastInquiryErrorCode: string | null;
  readonly reconcileInquiryRequestedAt: Date | null;
  readonly outcome: GatewayInvoiceOutcome | null;
  readonly outcomeAt: Date | null;
  readonly lateCompletionObservedAt: Date | null;
}

/** One `payment.lose_track` audit row: the lane moving the payment to UNKNOWN. */
export interface TimelineLoseTrackFacts {
  readonly id: string;
  readonly at: Date;
  /** The machine reason a mismatch hold records; null for a lapsed review. */
  readonly reason: string | null;
  readonly providerStatus: string | null;
}

/** The order this payment settled, behind `orders.view`. */
export interface TimelineOrderFacts {
  readonly id: string;
  readonly settledAt: Date | null;
  readonly refundedAt: Date | null;
  /** The operations that deliver what the order bought (`PURCHASED_AS`), oldest first. */
  readonly fulfilment: readonly {
    readonly id: string;
    readonly type: OperationType;
    readonly state: OperationState;
    readonly createdAt: Date;
    readonly completedAt: Date | null;
  }[];
}

/** One audit row on the payment, behind `audit.view`. Never `before`/`after`. */
export interface TimelineAuditFacts {
  readonly id: string;
  readonly at: Date;
  readonly action: string;
  readonly actorType: ActorType;
  readonly actorId: string | null;
  readonly result: AuditResult;
}

export interface TimelineReceiptCreditFacts {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly decidedAt: Date;
  readonly decidedByAdminId: string;
}

export interface TimelineReceiptFacts {
  readonly id: string;
  readonly kind: PaymentReceiptKind;
  readonly createdAt: Date;
}

export interface TimelineWalletEntryFacts {
  readonly id: string;
  readonly direction: LedgerDirection;
  readonly reason: LedgerReason;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly createdAt: Date;
}

export interface TimelineRefundFacts {
  readonly id: string;
  readonly state: RefundState;
  readonly channel: RefundChannel;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly requestedByAdminId: string | null;
  readonly completedByAdminId: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  readonly updatedAt: Date;
}

export interface TimelineNotificationFacts {
  readonly id: string;
  readonly kind: CustomerNotificationKind;
  readonly state: CustomerNotificationState;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

export interface PaymentTimelineFacts {
  readonly payment: TimelinePaymentFacts;
  readonly receiptCredit: TimelineReceiptCreditFacts | null;
  readonly notifications: readonly TimelineNotificationFacts[];
  readonly receipts: readonly TimelineReceiptFacts[];
  readonly walletEntries: readonly TimelineWalletEntryFacts[];
  readonly refunds: readonly TimelineRefundFacts[];
  /** Null for a payment that is not a `GATEWAY` payment. */
  readonly gateway?: TimelineGatewayFacts | null;
  readonly loseTrack?: readonly TimelineLoseTrackFacts[];
  /** Null when the payment settles no order, or the section is withheld. */
  readonly order?: TimelineOrderFacts | null;
  readonly audit?: readonly TimelineAuditFacts[];
}

/** The administrator actor types: the only actors whose id the timeline names. */
const ADMIN_ACTORS: ReadonlySet<ActorType> = new Set<ActorType>(['WEB_ADMIN', 'TELEGRAM_ADMIN']);

/**
 * A provider- or lane-supplied machine code as stored, or null when it is not one. The
 * timeline carries codes, never free text: a value that is not a short code is dropped
 * rather than shown.
 */
export function machineCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/u.test(value) ? value : null;
}

export interface AssembledTimeline {
  readonly entries: readonly PaymentTimelineEntry[];
  readonly truncated: boolean;
}

const RANK: ReadonlyMap<PaymentTimelineKind, number> = new Map(
  PAYMENT_TIMELINE_KINDS.map((kind, index) => [kind, index]),
);

/** An entry with the three keys it is sorted by, before `at` becomes a string. */
interface Sortable {
  readonly time: number;
  readonly rank: number;
  readonly key: string;
  readonly entry: PaymentTimelineEntry;
}

function sortable(time: Date, key: string, entry: PaymentTimelineEntry): Sortable {
  return { time: time.getTime(), rank: RANK.get(entry.kind) ?? 0, key, entry };
}

const RESOLVED: ReadonlySet<PaymentState> = new Set<PaymentState>([
  'FAILED',
  'CANCELLED',
  'EXPIRED',
]);

/**
 * The entries, oldest first, at most `max` of them.
 *
 * Sorted by time, then by the fixed rank `PAYMENT_TIMELINE_KINDS` declares, then by the
 * source row's id — so two reads of the same rows render the same order, and a payment
 * created and confirmed in one transaction (a wallet settlement, whose `created_at` and
 * `confirmed_at` are one instant) reads "created, then confirmed" rather than whichever
 * the engine returned first.
 *
 * `truncated` is decided BEFORE the cut, from how many entries there were, never from
 * how many survived it; a history that was exactly `max` long is complete.
 */
export function assemblePaymentTimeline(
  facts: PaymentTimelineFacts,
  max: number = PAYMENT_TIMELINE_MAX_ENTRIES,
): AssembledTimeline {
  const all: Sortable[] = [];
  const p = facts.payment;

  all.push(
    sortable(p.createdAt, 'payment', {
      kind: 'PAYMENT_CREATED',
      at: p.createdAt.toISOString(),
      method: p.method,
      amountMinor: p.amountMinor.toString(),
      currency: p.currency,
    }),
  );
  if (p.customerSignalledAt !== null) {
    all.push(
      sortable(p.customerSignalledAt, 'payment', {
        kind: 'CUSTOMER_SIGNALLED',
        at: p.customerSignalledAt.toISOString(),
      }),
    );
  }
  // `payments_confirmed_check` binds the two together; both are required here anyway so a
  // row that somehow carried one without the other shows nothing rather than a half-fact.
  if (p.confirmedAt !== null && p.evidenceKind !== null) {
    all.push(
      sortable(p.confirmedAt, 'payment', {
        kind: 'PAYMENT_CONFIRMED',
        at: p.confirmedAt.toISOString(),
        evidenceKind: p.evidenceKind,
        adminId: p.confirmedByAdminId,
      }),
    );
  }
  if (p.resolvedAt !== null && RESOLVED.has(p.state)) {
    all.push(
      sortable(p.resolvedAt, 'payment', {
        kind: 'PAYMENT_RESOLVED',
        at: p.resolvedAt.toISOString(),
        state: p.state as PaymentResolvedState,
        adminId: p.resolvedByAdminId,
      }),
    );
  }
  if (facts.receiptCredit !== null) {
    const c = facts.receiptCredit;
    all.push(
      sortable(c.decidedAt, 'receipt-credit', {
        kind: 'RECEIPT_CREDITED',
        at: c.decidedAt.toISOString(),
        amountMinor: c.amountMinor.toString(),
        currency: c.currency,
        adminId: c.decidedByAdminId,
      }),
    );
  }
  for (const r of facts.receipts) {
    all.push(
      sortable(r.createdAt, r.id, {
        kind: 'RECEIPT_SUBMITTED',
        at: r.createdAt.toISOString(),
        receiptId: r.id,
        receiptKind: r.kind,
      }),
    );
  }
  for (const w of facts.walletEntries) {
    all.push(
      sortable(w.createdAt, w.id, {
        kind: 'WALLET_ENTRY',
        at: w.createdAt.toISOString(),
        entryId: w.id,
        direction: w.direction,
        reason: w.reason,
        amountMinor: w.amountMinor.toString(),
        currency: w.currency,
      }),
    );
  }
  for (const f of facts.refunds) {
    const money = { amountMinor: f.amountMinor.toString(), currency: f.currency };
    all.push(
      sortable(f.createdAt, f.id, {
        kind: 'REFUND_REQUESTED',
        at: f.createdAt.toISOString(),
        refundId: f.id,
        channel: f.channel,
        ...money,
        adminId: f.requestedByAdminId,
      }),
    );
    if (f.state === 'COMPLETED' && f.completedAt !== null) {
      all.push(
        sortable(f.completedAt, f.id, {
          kind: 'REFUND_COMPLETED',
          at: f.completedAt.toISOString(),
          refundId: f.id,
          ...money,
          adminId: f.completedByAdminId,
        }),
      );
    }
    if (f.state === 'FAILED') {
      all.push(
        sortable(f.updatedAt, f.id, {
          kind: 'REFUND_CLOSED_FAILED',
          at: f.updatedAt.toISOString(),
          refundId: f.id,
          ...money,
        }),
      );
    }
  }
  const reviewStartedAt = p.providerReviewStartedAt ?? null;
  const reviewUntil = p.providerReviewUntil ?? null;
  if (reviewStartedAt !== null && reviewUntil !== null) {
    all.push(
      sortable(reviewStartedAt, 'payment', {
        kind: 'PROVIDER_REVIEW_OPENED',
        at: reviewStartedAt.toISOString(),
        until: reviewUntil.toISOString(),
      }),
    );
  }
  const g = facts.gateway ?? null;
  if (g !== null) {
    const requestedAt = g.creationSentAt ?? g.createdAt;
    all.push(
      sortable(requestedAt, 'gateway', {
        kind: 'GATEWAY_INVOICE_REQUESTED',
        at: requestedAt.toISOString(),
        provider: g.provider,
        creationState: g.creationState,
        errorCode: machineCode(g.creationErrorCode),
      }),
    );
    if (g.createdInvoiceAt !== null) {
      all.push(
        sortable(g.createdInvoiceAt, 'gateway', {
          kind: 'GATEWAY_INVOICE_CREATED',
          at: g.createdInvoiceAt.toISOString(),
          provider: g.provider,
          providerInvoiceId: g.providerInvoiceId,
        }),
      );
    }
    if (g.lastWebhookAt !== null) {
      all.push(
        sortable(g.lastWebhookAt, 'gateway', {
          kind: 'GATEWAY_WEBHOOK_HINT',
          at: g.lastWebhookAt.toISOString(),
          provider: g.provider,
          statusHint: machineCode(g.webhookStatusHint),
          webhookCount: g.webhookCount,
        }),
      );
    }
    if (g.lastInquiryAt !== null) {
      all.push(
        sortable(g.lastInquiryAt, 'gateway', {
          kind: 'GATEWAY_INQUIRY',
          at: g.lastInquiryAt.toISOString(),
          provider: g.provider,
          providerStatus: machineCode(g.providerStatus),
          providerPaid: g.providerPaid,
          errorCode: machineCode(g.lastInquiryErrorCode),
        }),
      );
    }
    if (g.reconcileInquiryRequestedAt !== null) {
      all.push(
        sortable(g.reconcileInquiryRequestedAt, 'gateway', {
          kind: 'GATEWAY_REINQUIRE_REQUESTED',
          at: g.reconcileInquiryRequestedAt.toISOString(),
        }),
      );
    }
    if (g.outcome !== null && g.outcomeAt !== null) {
      all.push(
        sortable(g.outcomeAt, 'gateway', {
          kind: 'GATEWAY_OUTCOME',
          at: g.outcomeAt.toISOString(),
          outcome: g.outcome,
        }),
      );
    }
    if (g.lateCompletionObservedAt !== null) {
      all.push(
        sortable(g.lateCompletionObservedAt, 'gateway', {
          kind: 'GATEWAY_LATE_COMPLETION',
          at: g.lateCompletionObservedAt.toISOString(),
        }),
      );
    }
  }
  for (const l of facts.loseTrack ?? []) {
    all.push(
      sortable(l.at, l.id, {
        kind: 'PAYMENT_OUTCOME_UNKNOWN',
        at: l.at.toISOString(),
        reason: machineCode(l.reason),
        providerStatus: machineCode(l.providerStatus),
      }),
    );
  }
  /*
   * The order's own facts, only when THIS payment is what settled it: one confirmed payment
   * per order (`payments_order_confirmed_key`), so an order's settlement, delivery and
   * refund belong on the confirmed payment's history and on no other.
   */
  const o = facts.order ?? null;
  if (o !== null && p.state === 'CONFIRMED') {
    if (o.settledAt !== null) {
      all.push(
        sortable(o.settledAt, o.id, {
          kind: 'ORDER_SETTLED',
          at: o.settledAt.toISOString(),
          orderId: o.id,
        }),
      );
    }
    for (const op of o.fulfilment) {
      const at = op.completedAt ?? op.createdAt;
      all.push(
        sortable(at, op.id, {
          kind: 'ORDER_FULFILMENT',
          at: at.toISOString(),
          orderId: o.id,
          operationType: op.type,
          operationState: op.state,
        }),
      );
    }
    if (o.refundedAt !== null) {
      all.push(
        sortable(o.refundedAt, o.id, {
          kind: 'ORDER_REFUNDED',
          at: o.refundedAt.toISOString(),
          orderId: o.id,
        }),
      );
    }
  }
  for (const a of facts.audit ?? []) {
    all.push(
      sortable(a.at, a.id, {
        kind: 'AUDIT_RECORDED',
        at: a.at.toISOString(),
        auditId: a.id,
        action: machineCode(a.action) ?? 'unknown',
        actorType: a.actorType,
        adminId: ADMIN_ACTORS.has(a.actorType) ? a.actorId : null,
        result: a.result,
      }),
    );
  }
  for (const n of facts.notifications) {
    all.push(
      sortable(n.createdAt, n.id, {
        kind: 'CUSTOMER_NOTIFIED',
        at: n.createdAt.toISOString(),
        notificationKind: n.kind,
        deliveryState: n.state,
        resolvedAt: n.resolvedAt === null ? null : n.resolvedAt.toISOString(),
      }),
    );
  }

  all.sort(
    (a, b) => a.time - b.time || a.rank - b.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const truncated = all.length > max;
  return { entries: all.slice(0, max).map((s) => s.entry), truncated };
}
