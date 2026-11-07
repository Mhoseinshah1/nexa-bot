import { describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  LATE_PAYMENT_POLICIES,
  SETTINGS,
  errors,
  latePaymentPolicyOf,
  money,
  opsLogButtonPath,
  orderIdSchema,
  paymentSituationOf,
  type OrderId,
  type PaymentId,
} from '@nexa/contracts';
import {
  LATE_DELIVERY_DEFER_MAX_MS,
  lateDecisionOpen,
  lateDeliveryDecision,
  lateDeliveryFallbackOf,
  lateDeliveryOrderId,
  lateDeliveryTarget,
} from '../../apps/api/src/modules/commerce/payments/application/late-delivery';
import { latePolicyPolls } from '../../apps/api/src/modules/commerce/payments/application/late-credit-policy';

/**
 * NEXA-OWNER-BATCH-1 PR-5: the pure rules of the late-payment policy. The money paths, the
 * races and the migration are in `tests/integration/late-payment-policy.test.ts`.
 */

const PAYMENT = '01a1b6d1-19f4-740a-96de-bd30720c08ac' as PaymentId;
const ORDER = '01a1b6d1-19f4-7aaa-96de-bd30720c08ad' as OrderId;
const NOW = new Date('2026-11-07T10:00:00Z');

const payment = (over: Record<string, unknown> = {}) => ({
  state: 'EXPIRED' as const,
  customerId: 'c-1' as never,
  amount: money(250_000n, 'IRT'),
  expiresAt: new Date(NOW.getTime() - 60_000),
  providerReviewUntil: null,
  ...over,
});
const order = (over: Record<string, unknown> = {}) => ({
  id: ORDER,
  state: 'EXPIRED' as const,
  customerId: 'c-1' as never,
  purpose: 'NEW_SERVICE' as const,
  totals: {
    subtotal: money(250_000n, 'IRT'),
    discount: money(0n, 'IRT'),
    total: money(250_000n, 'IRT'),
    currency: 'IRT' as const,
    quote: null as never,
  },
  ...over,
});
const decide = (
  p = payment(),
  o: ReturnType<typeof order> | null = order(),
  basis = 'LATE_APPROVAL',
) =>
  lateDeliveryDecision({
    payment: p as never,
    basis: basis as never,
    order: o as never,
    target: lateDeliveryTarget(PAYMENT, o)!,
    now: NOW,
  });

describe('the policy values', () => {
  it('are the three, and anything else reads as REVIEW (moves no money by itself)', () => {
    expect(LATE_PAYMENT_POLICIES).toEqual(['WALLET', 'REVIEW', 'DELIVER']);
    expect(latePaymentPolicyOf('WALLET')).toBe('WALLET');
    expect(latePaymentPolicyOf('DELIVER')).toBe('DELIVER');
    for (const other of ['REVIEW', true, false, null, undefined, 'deliver', 1]) {
      expect(latePaymentPolicyOf(other)).toBe('REVIEW');
    }
    expect(latePolicyPolls('WALLET')).toBe(true);
    expect(latePolicyPolls('DELIVER')).toBe(true);
    expect(latePolicyPolls('REVIEW')).toBe(false);
    expect(latePolicyPolls(null)).toBe(false);
  });

  it('keep each route’s old default meaning: TonPays routes WALLET, the newer ones REVIEW', () => {
    const defaults = Object.fromEntries(
      SETTINGS.filter(
        (d) => d.key.startsWith('payments.late_credit.') && d.key.endsWith('_enabled'),
      ).map((d) => [d.key, d.defaultValue]),
    );
    expect(defaults).toEqual({
      'payments.late_credit.tonpays_enabled': 'WALLET',
      'payments.late_credit.tonpays_telegram_enabled': 'WALLET',
      'payments.late_credit.tetrapay_enabled': 'REVIEW',
      'payments.late_credit.rialit_enabled': 'REVIEW',
      'payments.late_credit.custom_enabled': 'REVIEW',
    });
  });
});

