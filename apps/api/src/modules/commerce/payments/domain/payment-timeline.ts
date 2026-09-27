import {
  PAYMENT_TIMELINE_KINDS,
  PAYMENT_TIMELINE_MAX_ENTRIES,
  type CurrencyCode,
  type CustomerNotificationKind,
  type CustomerNotificationState,
  type LedgerDirection,
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
