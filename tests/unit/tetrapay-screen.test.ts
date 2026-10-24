import { describe, expect, it } from 'vitest';
import { money, type PaymentId, type UserId } from '@nexa/contracts';
import { gatewayAttemptScreen, intentOf } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import type { PaymentRecord } from '../../apps/api/src/modules/commerce/payments/application/ports';
import type { GatewayInvoiceRecord } from '../../apps/api/src/modules/commerce/payments/application/gateway-invoice-ports';

/**
 * The TetraPay customer screen (`docs/tetrapay-gateway-audit.md`), through the one pure function
 * the turn and the worker both render: the generic «💳 پرداخت آنلاین» link and «🔄 بررسی وضعیت
 * پرداخت», a held payment's own needs-review sentence, and the two create refusals a customer can
 * act on (the daily limit; an amount outside the provider's range, shown in Toman).
 */

const PAYMENT_ID = '01a0fa00-0000-7000-8000-000000000001' as PaymentId;
const CREATED_AT = new Date('2026-10-02T10:00:00Z');
const EXPIRES_AT = new Date('2026-10-02T11:10:00Z');

function payment(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: PAYMENT_ID,
    source: 'NEXA',
    customerId: '01a0fa00-0000-7000-8000-0000000000c1' as UserId,
    orderId: '01a0fa00-0000-7000-8000-0000000000d1' as never,
    state: 'PENDING',
    method: 'GATEWAY',
    amount: money(250_000n, 'IRT'),
    reference: 'ref',
    code: null,
    evidenceKind: null,
    evidenceNote: null,
    externalReference: 'q9Xk2VbR7tLmN4pA8sWcYg',
    confirmedAt: null,
    confirmedByAdminId: null,
    resolvedAt: null,
    resolvedByAdminId: null,
    resolutionNote: null,
    customerSignalledAt: null,
    checkoutHeldUntil: null,
    expiresAt: EXPIRES_AT,
    gatewayProvider: 'TETRAPAY',
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
    provider: 'TETRAPAY',
    providerOrderId: 'AB12CD34-X7K9QM',
    providerInvoiceId: 'q9Xk2VbR7tLmN4pA8sWcYg',
    hintedInvoiceId: null,
    hintedPaymentId: null,
    providerUserId: null,
    creationState: 'CREATED',
    creationAttempts: 1,
    creationSentAt: CREATED_AT,
    creationRetryAt: null,
    creationErrorCode: null,
    createdInvoiceAt: CREATED_AT,
    buyerChatIdSent: true,
    callbackUrlSent: true,
    invoiceUrl: 'https://tetrapay.online/pay/q9Xk2VbR7tLmN4pA8sWcYg',
    webInvoiceUrl: null,
    providerUnit: 'IRR',
    sentAmount: 2_500_000n,
    conversionRateMinor: null,
    conversionPolicy: 'SAME_UNIT',
    fx: null,
    botInstanceId: null,
    providerChargeId: null,
    requestAmount: 2_500_000n,
    finalAmount: 2_500_370n,
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
    cryptoPayCurrency: null,
    cryptoRequested: null,
    cryptoPaid: null,
    cryptoReceived: null,
    cryptoReceivedCurrency: null,
    cryptoPayAddress: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

const AT = new Date('2026-10-02T10:30:00Z');
const PAYMENT_UUID = '0190f2a4-7c3e-7d11-9a55-1f2e3d4c5b6a';

describe('the TetraPay screen', () => {
  it('opens the link with the generic online-pay button, beside the status check', () => {
    const reply = gatewayAttemptScreen({ payment: payment(), invoice: invoice() }, null, AT);
    expect(reply.key).toBe('bot.payment.gateway_invoice');
    expect(reply.buttons[0]).toMatchObject({
      label: { kind: 'TEMPLATE', key: 'bot.payment.gateway_pay_button' },
      url: 'https://tetrapay.online/pay/q9Xk2VbR7tLmN4pA8sWcYg',
    });
    expect(reply.buttons[1]).toMatchObject({
      label: { kind: 'TEMPLATE', key: 'bot.payment.gateway_check_button' },
    });
  });

  it('shows the order amount, the fee and the payable when the route charges one', () => {
    const reply = gatewayAttemptScreen(
      {
        payment: payment({
          customerFee: {
            basisPoints: 500,
            fee: money(12_500n, 'IRT'),
            payable: money(262_500n, 'IRT'),
          },
        }),
        invoice: invoice(),
      },
      null,
      AT,
    );
    expect(reply.key).toBe('bot.payment.gateway_invoice_order_fee');
    expect(reply.values).toMatchObject({
      principal: money(250_000n, 'IRT'),
      fee: money(12_500n, 'IRT'),
      payable: money(262_500n, 'IRT'),
    });
  });

  it('says a person is reconciling it once a verify did not match (UNKNOWN), with no pay link', () => {
    const reply = gatewayAttemptScreen(
      { payment: payment({ state: 'UNKNOWN' }), invoice: invoice() },
      null,
      AT,
    );
    expect(reply.key).toBe('bot.payment.tetrapay_review_unresolved');
    expect(reply.buttons.some((button) => 'url' in button)).toBe(false);
  });

  it('says the daily limit was reached, and offers a way back to choosing how to pay', () => {
    const reply = gatewayAttemptScreen(
      {
        payment: payment({ state: 'FAILED' }),
        invoice: invoice({
          creationState: 'CREATE_FAILED',
          creationErrorCode: 'tetrapay.DAILY_LIMIT_REACHED',
          providerInvoiceId: null,
          invoiceUrl: null,
        }),
      },
      null,
      AT,
    );
    expect(reply.key).toBe('bot.payment.tetrapay_daily_limit');
    expect(reply.buttons.length).toBeGreaterThan(1);
  });

  it('shows the provider min and max in Toman for an amount outside its range, dropping an unstated bound', () => {
    const failed = (code: string) =>
      gatewayAttemptScreen(
        {
          payment: payment({ state: 'FAILED' }),
          invoice: invoice({ creationState: 'CREATE_FAILED', creationErrorCode: code }),
        },
        null,
        AT,
      );
    const both = failed('tetrapay.AMOUNT_OUT_OF_RANGE:1000:100000000');
    expect(both.key).toBe('bot.payment.tetrapay_amount_out_of_range');
    expect(both.values).toMatchObject({
      min: money(1_000n, 'IRT'),
      max: money(100_000_000n, 'IRT'),
    });
    const onlyMin = failed('tetrapay.AMOUNT_OUT_OF_RANGE:1000:0');
    expect(onlyMin.values).toHaveProperty('min');
    expect(onlyMin.values).not.toHaveProperty('max');
    // Any other refusal keeps the generic sentence.
    expect(failed('tetrapay.VALIDATION').key).toBe('bot.payment.gateway_unavailable');
  });
});

describe('returning from the payment page through the bot', () => {
  const update = (text: string) => ({ message: { text, chat: { type: 'private' } } });

  it('turns /start tp-<payment> into a status check for that payment and nothing else', () => {
    expect(intentOf(update(`/start tp-${PAYMENT_UUID}`))).toMatchObject({
      intent: 'GATEWAY_RETURN',
      targetId: PAYMENT_UUID,
    });
  });

  it('never reads ?status= from the link: anything past the id is not a return', () => {
    expect(intentOf(update(`/start tp-${PAYMENT_UUID}&status=paid`)).intent).toBe('START');
    expect(intentOf(update(`/start tp-${PAYMENT_UUID}?status=paid`)).intent).toBe('START');
  });

  it('leaves an ordinary /start and a referral link alone', () => {
    expect(intentOf(update('/start')).intent).toBe('START');
    expect(intentOf(update('/start ref-ABC123')).intent).toBe('START');
    expect(intentOf(update('/start tp-not-a-uuid')).intent).toBe('START');
  });
});
