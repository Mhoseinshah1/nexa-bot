import { describe, expect, it } from 'vitest';
import {
  assemblePaymentTimeline,
  type PaymentTimelineFacts,
} from '../../apps/api/src/modules/commerce/payments/domain/payment-timeline';

/**
 * The pure assembly behind the payment timeline (WP17 D1). It copies fields and decides
 * ORDER and TRUNCATION; these cases pin both.
 */

const T0 = new Date('2026-09-01T10:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

function facts(overrides: Partial<PaymentTimelineFacts> = {}): PaymentTimelineFacts {
  return {
    payment: {
      method: 'WALLET',
      state: 'CONFIRMED',
      amountMinor: 250_000n,
      currency: 'IRT',
      createdAt: T0,
      customerSignalledAt: null,
      confirmedAt: T0,
      evidenceKind: 'WALLET_DEBIT',
      confirmedByAdminId: null,
      resolvedAt: null,
      resolvedByAdminId: null,
    },
    receiptCredit: null,
    notifications: [],
    receipts: [],
    walletEntries: [],
    refunds: [],
    ...overrides,
  };
}

describe('assemblePaymentTimeline', () => {
  it('orders same-instant entries by the fixed rank, not by input order', () => {
    // A wallet settlement: created, confirmed and debited in one transaction, one instant.
    const view = assemblePaymentTimeline(
      facts({
        walletEntries: [
          {
            id: 'e1',
            direction: 'DEBIT',
            reason: 'PURCHASE',
            amountMinor: 250_000n,
            currency: 'IRT',
            createdAt: T0,
          },
        ],
      }),
    );
    expect(view.entries.map((e) => e.kind)).toEqual([
      'PAYMENT_CREATED',
      'PAYMENT_CONFIRMED',
      'WALLET_ENTRY',
    ]);
  });

  it('orders by time before rank, and by source id when both tie', () => {
    const view = assemblePaymentTimeline(
      facts({
        receipts: [
          { id: 'r-b', kind: 'PHOTO', createdAt: at(5) },
          { id: 'r-a', kind: 'DOCUMENT', createdAt: at(5) },
        ],
        notifications: [
          {
            id: 'n1',
            kind: 'PAYMENT_EXPIRED',
            state: 'DELIVERED',
            createdAt: at(1),
            resolvedAt: at(2),
          },
        ],
      }),
    );
    expect(view.entries.map((e) => [e.kind, 'receiptId' in e ? e.receiptId : null])).toEqual([
      ['PAYMENT_CREATED', null],
      ['PAYMENT_CONFIRMED', null],
      ['CUSTOMER_NOTIFIED', null],
      ['RECEIPT_SUBMITTED', 'r-a'],
      ['RECEIPT_SUBMITTED', 'r-b'],
    ]);
  });

  it('reports truncation rather than dropping silently, and keeps the oldest', () => {
    const receipts = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`,
      kind: 'PHOTO' as const,
      createdAt: at(10 + i),
    }));
    const cut = assemblePaymentTimeline(facts({ receipts }), 4);
    expect(cut.truncated).toBe(true);
    expect(cut.entries).toHaveLength(4);
    expect(cut.entries.map((e) => e.kind)).toEqual([
      'PAYMENT_CREATED',
      'PAYMENT_CONFIRMED',
      'RECEIPT_SUBMITTED',
      'RECEIPT_SUBMITTED',
    ]);

    // Exactly `max` entries is a complete history.
    const exact = assemblePaymentTimeline(facts({ receipts: receipts.slice(0, 2) }), 4);
    expect(exact.truncated).toBe(false);
    expect(exact.entries).toHaveLength(4);
  });

  it('closes a FAILED refund at updated_at and never reports it completed', () => {
    const view = assemblePaymentTimeline(
      facts({
        refunds: [
          {
            id: 'f1',
            state: 'FAILED',
            channel: 'EXTERNAL_MANUAL',
            amountMinor: 100_000n,
            currency: 'IRT',
            requestedByAdminId: 'admin-1',
            completedByAdminId: null,
            createdAt: at(60),
            completedAt: null,
            updatedAt: at(120),
          },
        ],
      }),
    );
    const refund = view.entries.filter((e) => e.kind.startsWith('REFUND_'));
    expect(refund.map((e) => [e.kind, e.at])).toEqual([
      ['REFUND_REQUESTED', at(60).toISOString()],
      ['REFUND_CLOSED_FAILED', at(120).toISOString()],
    ]);
  });

  it('shows an open refund as requested only', () => {
    const view = assemblePaymentTimeline(
      facts({
        refunds: [
          {
            id: 'o1',
            state: 'AWAITING_EXTERNAL',
            channel: 'EXTERNAL_MANUAL',
            amountMinor: 1n,
            currency: 'IRT',
            requestedByAdminId: 'admin-1',
            completedByAdminId: null,
            createdAt: at(1),
            completedAt: null,
            updatedAt: at(1),
          },
        ],
      }),
    );
    expect(view.entries.filter((e) => e.kind.startsWith('REFUND_')).map((e) => e.kind)).toEqual([
      'REFUND_REQUESTED',
    ]);
  });

  it('emits a resolution only for a resolved state, and a confirmation only with its evidence', () => {
    const pending = assemblePaymentTimeline(
      facts({
        payment: {
          ...facts().payment,
          method: 'MANUAL_TRANSFER',
          state: 'PENDING',
          confirmedAt: null,
          evidenceKind: null,
        },
      }),
    );
    expect(pending.entries.map((e) => e.kind)).toEqual(['PAYMENT_CREATED']);

    const expired = assemblePaymentTimeline(
      facts({
        payment: {
          ...facts().payment,
          method: 'MANUAL_TRANSFER',
          state: 'EXPIRED',
          confirmedAt: null,
          evidenceKind: null,
          resolvedAt: at(3600),
        },
      }),
    );
    expect(expired.entries.map((e) => e.kind)).toEqual(['PAYMENT_CREATED', 'PAYMENT_RESOLVED']);
    expect(expired.entries[1]).toMatchObject({ state: 'EXPIRED', adminId: null });
  });

  it('serialises money as decimal strings with the currency', () => {
    const view = assemblePaymentTimeline(
      facts({
        receiptCredit: {
          amountMinor: 9_007_199_254_740_993n,
          currency: 'IRT',
          decidedAt: at(9),
          decidedByAdminId: 'admin-2',
        },
      }),
    );
    expect(view.entries.find((e) => e.kind === 'RECEIPT_CREDITED')).toEqual({
      kind: 'RECEIPT_CREDITED',
      at: at(9).toISOString(),
      amountMinor: '9007199254740993',
      currency: 'IRT',
      adminId: 'admin-2',
    });
  });
});
