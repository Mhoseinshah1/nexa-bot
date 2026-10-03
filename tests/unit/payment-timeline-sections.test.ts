import { describe, expect, it } from 'vitest';
import type {
  ActorContext,
  CorrelationId,
  OperationalEventRecorder,
  PermissionKey,
  TenantContext,
} from '@nexa/contracts';
import {
  PermissionGuard,
  type PermissionResolver,
} from '../../apps/api/src/modules/platform/access/application/permission-guard';
import { PaymentTimelineService } from '../../apps/api/src/modules/commerce/payments/application/payment-timeline.service';
import type {
  PaymentTimelineReader,
  TimelineSectionsIncluded,
} from '../../apps/api/src/modules/commerce/payments/application/timeline-ports';
import type { PaymentTimelineFacts } from '../../apps/api/src/modules/commerce/payments/domain/payment-timeline';

/**
 * Which sections of a payment's history a viewer is given (WP17 D1).
 *
 * The integration suite's viewers all hold `receipts.view` — the owner and the receipt
 * reviewer — so nothing there could tell a service that always read the receipts from one
 * that asked. These cases run the REAL `PermissionGuard` over a resolver that grants a
 * fixed set, and a reader that records what it was asked for and honours it the way the
 * Drizzle reader does, so the section decision is the service's and nothing else's.
 */

const PAYMENT_ID = '019240ab-cdef-7012-8345-6789abcdef01';
const T0 = new Date('2026-09-01T10:00:00.000Z');

const scope = { tenantId: 'tenant-1', botInstanceId: null } as unknown as TenantContext;
const actor: ActorContext = {
  type: 'WEB_ADMIN',
  id: 'admin-1',
  label: 'An admin',
  surface: 'WEB',
  correlationId: 'corr-timeline' as CorrelationId,
};

class FixedResolver implements PermissionResolver {
  constructor(private readonly held: readonly PermissionKey[]) {}
  async resolve(): Promise<ReadonlySet<PermissionKey>> {
    return new Set(this.held);
  }
  async permissionsIfActive(): Promise<ReadonlySet<PermissionKey>> {
    return new Set(this.held);
  }
}

/** Every case here holds `payments.view`, so a denial event would be a defect in the case. */
const noDenials = {
  record: async () => {
    throw new Error('no permission denial is expected in these cases');
  },
} as unknown as OperationalEventRecorder;

/** Records each `include` it is given, and returns only the sections it was asked for. */
class RecordingReader implements PaymentTimelineReader {
  readonly asked: TimelineSectionsIncluded[] = [];
  async facts(
    _scope: TenantContext,
    _paymentId: unknown,
    include: TimelineSectionsIncluded,
  ): Promise<PaymentTimelineFacts> {
    this.asked.push(include);
    return {
      payment: {
        method: 'MANUAL_TRANSFER',
        state: 'PENDING',
        amountMinor: 250_000n,
        currency: 'IRT',
        createdAt: T0,
        customerSignalledAt: null,
        confirmedAt: null,
        evidenceKind: null,
        confirmedByAdminId: null,
        resolvedAt: null,
        resolvedByAdminId: null,
      },
      receiptCredit: null,
      notifications: [],
      receipts: include.receipts
        ? [{ id: 'r1', kind: 'PHOTO', createdAt: new Date(T0.getTime() + 1000) }]
        : [],
      walletEntries: [],
      refunds: [],
    };
  }
}

async function timelineFor(held: readonly PermissionKey[]) {
  const reader = new RecordingReader();
  const service = new PaymentTimelineService({
    guard: new PermissionGuard(new FixedResolver(held), noDenials),
    reader,
  });
  const view = await service.timeline(scope, actor, PAYMENT_ID);
  return { view, asked: reader.asked };
}

describe('the payment timeline receipts section', () => {
  it('does not read receipts for a viewer without receipts.view, and names them withheld', async () => {
    const { view, asked } = await timelineFor(['payments.view', 'refunds.view', 'users.view']);

    expect(asked).toEqual([
      { receipts: false, refunds: true, wallet: true, order: false, audit: false },
    ]);
    expect(view.withheld).toEqual(['RECEIPTS', 'ORDER', 'AUDIT']);
    expect(view.entries.map((entry) => entry.kind)).not.toContain('RECEIPT_SUBMITTED');
  });

  it('reads receipts for a viewer holding receipts.view, and withholds nothing', async () => {
    const { view, asked } = await timelineFor([
      'payments.view',
      'receipts.view',
      'refunds.view',
      'users.view',
    ]);

    expect(asked).toEqual([
      { receipts: true, refunds: true, wallet: true, order: false, audit: false },
    ]);
    expect(view.withheld).toEqual(['ORDER', 'AUDIT']);
    expect(view.entries.map((entry) => entry.kind)).toContain('RECEIPT_SUBMITTED');
  });

  it('withholds and names every gated section from a viewer holding payments.view alone', async () => {
    const { view, asked } = await timelineFor(['payments.view']);

    expect(asked).toEqual([
      { receipts: false, refunds: false, wallet: false, order: false, audit: false },
    ]);
    expect(view.withheld).toEqual(['RECEIPTS', 'REFUNDS', 'WALLET', 'ORDER', 'AUDIT']);
  });

  /*
   * Payment Operations Center (program §10): the order's settlement and delivery sit behind
   * `orders.view`, and the payment's audit rows behind `audit.view` — the permissions that
   * already guard those facts elsewhere. Neither is read without its key.
   */
  it('reads the ORDER section only under orders.view and the AUDIT section only under audit.view', async () => {
    const order = await timelineFor(['payments.view', 'orders.view']);
    expect(order.asked[0]).toMatchObject({ order: true, audit: false });
    expect(order.view.withheld).not.toContain('ORDER');
    expect(order.view.withheld).toContain('AUDIT');

    const audit = await timelineFor(['payments.view', 'audit.view']);
    expect(audit.asked[0]).toMatchObject({ order: false, audit: true });
    expect(audit.view.withheld).toContain('ORDER');
    expect(audit.view.withheld).not.toContain('AUDIT');
  });

  it('decides the receipts section on receipts.view alone, not on receipts.review', async () => {
    const { view, asked } = await timelineFor(['payments.view', 'receipts.review']);

    expect(asked[0]?.receipts).toBe(false);
    expect(view.withheld).toContain('RECEIPTS');
  });
});
