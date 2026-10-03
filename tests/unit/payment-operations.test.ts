import { describe, expect, it } from 'vitest';
import {
  PAYMENT_OPS_QUEUES,
  paymentAttentionQuerySchema,
  paymentListQuerySchema,
  paymentTimelineResponseSchema,
  type ActorContext,
  type CorrelationId,
  type PermissionKey,
  type TenantContext,
} from '@nexa/contracts';
import {
  assemblePaymentTimeline,
  machineCode,
  type PaymentTimelineFacts,
} from '../../apps/api/src/modules/commerce/payments/domain/payment-timeline';
import {
  PARTIAL_PAYMENT_STATUSES,
  reconcilableNow,
  reconciliationEvidenceAllows,
  reconciliationVocabularies,
} from '../../apps/api/src/modules/commerce/payments/domain/gateway-reconciliation';
import {
  PaymentOperationsService,
  type PaymentAttentionReader,
} from '../../apps/api/src/modules/commerce/payments/application/payment-operations.service';
import type { PaymentService } from '../../apps/api/src/modules/commerce/payments/application/payment.service';
import { PermissionGuard } from '../../apps/api/src/modules/platform/access/application/permission-guard';

/**
 * The Payment Operations Center's pure parts (program §10): the evidence rule the
 * NEEDS_RECONCILIATION queue mirrors, the timeline's new entries, the window rule at the
 * edge, and the service's order of authority.
 */

const at = (minute: number) => new Date(Date.UTC(2026, 9, 3, 8, minute));

function facts(overrides: Partial<PaymentTimelineFacts> = {}): PaymentTimelineFacts {
  return {
    payment: {
      method: 'GATEWAY',
      state: 'UNKNOWN',
      amountMinor: 250000n,
      currency: 'IRT',
      createdAt: at(0),
      customerSignalledAt: null,
      confirmedAt: null,
      evidenceKind: null,
      confirmedByAdminId: null,
      resolvedAt: null,
      resolvedByAdminId: null,
      providerReviewStartedAt: null,
      providerReviewUntil: null,
    },
    receiptCredit: null,
    notifications: [],
    receipts: [],
    walletEntries: [],
    refunds: [],
    ...overrides,
  };
}

const gateway = {
  provider: 'NOWPAYMENTS' as const,
  createdAt: at(0),
  creationState: 'CREATED' as const,
  creationErrorCode: null,
  creationSentAt: at(1),
  createdInvoiceAt: at(2),
  providerInvoiceId: '4522625001',
  lastWebhookAt: at(5),
  webhookStatusHint: 'partially_paid',
  webhookCount: 3,
  lastInquiryAt: at(6),
  providerStatus: 'partially_paid',
  providerPaid: false,
  lastInquiryErrorCode: null,
  outcome: null,
  outcomeAt: null,
  lateCompletionObservedAt: null,
};

describe('the NEEDS_RECONCILIATION rule', () => {
  it('is exactly "the recorded evidence allows CONFIRMED (with a bound reference where required) or FAILED"', () => {
    for (const vocabulary of reconciliationVocabularies()) {
      for (const status of [...vocabulary.confirmed, ...vocabulary.failed, 'waiting', null]) {
        for (const paid of [true, false, null]) {
          for (const providerChargeId of [null, 'ref-1']) {
            const confirm =
              reconciliationEvidenceAllows(vocabulary.provider, 'CONFIRMED', { status, paid }) &&
              (!vocabulary.confirmRequiresReference || providerChargeId !== null);
            const fail = reconciliationEvidenceAllows(vocabulary.provider, 'FAILED', {
              status,
              paid,
            });
            expect(
              reconcilableNow(vocabulary.provider, { status, paid, providerChargeId }),
              `${vocabulary.provider} ${String(status)} ${String(paid)} ${String(providerChargeId)}`,
            ).toBe(confirm || fail);
          }
        }
      }
    }
  });

  it('leaves the cases an operator must ask about again first out of it', () => {
    // TonPays: `completed` without paid is still OPEN — never grounds for either resolution.
    expect(
      reconcilableNow('TONPAYS', { status: 'completed', paid: false, providerChargeId: null }),
    ).toBe(false);
    // CentralPay: a paid `verified` whose reference was never bound is neither.
    expect(
      reconcilableNow('CENTRALPAY', { status: 'verified', paid: true, providerChargeId: null }),
    ).toBe(false);
    expect(
      reconcilableNow('CENTRALPAY', { status: 'verified', paid: true, providerChargeId: 'r' }),
    ).toBe(true);
    // A route with no vocabulary (Stars, a manual transfer) is never reconcilable here.
    expect(
      reconcilableNow('TELEGRAM_STARS', { status: 'paid', paid: true, providerChargeId: 'c' }),
    ).toBe(false);
  });

  it('names a partial status only for a provider whose vocabulary has one', () => {
    expect(PARTIAL_PAYMENT_STATUSES).toEqual({ NOWPAYMENTS: ['partially_paid'] });
  });
});