describe('the fulfilment order of a payment', () => {
  it('is a UUIDv7 derived from the payment, the same every time, different per payment', () => {
    const id = lateDeliveryOrderId(PAYMENT);
    expect(orderIdSchema.parse(id)).toBe(id);
    expect(lateDeliveryOrderId(PAYMENT)).toBe(id);
    expect(lateDeliveryOrderId('01a1b6d1-19f4-740a-96de-bd30720c08ae')).not.toBe(id);
    expect(id).not.toBe(PAYMENT);
  });

  it('is the ORIGINAL order while it awaits payment, a fulfilment order once it expired, nothing otherwise', () => {
    expect(lateDeliveryTarget(PAYMENT, { id: ORDER, state: 'AWAITING_PAYMENT' })).toEqual({
      kind: 'ORIGINAL',
      orderId: ORDER,
    });
    expect(lateDeliveryTarget(PAYMENT, { id: ORDER, state: 'EXPIRED' })).toEqual({
      kind: 'FULFILMENT',
      orderId: lateDeliveryOrderId(PAYMENT),
    });
    for (const state of ['CANCELLED', 'PAID', 'REFUNDED', 'DRAFT'] as const) {
      expect(lateDeliveryTarget(PAYMENT, { id: ORDER, state })).toBeNull();
    }
    expect(lateDeliveryTarget(PAYMENT, null)).toBeNull();
  });
});

describe('the delivery decision', () => {
  it('delivers an expired order paid in full', () => {
    expect(decide()).toBeNull();
    expect(decide(payment(), order({ state: 'AWAITING_PAYMENT' }))).toBeNull();
    // An overpayment covers it (the rest stays in the wallet).
    expect(decide(payment({ amount: money(300_000n, 'IRT') }))).toBeNull();
  });

  it('falls back when the payment does not cover the frozen total, or is in another currency', () => {
    expect(decide(payment({ amount: money(249_999n, 'IRT') }))).toEqual({
      kind: 'FALLBACK',
      reason: 'AMOUNT_DOES_NOT_COVER',
    });
    expect(decide(payment({ amount: money(250_000n, 'USDT') }))).toEqual({
      kind: 'FALLBACK',
      reason: 'AMOUNT_DOES_NOT_COVER',
    });
  });

  it('never delivers an UNKNOWN payment, a closed order, or anything but a new service', () => {
    expect(decide(payment({ state: 'UNKNOWN' }))).toEqual({
      kind: 'FALLBACK',
      reason: 'PAYMENT_UNKNOWN',
    });
    for (const purpose of ['RENEW', 'CUSTOM_SERVICE', 'ADD_TRAFFIC', 'TRIAL']) {
      expect(decide(payment(), order({ purpose }))).toEqual({
        kind: 'FALLBACK',
        reason: 'PURPOSE_NOT_DELIVERABLE',
      });
    }
    const cancelled = order({ state: 'CANCELLED' });
    expect(
      lateDeliveryDecision({
        payment: payment() as never,
        basis: 'LATE_APPROVAL',
        order: cancelled as never,
        target: { kind: 'FULFILMENT', orderId: lateDeliveryOrderId(PAYMENT) },
        now: NOW,
      }),
    ).toEqual({ kind: 'FALLBACK', reason: 'ORDER_CLOSED' });
    expect(decide(payment(), order({ customerId: 'c-2' }))).toEqual({
      kind: 'FALLBACK',
      reason: 'ORDER_CLOSED',
    });
  });

  it('money RETURNED for an attempt that cannot pay its order is the plain credit, never a delivery', () => {
    expect(decide(payment({ state: 'CANCELLED' }), order(), 'RETURNED')).toEqual({
      kind: 'CREDIT',
    });
  });

  it('waits briefly for a PENDING payment past its deadline, then gives the money to the wallet', () => {
    expect(decide(payment({ state: 'PENDING' }))).toEqual({ kind: 'DEFER' });
    expect(
      decide(
        payment({
          state: 'PENDING',
          expiresAt: new Date(NOW.getTime() - LATE_DELIVERY_DEFER_MAX_MS),
        }),
      ),
    ).toEqual({ kind: 'FALLBACK', reason: 'PURCHASE_REFUSED' });
  });

  it('chooses again when the order moved between the advisory read and the lock', () => {
    expect(
      lateDeliveryDecision({
        payment: payment() as never,
        basis: 'LATE_APPROVAL',
        order: order({ state: 'EXPIRED' }) as never,
        target: { kind: 'ORIGINAL', orderId: ORDER },
        now: NOW,
      }),
    ).toEqual({ kind: 'RETRY' });
  });

  it('maps the purchase’s own refusals to a reason, and rethrows anything else', () => {
    expect(
      lateDeliveryFallbackOf(
        errors.preconditionFailed(COMMERCE_ERROR_CODES.PANEL_NOT_ELIGIBLE, 'x'),
      ),
    ).toBe('PANEL_FULL');
    expect(
      lateDeliveryFallbackOf(errors.conflict(COMMERCE_ERROR_CODES.CUSTOMER_BLOCKED, 'x')),
    ).toBe('CUSTOMER_BLOCKED');
    expect(
      lateDeliveryFallbackOf(errors.conflict(COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS, 'x')),
    ).toBe('PURCHASE_REFUSED');
    expect(lateDeliveryFallbackOf(new Error('connection reset'))).toBeNull();
    expect(
      lateDeliveryFallbackOf(errors.conflict(COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID, 'x')),
    ).toBeNull();
  });
});

