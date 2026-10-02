import { describe, expect, it } from 'vitest';
import { money, type PaymentId, type UserId } from '@nexa/contracts';
import { gatewayAttemptScreen } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import type { PaymentRecord } from '../../apps/api/src/modules/commerce/payments/application/ports';
import type {
  GatewayInvoiceRecord,
  GatewayReceiptSubmissionRecord,
} from '../../apps/api/src/modules/commerce/payments/application/gateway-invoice-ports';
import type { GatewayCardFacts } from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';

/**
 * The TonPays Telegram payment screen (`docs/tonpays-telegram-gateway-audit.md` §8.1), as the
 * one pure function the turn and the worker both render through. Pinned here: which screen
 * each state draws, and which of «📤 ارسال فیش واریزی» (`gr:`) and «🔄 تعویض کارت» (`gk:`)
 * it offers — a button drawn where its rule forbids it is an invitation to pay twice.
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
    gatewayProvider: 'TONPAYS_TELEGRAM',
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
    provider: 'TONPAYS_TELEGRAM',
    providerOrderId: 'NTAAAAAAAAAAAAAAAAAA',
    providerInvoiceId: 'TPT-1',
    hintedInvoiceId: null,
    creationState: 'CREATED',
    creationAttempts: 1,
    creationSentAt: CREATED_AT,
    creationRetryAt: null,
    creationErrorCode: null,
    createdInvoiceAt: CREATED_AT,
    buyerChatIdSent: true,
    callbackUrlSent: true,
    invoiceUrl: null,
    webInvoiceUrl: null,
    providerUnit: 'IRT',
    sentAmount: 250_000n,
    conversionRateMinor: null,
    conversionPolicy: 'SAME_UNIT',
    fx: null,
    botInstanceId: '01900000-0000-7000-8000-00000000a001',
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
    cardNumber: '6037-9911-0000-1001',
    cardName: 'علی رضایی',
    cardSeq: 1,
    cardReceivedAt: CREATED_AT,
    cardChangeShown: true,
    cardChangeCooldownUntil: null,
    cardChangeExhausted: false,
    reconcileInquiryRequestedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

const NO_FACTS: GatewayCardFacts = { latestChange: null, submissions: [] };
const AT = new Date('2026-10-02T10:30:00Z');

const submission = (
  state: GatewayReceiptSubmissionRecord['state'],
): GatewayReceiptSubmissionRecord => ({
  id: 's1',
  paymentId: PAYMENT_ID,
  providerInvoiceId: 'TPT-1',
  botInstanceId: 'b',
  customerId: 'c',
  captureId: 'w',
  telegramFileId: 'f',
  telegramFileUniqueId: 'u',
  declaredSize: 10n,
  state,
  attempts: 1,
  sentAt: null,
  retryAt: null,
  decidedAt: null,
  errorCode: null,
  providerStatus: null,
  receiptReceived: null,
  openedReview: false,
  inquiryResolvedAt: null,
  byteLength: null,
  createdAt: CREATED_AT,
});

const data = (reply: ReturnType<typeof gatewayAttemptScreen>) =>
  reply.buttons.map((button) => ('data' in button ? button.data : null));

describe('the TonPays Telegram payment screen', () => {
  it('shows the card, the payable, TonPays’ own figure apart, and the three actions in the customer window', () => {
    const reply = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice() },
      'o',
      AT,
      NO_FACTS,
    );
    expect(reply.key).toBe('bot.payment.gateway_card_invoice');
    expect(reply.values).toMatchObject({
      cardNumber: '6037-9911-0000-1001',
      cardName: 'علی رضایی',
      payable: money(250_000n, 'IRT'),
      transferAmount: money(250_037n, 'IRT'),
      expiresAt: EXPIRES_AT,
    });
    expect(data(reply)).toEqual([
      `gr:${PAYMENT_ID}`,
      `gk:${PAYMENT_ID}`,
      `gc:${PAYMENT_ID}`,
      'mm:',
    ]);
    expect(reply.wizard).toMatchObject({ step: 'INVOICE', paymentId: PAYMENT_ID });
  });

  it('TPTG-39: in review it renders gateway_in_review — no receipt, no card change, no retry — and never closed', () => {
    const reviewUntil = new Date(AT.getTime() + 24 * 3_600_000);
    const later = new Date(EXPIRES_AT.getTime() + 3_600_000);
    const reply = gatewayAttemptScreen(
      {
        payment: payment({ providerReviewStartedAt: AT, providerReviewUntil: reviewUntil }),
        invoice: invoice(),
      },
      'o',
      later,
      NO_FACTS,
    );
    expect(reply.key).toBe('bot.payment.gateway_in_review');
    expect(reply.values).toMatchObject({ reviewUntil });
    expect(data(reply)).toEqual([`gc:${PAYMENT_ID}`, 'mm:']);
  });

  it('TPTG-39: UNKNOWN renders gateway_review_unresolved with the main menu only — never failed, never closed', () => {
    const reply = gatewayAttemptScreen(
      { payment: payment({ state: 'UNKNOWN' }), invoice: invoice() },
      'o',
      AT,
      NO_FACTS,
    );
    expect(reply.key).toBe('bot.payment.gateway_review_unresolved');
    expect(data(reply)).toEqual(['mm:']);
  });

  it('TPTG-19: past the customer window (no review) it is closed, and offers no receipt or card change', () => {
    const reply = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice() },
      'o',
      EXPIRES_AT,
      NO_FACTS,
    );
    expect(reply.key).toBe('bot.payment.gateway_closed');
    expect(data(reply).filter((one) => one?.startsWith('gr:') || one?.startsWith('gk:'))).toEqual(
      [],
    );
  });

  it('draws gk: only while the provider allows a change and none is in flight; hides a lost card', () => {
    const exhausted = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice({ cardChangeExhausted: true }) },
      'o',
      AT,
      NO_FACTS,
    );
    expect(data(exhausted)).not.toContain(`gk:${PAYMENT_ID}`);
    const changing = gatewayAttemptScreen({ payment: payment(), invoice: invoice() }, 'o', AT, {
      latestChange: {
        id: 'c',
        paymentId: PAYMENT_ID,
        botInstanceId: 'b',
        customerId: 'c',
        state: 'SENT',
        requestedAt: AT,
        sentAt: AT,
        decidedAt: null,
        errorCode: null,
      },
      submissions: [],
    });
    expect(changing.key).toBe('bot.payment.gateway_card_changing');
    expect(data(changing)).not.toContain(`gk:${PAYMENT_ID}`);
    const lost = gatewayAttemptScreen(
      {
        payment: payment(),
        invoice: invoice({ cardNumber: null, cardName: null, cardSeq: null, cardReceivedAt: null }),
      },
      'o',
      AT,
      NO_FACTS,
    );
    expect(lost.key).toBe('bot.payment.gateway_card_unconfirmed');
    expect(lost.values).not.toHaveProperty('cardNumber');
  });

  it('a receipt on its way, or TonPays reporting processing, is "sent" with no second receipt button', () => {
    for (const state of ['QUEUED', 'SENDING'] as const) {
      const reply = gatewayAttemptScreen({ payment: payment(), invoice: invoice() }, 'o', AT, {
        latestChange: null,
        submissions: [submission(state)],
      });
      expect(reply.key).toBe('bot.payment.gateway_card_receipt_sent');
      expect(data(reply)).not.toContain(`gr:${PAYMENT_ID}`);
    }
    const processing = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice({ providerStatus: 'processing' }) },
      'o',
      AT,
      NO_FACTS,
    );
    expect(processing.key).toBe('bot.payment.gateway_card_receipt_sent');
    expect(data(processing)).not.toContain(`gr:${PAYMENT_ID}`);
    const refused = gatewayAttemptScreen({ payment: payment(), invoice: invoice() }, 'o', AT, {
      latestChange: null,
      submissions: [submission('REFUSED')],
    });
    expect(refused.key).toBe('bot.payment.gateway_card_receipt_refused');
    expect(data(refused)).toContain(`gr:${PAYMENT_ID}`);
  });

  it('a created invoice that came with no card cannot be paid here, and offers a new attempt', () => {
    const reply = gatewayAttemptScreen(
      {
        payment: payment(),
        invoice: invoice({
          creationErrorCode: 'nexa.no_payment_card',
          cardNumber: null,
          cardName: null,
          cardSeq: null,
          cardReceivedAt: null,
        }),
      },
      'o',
      AT,
      NO_FACTS,
    );
    expect(reply.key).toBe('bot.payment.gateway_card_missing');
  });

  it('never says paid until the payment is CONFIRMED', () => {
    const confirmed = gatewayAttemptScreen(
      {
        payment: payment({ state: 'CONFIRMED' }),
        invoice: invoice({ providerStatus: 'completed', providerPaid: true }),
      },
      'o',
      AT,
      NO_FACTS,
    );
    expect(confirmed.key).toBe('bot.payment.gateway_confirmed');
    const approvedButPending = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice({ providerStatus: 'completed', providerPaid: true }) },
      'o',
      AT,
      NO_FACTS,
    );
    expect(approvedButPending.key).not.toBe('bot.payment.gateway_confirmed');
  });
});
