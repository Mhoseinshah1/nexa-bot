import { describe, expect, it } from 'vitest';
import { money, type PaymentId, type UserId } from '@nexa/contracts';
import { gatewayAttemptScreen } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import type { PaymentRecord } from '../../apps/api/src/modules/commerce/payments/application/ports';
import type { GatewayInvoiceRecord } from '../../apps/api/src/modules/commerce/payments/application/gateway-invoice-ports';

/**
 * The NOWPayments customer screen (`docs/nowpayments-gateway-audit.md` §5.8), through the one
 * pure function the turn and the worker both render: the hosted invoice's URL button carries
 * the owner's «💳 پرداخت با ارز دیجیتال» under its OWN key (isolated for the inline-button
 * registry as `payment.nowpayments.open`), and the review and needs-review screens use
 * NOWPayments' own sentences — never TonPays' receipt wording, and never a payment link.
 */

const PAYMENT_ID = '01a0fa00-0000-7000-8000-000000000001' as PaymentId;
const CREATED_AT = new Date('2026-10-02T10:00:00Z');
const EXPIRES_AT = new Date('2026-10-02T11:10:00Z');

function payment(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: PAYMENT_ID,
    customerId: '01a0fa00-0000-7000-8000-0000000000c1' as UserId,
    orderId: '01a0fa00-0000-7000-8000-0000000000d1' as never,
    state: 'PENDING',
    method: 'GATEWAY',
    amount: money(250_000n, 'IRT'),
    reference: 'ref',
    evidenceKind: null,
    evidenceNote: null,
    externalReference: 'TPT-1',
    confirmedAt: null,
    confirmedByAdminId: null,
    resolvedAt: null,
    resolvedByAdminId: null,
    resolutionNote: null,
    customerSignalledAt: null,
    checkoutHeldUntil: null,
    expiresAt: EXPIRES_AT,
    gatewayProvider: 'NOWPAYMENTS',
    topupCashbackPercent: null,
    customerFee: null,
    providerReviewStartedAt: null,
    providerReviewUntil: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function invoice(overrides: Partial<GatewayInvoiceRecord> = {}): GatewayInvoiceRecord {
  return {
    paymentId: PAYMENT_ID,
    provider: 'NOWPAYMENTS',
    providerOrderId: 'NTAAAAAAAAAAAAAAAAAA',
    providerInvoiceId: 'TPT-1',
    hintedInvoiceId: null,
    hintedPaymentId: null,
    creationState: 'CREATED',
    creationAttempts: 1,
    creationSentAt: CREATED_AT,
    creationRetryAt: null,
    creationErrorCode: null,
    createdInvoiceAt: CREATED_AT,
    buyerChatIdSent: true,
    callbackUrlSent: true,
    invoiceUrl: 'https://nowpayments.io/payment/?iid=4522625843',
    webInvoiceUrl: null,
    providerUnit: 'USD',
    sentAmount: 1000n,
    conversionRateMinor: null,
    conversionPolicy: 'CENTRAL_FX',
    fx: null,
    botInstanceId: null,
    providerChargeId: null,
    requestAmount: 250_000n,
    finalAmount: 250_037n,
    creditAmount: null,
    providerStatus: 'pending',
    providerPaid: false,
    lastInquiryAt: null,
    lastInquiryErrorCode: null,
    inquiryAttempts: 0,
    nextInquiryAt: null,
    postDeadlineInquiries: 0,
    webhookStatusHint: null,
    lastWebhookAt: null,
    lastWebhookDeliveryId: null,
    webhookCount: 0,
    outcome: null,
    outcomeAt: null,
    lateCompletionObservedAt: null,
    cardNumber: null,
    cardName: null,
    cardSeq: null,
    cardReceivedAt: null,
    cardChangeShown: null,
    cardChangeCooldownUntil: null,
    cardChangeExhausted: null,
    reconcileInquiryRequestedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

const AT = new Date('2026-10-02T10:30:00Z');

describe('the NOWPayments screen', () => {
  it('opens the hosted invoice with its own pay button key, beside the status check', () => {
    const reply = gatewayAttemptScreen({ payment: payment(), invoice: invoice() }, null, AT);
    expect(reply.key).toBe('bot.payment.gateway_invoice');
    const pay = reply.buttons[0];
    expect(pay).toMatchObject({
      label: { kind: 'TEMPLATE', key: 'bot.payment.nowpayments_pay_button' },
      url: 'https://nowpayments.io/payment/?iid=4522625843',
    });
  });

  it('keeps the generic pay button for every other link route', () => {
    const reply = gatewayAttemptScreen(
      {
        payment: payment({ gatewayProvider: 'TONPAYS' }),
        invoice: invoice({ provider: 'TONPAYS' }),
      },
      null,
      AT,
    );
    expect(reply.buttons[0]).toMatchObject({
      label: { kind: 'TEMPLATE', key: 'bot.payment.gateway_pay_button' },
    });
  });

  it('says the coins are confirming while the review window is open, with no pay link', () => {
    const reviewUntil = new Date(AT.getTime() + 23 * 3_600_000);
    const reply = gatewayAttemptScreen(
      {
        payment: payment({ providerReviewStartedAt: AT, providerReviewUntil: reviewUntil }),
        invoice: invoice(),
      },
      null,
      AT,
    );
    expect(reply.key).toBe('bot.payment.nowpayments_in_review');
    expect(reply.buttons.some((button) => 'url' in button)).toBe(false);
  });

  it('says a person is reconciling it once the payment is UNKNOWN (a partial payment)', () => {
    const reply = gatewayAttemptScreen(
      { payment: payment({ state: 'UNKNOWN' }), invoice: invoice() },
      null,
      AT,
    );
    expect(reply.key).toBe('bot.payment.nowpayments_review_unresolved');
    expect(reply.buttons.some((button) => 'url' in button)).toBe(false);
  });
});
