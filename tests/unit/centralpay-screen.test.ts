import { describe, expect, it } from 'vitest';
import { money, type PaymentId, type UserId } from '@nexa/contracts';
import { gatewayAttemptScreen } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import type { PaymentRecord } from '../../apps/api/src/modules/commerce/payments/application/ports';
import type { GatewayInvoiceRecord } from '../../apps/api/src/modules/commerce/payments/application/gateway-invoice-ports';

/**
 * The CentralPay customer screen (`docs/centralpay-gateway-audit.md` §5.8), through the one
 * pure function the turn and the worker both render: the link's URL button carries the
 * owner's «💳 پرداخت با CentralPay» under its OWN key (isolated for the inline-button registry
 * as `payment.centralpay_open`), and a held (UNKNOWN) payment uses CentralPay's own
 * needs-review sentence with no payment link.
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
    externalReference: '1234567890',
    confirmedAt: null,
    confirmedByAdminId: null,
    resolvedAt: null,
    resolvedByAdminId: null,
    resolutionNote: null,
    customerSignalledAt: null,
    checkoutHeldUntil: null,
    expiresAt: EXPIRES_AT,
    gatewayProvider: 'CENTRALPAY',
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
    provider: 'CENTRALPAY',
    providerOrderId: '1234567890',
    providerInvoiceId: '1234567890',
    hintedInvoiceId: null,
    hintedPaymentId: null,
    providerUserId: '1987654321',
    creationState: 'CREATED',
    creationAttempts: 1,
    creationSentAt: CREATED_AT,
    creationRetryAt: null,
    creationErrorCode: null,
    createdInvoiceAt: CREATED_AT,
    buyerChatIdSent: true,
    callbackUrlSent: true,
    invoiceUrl: 'https://pay.centralapi.org/p/abc',
    webInvoiceUrl: null,
    providerUnit: 'IRT',
    sentAmount: 250_000n,
    conversionRateMinor: null,
    conversionPolicy: 'SAME_UNIT',
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
    rowFailures: 0,
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

describe('the CentralPay screen', () => {
  it('opens the link with its own pay button key, beside the status check', () => {
    const reply = gatewayAttemptScreen({ payment: payment(), invoice: invoice() }, null, AT);
    expect(reply.key).toBe('bot.payment.gateway_invoice');
    expect(reply.buttons[0]).toMatchObject({
      label: { kind: 'TEMPLATE', key: 'bot.payment.centralpay_pay_button' },
      url: 'https://pay.centralapi.org/p/abc',
    });
  });

  it('says a person is reconciling it once a verify did not match (UNKNOWN), with no pay link', () => {
    const reply = gatewayAttemptScreen(
      { payment: payment({ state: 'UNKNOWN' }), invoice: invoice() },
      null,
      AT,
    );
    expect(reply.key).toBe('bot.payment.centralpay_review_unresolved');
    expect(reply.buttons.some((button) => 'url' in button)).toBe(false);
  });

  it('shows a confirmed payment as confirmed, with no pay link', () => {
    const reply = gatewayAttemptScreen(
      { payment: payment({ state: 'CONFIRMED' }), invoice: invoice({ outcome: 'SETTLED' }) },
      null,
      AT,
    );
    expect(reply.buttons.some((button) => 'url' in button)).toBe(false);
  });
});