describe('the payment timeline’s operations entries', () => {
  it('turns the gateway row into one entry per recorded fact, in time order, by code', () => {
    const { entries } = assemblePaymentTimeline(
      facts({
        gateway,
        loseTrack: [
          {
            id: 'a1',
            at: at(6),
            reason: 'PROVIDER_AMOUNT_MISMATCH',
            providerStatus: 'partially_paid',
          },
        ],
        reinquireRequests: [{ id: 'r1', at: at(9) }],
      }),
    );
    expect(entries.map((e) => e.kind)).toEqual([
      'PAYMENT_CREATED',
      'GATEWAY_INVOICE_REQUESTED',
      'GATEWAY_INVOICE_CREATED',
      'GATEWAY_WEBHOOK_HINT',
      // Same instant: the inquiry is ranked before the hold it caused.
      'GATEWAY_INQUIRY',
      'PAYMENT_OUTCOME_UNKNOWN',
      'GATEWAY_REINQUIRE_REQUESTED',
    ]);
    expect(entries.find((e) => e.kind === 'GATEWAY_WEBHOOK_HINT')).toMatchObject({
      webhookCount: 3,
    });
    expect(() =>
      paymentTimelineResponseSchema.parse({
        paymentId: 'p',
        entries,
        withheld: [],
        truncated: false,
      }),
    ).not.toThrow();
  });

  it('shows every recorded ask-again from its own record, answered or not', () => {
    // Codex review of #154: the invoice column a request sets is cleared by the inquiry
    // that answers it, so the history is the audit rows, one entry each.
    const { entries } = assemblePaymentTimeline(
      facts({
        gateway,
        reinquireRequests: [
          { id: 'r1', at: at(3) },
          { id: 'r2', at: at(7) },
        ],
      }),
    );
    expect(
      entries.filter((e) => e.kind === 'GATEWAY_REINQUIRE_REQUESTED').map((e) => e.at),
    ).toEqual([at(3).toISOString(), at(7).toISOString()]);
  });

  it('never presents the status an EARLIER inquiry saw as a failed inquiry’s answer', () => {
    // Codex review of #154: a failed inquiry leaves the last observed status on the row.
    const failed = assemblePaymentTimeline(
      facts({ gateway: { ...gateway, lastInquiryErrorCode: 'HTTP_503' } }),
    ).entries.find((e) => e.kind === 'GATEWAY_INQUIRY');
    expect(failed).toMatchObject({
      errorCode: 'HTTP_503',
      providerStatus: null,
      providerPaid: null,
    });
    const answered = assemblePaymentTimeline(facts({ gateway })).entries.find(
      (e) => e.kind === 'GATEWAY_INQUIRY',
    );
    expect(answered).toMatchObject({
      errorCode: null,
      providerStatus: 'partially_paid',
      providerPaid: false,
    });
  });

  it('drops anything that is not a short machine code rather than showing it', () => {
    expect(machineCode('partially_paid')).toBe('partially_paid');
    expect(machineCode('nowpayments:finished:paid')).toBe('nowpayments:finished:paid');
    expect(machineCode('the customer said hello')).toBeNull();
    expect(machineCode('x'.repeat(65))).toBeNull();
    expect(machineCode(42)).toBeNull();
    const { entries } = assemblePaymentTimeline(
      facts({
        gateway: { ...gateway, webhookStatusHint: '<script>alert(1)</script>' },
        loseTrack: [
          { id: 'a1', at: at(6), reason: 'free text from somewhere', providerStatus: null },
        ],
      }),
    );
    expect(entries.find((e) => e.kind === 'GATEWAY_WEBHOOK_HINT')).toMatchObject({
      statusHint: null,
    });
    expect(entries.find((e) => e.kind === 'PAYMENT_OUTCOME_UNKNOWN')).toMatchObject({
      reason: null,
    });
  });

  it('puts the order’s settlement, delivery and refund only on the CONFIRMED payment that settled it', () => {
    const order = {
      id: 'o1',
      settledAt: at(10),
      refundedAt: at(40),
      fulfilment: [
        {
          id: 'op1',
          type: 'PROVISION' as const,
          state: 'SUCCEEDED' as const,
          createdAt: at(10),
          completedAt: at(12),
        },
      ],
    };
    const unknown = assemblePaymentTimeline(facts({ order }));
    expect(unknown.entries.map((e) => e.kind)).not.toContain('ORDER_SETTLED');
    const confirmed = assemblePaymentTimeline(
      facts({
        order,
        payment: {
          ...facts().payment,
          state: 'CONFIRMED',
          confirmedAt: at(10),
          evidenceKind: 'GATEWAY_CALLBACK',
        },
      }),
    );
    expect(confirmed.entries.map((e) => e.kind)).toEqual([
      'PAYMENT_CREATED',
      'PAYMENT_CONFIRMED',
      'ORDER_SETTLED',
      'ORDER_FULFILMENT',
      'ORDER_REFUNDED',
    ]);
    expect(confirmed.entries.find((e) => e.kind === 'ORDER_FULFILMENT')).toMatchObject({
      at: at(12).toISOString(),
      operationState: 'SUCCEEDED',
    });
  });

  it('names an administrator on an audit entry and nobody else', () => {
    const { entries } = assemblePaymentTimeline(
      facts({
        audit: [
          {
            id: 'a1',
            at: at(1),
            action: 'payment.reconcile_failed',
            actorType: 'WEB_ADMIN',
            actorId: 'adm-1',
            result: 'SUCCESS',
          },
          {
            id: 'a2',
            at: at(2),
            action: 'payment.lose_track',
            actorType: 'SYSTEM_JOB',
            actorId: 'job-7',
            result: 'SUCCESS',
          },
          {
            id: 'a3',
            at: at(3),
            action: 'payment.gateway_request',
            actorType: 'CUSTOMER',
            actorId: '7100001',
            result: 'SUCCESS',
          },
        ],
      }),
    );
    const audits = entries.filter((e) => e.kind === 'AUDIT_RECORDED');
    expect(audits.map((e) => (e.kind === 'AUDIT_RECORDED' ? e.adminId : 'x'))).toEqual([
      'adm-1',
      null,
      null,
    ]);
    // A customer's Telegram id never reaches the history through an audit row.
    expect(JSON.stringify(entries)).not.toContain('7100001');
  });
});