describe('the operator’s two decisions', () => {
  it('are open only on an EXPIRED gateway payment of a route with a policy', () => {
    expect(
      lateDecisionOpen({ method: 'GATEWAY', state: 'EXPIRED', gatewayProvider: 'TONPAYS' }),
    ).toBe(true);
    expect(
      lateDecisionOpen({ method: 'GATEWAY', state: 'EXPIRED', gatewayProvider: 'TETRAPAY' }),
    ).toBe(true);
    expect(
      lateDecisionOpen({ method: 'GATEWAY', state: 'UNKNOWN', gatewayProvider: 'TONPAYS' }),
    ).toBe(false);
    expect(
      lateDecisionOpen({ method: 'GATEWAY', state: 'EXPIRED', gatewayProvider: 'TELEGRAM_STARS' }),
    ).toBe(false);
    expect(
      lateDecisionOpen({ method: 'GATEWAY', state: 'EXPIRED', gatewayProvider: 'NOWPAYMENTS' }),
    ).toBe(false);
    expect(
      lateDecisionOpen({ method: 'MANUAL_TRANSFER', state: 'EXPIRED', gatewayProvider: null }),
    ).toBe(false);
  });

  it('are offered on the LATE_COMPLETION situation, and their ops-group buttons open the payment’s decision', () => {
    const facts = {
      state: 'EXPIRED' as const,
      method: 'GATEWAY' as const,
      topup: false,
      customerSignalled: false,
      receiptFiled: false,
      providerReviewOpened: false,
      resolvedByAdmin: false,
      receiptDisposition: null,
      invoiceCreation: 'CREATED' as never,
      lateCredited: false,
      queues: ['LATE_COMPLETION' as const],
      refundOpen: false,
      refundCompleted: false,
      refundRemaining: false,
      refundRefusal: null,
    };
    expect(paymentSituationOf({ ...facts, lateDecisionOpen: true }).actions).toEqual([
      'LATE_DELIVER',
      'LATE_TO_WALLET',
      'VERIFY_AT_PROVIDER',
    ]);
    expect(paymentSituationOf({ ...facts, lateDecisionOpen: false }).actions).toEqual([
      'VERIFY_AT_PROVIDER',
      'MANUAL_WALLET_ADJUSTMENT',
    ]);
    expect(opsLogButtonPath({ kind: 'LATE_DELIVER', ref: PAYMENT })).toBe(
      `/payments/${PAYMENT}?late=deliver`,
    );
    expect(opsLogButtonPath({ kind: 'LATE_TO_WALLET', ref: PAYMENT })).toBe(
      `/payments/${PAYMENT}?late=wallet`,
    );
  });
});