describe('the queue and window parameters', () => {
  it('accept the contract’s queues and routes, and a range with the reports’ CUSTOM rule', () => {
    for (const queue of PAYMENT_OPS_QUEUES) {
      expect(paymentListQuerySchema.safeParse({ queue }).success, queue).toBe(true);
    }
    expect(paymentListQuerySchema.safeParse({ queue: 'FORCE_PAID' }).success).toBe(false);
    expect(paymentListQuerySchema.safeParse({ gateway: 'NOWPAYMENTS' }).success).toBe(true);
    expect(paymentListQuerySchema.safeParse({ gateway: 'PAYPAL' }).success).toBe(false);
    expect(paymentListQuerySchema.safeParse({ range: 'LAST_7_DAYS' }).success).toBe(true);
    expect(paymentListQuerySchema.safeParse({ range: 'CUSTOM' }).success).toBe(false);
    expect(
      paymentListQuerySchema.safeParse({ range: 'CUSTOM', from: '1405-07-01', to: '1405-07-10' })
        .success,
    ).toBe(true);
    expect(paymentListQuerySchema.safeParse({ from: '1405-07-01' }).success).toBe(false);
    expect(paymentAttentionQuerySchema.safeParse({}).success).toBe(true);
    expect(
      paymentAttentionQuerySchema.safeParse({ range: 'TODAY', to: '1405-07-01' }).success,
    ).toBe(false);
  });
});

describe('PaymentOperationsService', () => {
  const scope = { tenantId: 't-1', botInstanceId: null } as unknown as TenantContext;
  const actor: ActorContext = {
    type: 'WEB_ADMIN',
    id: 'adm-1',
    label: 'admin',
    surface: 'WEB',
    correlationId: 'c' as CorrelationId,
  };

  function service(held: readonly string[]) {
    const resolved: string[] = [];
    const reader: PaymentAttentionReader = {
      counts: async () => [
        {
          gatewayProvider: 'TONPAYS',
          counts: Object.fromEntries(
            PAYMENT_OPS_QUEUES.map((q) => [q, q === 'PENDING' ? 2 : 0]),
          ) as never,
        },
        {
          gatewayProvider: 'CENTRALPAY',
          counts: Object.fromEntries(
            PAYMENT_OPS_QUEUES.map((q) => [q, q === 'PENDING' ? 1 : q === 'UNKNOWN' ? 3 : 0]),
          ) as never,
        },
      ],
    };
    const permissions = async () => new Set(held as PermissionKey[]);
    const guard = new PermissionGuard(
      { resolve: permissions, permissionsIfActive: permissions } as never,
      { record: async () => undefined } as never,
    );
    const ops = new PaymentOperationsService({
      guard,
      attention: reader,
      payments: {} as PaymentService,
      windows: {
        resolve: async (_scope, input) => {
          resolved.push(input.range);
          return { start: at(0), end: at(60) };
        },
      },
    });
    return { ops, resolved };
  }

  it('sums the routes into totals', async () => {
    const { ops } = service(['payments.view']);
    const view = await ops.attention(scope, actor, { range: 'TODAY' });
    expect(view.totals).toMatchObject({ PENDING: 3, UNKNOWN: 3, MISMATCH: 0 });
    expect(view.window).toEqual({ start: at(0), end: at(60) });
  });

  it('charges payments.view BEFORE resolving anything about the tenant’s calendar', async () => {
    const { ops, resolved } = service([]);
    await expect(ops.attention(scope, actor, { range: 'TODAY' })).rejects.toMatchObject({
      code: 'platform.permission_denied',
    });
    await expect(ops.list(scope, actor, { search: {} }, { range: 'TODAY' })).rejects.toMatchObject({
      code: 'platform.permission_denied',
    });
    expect(resolved).toEqual([]);
  });

  it('asks for no window when no range is named', async () => {
    const { ops, resolved } = service(['payments.view']);
    const view = await ops.attention(scope, actor, {});
    expect(view.window).toBeNull();
    expect(resolved).toEqual([]);
  });
});
